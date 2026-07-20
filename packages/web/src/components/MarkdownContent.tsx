'use client';

import { Children, isValidElement, type ReactNode, useCallback, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { UNKNOWN_CAT_COLOR } from '@/lib/color-defaults';
import { getMentionColor, getMentionRe, getMentionToCat } from '@/lib/mention-highlight';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { MermaidDiagram } from './MermaidDiagram';
import { createWorkspaceImageComponent, createWorkspaceLinkComponent } from './workspace-md-components';

/* ── @mention highlighting ─────────────────────────────────── */

function highlightMentions(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  const re = getMentionRe();
  const toCat = getMentionToCat();
  const colorMap = getMentionColor();

  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    const catId = toCat[m[1].toLowerCase()] ?? 'opus';
    const catColor = colorMap[catId] ?? UNKNOWN_CAT_COLOR.primary;
    const r = Number.parseInt(catColor.slice(1, 3), 16);
    const g = Number.parseInt(catColor.slice(3, 5), 16);
    const b = Number.parseInt(catColor.slice(5, 7), 16);
    parts.push(
      <span
        key={`m${m.index}`}
        className="font-semibold"
        style={{
          color: catColor,
          backgroundColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
          borderRadius: 4,
          padding: '1px 5px',
        }}
      >
        {m[0]}
      </span>,
    );
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

/** Process immediate string children → highlight @mentions */
function withMentions(children: ReactNode): ReactNode {
  return Children.map(children, (child) => (typeof child === 'string' ? highlightMentions(child) : child));
}

/* ── Code block with copy button ───────────────────────────── */
function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    void navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  return (
    <div className="relative group my-2">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 px-1.5 py-0.5 rounded text-micro bg-cafe-surface-sunken text-cafe-muted md:opacity-0 md:group-hover:opacity-100 hover:bg-[var(--console-hover-bg)] transition-opacity"
      >
        {copied ? '已复制' : '复制'}
      </button>
      <pre
        ref={preRef}
        className="bg-cafe-surface-sunken text-cafe rounded-lg p-3 overflow-x-auto text-xs leading-5 font-mono [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit [&>code]:text-xs"
      >
        {children}
      </pre>
    </div>
  );
}

/* ── File path → VSCode link ──────────────────────────────── */
const PROJECT_ROOT = process.env.NEXT_PUBLIC_PROJECT_ROOT ?? '';
const AGENTROOM_REPORT_FILE_PATH_RE =
  /(?:^|\s)`?((?:\/[^\s`]+)*\/Documents\/AgentRoom\/profiles\/[^/\s`]+\/threads\/[^/\s`]+\/reports\/[^\n\r`<>()\[\]]+?\.(?:markdown|md))(?:`?)/gi;
const FILE_PATH_RE = /(?:^|\s)`?((?:\/[\w.@-]+)+(?:\.[\w]+)(?::(\d+))?)(?:`?)/g;
const REL_PATH_RE = /(?:^|\s)`?((?:packages|src|docs|tests?)\/[\w./@-]+(?:\.[\w]+)(?::(\d+))?)(?:`?)/g;
const WT_TAG_RE = /^\s*\[wt:([a-zA-Z0-9_/-]+)\]/;
const AGENTROOM_REPORT_PATH_RE = /(?:^|\/)Documents\/AgentRoom\/profiles\/[^/]+\/threads\/[^/]+\/reports\/.+/;
const ARTIFACT_STORE_PREFIX = '/api/artifact-store/threads/';

function stripMarkdownFragment(href: string): string {
  return href.split('#')[0]?.trim() ?? '';
}

