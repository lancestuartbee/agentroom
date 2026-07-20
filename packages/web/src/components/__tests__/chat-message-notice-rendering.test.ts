import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      threads: [],
    }),
}));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));
vi.mock('@/components/SystemNoticeBar', () => ({
  SystemNoticeBar: ({ message }: { message: ChatMessageType }) =>
    React.createElement('div', { 'data-testid': 'notice-bar' }, `${message.source?.connector}:${message.content}`),
}));
vi.mock('@/components/ConnectorBubble', () => ({
  ConnectorBubble: ({ message }: { message: ChatMessageType }) =>
    React.createElement(
      'div',
      { 'data-testid': 'connector-bubble' },
      `${message.source?.connector}:${message.source?.label}:${message.content}`,
    ),
}));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));

describe('ChatMessage notice rendering', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ChatMessage: React.FC<{ message: ChatMessageType; getCatById: (id: string) => CatData | undefined }>;
  let parseRoundtableContent: typeof import('@/components/ChatMessage').parseRoundtableContent;
  let roundtableMetaLabel: typeof import('@/components/ChatMessage').roundtableMetaLabel;
  let roundtableSectionRole: typeof import('@/components/ChatMessage').roundtableSectionRole;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const mod = await import('@/components/ChatMessage');
    ChatMessage = mod.ChatMessage;
    parseRoundtableContent = mod.parseRoundtableContent;
    roundtableMetaLabel = mod.roundtableMetaLabel;
    roundtableSectionRole = mod.roundtableSectionRole;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders inline mention hint as in-thread notice bar instead of connector bubble', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'notice-inline',
            type: 'connector',
            content: '把 @gpt52 单独放到新起一行开头，才能交接。',
            timestamp: Date.now(),
            source: {
              connector: 'inline-mention-hint',
              label: 'Routing hint',
              icon: 'lightbulb',
              meta: { presentation: 'system_notice', noticeTone: 'info' },
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="notice-bar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="connector-bubble"]')).toBeFalsy();
  });

  it('renders restart interruption notice as in-thread notice bar instead of connector bubble', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'notice-restart',
            type: 'connector',
            content: '服务重启，opus 的进行中请求已中断，请重新发送。',
            timestamp: Date.now(),
            source: {
              connector: 'startup-reconciler',
              label: '⚠️ 重启通知',
              icon: '⚠️',
              meta: { presentation: 'system_notice', noticeTone: 'warning' },
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="notice-bar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="connector-bubble"]')).toBeFalsy();
  });

  it('keeps true connector events on ConnectorBubble path', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'connector-vote',
            type: 'connector',
            content: '投票结果：2 票',
            timestamp: Date.now(),
            source: {
              connector: 'vote-result',
              label: '投票结果',
              icon: 'ballot',
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="connector-bubble"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="notice-bar"]')).toBeFalsy();
  });

  it('renders upgrade background system messages through markdown card path', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'upgrade-bg',
            type: 'system',
            catId: null,
            content: '# 升级背景\n由闲聊会话升级为圆桌会议。',
            timestamp: Date.now(),
            extra: { systemKind: 'upgrade_background' },
          } as unknown as ChatMessageType,
        }),
      );
    });

    expect(container.querySelector('[data-testid="notice-bar"]')).toBeFalsy();
    expect(container.textContent).toContain('升级背景');
    expect(container.textContent).toContain('由闲聊会话升级为圆桌会议');
  });

  it('parses roundtable response metadata and markdown sections for structured rendering', () => {
    const parsed = parseRoundtableContent(
      [
        'CHANGE: yes',
        'NEW_CHALLENGE: no',
        'READY_TO_VOTE: no',
        'BLOCKER: yes',
        '',
        '## 收到的挑战与回应',
        '我接受其中一个风险点。',
        '',
        '## 我仍然反对的论点',
        '证据还不够。',
      ].join('\n'),
    );

    expect(parsed?.meta).toEqual(['CHANGE: yes', 'NEW_CHALLENGE: no', 'READY_TO_VOTE: no', 'BLOCKER: yes']);
    expect(parsed?.sections.map((section) => section.title)).toEqual(['收到的挑战与回应', '我仍然反对的论点']);
    expect(parsed?.sections[0]?.body).toContain('风险点');
    expect(roundtableMetaLabel('READY_TO_VOTE: no')).toBe('准备投票: no');
    expect(roundtableMetaLabel('BLOCKER: yes')).toBe('仍有阻塞: yes');
    expect(roundtableMetaLabel('VOTE: accept_with_conditions')).toBe('投票: accept_with_conditions');
    expect(roundtableSectionRole('当前立场')).toBe('claim');
    expect(roundtableSectionRole('我仍然反对的论点')).toBe('challenge');
  });

  it('parses localized roundtable metadata and bold labels used by looser models', () => {
    const parsed = parseRoundtableContent(
      [
        '立场变化：否',
        '新挑战：无',
        '准备投票：是',
        '仍有阻塞：否',
        '',
        '**立场修订**：我维持默认请假，但接受把交接降级为一页纸。',
        '',
        '**对 缅因猫 挑战的回应**：',
        '我接受时间盒熔断。',
      ].join('\n'),
    );

    expect(parsed?.meta).toEqual(['CHANGE: no', 'NEW_CHALLENGE: no', 'READY_TO_VOTE: yes', 'BLOCKER: no']);
    expect(parsed?.sections.map((section) => section.title)).toEqual(['立场修订', '对 缅因猫 挑战的回应']);
    expect(parsed?.sections[0]?.body).toContain('我维持默认请假');
  });

  it('infers roundtable metadata when critique responses omit control lines', () => {
    const parsed = parseRoundtableContent(
      [
        '**立场修订**：接受对方批评，我修正为最小可用交接。',
        '',
        '**新的挑战**：',
        '对狸花猫：仍有一个证据不足的问题。',
        '',
        '**仍未消除的不确定性**：会议是否可延期。',
      ].join('\n'),
    );

    expect(parsed?.meta).toContain('CHANGE: yes');
    expect(parsed?.meta).toContain('NEW_CHALLENGE: yes');
    expect(parsed?.meta).toContain('BLOCKER: yes');
    expect(parsed?.sections.map((section) => section.title)).toContain('立场修订');
  });
});
