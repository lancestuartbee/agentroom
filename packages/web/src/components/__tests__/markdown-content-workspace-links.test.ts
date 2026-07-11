import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isRelativeMdLink, MarkdownContent, resolveRelativePath } from '@/components/MarkdownContent';

Object.assign(globalThis as Record<string, unknown>, { React });

/* ── isRelativeMdLink ────────────────────────────────── */
describe('isRelativeMdLink', () => {
  it('returns true for relative .md links', () => {
    expect(isRelativeMdLink('features/F046.md')).toBe(true);
    expect(isRelativeMdLink('../ROADMAP.md')).toBe(true);
    expect(isRelativeMdLink('./notes.mdx')).toBe(true);
  });

  it('returns true for .md links with fragment', () => {
    expect(isRelativeMdLink('README.md#section')).toBe(true);
  });

  it('returns false for absolute URLs', () => {
    expect(isRelativeMdLink('https://example.com/doc.md')).toBe(false);
    expect(isRelativeMdLink('http://example.com/doc.md')).toBe(false);
  });

  it('returns false for root-relative paths', () => {
    expect(isRelativeMdLink('/docs/README.md')).toBe(false);
  });

  it('returns false for non-markdown files', () => {
    expect(isRelativeMdLink('style.css')).toBe(false);
    expect(isRelativeMdLink('image.png')).toBe(false);
    expect(isRelativeMdLink('data.json')).toBe(false);
  });

  it('returns false for undefined/empty', () => {
    expect(isRelativeMdLink(undefined)).toBe(false);
    expect(isRelativeMdLink('')).toBe(false);
  });
});

/* ── resolveRelativePath ─────────────────────────────── */
describe('resolveRelativePath', () => {
  it('resolves simple filename against base dir', () => {
    expect(resolveRelativePath('docs/features', 'F046.md')).toBe('docs/features/F046.md');
  });

  it('resolves parent traversal (..)', () => {
    expect(resolveRelativePath('docs/features', '../ROADMAP.md')).toBe('docs/ROADMAP.md');
  });

  it('resolves multiple parent traversals', () => {
    expect(resolveRelativePath('docs/features/sub', '../../README.md')).toBe('docs/README.md');
  });

  it('resolves dot-slash (./) segments', () => {
    expect(resolveRelativePath('docs', './notes.md')).toBe('docs/notes.md');
  });

  it('strips fragment from relative path', () => {
    expect(resolveRelativePath('docs', 'README.md#section')).toBe('docs/README.md');
  });

  it('handles empty base', () => {
    expect(resolveRelativePath('', 'README.md')).toBe('README.md');
  });

  it('handles nested relative path', () => {
    expect(resolveRelativePath('docs', 'features/F063.md')).toBe('docs/features/F063.md');
  });
});

/* ── MarkdownContent with basePath ──────────────────── */
describe('MarkdownContent workspace link rendering', () => {
  function render(content: string, basePath?: string): string {
    return renderToStaticMarkup(
      React.createElement(MarkdownContent, { content, disableCommandPrefix: true, basePath }),
    );
  }

  it('renders relative md link as workspace-navigable when basePath is set', () => {
    const html = render('[Feature spec](features/F046.md)', 'docs');
    expect(html).toContain('在工作区中打开');
    expect(html).toContain('docs/features/F046.md');
    // Should NOT have target="_blank" for workspace links
    expect(html).not.toMatch(/target=.*_blank.*在工作区中打开/);
  });

  it('renders external links normally even with basePath', () => {
    const html = render('[GitHub](https://github.com)', 'docs');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('https://github.com');
  });

  it('renders relative md link as external when no basePath', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownContent, {
        content: '[Feature spec](features/F046.md)',
        disableCommandPrefix: true,
        artifactThreadId: '',
      }),
    );
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('在工作区中打开');
  });

  it('renders relative report markdown links as thread artifact downloads', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownContent, {
        content: '[报告](gemini-report.md)',
        disableCommandPrefix: true,
        artifactThreadId: 'thread-1',
      }),
    );

    expect(html).toContain('/api/artifact-store/threads/thread-1/download-path');
    expect(html).toContain('path=gemini-report.md');
  });

  it('renders absolute AgentRoom report paths as thread artifact downloads', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownContent, {
        content: '报告路径 /Users/aidox/Documents/AgentRoom/profiles/opensource-6398/threads/thread-1/reports/report.md',
        disableCommandPrefix: true,
        artifactThreadId: 'thread-1',
      }),
    );

    expect(html).toContain('/api/artifact-store/threads/thread-1/download-path');
    expect(html).toContain('Documents%2FAgentRoom%2Fprofiles%2Fopensource-6398%2Fthreads%2Fthread-1%2Freports%2Freport.md');
  });

  it('renders file URI AgentRoom report links as downloads without leaking file scheme', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownContent, {
        content:
          '[magic-link-test.md](file:///Users/aidox/Documents/AgentRoom/profiles/opensource-6398/threads/thread-1/reports/magic-link-test.md)',
        disableCommandPrefix: true,
        artifactThreadId: 'thread-1',
      }),
    );

    expect(html).toContain('/api/artifact-store/threads/thread-1/download-path');
    expect(html).toContain(
      '%2FUsers%2Faidox%2FDocuments%2FAgentRoom%2Fprofiles%2Fopensource-6398%2Fthreads%2Fthread-1%2Freports%2Fmagic-link-test.md',
    );
    expect(html).not.toContain('path=file%3A');
  });

  it('renders artifact-store content links as download links', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownContent, {
        content: '[报告](http://localhost:3004/api/artifact-store/threads/thread-1/md-abc/content)',
        disableCommandPrefix: true,
        artifactThreadId: 'thread-1',
      }),
    );

    expect(html).toContain('/api/artifact-store/threads/thread-1/md-abc/download');
  });

  it('renders artifact deep links with threadId and artifactId as download links', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownContent, {
        content: '[报告](http://localhost:3003/thread/thread-1?workspace=artifacts&threadId=thread-1&artifactId=md-abc)',
        disableCommandPrefix: true,
        artifactThreadId: 'thread-1',
      }),
    );

    expect(html).toContain('/api/artifact-store/threads/thread-1/md-abc/download');
  });
});
