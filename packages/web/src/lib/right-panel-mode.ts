/**
 * The right-hand panel's vocabulary, owned by neither the store nor the components.
 *
 * `status` is the narrow default; everything else takes over the wide right half. F247
 * added `sandbox` (the A2A sandbox run pane).
 *
 * This lives in a neutral module because both sides need it and neither should depend on
 * the other. Two earlier landings were both wrong in an instructive way: declaring the
 * predicate on the store meant every suite that mocks the store to render a component had
 * to re-implement pure logic (six suites broke the day it was added), and moving it into
 * the components layer made the state layer import the UI layer — review rejected the
 * second for the direction, not the extraction.
 */
export type RightPanelMode = 'status' | 'workspace' | 'transcript' | 'sandbox';

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
