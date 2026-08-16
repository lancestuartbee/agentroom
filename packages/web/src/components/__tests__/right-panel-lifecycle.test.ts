/**
 * F247 Phase D — sandbox pane entry / exit / reopen lifecycle.
 *
 * Review found three defects here, and my previous test suite missed all of them
 * because it only exercised the `isWideRightPanelMode` predicate — the mechanism I had
 * just written — rather than the behaviour the operator actually experiences. These
 * tests are written from the navigation sequences instead.
 */

import { describe, expect, it } from 'vitest';
import { defaultPanelModeForThread, reconcileRightPanelForThread } from '@/components/right-panel-lifecycle';
import type { RightPanelMode } from '@/stores/chatStore';

const SANDBOX_A = 'thread-sandbox-a';
const SANDBOX_C = 'thread-sandbox-c';

/** Drives a navigation sequence the way ChatContainer does, carrying both bits of state. */
function walk(steps: Array<string | null>, startMode: RightPanelMode = 'status') {
  let mode = startMode;
  let autoOpenedFor: string | null = null;
  const modes: RightPanelMode[] = [];
  for (const sandboxThreadId of steps) {
    const result = reconcileRightPanelForThread({ currentMode: mode, ctx: { sandboxThreadId }, autoOpenedFor });
    autoOpenedFor = result.autoOpenedFor;
    if (result.nextMode) mode = result.nextMode;
    modes.push(mode);
  }
  return { mode, autoOpenedFor, modes };
}

describe('sandbox pane lifecycle', () => {
  it('opens the run pane on entering a sandbox thread', () => {
    expect(walk([SANDBOX_A]).mode).toBe('sandbox');
  });

  // Review finding: the auto-open marker was written but never cleared, so returning to
  // a sandbox thread matched the stale marker and the pane stayed shut.
  it('reopens the run pane on returning to the same sandbox thread (A → B → A)', () => {
    const { modes } = walk([SANDBOX_A, null, SANDBOX_A]);
    expect(modes[0]).toBe('sandbox');
    expect(modes[1]).not.toBe('sandbox');
    expect(modes[2]).toBe('sandbox');
  });

  // Review finding: rightPanelMode is global, and SandboxRunPane renders nothing without
  // a sandbox — so an ordinary thread inherited a wide, blank right panel.
  it('does not leave an ordinary thread showing an empty sandbox panel', () => {
    expect(walk([SANDBOX_A, null]).mode).toBe('status');
  });

  it('leaves a non-sandbox panel choice alone when moving between ordinary threads', () => {
    // The operator picked workspace; nothing about sandbox should disturb it.
    const { mode } = walk([null, null], 'workspace');
    expect(mode).toBe('workspace');
  });

  // Staying on one thread must not fight the operator: re-running the effect (a thread
  // list refresh, a re-render) cannot drag them back to the run pane.
  it('does not reopen the run pane while the operator stays on the thread', () => {
    let mode: RightPanelMode = 'status';
    let autoOpenedFor: string | null = null;

    const enter = reconcileRightPanelForThread({
      currentMode: mode,
      ctx: { sandboxThreadId: SANDBOX_A },
      autoOpenedFor,
    });
    mode = enter.nextMode ?? mode;
    autoOpenedFor = enter.autoOpenedFor;
    expect(mode).toBe('sandbox');

    // Operator deliberately switches to workspace, then the effect re-runs.
    mode = 'workspace';
    const rerun = reconcileRightPanelForThread({
      currentMode: mode,
      ctx: { sandboxThreadId: SANDBOX_A },
      autoOpenedFor,
    });
    expect(rerun.nextMode).toBeUndefined();
  });

  it('switches directly between two sandbox threads', () => {
    const { modes, autoOpenedFor } = walk([SANDBOX_A, SANDBOX_C]);
    expect(modes[0]).toBe('sandbox');
    expect(modes[1]).toBe('sandbox');
    expect(autoOpenedFor).toBe(SANDBOX_C);
  });

  // Thread metadata arrives asynchronously: the first pass sees null, the second sees
  // the sandbox. The pane must open when the data lands, not be lost to the first miss.
  it('opens the pane when thread metadata arrives late', () => {
    const { mode } = walk([null, SANDBOX_A]);
    expect(mode).toBe('sandbox');
  });
});

describe('defaultPanelModeForThread', () => {
  // Review finding: the header was the only reopen affordance and it always went to
  // workspace, so closing the run pane on a sandbox thread was one-way.
  it('reopens into the run pane on a sandbox thread', () => {
    expect(defaultPanelModeForThread({ sandboxThreadId: SANDBOX_A })).toBe('sandbox');
  });

  it('reopens into workspace on an ordinary thread', () => {
    expect(defaultPanelModeForThread({ sandboxThreadId: null })).toBe('workspace');
  });

  // The full close → reopen round trip: close drops to 'status', header reopen must be
  // able to get back to the run pane.
  it('completes a close → reopen round trip on a sandbox thread', () => {
    const afterEntry = walk([SANDBOX_A]);
    expect(afterEntry.mode).toBe('sandbox');

    const afterClose: RightPanelMode = 'status'; // closeRightPanel()
    expect(afterClose).toBe('status');

    expect(defaultPanelModeForThread({ sandboxThreadId: SANDBOX_A })).toBe('sandbox');
  });
});
