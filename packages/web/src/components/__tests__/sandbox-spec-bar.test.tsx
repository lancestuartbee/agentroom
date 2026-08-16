/**
 * F247 AC-D2/AC-D3 — the sandbox's current shape, at the top of the conversation it
 * belongs to.
 *
 * The dev pane is where a sandbox is shaped, and the only way to change it is to say so
 * in chat. Until now the operator was talking to something they could not see: no goal on
 * screen, no members, no schedule, no way to tell whether it was still running. This bar
 * is the referent the conversation is about — so the tests are about what an operator can
 * read off it and what they can do to it.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SANDBOX = {
  id: 'sandbox:sb-1',
  title: '股票模拟沙盘',
  projectPath: '/tmp/p',
  threadId: 'thread-1',
  createdBy: 'user-1',
  members: ['opus'],
  spec: {
    specVersion: '1',
    name: '股票模拟沙盘',
    goal: '盯住持仓的异动并给出处置建议',
    learningGoal: '积累出这些标的的异动模式',
    members: ['opus'],
    schedule: { cron: '0 9 * * *', prompt: '看一遍持仓', timezone: 'Asia/Shanghai' },
  },
  settings: { allowBackflow: false, autoStartSchedule: true, maxRunLogs: 100 },
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
};

let mockThreads: Array<Record<string, unknown>> = [];
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentThreadId: 'thread-1', threads: mockThreads }),
}));

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: '',
}));

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

async function render(): Promise<{ container: HTMLDivElement; root: Root }> {
  const { SandboxSpecBar } = await import('../SandboxSpecBar');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SandboxSpecBar threadId="thread-1" />);
  });
  return { container, root };
}

function click(container: HTMLElement, testId: string) {
  const btn = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  expect(btn, `no button ${testId}`).toBeTruthy();
  act(() => btn?.click());
}

describe('SandboxSpecBar', () => {
  let root: Root | null = null;

  beforeEach(() => {
    mockThreads = [{ id: 'thread-1', mode: 'sandbox', sandboxId: 'sandbox:sb-1' }];
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(() => Promise.resolve(jsonResponse({ sandbox: SANDBOX })));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.restoreAllMocks();
  });

  // The glance line carries what changes the operator's next sentence: what it is for,
  // when it fires, who runs it. It sits above every message, so the longer prose stays one
  // click away rather than pushing the conversation down the screen.
  it('shows the goal, schedule and members without being asked', async () => {
    const r = await render();
    root = r.root;
    expect(r.container.textContent).toContain('盯住持仓的异动并给出处置建议');
    expect(r.container.textContent).toContain('0 9 * * *');
    expect(r.container.textContent).toContain('Asia/Shanghai');
    expect(r.container.querySelector('[data-testid="spec-bar-members"]')?.textContent).toContain('opus');
  });

  it('keeps the learning goal and the run instruction one click away', async () => {
    const r = await render();
    root = r.root;
    expect(r.container.textContent).not.toContain('积累出这些标的的异动模式');
    click(r.container, 'spec-bar-toggle');
    expect(r.container.textContent).toContain('积累出这些标的的异动模式');
    expect(r.container.textContent).toContain('看一遍持仓');
  });

  // AC-D2: schedule state and the backflow switch belong where the operator is working,
  // not only inside a panel they may have closed.
  it('states the backflow switch rather than leaving it to be guessed', async () => {
    const r = await render();
    root = r.root;
    expect(r.container.querySelector('[data-testid="spec-bar-backflow"]')?.textContent).toContain('关闭');
  });

  it('says so plainly when there is no schedule at all', async () => {
    mockApiFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({ sandbox: { ...SANDBOX, spec: { ...SANDBOX.spec, schedule: undefined } } })),
    );
    const r = await render();
    root = r.root;
    expect(r.container.querySelector('[data-testid="spec-bar-schedule"]')?.textContent).toMatch(/手动|未设置/);
  });

  // An ordinary thread must not grow an empty bar.
  it('renders nothing for a thread with no sandbox', async () => {
    mockThreads = [{ id: 'thread-1', mode: 'development' }];
    const r = await render();
    root = r.root;
    expect(r.container.textContent).toBe('');
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  // The run pane already refuses to run a paused sandbox — without a control here that is
  // a dead end: paused with no way back.
  it('pauses and resumes through the status endpoint', async () => {
    const r = await render();
    root = r.root;

    mockApiFetch.mockClear();
    mockApiFetch.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') return Promise.resolve(jsonResponse({ sandbox: { ...SANDBOX, status: 'paused' } }));
      return Promise.resolve(jsonResponse({ sandbox: { ...SANDBOX, status: 'paused' } }));
    });
    click(r.container, 'spec-bar-pause');
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });

    const [url, init] = mockApiFetch.mock.calls[0];
    expect(url).toContain('/status');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ status: 'paused' });
    expect(r.container.querySelector('[data-testid="spec-bar-resume"]')).toBeTruthy();
  });

  // A bar that silently shows nothing is indistinguishable from "no sandbox" — which is
  // the exact confusion this whole feature keeps having to design against.
  it('does not go blank when the sandbox cannot be read', async () => {
    mockApiFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
    const r = await render();
    root = r.root;
    expect(r.container.querySelector('[data-testid="spec-bar-error"]')).toBeTruthy();
  });

  // Review: reading the globally-current thread let the bar describe one sandbox while its
  // buttons acted on another. It now follows the thread the parent is rendering, so a
  // global that has already moved on cannot pull it away.
  it('follows the thread it was given, not whatever is globally current', async () => {
    mockThreads = [
      { id: 'thread-1', mode: 'sandbox', sandboxId: 'sandbox:sb-1' },
      { id: 'thread-2', mode: 'sandbox', sandboxId: 'sandbox:sb-2' },
    ];
    const { SandboxSpecBar } = await import('../SandboxSpecBar');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = createRoot(container);
    root = r;
    await act(async () => {
      r.render(<SandboxSpecBar threadId="thread-2" />);
    });

    expect(mockApiFetch.mock.calls[0][0]).toContain('sb-2');
  });

  // Twice in this feature I have written a component that worked and was never mounted,
  // and the suite could not tell. A component that renders itself away when irrelevant
  // needs no mode branch at the call site — but it does need the call site to exist.
  it('is actually mounted in the chat area', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ChatContainer.tsx'), 'utf8');
    expect(src).toMatch(/<SandboxSpecBar threadId=\{threadId\} \/>/);
    expect(src).toMatch(/import \{ SandboxSpecBar \}/);
  });
});
