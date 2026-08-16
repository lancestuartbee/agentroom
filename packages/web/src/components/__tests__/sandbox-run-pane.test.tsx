/**
 * F247 Phase D — SandboxRunPane regression tests.
 *
 * The pane is the operator's only window into what the sandbox did while nobody was
 * watching, so the states it must never confuse are exactly the ones the backend spent
 * its whole review cycle keeping apart: "never ran" vs "cannot read the history".
 */

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
    goal: 'g',
    members: ['opus'],
    schedule: { cron: '0 9 * * *', prompt: 'r', timezone: 'Asia/Shanghai' },
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
  const { SandboxRunPane } = await import('../SandboxRunPane');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SandboxRunPane />);
  });
  return { container, root };
}

describe('SandboxRunPane', () => {
  beforeEach(() => {
    mockThreads = [{ id: 'thread-1', mode: 'sandbox', sandboxId: 'sandbox:sb-1' }];
    mockApiFetch.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('shows schedule, accumulated knowledge and newest-first run history', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        sandbox: SANDBOX,
        memory: {
          v: 1,
          summary: 's',
          runsIncorporated: 12,
          learnedItems: [{ id: 'l1', content: '低换手率+放量突破是较强信号', sourceRunAt: 1, promoted: false }],
          updatedAt: 1,
        },
        runs: [
          { v: 1, runId: 'r2', trigger: 'manual', triggeredAt: 2000, specVersion: '1', summary: '第二天复盘' },
          { v: 1, runId: 'r1', trigger: 'scheduled', triggeredAt: 1000, specVersion: '1', summary: '第一天复盘' },
        ],
        runsAvailable: true,
      }),
    );

    const { container, root } = await render();
    const text = container.textContent ?? '';

    expect(text).toContain('0 9 * * *');
    expect(text).toContain('Asia/Shanghai');
    expect(text).toContain('已纳入 12 次运行');
    expect(text).toContain('低换手率+放量突破是较强信号');
    // Newest first: the second day must appear before the first.
    expect(text.indexOf('第二天复盘')).toBeLessThan(text.indexOf('第一天复盘'));

    await act(async () => root.unmount());
  });

  // The whole point of the backend throwing instead of returning [] — the operator must
  // never read a disk fault as "this sandbox has never run".
  it('distinguishes an unreadable history from a sandbox that never ran', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        sandbox: SANDBOX,
        memory: null,
        runs: [],
        runsAvailable: false,
        runsError: 'Run history is temporarily unreadable',
      }),
    );

    const { container, root } = await render();
    expect(container.querySelector('[data-testid="sandbox-runs-unavailable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sandbox-runs-empty"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it('says a sandbox has never run when it genuinely has not', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ sandbox: SANDBOX, memory: null, runs: [], runsAvailable: true }));

    const { container, root } = await render();
    expect(container.querySelector('[data-testid="sandbox-runs-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sandbox-runs-unavailable"]')).toBeNull();

    await act(async () => root.unmount());
  });

  // Dispatch is fire-and-forget: claiming the run "finished" would be a lie the whole
  // backend design goes out of its way not to tell.
  it('reports a manual trigger as dispatched, not as completed', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 202, json: async () => ({}) });
      return Promise.resolve(jsonResponse({ sandbox: SANDBOX, memory: null, runs: [], runsAvailable: true }));
    });

    const { container, root } = await render();
    const button = container.querySelector('[data-testid="sandbox-run-now"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => {
      button.click();
    });

    const note = container.querySelector('[data-testid="sandbox-trigger-note"]')?.textContent ?? '';
    expect(note).toContain('已触发');
    expect(note).not.toContain('完成');

    await act(async () => root.unmount());
  });

  it('disables running while the sandbox is paused', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        sandbox: { ...SANDBOX, status: 'paused' },
        memory: null,
        runs: [],
        runsAvailable: true,
      }),
    );

    const { container, root } = await render();
    const button = container.querySelector('[data-testid="sandbox-run-now"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await act(async () => root.unmount());
  });

  it('renders nothing for a thread that is not bound to a sandbox', async () => {
    mockThreads = [{ id: 'thread-1', mode: 'development' }];
    const { container, root } = await render();
    expect(container.textContent).toBe('');
    expect(mockApiFetch).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
