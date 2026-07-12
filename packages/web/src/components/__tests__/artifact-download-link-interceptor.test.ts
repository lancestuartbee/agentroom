import { describe, expect, it } from 'vitest';
import { resolveArtifactDownloadApiPathForHref } from '@/components/ArtifactDownloadLinkInterceptor';

describe('ArtifactDownloadLinkInterceptor href resolver', () => {
  const baseUrl = 'http://localhost:3003/thread/thread_mrhzx4ueucwdg861';

  it('resolves root-local AgentRoom report links that would otherwise route to Next 404', () => {
    const apiPath = resolveArtifactDownloadApiPathForHref(
      '/Users/aidox/Documents/AgentRoom/profiles/default-6398/threads/thread_mrhzx4ueucwdg861/reports/烁烁_test.md',
      'wrong-current-thread',
      baseUrl,
    );

    expect(apiPath).toContain('/api/artifact-store/threads/thread_mrhzx4ueucwdg861/download-path');
    expect(apiPath).toContain('%E7%83%81%E7%83%81_test.md');
    expect(apiPath).not.toContain('wrong-current-thread');
  });

  it('resolves browser-normalized same-origin AgentRoom report links', () => {
    const apiPath = resolveArtifactDownloadApiPathForHref(
      'http://localhost:3003/Users/aidox/Documents/AgentRoom/profiles/default-6398/threads/thread_mrhzx4ueucwdg861/reports/%E7%83%81%E7%83%81_test.md',
      undefined,
      baseUrl,
    );

    expect(apiPath).toContain('/api/artifact-store/threads/thread_mrhzx4ueucwdg861/download-path');
    expect(apiPath).toContain('%E7%83%81%E7%83%81_test.md');
    expect(apiPath).not.toContain('%25E7%2583%2581%25E7%2583%2581_test.md');
  });

  it('resolves file URI AgentRoom report links', () => {
    const apiPath = resolveArtifactDownloadApiPathForHref(
      'file:///Users/aidox/Documents/AgentRoom/profiles/default-6398/threads/thread_mrhzx4ueucwdg861/reports/report.md',
      undefined,
      baseUrl,
    );

    expect(apiPath).toContain('/api/artifact-store/threads/thread_mrhzx4ueucwdg861/download-path');
    expect(apiPath).toContain('%2FUsers%2Faidox%2FDocuments%2FAgentRoom');
  });

  it('leaves unrelated links alone', () => {
    expect(resolveArtifactDownloadApiPathForHref('https://example.com/report.md', 'thread-1', baseUrl)).toBeNull();
    expect(resolveArtifactDownloadApiPathForHref('/thread/thread-1', 'thread-1', baseUrl)).toBeNull();
  });
});
