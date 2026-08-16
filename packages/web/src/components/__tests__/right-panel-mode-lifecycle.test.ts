/**
 * F247 Phase D — right-panel mode lifecycle.
 *
 * Every WIDE right-panel mode has to be registered in three places at once: the
 * auto-open effect, the close handler, and the chat-column flex basis. F247 shipped
 * 'sandbox' registered in only one of them, so the pane could be opened but never
 * closed — closing set statusPanelOpen=false and the auto-open effect immediately
 * undid it.
 *
 * These tests pin the single predicate that now drives all three, so a future mode
 * cannot be half-registered.
 */

import { describe, expect, it } from 'vitest';
import { isWideRightPanelMode, type RightPanelMode } from '@/lib/right-panel-mode';

const ALL_MODES: RightPanelMode[] = ['status', 'workspace', 'transcript', 'sandbox'];

describe('isWideRightPanelMode', () => {
  it('treats every non-status mode as wide, including sandbox', () => {
    expect(isWideRightPanelMode('status')).toBe(false);
    for (const mode of ALL_MODES.filter((m) => m !== 'status')) {
      expect(isWideRightPanelMode(mode), `${mode} must count as a wide panel mode`).toBe(true);
    }
  });

  // The bug was a mode that could be opened but not closed. Closing means falling back
  // to 'status', so any mode the predicate calls wide MUST be closable to status.
  it('every wide mode closes back to status', () => {
    const close = (mode: RightPanelMode): RightPanelMode => (isWideRightPanelMode(mode) ? 'status' : mode);
    for (const mode of ALL_MODES) {
      expect(close(mode)).toBe('status');
    }
  });

  // A new mode added to the union but forgotten everywhere else is exactly how this
  // broke; the predicate is derived from the union, so it cannot drift.
  it('is derived from the mode union rather than an enumerated list', () => {
    const surprise = 'some-future-pane' as RightPanelMode;
    expect(isWideRightPanelMode(surprise)).toBe(true);
  });
});
