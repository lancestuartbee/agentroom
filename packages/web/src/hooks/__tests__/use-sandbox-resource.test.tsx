/**
 * F247 — the cross-thread identity race review found in SandboxSpecBar.
 *
 * Written from the operator's sequence, not from the guard's implementation: open sandbox
 * A, switch to B before A's response arrives, let A land late. The panel must never show
 * A's data while it is B's panel — its buttons act on B.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: '',
}));

let seen: {
  data: unknown;
  error: string | null;
  isStale: boolean;
  reload: () => Promise<void>;
  apply: (data: { name: string }) => void;
  isCurrent: (id: string | undefined) => boolean;
} | null = null;

const buildPath = (sid: string) => `/api/sandboxes/${sid}`;

async function mount(sandboxId: string | undefined): Promise<{ root: Root; rerender: (id?: string) => Promise<void> }> {
  const { useSandboxResource } = await import('../useSandboxResource');
  function Probe({ id }: { id: string | undefined }) {
    seen = useSandboxResource<{ name: string }>(id, buildPath, { errorMessage: '读不到' });
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe id={sandboxId} />);
  });
  return {
    root,
    rerender: async (id?: string) => {
      await act(async () => {
        root.render(<Probe id={id} />);
      });
    },
  };
}

/** A response that resolves only when told to — the whole point is controlling the order. */
function deferred() {
  let release: (value: unknown) => void = () => {};
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('useSandboxResource', () => {
  let root: Root | null = null;

  beforeEach(() => {
    seen = null;
    mockApiFetch.mockReset();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.restoreAllMocks();
  });

  it('loads the sandbox it was asked for', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ name: 'A' }) });
    const m = await mount('sbx-a');
    root = m.root;
    await act(async () => {
      await Promise.resolve();
    });
    expect(seen?.data).toEqual({ name: 'A' });
  });

  // The defect: A's response resolving after the switch used to be written into state.
  it('drops a response that arrives after the operator moved to another sandbox', async () => {
    const slowA = deferred();
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('sbx-a')) return slowA.promise;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ name: 'B' }) });
    });

    const m = await mount('sbx-a');
    root = m.root;
    await m.rerender('sbx-b');
    expect(seen?.data).toEqual({ name: 'B' });

    await act(async () => {
      slowA.release({ ok: true, status: 200, json: async () => ({ name: 'A' }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(seen?.data, "A's late response must not overwrite B").toEqual({ name: 'B' });
  });

  // Showing nothing for a tick is honest; showing the previous sandbox is not.
  it('shows nothing rather than the previous sandbox while the new one loads', async () => {
    const slowB = deferred();
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('sbx-b')) return slowB.promise;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ name: 'A' }) });
    });

    const m = await mount('sbx-a');
    root = m.root;
    await act(async () => {
      await Promise.resolve();
    });
    expect(seen?.data).toEqual({ name: 'A' });

    await m.rerender('sbx-b');
    expect(seen?.data).toBeNull();
    slowB.release({ ok: true, status: 200, json: async () => ({ name: 'B' }) });
  });

  it('reports a failed read but keeps the last good snapshot visible as stale', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ name: 'A' }) });
    const m = await mount('sbx-a');
    root = m.root;
    await act(async () => {
      await Promise.resolve();
    });

    mockApiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await act(async () => {
      await seen?.reload();
    });

    expect(seen?.data).toEqual({ name: 'A' });
    expect(seen?.isStale).toBe(true);
  });

  it('does not fetch at all without a sandbox id', async () => {
    const m = await mount(undefined);
    root = m.root;
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(seen?.data).toBeNull();
  });

  // Review: the response guard protects the DATA, but a mutation's own callback writes
  // caller-local state (a trigger note, an error, a busy flag) that no data guard can see.
  // `isCurrent` is what a caller checks before touching that state after an await.
  it('tells a caller whether the sandbox it started on is still the current one', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ name: 'A' }) });
    const m = await mount('sbx-a');
    root = m.root;
    await act(async () => {
      await Promise.resolve();
    });
    expect(seen?.isCurrent('sbx-a')).toBe(true);

    await m.rerender('sbx-b');
    expect(seen?.isCurrent('sbx-a'), 'a mutation started on A must know it is stale').toBe(false);
    expect(seen?.isCurrent('sbx-b')).toBe(true);
  });

  it('reports nothing as current once there is no sandbox at all', async () => {
    const m = await mount(undefined);
    root = m.root;
    expect(seen?.isCurrent('sbx-a')).toBe(false);
    expect(seen?.isCurrent(undefined)).toBe(false);
  });

  // A mutation reply is fresher than the next poll; it must also be identity-checked.
  it('accepts a payload applied from a mutation reply', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ name: 'A' }) });
    const m = await mount('sbx-a');
    root = m.root;
    await act(async () => {
      await Promise.resolve();
    });
    act(() => seen?.apply({ name: 'A-paused' }));
    expect(seen?.data).toEqual({ name: 'A-paused' });
  });
});
