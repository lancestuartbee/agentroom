import type { SandboxLearnedItemV1, SandboxMemoryV1, SandboxRunRecordV1 } from '@cat-cafe/shared';

/**
 * F247 Phase C — turning runs into accumulated knowledge.
 *
 * Run reports on disk are only a trace; on their own they make the sandbox
 * *auditable*, not *smarter*. This is the step that makes "越跑越懂行" real: new run
 * reports are folded into the rolling `SandboxMemoryV1` that every subsequent run
 * receives in its prompt.
 *
 * Two design rules, both learned the hard way from long-running memory:
 *
 * 1. DURABLE vs EPHEMERAL. A run's `summary` ("today the index was thin") expires;
 *    its `learned` entries ("low turnover + volume breakout is a strong signal") do
 *    not. Only `learned` becomes a durable item. Mixing them is exactly what degrades
 *    month-long memory into an unreadable log.
 *
 * 2. BOUND THE INJECTION, NOT THE STORAGE. The rolling summary is capped so it cannot
 *    grow until SessionBootstrap drops the whole memory section under budget pressure.
 *    Durable learnings are never discarded on disk — they are the accumulated asset;
 *    capping happens where they are injected into a prompt, and the prompt says how
 *    many were held back rather than silently truncating.
 */

/** How many recent run summaries the rolling summary keeps verbatim. */
const MAX_SUMMARY_ENTRIES = 12;
/** Hard character ceiling for the rolling summary, independent of entry count. */
const MAX_SUMMARY_CHARS = 3000;

const SUMMARY_SEPARATOR = '\n';

export interface FoldResult {
  memory: SandboxMemoryV1 & { learnedItems: SandboxLearnedItemV1[] };
  /** False when no run was newer than the cursor — caller can skip a write. */
  changed: boolean;
  /** Runs actually incorporated by this fold. */
  foldedRunIds: string[];
}

function emptyMemory(): SandboxMemoryV1 & { learnedItems: SandboxLearnedItemV1[] } {
  return { v: 1, summary: '', runsIncorporated: 0, learnedItems: [], updatedAt: 0 };
}

/**
 * Keep the rolling summary readable and bounded: newest entries win, oldest age out.
 * Dropping the tail is safe here precisely because durable learnings live elsewhere —
 * ageing out "what happened on day 3" loses nothing that was worth keeping.
 */
function boundSummary(entries: string[]): string {
  let kept = entries.slice(-MAX_SUMMARY_ENTRIES);
  let text = kept.join(SUMMARY_SEPARATOR);
  while (text.length > MAX_SUMMARY_CHARS && kept.length > 1) {
    kept = kept.slice(1);
    text = kept.join(SUMMARY_SEPARATOR);
  }
  return text.length > MAX_SUMMARY_CHARS ? text.slice(-MAX_SUMMARY_CHARS) : text;
}

function formatSummaryEntry(record: SandboxRunRecordV1): string {
  const day = new Date(record.triggeredAt).toISOString().slice(0, 10);
  return `- [${day}] ${record.summary.replace(/\s+/g, ' ').trim()}`;
}

/**
 * Fold every run newer than `memory.lastRunAt` into the memory.
 *
 * Idempotent by construction: the cursor is what decides, so re-reading the whole runs
 * directory on every fire (which is what actually happens) cannot double-count.
 */
export function foldRunsIntoMemory(memory: SandboxMemoryV1 | null, runs: readonly SandboxRunRecordV1[]): FoldResult {
  const base = memory ? { ...memory, learnedItems: [...(memory.learnedItems ?? [])] } : emptyMemory();

  const cursor = base.lastRunAt ?? Number.NEGATIVE_INFINITY;
  const fresh = runs
    .filter((r) => r.triggeredAt > cursor)
    .slice()
    .sort((a, b) => a.triggeredAt - b.triggeredAt);

  if (fresh.length === 0) {
    return { memory: base, changed: false, foldedRunIds: [] };
  }

  const existingEntries = base.summary ? base.summary.split(SUMMARY_SEPARATOR).filter(Boolean) : [];
  const summary = boundSummary([...existingEntries, ...fresh.map(formatSummaryEntry)]);

  const newLearnings: SandboxLearnedItemV1[] = [];
  for (const record of fresh) {
    for (const [index, content] of (record.learned ?? []).entries()) {
      const trimmed = content.trim();
      if (!trimmed) continue;
      newLearnings.push({
        id: `${record.runId}-${index}`,
        content: trimmed,
        sourceRunAt: record.triggeredAt,
        promoted: false,
      });
    }
  }

  // Guard against a re-written report re-adding the same learning under the same id.
  const seen = new Set(base.learnedItems.map((item) => item.id));
  const learnedItems = [...base.learnedItems, ...newLearnings.filter((item) => !seen.has(item.id))];

  const last = fresh[fresh.length - 1];
  return {
    memory: {
      ...base,
      v: 1,
      summary,
      learnedItems,
      runsIncorporated: base.runsIncorporated + fresh.length,
      // Advancing the cursor even for a run with no learnings is what stops that run
      // from being replayed on every future fire.
      lastRunAt: last?.triggeredAt ?? base.lastRunAt,
      updatedAt: last?.triggeredAt ?? base.updatedAt,
    },
    changed: true,
    foldedRunIds: fresh.map((r) => r.runId),
  };
}