function normalizeLocalFileHref(href: string): string {
  const clean = stripMarkdownFragment(href);
  if (!/^file:\/\//i.test(clean)) return clean;
  try {
    return decodeURI(new URL(clean).pathname);
  } catch {
    return clean.replace(/^file:\/\//i, '');
  }
}

function decodeLocalPathHref(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

function isRelativeMarkdownReportHref(href: string): boolean {
  const clean = decodeLocalPathHref(stripMarkdownFragment(href));
  if (!clean || clean.startsWith('/') || clean.startsWith('#') || isExternalHref(clean)) return false;
  return /\.(md|markdown)$/i.test(clean);
}

function isAgentRoomReportPath(href: string): boolean {
  const clean = decodeLocalPathHref(normalizeLocalFileHref(href));
  return AGENTROOM_REPORT_PATH_RE.test(clean) && /\.(md|markdown)$/i.test(clean);
}

function resolveArtifactReportDownloadHref(href: string | undefined, threadId: string | undefined): string | null {
  if (!href || !threadId) return null;
  const clean = decodeLocalPathHref(normalizeLocalFileHref(href));
  if (!clean) return null;
  if (!isRelativeMarkdownReportHref(clean) && !isAgentRoomReportPath(clean)) return null;
  return `${API_URL}/api/artifact-store/threads/${encodeURIComponent(threadId)}/download-path?path=${encodeURIComponent(clean)}`;
}

function resolveArtifactStoreDownloadHref(href: string | undefined, currentThreadId: string | undefined): string | null {
  if (!href) return null;
  const clean = stripMarkdownFragment(href);
  if (!clean) return null;

  let url: URL;
  try {
    url = new URL(clean, API_URL);
  } catch {
    return null;
  }

  if (url.pathname.startsWith(ARTIFACT_STORE_PREFIX)) {
    const parts = url.pathname.split('/').filter(Boolean);
    const threadId = parts[3] ? decodeURIComponent(parts[3]) : '';
    const artifactId = parts[4] ? decodeURIComponent(parts[4]) : '';
    const action = parts[5] ?? '';

    if (threadId && artifactId && (action === 'content' || action === 'download')) {
      return `${API_URL}/api/artifact-store/threads/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}/download`;
    }
    if (threadId && action === 'download-path') {
      return `${API_URL}${url.pathname}${url.search}`;
    }
  }

  const linkedThreadId = url.searchParams.get('threadId') ?? currentThreadId;
  const linkedArtifactId = url.searchParams.get('artifactId');
  if (linkedThreadId && linkedArtifactId) {
    return `${API_URL}/api/artifact-store/threads/${encodeURIComponent(linkedThreadId)}/${encodeURIComponent(
      linkedArtifactId,
    )}/download`;
  }

  return null;
}

function resolveArtifactDownloadHref(href: string | undefined, threadId: string | undefined): string | null {
  return resolveArtifactStoreDownloadHref(href, threadId) ?? resolveArtifactReportDownloadHref(href, threadId);
}

function markdownUrlTransform(url: string): string {
  if (/^file:\/\//i.test(url) && isAgentRoomReportPath(url)) return url;
  return defaultUrlTransform(url);
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

function filenameFromDownloadHref(href: string): string {
  try {
    const url = new URL(href, API_URL);
    const rawPath = url.searchParams.get('path') ?? '';
    const cleanPath = stripMarkdownFragment(rawPath);
    const name = cleanPath.split('/').filter(Boolean).at(-1);
    if (name) return name;
    const pathName = decodeURIComponent(url.pathname).split('/').filter(Boolean).at(-2);
    return pathName || 'artifact.md';
  } catch {
    return 'artifact.md';
  }
}

function apiPathFromHref(href: string): string | null {
  try {
    const url = new URL(href, API_URL);
    const apiUrl = new URL(API_URL);
    if (url.origin !== apiUrl.origin) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function ArtifactReportLink({
  href,
  children,
  title,
}: {
  href: string;
  children: ReactNode;
  title?: string;
}) {
  const [downloading, setDownloading] = useState(false);

  const handleClick = useCallback(
    async (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const apiPath = apiPathFromHref(href);
      if (!apiPath) return;

      event.preventDefault();
      if (downloading) return;
      setDownloading(true);
      try {
        const res = await apiFetch(apiPath);
        if (!res.ok) throw new Error(`artifact download failed (${res.status})`);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = filenameFromContentDisposition(res.headers.get('content-disposition')) ?? filenameFromDownloadHref(href);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      } catch (err) {
        console.error('[MarkdownContent] Failed to download artifact report', err);
        window.alert?.('下载失败：文件可能已移动、删除，或不属于当前对话产物目录。');
      } finally {
        setDownloading(false);
      }
    },
    [downloading, href],
  );

  return (
    <a
      href={href}
      onClick={handleClick}
      target="_blank"
      rel="noopener noreferrer"
      className="text-conn-blue-text hover:underline break-all"
      title={downloading ? '正在下载...' : (title ?? '下载当前对话产物')}
    >
      {children}
      <span className="ml-1 rounded border border-cafe-subtle bg-cafe-surface-elevated px-1 py-0.5 text-micro text-cafe-muted no-underline">
        下载
      </span>
    </a>
  );
}

function linkifyFilePaths(text: string, artifactThreadId?: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  const combined = new RegExp(`${AGENTROOM_REPORT_FILE_PATH_RE.source}|${FILE_PATH_RE.source}|${REL_PATH_RE.source}`, 'gi');
  let m: RegExpExecArray | null;

  combined.lastIndex = 0;
  while ((m = combined.exec(text)) !== null) {
    const fullMatch = m[0];
    const leading = fullMatch.match(/^\s/)?.[0] ?? '';
    const path = m[1] ?? m[2] ?? m[4];
    const line = m[3] ?? m[5];
    if (!path) continue;

    const start = m.index + leading.length;
    if (start > lastIdx) parts.push(text.slice(lastIdx, start));

    // Check for [wt:ID] tag immediately after the match
    const afterMatch = text.slice(m.index + fullMatch.length);
    const wtMatch = afterMatch.match(WT_TAG_RE);
    const worktreeId = wtMatch?.[1] ?? undefined;

    // Strip backticks from display
    const display = path;
    const isAbsolute = path.startsWith('/');
    const filePath = path.split(':')[0];
    const artifactHref = resolveArtifactDownloadHref(filePath, artifactThreadId);
    if (artifactHref) {
      parts.push(
        <ArtifactReportLink
          key={`artifact${m.index}`}
          href={artifactHref}
          title={`下载当前对话产物\n${display}`}
        >
          {display}
        </ArtifactReportLink>,
      );
      if (wtMatch) {
        lastIdx = m.index + fullMatch.length + wtMatch[0].length;
        combined.lastIndex = lastIdx;
      } else {
        lastIdx = m.index + fullMatch.length;
      }
      continue;
    }

    const absPath = isAbsolute ? filePath : PROJECT_ROOT ? `${PROJECT_ROOT}/${filePath}` : null;
    const href = absPath ? `vscode://file${absPath}${line ? `:${line}` : ''}` : null;

    parts.push(
      href ? (
        <FilePathLink
          key={`fp${m.index}`}
          display={display}
          href={href}
          filePath={filePath!}
          line={line ? parseInt(line, 10) : undefined}
          worktreeId={worktreeId}
        />
      ) : (
        <span key={`fp${m.index}`} className="text-[var(--semantic-info)] font-mono text-[0.85em]">
          {display}
        </span>
      ),
    );
    // Skip past the [wt:ID] tag so it's not rendered as visible text
    if (wtMatch) {
      lastIdx = m.index + fullMatch.length + wtMatch[0].length;
      combined.lastIndex = lastIdx;
    } else {
      lastIdx = m.index + fullMatch.length;
    }
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? parts : [text];
}

/** F063: File path link — click opens in workspace panel, Cmd/Ctrl+click opens in VSCode */
function FilePathLink({
  display,
  href,
  filePath,
  line,
  worktreeId,
}: {
  display: string;
  href: string;
  filePath: string;
  line?: number;
  worktreeId?: string;
}) {
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Cmd/Ctrl+click → VSCode (default link behavior)
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      // Regular click → open in workspace panel (with optional worktree switch)
      setOpenFile(filePath, line ?? null, worktreeId ?? null);
    },
    [setOpenFile, filePath, line, worktreeId],
  );

  return (
    <a
      href={href}
      onClick={handleClick}
      className="text-[var(--semantic-info)] hover:text-[var(--semantic-info)] hover:underline font-mono text-[0.85em] cursor-pointer"
      title={`点击在工作区中查看 · Cmd+Click 打开 VSCode\n${display}`}
    >
      {display}
    </a>
  );
}

/** Process string children → @mentions + file path links */
function withMentionsAndLinks(children: ReactNode, artifactThreadId?: string): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child;
    // First pass: file paths → ReactNode[]
    const linked = linkifyFilePaths(child, artifactThreadId);
    // Second pass: highlight @mentions in remaining text nodes
    return (
      <>{linked.map((node, i) => (typeof node === 'string' ? <span key={i}>{highlightMentions(node)}</span> : node))}</>
    );
  });
}

function hasMermaidLanguage(className = ''): boolean {
  return /\blanguage-mermaid\b/i.test(className);
}

function codeChildToString(child: ReactNode): string {
  if (typeof child === 'string') return child;
  if (typeof child === 'number') return String(child);
  return '';
}

function codeChildrenToString(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => codeChildToString(child))
    .join('')
    .replace(/\n$/, '');
}

function isMermaidPre(children: ReactNode): boolean {
  const firstChild = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string }>(firstChild)) return false;
  if (firstChild.type === MermaidDiagram) return true;
  return hasMermaidLanguage(firstChild.props.className);
}

