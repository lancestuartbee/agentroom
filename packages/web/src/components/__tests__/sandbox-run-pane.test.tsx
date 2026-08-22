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

/** A response that resolves only when told to — controlling the ORDER is the whole point. */
function deferred() {
  let release: (value: unknown) => void = () => {};
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function render(): Promise<{ container: HTMLDivElement; root: Root }> {
  const { SandboxRunPane } = await import('../SandboxRunPane');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SandboxRunPane threadId="thread-1" />);
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

/**
 * The identity SOURCE, not the response race.
 *
 * ChatContainer syncs the thread it is rendering into the store from an effect, so during
 * the render/effect window after a switch the global `currentThreadId` still says A while
 * the parent is already rendering B. A pane that derives its sandbox from the global reads
 * the wrong one — and worse, "立即运行" fires a POST at A. The response guard in
 * useSandboxResource cannot help: the request was aimed wrong before it was sent.
 */
describe('SandboxRunPane follows the thread it was given', () => {
  beforeEach(() => {
    // The global still points at A — exactly the window the effect has not closed yet.
    mockThreads = [
      { id: 'thread-1', mode: 'sandbox', sandboxId: 'sandbox:sb-A' },
      { id: 'thread-2', mode: 'sandbox', sandboxId: 'sandbox:sb-B' },
    ];
    mockApiFetch.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  async function renderFor(threadId: string) {
    const { SandboxRunPane } = await import('../SandboxRunPane');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SandboxRunPane threadId={threadId} />);
    });
    return { container, root };
  }

  it('reads the sandbox of the prop thread, not the globally current one', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ sandbox: SANDBOX, memory: null, runs: [], runsAvailable: true }));
    const { root } = await renderFor('thread-2');

    expect(mockApiFetch.mock.calls[0][0]).toContain('sb-B');
    await act(async () => root.unmount());
  });

  it('never fires "run now" at the sandbox the operator has already left', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ sandbox: SANDBOX, memory: null, runs: [], runsAvailable: true }));
    const { container, root } = await renderFor('thread-2');

    mockApiFetch.mockClear();
    const runBtn = container.querySelector('[data-testid="sandbox-run-now"]') as HTMLButtonElement;
    expect(runBtn).toBeTruthy();
    await act(async () => {
      runBtn.click();
    });

    const posted = mockApiFetch.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'POST');
    expect(posted, 'run-now must have been dispatched').toBeTruthy();
    expect(posted?.[0]).toContain('sb-B');
    expect(posted?.[0]).not.toContain('sb-A');

    await act(async () => root.unmount());
  });

  // Review: clearing the note on switch only clears the value that exists AT the switch.
  // A POST still in flight resurrects it afterwards — B's panel then reports a run that
  // happened to A. The source fix cannot reach this; the callback has to check for itself.
  it("does not resurrect A's trigger note after the operator has moved to B", async () => {
    const slowPost = deferred();
    mockApiFetch.mockImplementation((_path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return slowPost.promise;
      return Promise.resolve(jsonResponse({ sandbox: SANDBOX, memory: null, runs: [], runsAvailable: true }));
    });

    const { SandboxRunPane } = await import('../SandboxRunPane');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SandboxRunPane threadId="thread-1" />);
    });

    const runBtn = container.querySelector('[data-testid="sandbox-run-now"]') as HTMLButtonElement;
    act(() => {
      runBtn.click();
    });

    // Operator leaves while the trigger is still in flight.
    await act(async () => {
      root.render(<SandboxRunPane threadId="thread-2" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      slowPost.release({ ok: true, status: 202, json: async () => ({}) });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Assert B's pane is actually rendered, or "no note" would pass vacuously on a
    // still-loading panel — a green test proving nothing.
    expect(container.querySelector('[data-testid="sandbox-run-now"]'), "B's pane must be rendered").toBeTruthy();
    expect(container.querySelector('[data-testid="sandbox-trigger-note"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("does not report A's trigger failure on B either", async () => {
    const slowPost = deferred();
    mockApiFetch.mockImplementation((_path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return slowPost.promise;
      return Promise.resolve(jsonResponse({ sandbox: SANDBOX, memory: null, runs: [], runsAvailable: true }));
    });

    const { SandboxRunPane } = await import('../SandboxRunPane');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SandboxRunPane threadId="thread-1" />);
    });
    act(() => {
      (container.querySelector('[data-testid="sandbox-run-now"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      root.render(<SandboxRunPane threadId="thread-2" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      slowPost.release({ ok: false, status: 500, json: async () => ({ error: 'A 触发失败' }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('A 触发失败');
    await act(async () => root.unmount());
  });

  // A 200 the pane cannot read is not "still loading" — saying so leaves the operator
  // waiting forever for data that will never take that shape.
  it('calls a malformed response unreadable instead of pretending to still be loading', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({}));
    const { root } = await renderFor('thread-2');

    const container = document.body.lastElementChild as HTMLElement;
    expect(container.querySelector('[data-testid="sandbox-run-pane-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="sandbox-run-pane-error"]')).toBeTruthy();

    await act(async () => root.unmount());
  });

  // A trigger note is about one sandbox's run. Carrying it across a switch tells the
  // operator something about B that only ever happened to A.
  it("drops the previous sandbox's trigger note when the thread changes", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ sandbox: SANDBOX, memory: null, runs: [], runsAvailable: true }));
    const { SandboxRunPane } = await import('../SandboxRunPane');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SandboxRunPane threadId="thread-1" />);
    });

    const runBtn = container.querySelector('[data-testid="sandbox-run-now"]') as HTMLButtonElement;
    await act(async () => {
      runBtn.click();
    });
    expect(container.querySelector('[data-testid="sandbox-trigger-note"]')).toBeTruthy();

    await act(async () => {
      root.render(<SandboxRunPane threadId="thread-2" />);
    });
    expect(container.querySelector('[data-testid="sandbox-trigger-note"]')).toBeNull();

    await act(async () => root.unmount());
  });
});

