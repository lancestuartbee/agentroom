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
