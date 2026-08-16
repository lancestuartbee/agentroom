/**
 * F247 Phase D — wiring test for the sandbox pane lifecycle.
 *
 * Review point: the pure reconciler tests prove the RULES are right, but nothing proved
 * the component actually calls them — delete the effect and every test stays green.
 * This drives the hook that holds the wiring, against a live store double, through the
 * three navigation paths review asked for.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Thread = { id: string; mode?: string; sandboxId?: string };

let rightPanelMode = 'status';
let threads: Thread[] = [];
const setRightPanelMode = (mode: string) => {
  rightPanelMode = mode;
};

// Minimal store double with the same selector shape the hook uses.
const state = () => ({ rightPanelMode, threads, setRightPanelMode });
const useChatStore = Object.assign((selector: (s: ReturnType<typeof state>) => unknown) => selector(state()), {
  getState: () => state(),
});

vi.mock('@/stores/chatStore', () => ({ useChatStore }));

const SANDBOX_A: Thread = { id: 'a', mode: 'sandbox', sandboxId: 'sandbox:sb-a' };
const SANDBOX_B: Thread = { id: 'b', mode: 'sandbox', sandboxId: 'sandbox:sb-b' };
const ORDINARY: Thread = { id: 'o', mode: 'development' };

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let lastReopenMode: (() => string) | null = null;

// Defined ONCE, at module scope. Declaring it inside the helper would create a new
// component type per call, so React would unmount and remount — resetting the very
// ref this suite exists to exercise. The real ChatContainer stays mounted across thread
// switches, and a helper that quietly remounts would make every persistence assertion
// pass for the wrong reason.
let Probe: (props: { id: string | null }) => null;

async function mountAt(threadId: string | null) {
  if (!Probe) {
    const { useSandboxPaneLifecycle } = await import('../useSandboxPaneLifecycle');
    Probe = ({ id }: { id: string | null }) => {
      const { reopenMode } = useSandboxPaneLifecycle(id);
      lastReopenMode = reopenMode as () => string;
      return null;
    };
  }
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(<Probe id={threadId} />);
  });
}

describe('useSandboxPaneLifecycle wiring', () => {
  beforeEach(() => {
    rightPanelMode = 'status';
    threads = [SANDBOX_A, SANDBOX_B, ORDINARY];
    root = null;
    container = null;
    lastReopenMode = null;
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    document.body.innerHTML = '';
  });

  it('opens the run pane on entering a sandbox thread', async () => {
    await mountAt('a');
    expect(rightPanelMode).toBe('sandbox');
  });

  it('drops sandbox mode when navigating to an ordinary thread', async () => {
    await mountAt('a');
    expect(rightPanelMode).toBe('sandbox');
    await mountAt('o');
    expect(rightPanelMode).toBe('status');
  });

  it('reopens the run pane on returning to the same sandbox thread (A → B → A)', async () => {
    await mountAt('a');
    await mountAt('o');
    expect(rightPanelMode).not.toBe('sandbox');
    await mountAt('a');
    expect(rightPanelMode).toBe('sandbox');
  });

  it('follows a direct sandbox → sandbox switch', async () => {
    await mountAt('a');
    await mountAt('b');
    expect(rightPanelMode).toBe('sandbox');
  });

  // Thread metadata arrives asynchronously; the first pass sees no sandbox binding.
  it('opens the pane once thread metadata arrives', async () => {
    threads = [];
    await mountAt('a');
    expect(rightPanelMode).toBe('status');

    threads = [SANDBOX_A];
    await mountAt('a');
    expect(rightPanelMode).toBe('sandbox');
  });

  // The header is the only reopen affordance; on a sandbox thread it must come back to
  // the run pane rather than workspace.
  it('exposes a thread-aware reopen mode', async () => {
    await mountAt('a');
    expect(lastReopenMode?.()).toBe('sandbox');

    await mountAt('o');
    expect(lastReopenMode?.()).toBe('workspace');
  });

  it('does not fight a deliberate panel switch while staying on the thread', async () => {
    await mountAt('a');
    rightPanelMode = 'workspace'; // operator switches away
    await mountAt('a'); // effect re-runs (re-render / thread list refresh)
    expect(rightPanelMode).toBe('workspace');
  });
});
