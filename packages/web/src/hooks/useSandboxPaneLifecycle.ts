'use client';

import { useCallback, useEffect, useRef } from 'react';
import { defaultPanelModeForThread, reconcileRightPanelForThread } from '@/components/right-panel-lifecycle';
import { type RightPanelMode, useChatStore } from '@/stores/chatStore';

/**
 * F247 Phase D — the WIRING between the pure panel-lifecycle rules and the live store.
 *
 * Review point: pure-function tests prove the rules are right, but nothing proved the
 * component actually calls them — a future edit could delete the effect and every test
 * would stay green. Extracting the wiring into a hook makes it the thing under test
 * rather than two lines buried in a 1400-line component, so what remains untested is
 * only "ChatContainer calls this hook", which tsc and an unused-export would surface.
 */
export interface SandboxPaneLifecycle {
  /** Resolved sandbox thread id, or null when this thread has no sandbox bound. */
  sandboxThreadId: string | null;
  /** Panel to open when the operator reopens the right panel on this thread. */
  reopenMode: () => RightPanelMode;
}

export function useSandboxPaneLifecycle(threadId: string | null | undefined): SandboxPaneLifecycle {
  const setRightPanelMode = useChatStore((s) => s.setRightPanelMode);

  // Selects from the thread LIST so late-arriving metadata still opens the pane.
  const sandboxThreadId = useChatStore(
    (s) => s.threads.find((t) => t.id === threadId && t.mode === 'sandbox' && t.sandboxId)?.id ?? null,
  );

  const autoOpenedForRef = useRef<string | null>(null);

  // The effect needs the CURRENT panel mode but must not re-run when it changes: waking on
  // every mode change is what made the pane fight the operator (it reopened itself the
  // moment they switched away). Subscribe for the value, read it from a ref in the effect.
  //
  // Deliberately not `useChatStore.getState()`. Reaching past the hook binds this code to
  // the store module's shape rather than its data, and every component test that mocks the
  // store as a plain selector function then crashes on mount — six suites did.
  const rightPanelMode = useChatStore((s) => s.rightPanelMode);
  const rightPanelModeRef = useRef(rightPanelMode);
  rightPanelModeRef.current = rightPanelMode;

  useEffect(() => {
    const result = reconcileRightPanelForThread({
      currentMode: rightPanelModeRef.current,
      ctx: { sandboxThreadId },
      autoOpenedFor: autoOpenedForRef.current,
    });
    autoOpenedForRef.current = result.autoOpenedFor;
    if (result.nextMode) setRightPanelMode(result.nextMode);
  }, [sandboxThreadId, setRightPanelMode]);

  const reopenMode = useCallback(() => defaultPanelModeForThread({ sandboxThreadId }), [sandboxThreadId]);

  return { sandboxThreadId, reopenMode };
}