describe('SandboxRunPane stale state', () => {
  beforeEach(() => {
    mockThreads = [{ id: 'thread-1', mode: 'sandbox', sandboxId: 'sandbox:sb-1' }];
    mockApiFetch.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  // Review finding (luna P2): after one successful load, a failed poll only set `error`,
  // which was rendered solely when there was no state at all. So stale runs kept looking
  // current — the same "looks fine, is silently wrong" shape this feature keeps hitting.
  //
  // Drives the REAL poll on the same mounted component; remounting would reset state and
  // never reach the stale branch, which is exactly the kind of test that passes without
  // proving anything.
  it('marks the view as stale when a later poll fails, keeping the last good data', async () => {
    let call = 0;
    mockApiFetch.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          jsonResponse({
            sandbox: SANDBOX,
            memory: null,
            runs: [
              {
                v: 1,
                runId: 'r1',
                trigger: 'scheduled',
                triggeredAt: 1000,
                specVersion: '1',
                summary: '上次成功读到的运行',
              },
            ],
            runsAvailable: true,
          }),
        );
      }
      return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    });

    const { container, root } = await render();
    expect(container.querySelector('[data-testid="sandbox-stale-banner"]')).toBeNull();
    expect(container.textContent).toContain('上次成功读到的运行');

    // Advance past the poll interval so the SAME instance re-fetches and fails.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(call).toBeGreaterThan(1);
    expect(container.querySelector('[data-testid="sandbox-stale-banner"]')).not.toBeNull();
    // The last good snapshot must remain — an empty pane would be worse than a stale one.
    expect(container.textContent).toContain('上次成功读到的运行');

    await act(async () => root.unmount());
  });
});

