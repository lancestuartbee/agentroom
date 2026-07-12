import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: '用户',
    aliases: [],
    mentionPatterns: [],
    avatar: null,
    color: { primary: '#B76E4C', secondary: '#F8D7C6' },
  }),
}));

vi.mock('@/stores/chatStore', async () => {
  const actual = await vi.importActual<typeof import('@/stores/chatStore')>('@/stores/chatStore');
  return {
    ...actual,
    useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        currentThreadId: 'wrong-current-thread',
        isLoadingThreads: false,
        threads: [],
        messages: [],
        globalBubbleDefaults: { thinking: 'collapsed', cli: 'collapsed' },
      }),
  };
});

describe('ChatMessage artifact links', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('uses the message list threadId for bare AgentRoom report paths with Chinese filenames', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const threadId = 'thread_mrhzx4ueucwdg861';
    const message = {
      id: 'artifact-msg-1',
      type: 'assistant',
      catId: 'gemini',
      content:
        '文件保存在这里：\n/Users/aidox/Documents/AgentRoom/profiles/default-6398/threads/thread_mrhzx4ueucwdg861/reports/烁烁_test.md',
      timestamp: Date.now(),
      contentBlocks: [],
      isStreaming: false,
    };

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: message as never,
          threadId,
          getCatById: (() => undefined) as never,
        }),
      );
    });

    const link = container.querySelector('a[href*="/api/artifact-store/threads/thread_mrhzx4ueucwdg861/download-path"]');
    expect(link?.getAttribute('href')).toContain('%E7%83%81%E7%83%81_test.md');
    expect(link?.textContent).toContain('下载');
    expect(container.innerHTML).not.toContain('/api/artifact-store/threads/wrong-current-thread/download-path');
  });

  it('uses the message list threadId for markdown artifact links inside stream stdout', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const threadId = 'thread_mrhzx4ueucwdg861';
    const message = {
      id: 'artifact-stream-msg-1',
      type: 'assistant',
      catId: 'gpt',
      origin: 'stream',
      content:
        '已生成测试文件：[下载报告](/Users/aidox/Documents/AgentRoom/profiles/default-6398/threads/thread_mrhzx4ueucwdg861/reports/烁烁_test.md)',
      timestamp: Date.now(),
      contentBlocks: [],
      toolEvents: [],
      isStreaming: true,
    };

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: message as never,
          threadId,
          getCatById: (() => undefined) as never,
        }),
      );
    });

    const link = container.querySelector('a[href*="/api/artifact-store/threads/thread_mrhzx4ueucwdg861/download-path"]');
    expect(link?.getAttribute('href')).toContain('%E7%83%81%E7%83%81_test.md');
    expect(link?.textContent).toContain('下载');
    expect(link?.getAttribute('href')).not.toContain('/Users/aidox/Documents/AgentRoom');
    expect(container.innerHTML).not.toContain('/api/artifact-store/threads/wrong-current-thread/download-path');
  });
});
