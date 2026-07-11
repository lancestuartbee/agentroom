'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { DownloadIcon } from './icons/DownloadIcon';

type ExportAction = 'png' | 'md' | 'txt' | 'save-md' | 'save-md-reveal';

interface ExportOption {
  action: ExportAction;
  label: string;
  description: string;
}

const EXPORT_OPTIONS: ExportOption[] = [
  { action: 'save-md', label: '保存到本对话', description: 'Markdown' },
  { action: 'save-md-reveal', label: '保存并显示路径', description: 'Finder' },
  { action: 'png', label: '导出长图', description: 'PNG 截图' },
  { action: 'md', label: '下载聊天记录', description: 'Markdown' },
  { action: 'txt', label: '下载聊天记录', description: '纯文本' },
];

export function ExportButton({ threadId }: { threadId: string }) {
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleExport = useCallback(
    async (action: ExportAction) => {
      setMenuOpen(false);
      setLoading(true);
      try {
        if (action === 'png') {
          await exportImage(threadId);
        } else if (action === 'save-md' || action === 'save-md-reveal') {
          await saveThreadMarkdown(threadId, action === 'save-md-reveal');
        } else {
          await exportText(threadId, action);
        }
      } catch (error) {
        console.error('导出失败:', error);
        alert(`导出失败：${error instanceof Error ? error.message : '未知错误'}`);
      } finally {
        setLoading(false);
      }
    },
    [threadId],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={loading}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-transparent text-cafe-secondary transition-colors hover:text-cafe-accent disabled:opacity-50 disabled:cursor-not-allowed"
        title="导出对话"
        aria-label="导出对话"
      >
        {loading ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            className="w-4 h-4 animate-spin text-cafe-secondary"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 019.8 8" />
          </svg>
        ) : (
          <DownloadIcon className="w-4 h-4 text-cafe-secondary" />
        )}
      </button>

      {menuOpen && (
        <div className="absolute right-0 top-full mt-1 w-52 bg-[var(--console-card-bg)] border border-[var(--console-border-soft)] rounded-lg shadow-lg z-50 py-1">
          {EXPORT_OPTIONS.map((opt) => (
            <button
              type="button"
              key={opt.action}
              onClick={() => handleExport(opt.action)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--console-hover-bg)] transition-colors flex items-center justify-between"
            >
              <span className="text-cafe-black">{opt.label}</span>
              <span className="text-xs text-cafe-muted">{opt.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

async function exportImage(threadId: string): Promise<void> {
  const res = await apiFetch(`/api/threads/${threadId}/export-image`, {
    method: 'POST',
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string; message?: string };
    throw new Error(data.message || data.error || '导出失败');
  }
  const blob = await res.blob();
  downloadBlob(blob, `chat-${threadId}-${Date.now()}.png`);
}

async function exportText(threadId: string, format: 'md' | 'txt'): Promise<void> {
  const res = await apiFetch(`/api/export/thread/${threadId}?format=${format}`);
  if (!res.ok) {
    const data = (await res.json()) as { error?: string; message?: string };
    throw new Error(data.message || data.error || '导出失败');
  }
  const text = await res.text();
  const ext = format === 'md' ? 'md' : 'txt';
  const mime = format === 'md' ? 'text/markdown' : 'text/plain';
  const blob = new Blob([text], { type: `${mime}; charset=utf-8` });
  downloadBlob(blob, `thread-${threadId}.${ext}`);
}

interface SaveMarkdownResponse {
  artifact?: {
    artifactId?: string;
    localPath?: string;
  };
}

async function saveThreadMarkdown(threadId: string, reveal: boolean): Promise<void> {
  const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/artifacts/markdown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'thread-export' }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string; message?: string };
    throw new Error(data.message || data.error || '保存失败');
  }

  const data = (await res.json()) as SaveMarkdownResponse;
  const artifactId = data.artifact?.artifactId;
  if (reveal && artifactId) {
    const revealRes = await apiFetch(
      `/api/artifact-store/threads/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}/reveal`,
      { method: 'POST' },
    );
    if (!revealRes.ok) {
      const revealData = (await revealRes.json()) as { error?: string; message?: string };
      throw new Error(revealData.message || revealData.error || '打开路径失败');
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('agentroom:artifacts-updated', { detail: { threadId } }));
    window.alert(`已保存到本对话产物目录：\n${data.artifact?.localPath ?? '路径未返回'}`);
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
