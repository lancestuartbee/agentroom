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
 *
 * 3. NEVER REQUIRE PROOF THAT AN EXTERNAL WRITER FINISHED. Reports are written by the
 *    member, not by us, so "the file is complete" is unknowable — every candidate
 *    signal is either the member's cooperation (which it may forget) or a timing
 *    heuristic (which only moves the race). So memory is a PROJECTION of the reports:
 *    both the rolling summary and the learnings are re-derived from the currently
 *    visible reports on every pass, and converge to whatever they now say. A late
 *    append or a correction is absorbed whenever it lands, with no completion protocol.
 *
 *    Two deliberate exceptions to pure projection, both because losing accumulated
 *    knowledge is worse than being stale: learnings are never REMOVED when their report
 *    disappears (reports get archived; learnings are the asset), and promoted learnings
 *    are frozen (their content already lives outside the sandbox, so a silent local
 *    rewrite would desync the published copy — reported via `divergedPromotedIds`).
 *
 * `processedRunIds` therefore gates only "have we counted this run before"
 * (`runsIncorporated` / `foldedRunIds`) — NOT what the summary or learnings contain.
 */

/** How many recent run summaries the rolling summary keeps verbatim. */
const MAX_SUMMARY_ENTRIES = 12;
/** Hard character ceiling for the rolling summary, independent of entry count. */
const MAX_SUMMARY_CHARS = 3000;

const SUMMARY_SEPARATOR = '\n';

export interface FoldResult {
  memory: SandboxMemoryV1 & { learnedItems: SandboxLearnedItemV1[] };
  /** False when nothing on disk differs from memory — caller can skip a write. */
  changed: boolean;
  /** Runs newly incorporated by this fold. */
  foldedRunIds: string[];
  /**
   * Promoted learnings whose source report has since been rewritten. Their content is
   * intentionally NOT updated (the exported copy would desync), so the caller surfaces
   * this rather than letting the two versions drift unnoticed.
   */
  divergedPromotedIds: string[];
}

function emptyMemory(): SandboxMemoryV1 & { learnedItems: SandboxLearnedItemV1[] } {
  return { v: 1, summary: '', runsIncorporated: 0, learnedItems: [], updatedAt: 0 };
}

/**
 * Keep the rolling summary readable and bounded: newest entries win, oldest age out.
 * Dropping the tail is safe here precisely because durable learnings live elsewhere —
 * ageing out "what happened on day 3" loses nothing that was worth keeping.
 *
 * Note this window is over the VISIBLE reports, so archiving old reports shortens the
 * recent-context summary. That is intended: the summary is ephemeral context, and the
 * learnings it leaves behind are what actually accumulate.
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
 * Internal separator for the memory item identity namespace.
 *
 * Report ids are local to one run (the prompt only requires uniqueness within the
 * report). Using them directly as sandbox-global memory keys makes two runs that both
 * use `finding-1` collide silently. The memory key is therefore `sourceRunId<sep>localId`.
 *
 * The unit separator is chosen because it cannot appear in markdown bullet text without
 * deliberate binary injection, so it is unambiguous for both joining and parsing.
 */
const ID_NAMESPACE_SEP = '\x1f';

function makeMemoryId(sourceRunId: string, localId: string): string {
  return `${sourceRunId}${ID_NAMESPACE_SEP}${localId}`;
}

function deriveSourceRunId(itemId: string): string {
  const lastDash = itemId.lastIndexOf('-');
  return lastDash > 0 ? itemId.slice(0, lastDash) : itemId;
}

function listLearnedFromRecord(
  record: SandboxRunRecordV1,
): Array<{ localId: string; content: string; sourceRunId: string }> {
  if (record.learnedWithIds && record.learnedWithIds.length > 0) {
    return record.learnedWithIds.map((item) => ({
      localId: item.id,
      content: item.content,
      sourceRunId: record.runId,
    }));
  }
  return (record.learned ?? []).map((content, index) => ({
    localId: `${record.runId}-${index}`,
    content,
    sourceRunId: record.runId,
  }));
}

/**
 * Reconcile the memory against the currently visible run reports.
 *
 * RUN COUNTING IS BY RUN ID, NOT BY TIMESTAMP. An earlier version used a
 * `triggeredAt > lastRunAt` cursor, which silently and permanently dropped runs in
 * three real situations (review found all three):
 *
 *  - two reports sharing a timestamp — the second is never folded;
 *  - a system clock that steps backwards — everything before the old cursor is lost;
 *  - concurrent folds — a stale whole-memory write rolls the cursor back.
 *
 * A months-long project cannot afford to lose days of learning silently, so membership
 * in `processedRunIds` decides instead. Under a lost update the ids are re-derived from
 * disk and those runs simply fold again; `learnedItems` dedupes by id, so the result
 * converges rather than duplicating.
 *
 * `lastRunAt` is retained for display ("last run at ..."), never as the fold gate.
 */