function inlineCodeClassName(className = ''): string {
  return `${className} bg-[var(--code-bg)] text-[var(--code-text)] rounded px-1 py-0.5 text-[0.85em] font-mono`;
}

/* ── Markdown component overrides ──────────────────────────── */

/**
 * Build react-markdown component overrides. When `tp` (textProcessor) is provided,
 * it runs BEFORE mention/link processing on every text-containing component
 * (p, strong, em, del, h1-h6, li, a, th, td). Code/pre components are excluded —
 * textProcessor never touches code block content.
 *
 * Using a factory avoids duplicating component definitions: styling is defined once,
 * and textProcessor composition is injected into the mention-processing pipeline.
 */
function buildMdComponents(tp?: (children: ReactNode) => ReactNode, artifactThreadId?: string): Components {
  // Compose text processing: tp runs first (e.g. replace markers with buttons),
  // then withMentions/withMentionsAndLinks processes remaining strings.
  const m = tp ? (c: ReactNode) => withMentions(tp(c)) : withMentions;
  const ml = tp
    ? (c: ReactNode) => withMentionsAndLinks(tp(c), artifactThreadId)
    : (c: ReactNode) => withMentionsAndLinks(c, artifactThreadId);

  return {
    p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{ml(children)}</p>,
    strong: ({ children }) => <strong className="font-semibold">{ml(children)}</strong>,
    em: ({ children }) => <em>{ml(children)}</em>,
    del: ({ children }) => <del className="opacity-60">{ml(children)}</del>,

    h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{ml(children)}</h1>,
    h2: ({ children }) => <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{ml(children)}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-bold mb-1 mt-2 first:mt-0">{ml(children)}</h3>,
    h4: ({ children }) => <h4 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{ml(children)}</h4>,
    h5: ({ children }) => (
      <h5 className="text-xs font-semibold mb-1 mt-1.5 first:mt-0 uppercase tracking-wide">{ml(children)}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="text-xs font-medium mb-1 mt-1.5 first:mt-0 text-cafe-muted">{ml(children)}</h6>
    ),

    ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
    li: ({ children, className }) => (
      <li className={className === 'task-list-item' ? 'list-none -ml-5 flex items-start gap-1.5' : undefined}>
        {ml(children)}
      </li>
    ),
    input: ({ type, checked }) =>
      type === 'checkbox' ? (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          className="mt-1 h-3.5 w-3.5 rounded border-[var(--console-border-soft)] text-conn-blue-text pointer-events-none"
        />
      ) : (
        <input type={type} />
      ),

    blockquote: ({ children }) => (
      <blockquote className="border-l-[3px] border-cafe pl-3 my-2 italic opacity-80">{children}</blockquote>
    ),
    a: ({ href, children }) => {
      const artifactHref = resolveArtifactDownloadHref(href, artifactThreadId);
      if (artifactHref) {
        return (
          <ArtifactReportLink href={artifactHref} title={`下载当前对话产物\n${href ?? ''}`}>
            {m(children)}
          </ArtifactReportLink>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-conn-blue-text hover:underline break-all"
        >
          {m(children)}
        </a>
      );
    },
    hr: () => <hr className="my-3 border-cafe" />,

    /* Code blocks with copy button — textProcessor intentionally excluded */
    pre: ({ children }) => (isMermaidPre(children) ? children : <CodeBlock>{children}</CodeBlock>),
    code: ({ className = '', children }) => {
      const source = codeChildrenToString(children).trim();
      const artifactHref =
        !hasMermaidLanguage(className) && source && !source.includes('\n')
          ? resolveArtifactDownloadHref(source, artifactThreadId)
          : null;
      if (artifactHref) {
        return (
          <ArtifactReportLink href={artifactHref} title={`下载当前对话产物\n${source}`}>
            <code className={inlineCodeClassName(className)}>{children}</code>
          </ArtifactReportLink>
        );
      }
      return hasMermaidLanguage(className) ? (
        <MermaidDiagram source={source} />
      ) : (
        <code className={inlineCodeClassName(className)}>{children}</code>
      );
    },

    /* Tables (GFM) */
    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="min-w-full text-sm border-collapse">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-cafe-surface-elevated">{children}</thead>,
    th: ({ children }) => (
      <th className="border border-cafe px-2 py-1 text-left font-semibold text-xs">{ml(children)}</th>
    ),
    td: ({ children }) => <td className="border border-cafe px-2 py-1">{ml(children)}</td>,
  };
}

/** Default components — no textProcessor, built once at module load */
const mdComponents = buildMdComponents();

/* ── Exported component ────────────────────────────────────── */
interface Props {
  content: string;
  className?: string;
  /** Skip slash-command prefix detection (e.g. for rich block bodyMarkdown) */
  disableCommandPrefix?: boolean;
  /** Base directory path for resolving relative links (e.g. "docs/features") */
  basePath?: string;
  /** Worktree ID for resolving workspace-relative image paths */
  worktreeId?: string;
  /** Thread whose shared artifact reports directory should resolve report links */
  artifactThreadId?: string;
  /** Pre-process text children in all text-containing components (p, strong, em,
   *  del, h1-h6, li, a, th, td) BEFORE mention/link processing. Code/pre components
   *  are excluded — textProcessor never touches code block content.
   *  Useful for replacing text patterns (e.g. markers) with interactive elements. */
  textProcessor?: (children: ReactNode) => ReactNode;
}

/** Check if href is a relative markdown link (not absolute, not external) */
export function isRelativeMdLink(href: string | undefined): href is string {
  if (!href) return false;
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')) return false;
  return /\.mdx?(?:#|$)/.test(href);
}

/** Resolve a relative path against a base directory */
export function resolveRelativePath(base: string, relative: string): string {
  // Strip fragment/hash
  const clean = relative.split('#')[0];
  // base is the directory of the current file (e.g. "docs/features")
  const parts = base ? base.split('/') : [];
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export function MarkdownContent({
  content,
  className,
  disableCommandPrefix,
  basePath,
  worktreeId,
  artifactThreadId,
  textProcessor,
}: Props) {
  const cmdMatch = disableCommandPrefix ? null : /^(\/\w+)/.exec(content);
  const md = cmdMatch ? content.slice(cmdMatch[1].length) : content;
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const resolvedArtifactThreadId = artifactThreadId ?? currentThreadId;

  let components: Components = textProcessor
    ? buildMdComponents(textProcessor, resolvedArtifactThreadId)
    : resolvedArtifactThreadId
      ? buildMdComponents(undefined, resolvedArtifactThreadId)
      : mdComponents;

  if (basePath != null) {
    // When textProcessor is active, the workspace link component must also compose it
    const mentionsFn = textProcessor ? (c: ReactNode) => withMentions(textProcessor(c)) : withMentions;
    components = { ...components, a: createWorkspaceLinkComponent(basePath, mentionsFn, worktreeId) };
    if (worktreeId) {
      components = { ...components, img: createWorkspaceImageComponent(basePath, worktreeId) };
    }
  }

  return (
    <div className={`markdown-content text-sm break-words ${className ?? ''}`}>
      {cmdMatch && <span className="font-semibold text-[var(--semantic-info)]">{cmdMatch[1]}</span>}
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components} urlTransform={markdownUrlTransform}>
        {md}
      </ReactMarkdown>
    </div>
  );
}
