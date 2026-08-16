'use client';

import type { Sandbox } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

/**
 * F247 AC-D2/AC-D3 — what this sandbox is currently set to, at the top of the dev pane.
 *
 * The left column is where a sandbox is shaped, and the only way to change it is to say so
 * in chat (AC-D4). Until now the operator was talking to something they could not see: the
 * goal, members, schedule and backflow switch existed only on disk. This bar is the
 * referent that conversation is about — you say "改到 9 点" and watch it change here.
 *
 * It also carries pause/resume. The run pane refuses to run a paused sandbox, which
 * without a control anywhere is a dead end: paused, with no way back.
 *
 * Polling rather than pushing: a spec edit lands through an MCP callback on the server, so
 * there is no client-side event to react to. The server stays the single truth; this is
 * one view of it that re-reads, and the run pane is another.
 */
const REFRESH_MS = 30_000;

function statusLabel(status: Sandbox['status']): string {
  if (status === 'active') return '运行中';
  if (status === 'paused') return '已暂停';
  return '已归档';
}

export function SandboxSpecBar(): JSX.Element | null {
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const threads = useChatStore((s) => s.threads);
  const sandboxId = threads.find((t) => t.id === currentThreadId)?.sandboxId;

  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!sandboxId) return;
    try {
      const res = await apiFetch(`/api/sandboxes/${encodeURIComponent(sandboxId)}`);
      if (!res.ok) {
        setError(`无法读取沙盒设置（HTTP ${res.status}）`);
        return;
      }
      const body = (await res.json()) as { sandbox: Sandbox };
      setSandbox(body.sandbox);
      setError(null);
    } catch {
      setError('无法读取沙盒设置');
    }
  }, [sandboxId]);

  useEffect(() => {
    if (!sandboxId) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [sandboxId, load]);

  const setStatus = useCallback(
    async (status: 'active' | 'paused') => {
      if (!sandboxId || busy) return;
      setBusy(true);
      try {
        const res = await apiFetch(`/api/sandboxes/${encodeURIComponent(sandboxId)}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) {
          setError(`暂停/恢复失败（HTTP ${res.status}）`);
          return;
        }
        const body = (await res.json()) as { sandbox?: Sandbox };
        // Trust the server's answer over the status we asked for: a rejected or coerced
        // transition must not leave the bar claiming something the sandbox is not.
        if (body.sandbox) setSandbox(body.sandbox);
        else await load();
        setError(null);
      } catch {
        setError('暂停/恢复失败');
      } finally {
        setBusy(false);
      }
    },
    [sandboxId, busy, load],
  );

  if (!sandboxId) return null;

  if (!sandbox) {
    return (
      <div
        className="px-4 py-2 text-xs text-[var(--console-text-muted)] border-b border-cafe-subtle"
        data-testid={error ? 'spec-bar-error' : 'spec-bar-loading'}
      >
        {error ?? '正在读取沙盒设置…'}
      </div>
    );
  }

  const spec = sandbox.spec;
  const schedule = spec.schedule;

  return (
    <div className="px-4 py-2 border-b border-cafe-subtle text-xs space-y-1" data-testid="sandbox-spec-bar">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-cafe-black">{sandbox.title}</span>
        <span className="text-cafe-muted" data-testid="spec-bar-status">
          {statusLabel(sandbox.status)}
        </span>
        {sandbox.status === 'active' ? (
          <button
            type="button"
            onClick={() => void setStatus('paused')}
            disabled={busy}
            data-testid="spec-bar-pause"
            className="px-2 py-0.5 rounded border border-cafe text-cafe-secondary disabled:opacity-50"
          >
            暂停
          </button>
        ) : sandbox.status === 'paused' ? (
          <button
            type="button"
            onClick={() => void setStatus('active')}
            disabled={busy}
            data-testid="spec-bar-resume"
            className="px-2 py-0.5 rounded border border-cafe text-cafe-secondary disabled:opacity-50"
          >
            恢复
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto text-cafe-secondary"
          data-testid="spec-bar-toggle"
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>

      <div className="text-cafe-secondary" data-testid="spec-bar-goal">
        目标：{spec.goal}
      </div>

      <div className="flex items-center gap-3 flex-wrap text-cafe-muted">
        <span data-testid="spec-bar-schedule">
          {schedule?.cron
            ? `定时：${schedule.cron}${schedule.timezone ? `（${schedule.timezone}）` : ''}`
            : '未设置定时，仅手动运行'}
        </span>
        <span data-testid="spec-bar-backflow">回流：{sandbox.settings.allowBackflow ? '开启' : '关闭'}</span>
        <span data-testid="spec-bar-members">成员：{spec.members.join('、')}</span>
      </div>

      {expanded && (
        <div className="space-y-1 text-cafe-muted pt-1">
          {spec.learningGoal && <div data-testid="spec-bar-learning-goal">学习目标：{spec.learningGoal}</div>}
          {schedule?.prompt && <div data-testid="spec-bar-schedule-prompt">到点执行：{schedule.prompt}</div>}
          <div className="text-micro">改这些直接在下面说，例如「把它改到每天 9 点」。</div>
        </div>
      )}

      {error && (
        <div className="text-conn-red-text" data-testid="spec-bar-stale">
          {error}
        </div>
      )}
    </div>
  );
}
