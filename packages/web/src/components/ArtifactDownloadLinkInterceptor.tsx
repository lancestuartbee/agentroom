'use client';

import { useEffect } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';

const ARTIFACT_STORE_PREFIX = '/api/artifact-store/threads/';
const AGENTROOM_REPORT_PATH_RE =
  /(?:^|\/)Documents\/AgentRoom\/profiles\/[^/]+\/threads\/([^/]+)\/reports\/.+\.(?:md|markdown)$/i;

function stripMarkdownFragment(href: string): string {
  return href.split('#')[0]?.trim() ?? '';
}

function decodeLocalPathHref(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

function pathCandidateFromHref(href: string, baseUrl: string): string {
  const clean = stripMarkdownFragment(href);
  if (!clean) return '';

  if (/^file:\/\//i.test(clean)) {
    try {
      return decodeLocalPathHref(new URL(clean).pathname);
    } catch {
      return decodeLocalPathHref(clean.replace(/^file:\/\//i, ''));
    }
  }

  if (/^https?:\/\//i.test(clean)) {
    try {
      const url = new URL(clean);
      return decodeLocalPathHref(url.pathname);
    } catch {
      return decodeLocalPathHref(clean);
    }
  }

  try {
    const url = new URL(clean, baseUrl);
    if (clean.startsWith('/')) return decodeLocalPathHref(url.pathname);
  } catch {
    // Fall through to raw path.
  }

  return decodeLocalPathHref(clean);
}

function artifactStoreDownloadApiPath(href: string, currentThreadId: string | undefined, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(stripMarkdownFragment(href), baseUrl);
  } catch {
    return null;
  }

  if (url.pathname.startsWith(ARTIFACT_STORE_PREFIX)) {
    const parts = url.pathname.split('/').filter(Boolean);
    const threadId = parts[3] ? decodeURIComponent(parts[3]) : '';
    const artifactId = parts[4] ? decodeURIComponent(parts[4]) : '';
    const action = parts[5] ?? '';

    if (threadId && artifactId && (action === 'content' || action === 'download')) {
      return `/api/artifact-store/threads/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}/download`;
    }
    if (threadId && action === 'download-path') {
      return `${url.pathname}${url.search}`;
    }
  }

  const linkedThreadId = url.searchParams.get('threadId') ?? currentThreadId;
  const linkedArtifactId = url.searchParams.get('artifactId');
  if (linkedThreadId && linkedArtifactId) {
    return `/api/artifact-store/threads/${encodeURIComponent(linkedThreadId)}/${encodeURIComponent(
      linkedArtifactId,
    )}/download`;
  }

  return null;
}

export function resolveArtifactDownloadApiPathForHref(
  href: string,
  currentThreadId?: string,
  baseUrl = API_URL,
): string | null {
  const artifactStorePath = artifactStoreDownloadApiPath(href, currentThreadId, baseUrl);
  if (artifactStorePath) return artifactStorePath;

  const candidate = pathCandidateFromHref(href, baseUrl);
  const reportMatch = AGENTROOM_REPORT_PATH_RE.exec(candidate);
  if (!reportMatch?.[1]) return null;

  const threadId = reportMatch[1];
  return `/api/artifact-store/threads/${encodeURIComponent(threadId)}/download-path?path=${encodeURIComponent(
    candidate,
  )}`;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).trim() || null;
    } catch {
      return utf8Match[1].trim() || null;
    }
  }
  const asciiMatch = /filename="?([^";]+)"?/i.exec(value);
  return asciiMatch?.[1]?.trim() || null;
}

function filenameFromApiPath(apiPath: string): string {
  try {
    const url = new URL(apiPath, API_URL);
    const path = url.searchParams.get('path') ?? '';
    const name = decodeLocalPathHref(path).split('/').filter(Boolean).at(-1);
    return name || 'agentroom-report.md';
  } catch {
    return 'agentroom-report.md';
  }
}

async function downloadArtifact(apiPath: string): Promise<void> {
  const res = await apiFetch(apiPath);
  if (!res.ok) throw new Error(`artifact download failed (${res.status})`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filenameFromContentDisposition(res.headers.get('content-disposition')) ?? filenameFromApiPath(apiPath);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export function ArtifactDownloadLinkInterceptor() {
  const currentThreadId = useChatStore((s) => s.currentThreadId);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;

      const href = anchor.getAttribute('href') ?? anchor.href;
      const apiPath = resolveArtifactDownloadApiPathForHref(href, currentThreadId, window.location.href);
      if (!apiPath) return;

      event.preventDefault();
      event.stopPropagation();
      void downloadArtifact(apiPath).catch((err) => {
        console.error('[ArtifactDownloadLinkInterceptor] Failed to download artifact', err);
        window.alert('下载失败：文件可能已移动、删除，或不属于当前对话产物目录。');
      });
    };

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [currentThreadId]);

  return null;
}