export function foldRunsIntoMemory(memory: SandboxMemoryV1 | null, runs: readonly SandboxRunRecordV1[]): FoldResult {
  let migratedIds = false;
  const base = memory
    ? {
        ...memory,
        learnedItems: (memory.learnedItems ?? []).map((item) => {
          const sourceRunId = item.sourceRunId ?? deriveSourceRunId(item.id);
          // Migrate items whose id was written before namespacing (bare local id, including
          // legacy runId-index ids like `r1-0`) to the namespaced form. A pre-existing id
          // that already begins with `sourceRunId<sep>` is left untouched.
          const namespacePrefix = makeMemoryId(sourceRunId, '');
          if (item.id.startsWith(namespacePrefix)) {
            return { ...item, sourceRunId };
          }
          migratedIds = true;
          return { ...item, id: makeMemoryId(sourceRunId, item.id), sourceRunId };
        }),
      }
    : emptyMemory();

  const processed = new Set(base.processedRunIds ?? []);

  // Legacy memories predate processedRunIds. MIGRATE by actually adding the
  // already-incorporated ids to the set — an earlier version merely FILTERED by the old
  // cursor without recording anything, so the second fold saw a non-empty set, dropped
  // the cursor, and replayed the entire pre-migration history.
  //
  // Recomputing this seed on every fold is harmless: it is derived from the same
  // lastRunAt and the same disk state, so it converges to the same set.
  if (processed.size === 0 && base.lastRunAt !== undefined) {
    for (const record of runs) {
      if (record.triggeredAt <= base.lastRunAt) processed.add(record.runId);
    }
  }

  const fresh = runs
    .filter((r) => !processed.has(r.runId))
    .slice()
    .sort((a, b) => a.triggeredAt - b.triggeredAt);

  /** Promoted learnings whose source report has since changed — reported, not applied. */
  const divergedPromotedIds: string[] = [];

  // THE ROLLING SUMMARY IS RECOMPUTED FROM THE VISIBLE REPORTS, not appended to.
  //
  // It is injected into the next run's prompt, so a half-written summary does not just
  // look untidy — it actively misleads later runs until it scrolls out of the window.
  // Deriving it fresh each time makes it self-correcting: when the report completes, so
  // does the summary.
  const summary = boundSummary(
    runs
      .slice()
      .sort((a, b) => a.triggeredAt - b.triggeredAt)
      .map(formatSummaryEntry),
  );

  // LEARNINGS TRACK WHAT THE REPORTS CURRENTLY SAY.
  //
  // An earlier version paired "no proof of completion is needed" with first-write-wins,
  // which is self-contradictory: first-write-wins IS an immutability assumption. Review
  // showed the consequence — a half-written bullet read on the first scan was sealed
  // into memory permanently, and the completed rewrite was ignored.
  //
  // Since a report can change at any moment, memory has to be a PROJECTION of it and
  // converge to the current content. Two deliberate exceptions to pure projection:
  //
  //  - Learnings are never REMOVED when their report disappears. Reports may be archived
  //    over a months-long project, and learnings are the accumulated asset — pruning
  //    reports must not cause amnesia.
  //  - Promoted learnings are frozen. Once a learning has been exported out of the
  //    sandbox (Phase E), silently rewriting the local copy would desync it from the
  //    copy already published, so the divergence is logged instead of applied.
  const byId = new Map(base.learnedItems.map((item) => [item.id, item]));
  let learningsChanged = false;
  /** Ids the currently visible reports still assert, so absence can be told from archival. */
  const assertedIds = new Set<string>();
  // A run whose learning section failed to parse is still visible as a run (its summary
  // is real and it should be counted), but it must not be treated as evidence that the
  // member retracted any learning. Exclude it from the retraction check.
  const retractionVisibleRunIds = new Set(runs.filter((r) => !r.learningParseError).map((r) => r.runId));

  for (const record of runs) {
    for (const { localId, content, sourceRunId } of listLearnedFromRecord(record)) {
      const trimmed = content.trim();
      if (!trimmed) continue;
      const id = makeMemoryId(sourceRunId, localId);
      assertedIds.add(id);
      const existing = byId.get(id);

      if (!existing) {
        byId.set(id, { id, content: trimmed, sourceRunId, sourceRunAt: record.triggeredAt, promoted: false });
        learningsChanged = true;
        continue;
      }
      if (existing.content === trimmed) {
        // The report agrees again — a half-written bullet that finished, not a conflict.
        // Clearing is what makes divergence self-healing rather than a permanent scar.
        if (existing.divergence) {
          byId.set(id, { ...existing, divergence: undefined });
          learningsChanged = true;
        }
        continue;
      }
      if (existing.promoted) {
        // Reported on EVERY fold — the disagreement is still true, and the scheduler's
        // warning should not fall silent after the first time. But re-recording an
        // identical divergence is not a change: treating it as one would rewrite memory on
        // every single run for the rest of the sandbox's life, and `changed` would stop
        // meaning anything.
        divergedPromotedIds.push(id);
        const already =
          existing.divergence?.kind === 'rewritten' &&
          existing.divergence.reportContent === trimmed &&
          existing.divergence.observedAt === record.triggeredAt;
        if (!already) {
          byId.set(id, {
            ...existing,
            divergence: { kind: 'rewritten', reportContent: trimmed, observedAt: record.triggeredAt },
          });
          learningsChanged = true;
        }
        continue;
      }
      byId.set(id, {
        ...existing,
        content: trimmed,
        sourceRunId,
        sourceRunAt: record.triggeredAt,
        divergence: undefined,
      });
      learningsChanged = true;
    }
  }

  // A LEARNING THAT VANISHED FROM ITS REPORT (F247 Phase E prerequisite).
  //
  // The loop above only walks what the reports currently say, so a member who rewrites a
  // report and drops a bullet used to be invisible: the stale id sat in memory forever and
  // nothing warned. Absence means two different things and they must not be conflated:
  //
  //  - the report is STILL VISIBLE but no longer contains it → a retraction. The member
  //    decided it was wrong. Learnings are injected into every future run's prompt, so
  //    keeping one its own author withdrew is worse than losing it: the sandbox goes on
  //    reasoning from a judgement that has been taken back.
  //  - the whole report is GONE → archival, not retraction. Reports get pruned over a
  //    months-long project and learnings are the accumulated asset; dropping them here
  //    would turn routine cleanup into amnesia.
  //
  // Promoted items are exempt from removal either way, for the same reason a promoted
  // rewrite is not applied: the content already left the sandbox, and silently dropping
  // our copy desyncs it from the published one. Report it and let the operator decide.
  for (const [id, item] of [...byId.entries()]) {
    if (assertedIds.has(id)) continue;
    const sourceRunId = item.sourceRunId;
    if (!retractionVisibleRunIds.has(sourceRunId)) continue;

    if (item.promoted) {
      // Same rule as a rewrite: keep reporting it, but only the first observation is a
      // change to persist.
      divergedPromotedIds.push(id);
      if (item.divergence?.kind !== 'retracted') {
        byId.set(id, { ...item, divergence: { kind: 'retracted', observedAt: item.sourceRunAt } });
        learningsChanged = true;
      }
      continue;
    }
    byId.delete(id);
    learningsChanged = true;
  }

  const learnedItems = [...byId.values()];

  // Any of these is a real change worth persisting: a new run, a corrected/late
  // learning, a summary that no longer matches the reports, or an in-memory id
  // migration that must be written back to disk.
  if (fresh.length === 0 && !learningsChanged && summary === base.summary && !migratedIds) {
    return { memory: base, changed: false, foldedRunIds: [], divergedPromotedIds };
  }

  const last = fresh[fresh.length - 1];
  const foldedRunIds = fresh.map((r) => r.runId);
  // Recording the id even for a run with no learnings is what stops that run from
  // being replayed on every future fire.
  const processedRunIds = [...processed, ...foldedRunIds];

  // lastRunAt is display-only now, so take the max rather than "the last one folded" —
  // a late report with an older timestamp must not drag the displayed time backwards.
  const newestSeen = Math.max(base.lastRunAt ?? Number.NEGATIVE_INFINITY, last?.triggeredAt ?? 0);

  return {
    memory: {
      ...base,
      v: 1,
      summary,
      learnedItems,
      processedRunIds,
      runsIncorporated: base.runsIncorporated + fresh.length,
      lastRunAt: newestSeen,
      updatedAt: newestSeen,
    },
    changed: true,
    foldedRunIds,
    divergedPromotedIds,
  };
}
