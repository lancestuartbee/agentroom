import type { RightPanelMode } from '@/stores/chatStore';

/**
 * F247 Phase D — thread-scoped right-panel lifecycle.
 *
 * `rightPanelMode` is GLOBAL, but "which panel belongs to this thread" is thread-scoped,
 * and ChatContainer stays mounted across thread switches by design. Bolting the sandbox
 * pane onto the global field without reconciling that produced three separate defects
 * (review found all three): the pane could not be reopened after closing, an A → B → A
 * navigation never reopened it, and leaving a sandbox thread left a wide-but-empty
 * panel behind.
 *
 * These are one bug — the panel was never reconciled against the current thread — so
 * the decision lives in one place here rather than as conditions sprinkled through the
 * component. Pure functions, so the lifecycle is testable without mounting the tree.
 */

/**
 * True for modes that occupy the WIDE right panel rather than the narrow status rail.
 *
 * Every wide mode has to be listed in three places at once — the auto-open effect, the
 * close handler, and the chat-column flex basis — and F247 shipped a mode that was only
 * added to one of them: the pane could be opened but never closed, because closing set
 * statusPanelOpen=false and the auto-open effect immediately undid it. One predicate, so
 * the next mode cannot be half-registered.
 */
export function isWideRightPanelMode(mode: RightPanelMode): boolean {
  return mode !== 'status';
}

export interface PanelThreadContext {
  /** null when the thread has no sandbox bound (ordinary thread, or not loaded yet). */
  sandboxThreadId: string | null;
}

/** The panel a thread should show when the operator opens the right panel afresh. */
export function defaultPanelModeForThread(ctx: PanelThreadContext): RightPanelMode {
  // A sandbox thread's right half IS the run pane; reopening into workspace would strand
  // the operator with no route back to it — the header is the only reopen affordance.
  return ctx.sandboxThreadId ? 'sandbox' : 'workspace';
}

export interface ReconcileInput {
  currentMode: RightPanelMode;
  ctx: PanelThreadContext;
  /** Thread whose sandbox pane was auto-opened last, or null if none. */
  autoOpenedFor: string | null;
}

export interface ReconcileResult {
  /** Set when the mode must change; undefined means leave it alone. */
  nextMode?: RightPanelMode;
  /** New value for the auto-open marker. */
  autoOpenedFor: string | null;
}

/**
 * Reconcile the global panel mode against the thread now in view.
 *
 * Called on every thread change. Two obligations:
 *
 *  - entering a sandbox thread opens its run pane, ONCE per entry, so a deliberate
 *    switch to another panel sticks while the operator stays on that thread;
 *  - leaving a sandbox thread drops `sandbox` mode, because the pane renders nothing
 *    for a thread with no sandbox — the panel would stay wide and blank.
 */
export function reconcileRightPanelForThread(input: ReconcileInput): ReconcileResult {
  const { currentMode, ctx, autoOpenedFor } = input;

  if (!ctx.sandboxThreadId) {
    // Clearing the marker is what makes A → B → A work: without it the return visit
    // matches the stale marker and the run pane never reopens.
    return {
      ...(currentMode === 'sandbox' ? { nextMode: 'status' as const } : {}),
      autoOpenedFor: null,
    };
  }

  if (autoOpenedFor === ctx.sandboxThreadId) {
    return { autoOpenedFor };
  }

  return { nextMode: 'sandbox', autoOpenedFor: ctx.sandboxThreadId };
}
