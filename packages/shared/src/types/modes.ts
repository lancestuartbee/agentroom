/**
 * Session mode types for the professional collaboration refactor.
 *
 * The old mode system was removed in F101; this file now owns the lightweight
 * thread/session mode contract shared by api and web.
 */

export const THREAD_MODES = ['casual', 'roundtable', 'development'] as const;

export type ThreadMode = (typeof THREAD_MODES)[number];

export const DEFAULT_THREAD_MODE: ThreadMode = 'development';

export type ThreadAudience = { mode: 'all' } | { mode: 'selected'; agentIds: string[] };

export const DEFAULT_THREAD_AUDIENCE: ThreadAudience = Object.freeze({ mode: 'all' });

export type RoundtableIssueStatus = 'open' | 'voting' | 'summarized' | 'closed';

export type RoundtableIssueStage = 'independent_stance' | 'critique_loop' | 'consensus_vote' | 'final_summary';

export type RoundtableCritiqueStep = 'challenge' | 'response';

export interface RoundtableIssueStateV1 {
  v: 1;
  issueId: string;
  threadId: string;
  topic: string;
  status: RoundtableIssueStatus;
  stage: RoundtableIssueStage;
  critiqueStep?: RoundtableCritiqueStep;
  critiqueRound: number;
  maxCritiqueRounds: number;
  participants: string[];
  lastPhaseMessageId?: string;
  finalSummaryMessageId?: string;
  updatedAt: number;
}

export function isThreadMode(value: unknown): value is ThreadMode {
  return typeof value === 'string' && (THREAD_MODES as readonly string[]).includes(value);
}

export function normalizeThreadAudience(value: unknown): ThreadAudience {
  if (!value || typeof value !== 'object') return DEFAULT_THREAD_AUDIENCE;

  const candidate = value as { mode?: unknown; agentIds?: unknown };
  if (candidate.mode === 'all') return DEFAULT_THREAD_AUDIENCE;

  if (candidate.mode !== 'selected' || !Array.isArray(candidate.agentIds)) {
    return DEFAULT_THREAD_AUDIENCE;
  }

  const agentIds = [...new Set(candidate.agentIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (agentIds.length === 0) return DEFAULT_THREAD_AUDIENCE;

  return { mode: 'selected', agentIds };
}

export function isRoundtableIssueStateV1(value: unknown): value is RoundtableIssueStateV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RoundtableIssueStateV1>;
  return (
    candidate.v === 1 &&
    typeof candidate.issueId === 'string' &&
    candidate.issueId.length > 0 &&
    typeof candidate.threadId === 'string' &&
    candidate.threadId.length > 0 &&
    typeof candidate.topic === 'string' &&
    (candidate.status === 'open' ||
      candidate.status === 'voting' ||
      candidate.status === 'summarized' ||
      candidate.status === 'closed') &&
    (candidate.stage === 'independent_stance' ||
      candidate.stage === 'critique_loop' ||
      candidate.stage === 'consensus_vote' ||
      candidate.stage === 'final_summary') &&
    (candidate.critiqueStep === undefined ||
      candidate.critiqueStep === 'challenge' ||
      candidate.critiqueStep === 'response') &&
    typeof candidate.critiqueRound === 'number' &&
    Number.isFinite(candidate.critiqueRound) &&
    typeof candidate.maxCritiqueRounds === 'number' &&
    Number.isFinite(candidate.maxCritiqueRounds) &&
    Array.isArray(candidate.participants) &&
    candidate.participants.every((id) => typeof id === 'string' && id.length > 0) &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt)
  );
}
