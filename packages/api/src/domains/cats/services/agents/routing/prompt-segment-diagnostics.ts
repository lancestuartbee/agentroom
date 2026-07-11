import type { ContextBudget } from '@cat-cafe/shared';
import { estimateTokens } from '../../../../../utils/token-counter.js';

export const PROMPT_SEGMENT_DIAGNOSTICS_ENV = 'PROMPT_SEGMENT_DIAGNOSTICS';
export const PROMPT_SEGMENT_DIAGNOSTICS_NATIVE_ENV = 'PROMPT_SEGMENT_DIAGNOSTICS_NATIVE';

export interface PromptDiagnosticSegment {
  readonly name: string;
  readonly included: boolean;
  readonly chars: number | null;
  readonly estimatedTokens: number | null;
  readonly note?: string;
}

export interface RoutePromptSegmentDiagnostics {
  readonly routeStrategy: 'serial' | 'parallel';
  readonly mode: 'casual' | 'other';
  readonly threadId: string;
  readonly catId: string;
  readonly incrementalMode: boolean;
  readonly nativeL0Provider: boolean;
  readonly mcpAvailable: boolean;
  readonly contextBudget?: ContextBudget;
  readonly effectiveContextBudget?: number;
  readonly routeSegments: readonly PromptDiagnosticSegment[];
}

export function isCasualModePrompt(modeSystemPrompt: string | undefined): boolean {
  return modeSystemPrompt?.startsWith('[Casual mode]') ?? false;
}

export function shouldRecordPromptSegmentDiagnostics(modeSystemPrompt: string | undefined): boolean {
  const mode = process.env[PROMPT_SEGMENT_DIAGNOSTICS_ENV]?.trim().toLowerCase();
  if (!mode || mode === '0' || mode === 'false' || mode === 'off' || mode === 'no') return false;
  if (mode === 'casual') return isCasualModePrompt(modeSystemPrompt);
  return mode === '1' || mode === 'true' || mode === 'on' || mode === 'all';
}

export function shouldMeasureNativePromptSegmentDiagnostics(): boolean {
  const mode = process.env[PROMPT_SEGMENT_DIAGNOSTICS_NATIVE_ENV]?.trim().toLowerCase();
  return mode === '1' || mode === 'true' || mode === 'on' || mode === 'yes';
}

export function promptTextSegment(
  name: string,
  text: string | null | undefined,
  note?: string,
): PromptDiagnosticSegment {
  const value = text ?? '';
  return withOptionalNote(
    {
      name,
      included: value.length > 0,
      chars: value.length,
      estimatedTokens: estimateTokens(value),
    },
    note,
  );
}

export function promptDeltaSegment(
  name: string,
  before: string,
  after: string,
  note?: string,
): PromptDiagnosticSegment {
  return withOptionalNote(
    {
      name,
      included: after !== before,
      chars: after.length - before.length,
      estimatedTokens: estimateTokens(after) - estimateTokens(before),
    },
    note,
  );
}

export function promptUnmeasuredSegment(name: string, included: boolean, note: string): PromptDiagnosticSegment {
  return {
    name,
    included,
    chars: null,
    estimatedTokens: null,
    note,
  };
}

export function sumMeasuredPromptTokens(segments: readonly PromptDiagnosticSegment[]): number {
  return segments.reduce((sum, segment) => sum + (segment.estimatedTokens ?? 0), 0);
}

function withOptionalNote(segment: PromptDiagnosticSegment, note: string | undefined): PromptDiagnosticSegment {
  return note ? { ...segment, note } : segment;
}