describe('SandboxRunPane promote learning', () => {
  beforeEach(() => {
    mockThreads = [{ id: 'thread-1', mode: 'sandbox', sandboxId: 'sandbox:sb-1' }];
    mockApiFetch.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('does not offer promote when allowBackflow is false', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        sandbox: SANDBOX,
        memory: {
          v: 1,
          summary: 's',
          runsIncorporated: 1,
          learnedItems: [{ id: 'l1', content: 'A', sourceRunAt: 1, promoted: false }],
          updatedAt: 1,
        },
        runs: [],
        runsAvailable: true,
      }),
    );

    const { container, root } = await render();
    expect(container.querySelector('[data-testid="sandbox-promote-l1"]')).toBeNull();
    expect(container.textContent).toContain('学习成果回流：关闭');

    await act(async () => root.unmount());
  });

  it('shows promote buttons and calls the API when clicked', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && path.includes('/learned-items/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ item: { id: 'l1', content: 'A', promoted: true }, evidenceAnchor: 'ev-1' }),
        });
      }
      return Promise.resolve(
        jsonResponse({
          sandbox: { ...SANDBOX, settings: { ...SANDBOX.settings, allowBackflow: true } },
          memory: {
            v: 1,
            summary: 's',
            runsIncorporated: 1,
            learnedItems: [{ id: 'l1', content: 'A', sourceRunAt: 1, promoted: false }],
            updatedAt: 1,
          },
          runs: [],
          runsAvailable: true,
        }),
      );
    });

    const { container, root } = await render();
    expect(container.textContent).toContain('学习成果回流：开启');

    const button = container.querySelector('[data-testid="sandbox-promote-l1"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain('提升为系统知识');

    await act(async () => {
      button.click();
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/sandboxes/sandbox%3Asb-1/learned-items/l1/promote'),
      expect.objectContaining({ method: 'POST' }),
    );

    await act(async () => root.unmount());
  });

  // A POST still in flight can outlive the thread switch. The response must not paint
  // A's outcome onto B, and the success branch must not call A's load() closure.
  it("does not resurrect A's promote note after the operator has moved to B", async () => {
    const slowPost = deferred();
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && path.includes('/learned-items/')) {
        return slowPost.promise as Promise<Response>;
      }
      return Promise.resolve(
        jsonResponse({
          sandbox: { ...SANDBOX, settings: { ...SANDBOX.settings, allowBackflow: true } },
          memory: {
            v: 1,
            summary: 's',
            runsIncorporated: 1,
            learnedItems: [{ id: 'l1', content: 'A', sourceRunAt: 1, promoted: false }],
            updatedAt: 1,
          },
          runs: [],
          runsAvailable: true,
        }),
      );
    });

    mockThreads = [
      { id: 'thread-1', mode: 'sandbox', sandboxId: 'sandbox:sb-1' },
      { id: 'thread-2', mode: 'sandbox', sandboxId: 'sandbox:sb-2' },
    ];

    const { SandboxRunPane } = await import('../SandboxRunPane');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SandboxRunPane threadId="thread-1" />);
    });

    const button = container.querySelector('[data-testid="sandbox-promote-l1"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('提升中');

    await act(async () => {
      root.render(<SandboxRunPane threadId="thread-2" />);
    });
    expect(container.querySelector('[data-testid="sandbox-promote-note"]')).toBeNull();
    // B must have actually rendered, not still be loading or in an error state that would
    // make the "no A note" assertion trivially true.
    expect(container.querySelector('[data-testid="sandbox-status"]')).not.toBeNull();

    // Capture calls after B has mounted and loaded.
    mockApiFetch.mockClear();

    await act(async () => {
      slowPost.release({
        ok: true,
        status: 200,
        json: async () => ({ item: { id: 'l1', content: 'A', promoted: true }, evidenceAnchor: 'ev-1' }),
      });
    });

    expect(container.querySelector('[data-testid="sandbox-promote-note"]')).toBeNull();
    // A's late response must not trigger a reload of A's runtime now that B is rendered.
    expect(mockApiFetch.mock.calls.some((call) => (call[0] as string).includes('sandbox%3Asb-1'))).toBe(false);

    await act(async () => root.unmount());
  });
});
