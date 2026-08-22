/**
 * F247: A2A 沙盒内存存储实现
 *
 * v1 同时维护内存缓存和目录持久化：
 * - 目录 (<projectPath>/.a2a-sandbox/) 是真相源
 * - 内存 Map 是运行时缓存
 *
 * 后续可替换为 Redis / SQLite 实现。
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CreateSandboxInput,
  Sandbox,
  SandboxLearnedItemV1,
  SandboxLearningPromotionClaimV1,
  SandboxLearningPromotionProvenanceV1,
  SandboxMemoryV1,
  SandboxRunRecordV1,
  SandboxSettingsV1,
  SandboxSpecV1,
  SandboxStateFileV1,
  UpdateSandboxSettingsInput,
  UpdateSandboxSpecInput,
  UpdateSandboxStatusInput,
} from '@cat-cafe/shared';
import { createModuleLogger } from '../../../infrastructure/logger.js';
import type { ISandboxStore } from '../ports/SandboxStore.js';
import { renderSandboxRunReport, SANDBOX_NO_LEARNING_PLACEHOLDER } from '../services/sandbox-run-prompt.js';

const DEFAULT_SETTINGS: SandboxSettingsV1 = {
  allowBackflow: false,
  autoStartSchedule: true,
  maxRunLogs: 100,
};

/**
 * A claim older than this is treated as stale (e.g., a previous attempt crashed after
 * writing the claim but before completing). A stale claim can be resumed by a new request
 * with the same snapshot. A newer claim is considered in-progress and must not share its
 * attemptId with concurrent callers.
 */
const PROMOTION_CLAIM_STALE_MS = 30_000;

function fingerprintMatches(
  a: { sourceRunId: string; content: string },
  b: { sourceRunId: string; content: string },
): boolean {
  return a.sourceRunId === b.sourceRunId && a.content === b.content;
}

function resolveClaimConflict(
  existingClaim: SandboxLearningPromotionClaimV1,
  claim: SandboxLearningPromotionClaimV1,
): 'overwrite' | 'return-existing' | 'conflict' {
  if (existingClaim.attemptId === claim.attemptId) return 'overwrite';
  if (!fingerprintMatches(existingClaim.fingerprint, claim.fingerprint)) return 'conflict';
  if (claim.attemptedAt - existingClaim.attemptedAt > PROMOTION_CLAIM_STALE_MS) return 'overwrite';
  return 'return-existing';
}

/**
 * Sandbox ids double as evidence collection ids (`<kind>:<name>`), so they must
 * satisfy COLLECTION_ID_RE (`^[a-z]+:[a-z][a-z0-9-]*$`) — the name segment has to
 * START WITH A LETTER. A bare UUID starts with a hex digit ~62.5% of the time, so
 * `sandbox:${uuid}` failed collection registration for most sandboxes (measured:
 * 641/1000). The `sb-` prefix makes every generated id collection-compatible.
 */
function generateSandboxId(): string {
  return `sandbox:sb-${randomUUID()}`;
}

function sanitizeProjectPath(projectPath: string): string {
  // Prevent directory traversal; projectPath is expected to be validated upstream.
  return projectPath.replace(/\.\./g, '');
}

const log = createModuleLogger('sandbox/store');

/**
 * DEBOUNCE ONLY — deliberately not a correctness boundary.
 *
 * "Unchanged for N seconds" can never prove "finished", and an earlier version that
 * treated it as proof merely moved the race later: a report that gained its durable
 * bullet after the window had already been marked processed. Correctness now lives in
 * the fold, which re-extracts learnings from every report on every pass, so a late
 * append is always absorbed.
 *
 * What this window still buys is summary quality: the rolling summary IS appended once
 * and never revised, so it is worth waiting a moment before capturing a report that
 * looks like it is still being written.
 */
const REPORT_QUIESCENCE_MS = 5_000;

/**
 * Extract durable learnings from a run report's `## Learned` section.
 *
 * The template ships one placeholder line for the "nothing durable today" case;
 * treating it as a real learning would poison long-term memory with empty entries.
 */
/** Raw bullet count in a `## Learned` section — used for the in-flight completeness gate. */
function countBullets(section: string | undefined): number {
  if (!section) return 0;
  return section.split('\n').filter((line) => line.trim().startsWith('- ')).length;
}

interface ParsedLearnedStable {
  kind: 'stable';
  items: Array<{ id: string; content: string }>;
}
interface ParsedLearnedLegacy {
  kind: 'legacy';
  items: string[];
}
interface ParsedLearnedMixed {
  kind: 'mixed';
}
interface ParsedLearnedDuplicate {
  kind: 'duplicate';
}
interface ParsedLearnedMalformed {
  kind: 'malformed';
}
type ParsedLearnedResult =
  | ParsedLearnedStable
  | ParsedLearnedLegacy
  | ParsedLearnedMixed
  | ParsedLearnedDuplicate
  | ParsedLearnedMalformed;

function parseLearnedBullets(section: string | undefined): ParsedLearnedResult {
  const raw = section
    ? section
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- '))
        .map((line) => {
          const body = line.slice(2).trim();
          const idMatch = /^id:([^\s]+)\s+(.*)$/.exec(body);
          if (idMatch) {
            return { id: idMatch[1], content: idMatch[2].trim() };
          }
          return { content: body };
        })
        // Drop ONLY the exact template placeholder. An earlier version matched any
        // fully-parenthesised line, which would have silently discarded genuine
        // conclusions that happen to be written inside brackets.
        .filter((item) => item.content.length > 0 && item.content !== SANDBOX_NO_LEARNING_PLACEHOLDER)
    : [];

  if (raw.length === 0) {
    return { kind: 'legacy', items: [] };
  }

  // Any line that starts with `id:` but does not match the full `id:<token> <content>`
  // shape is a malformed attempt at a stable id (e.g. `- id:a` with no conclusion, or
  // `- id: a` with a space where the id should be). Treating it as legacy content would
  // invent a fake learning and, worse, retract the real item that previously used this id.
  const hasMalformedId = raw.some((item) => item.id === undefined && item.content.startsWith('id:'));
  if (hasMalformedId) {
    return { kind: 'malformed' };
  }

  const withIdCount = raw.filter((item) => item.id !== undefined).length;
  const allHaveIds = withIdCount === raw.length;
  const noneHaveIds = withIdCount === 0;

  // A report either uses explicit ids or it doesn't. Mixing the two is a malformed
  // report: falling back to legacy indexing would silently drop the lines that DO
  // have ids, and treating it as stable would invent ids for the rest. Reject the
  // whole learning section so the format error does not masquerade as a retraction.
  if (!allHaveIds && !noneHaveIds) {
    return { kind: 'mixed' };
  }

  if (allHaveIds) {
    const seen = new Set<string>();
    for (const item of raw) {
      if (seen.has(item.id as string)) {
        return { kind: 'duplicate' };
      }
      seen.add(item.id as string);
    }
    return { kind: 'stable', items: raw as Array<{ id: string; content: string }> };
  }

  return { kind: 'legacy', items: raw.map((item) => item.content) };
}

function getSandboxDir(projectPath: string): string {
  return join(sanitizeProjectPath(projectPath), '.a2a-sandbox');
}

function getStateFilePath(projectPath: string): string {
  return join(getSandboxDir(projectPath), 'state.json');
}

function getMemoryFilePath(projectPath: string): string {
  return join(getSandboxDir(projectPath), 'memory', 'sandbox-memory.json');
}

function getRunsDir(projectPath: string): string {
  return join(getSandboxDir(projectPath), 'runs');
}

function getSpecFilePath(projectPath: string): string {
  return join(getSandboxDir(projectPath), 'spec.yaml');
}

function getSpecHistoryDir(projectPath: string): string {
  return join(getSandboxDir(projectPath), 'spec');
}

function toYamlString(obj: unknown): string {
  // Minimal YAML serialization for v1. Replace with a proper YAML library if needed.
  return JSON.stringify(obj, null, 2);
}

function fromYamlString<T>(value: string): T {
  // Minimal YAML parsing for v1. Replace with a proper YAML library if needed.
  return JSON.parse(value) as T;
}

interface SandboxIndexEntry {
  sandboxId: string;
  threadId: string;
  projectPath: string;
}

export interface InMemorySandboxStoreOptions {
  /** Path to a global append-only index for rehydration after restart */
  indexFilePath?: string;
}

export class InMemorySandboxStore implements ISandboxStore {
  private sandboxes: Map<string, Sandbox> = new Map();
  private memories: Map<string, SandboxMemoryV1> = new Map();
  private runs: Map<string, SandboxRunRecordV1[]> = new Map();
  private threadIndex: Map<string, string> = new Map();
  private indexFilePath?: string;

  constructor(options?: InMemorySandboxStoreOptions) {
    this.indexFilePath = options?.indexFilePath;
  }

  async create(input: CreateSandboxInput, createdBy: string): Promise<Sandbox> {
    const now = Date.now();
    const id = generateSandboxId();
    const settings: SandboxSettingsV1 = {
      ...DEFAULT_SETTINGS,
      ...input.settings,
    };

    const sandbox: Sandbox = {
      id,
      title: input.title,
      projectPath: input.projectPath,
      threadId: '', // Bound later when thread is created
      createdBy,
      members: input.members,
      spec: input.spec,
      settings,
      status: settings.autoStartSchedule ? 'active' : 'paused',
      createdAt: now,
      updatedAt: now,
    };

    this.sandboxes.set(id, sandbox);
    this.memories.set(id, {
      v: 1,
      summary: '',
      runsIncorporated: 0,
      updatedAt: now,
    });
    this.runs.set(id, []);

    await this.persist(sandbox);
    return sandbox;
  }

  async bindThread(sandboxId: string, threadId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return;
    sandbox.threadId = threadId;
    this.threadIndex.set(threadId, sandboxId);
    await this.persist(sandbox);
    await this.appendIndex({ sandboxId, threadId, projectPath: sandbox.projectPath });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    return this.sandboxes.get(sandboxId) ?? null;
  }

  async getByThreadId(threadId: string): Promise<Sandbox | null> {
    const sandboxId = this.threadIndex.get(threadId);
    if (!sandboxId) return null;
    return this.get(sandboxId);
  }

  async listByProject(projectPath: string): Promise<Sandbox[]> {
    const result: Sandbox[] = [];
    for (const sandbox of this.sandboxes.values()) {
      if (sandbox.projectPath === projectPath) {
        result.push(sandbox);
      }
    }
    return result;
  }

  async updateSpec(sandboxId: string, input: UpdateSandboxSpecInput): Promise<Sandbox | null> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return null;

    const newSpec: SandboxSpecV1 = {
      ...sandbox.spec,
      ...input.spec,
      // Ensure immutable fields are not overwritten by accident
      specVersion: input.spec.specVersion ?? sandbox.spec.specVersion,
    };

    const now = Date.now();
    sandbox.spec = newSpec;
    sandbox.updatedAt = now;

    await this.persist(sandbox);
    return sandbox;
  }

  async updateSettings(sandboxId: string, input: UpdateSandboxSettingsInput): Promise<Sandbox | null> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return null;

    sandbox.settings = { ...sandbox.settings, ...input.settings };
    sandbox.updatedAt = Date.now();

    await this.persist(sandbox);
    return sandbox;
  }

  async updateStatus(sandboxId: string, input: UpdateSandboxStatusInput): Promise<Sandbox | null> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return null;

    sandbox.status = input.status;
    sandbox.updatedAt = Date.now();

    await this.persist(sandbox);
    return sandbox;
  }

  async getMemory(sandboxId: string): Promise<SandboxMemoryV1 | null> {
    return this.memories.get(sandboxId) ?? null;
  }

  async updateMemory(sandboxId: string, memory: SandboxMemoryV1): Promise<void> {
    this.memories.set(sandboxId, memory);
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox) {
      await this.persistMemory(sandbox.projectPath, memory);
    }
  }

  async claimPromotion(
    sandboxId: string,
    itemId: string,
    claim: SandboxLearningPromotionClaimV1,
  ): Promise<SandboxLearnedItemV1 | null> {
    const memory = this.memories.get(sandboxId);
    if (!memory) return null;

    const item = memory.learnedItems?.find((i) => i.id === itemId);
    if (!item) return null;
    if (item.promoted) return null;

    // The claim is a linearization point: it must match the CURRENT snapshot. If fold
    // rewrote the item between the caller's read and this write, the promotion must not
    // proceed with a stale fingerprint.
    if (item.sourceRunId !== claim.fingerprint.sourceRunId || item.content !== claim.fingerprint.content) {
      return null;
    }

    const existingClaim = item.promotionClaim;
    if (existingClaim) {
      const action = resolveClaimConflict(existingClaim, claim);
      if (action === 'conflict') {
        return null;
      }
      if (action === 'return-existing') {
        // An active in-flight claim with the same snapshot: surface it so the caller can
        // report "already in progress" without touching evidence or releasing someone
        // else's claim.
        return item;
      }
      // action === 'overwrite': either idempotent same-attempt or stale crashed claim.
    }

    const updated: SandboxLearnedItemV1 = { ...item, promotionClaim: claim };
    const learnedItems = (memory.learnedItems ?? []).map((i) => (i.id === itemId ? updated : i));
    const nextMemory: SandboxMemoryV1 = { ...memory, learnedItems, updatedAt: claim.attemptedAt };
    await this.updateMemory(sandboxId, nextMemory);
    return updated;
  }

  async completePromotion(
    sandboxId: string,
    itemId: string,
    provenance: SandboxLearningPromotionProvenanceV1,
    evidenceAnchor: string,
    fingerprint: { sourceRunId: string; content: string },
    attemptId: string,
  ): Promise<SandboxLearnedItemV1 | null> {
    const memory = this.memories.get(sandboxId);
    if (!memory) return null;

    const item = memory.learnedItems?.find((i) => i.id === itemId);
    if (!item) return null;
    if (item.promoted) return null;
    if (!item.promotionClaim || item.promotionClaim.attemptId !== attemptId) return null;
    if (item.sourceRunId !== fingerprint.sourceRunId || item.content !== fingerprint.content) return null;

    const updated: SandboxLearnedItemV1 = {
      ...item,
      promoted: true,
      promotedAt: provenance.promotedAt,
      promotedEvidenceAnchor: evidenceAnchor,
      promotionProvenance: provenance,
      promotionClaim: undefined,
    };

    const learnedItems = (memory.learnedItems ?? []).map((i) => (i.id === itemId ? updated : i));
    const nextMemory: SandboxMemoryV1 = { ...memory, learnedItems, updatedAt: provenance.promotedAt };
    await this.updateMemory(sandboxId, nextMemory);
    return updated;
  }

  async releasePromotionClaim(
    sandboxId: string,
    itemId: string,
    attemptId: string,
  ): Promise<SandboxLearnedItemV1 | null> {
    const memory = this.memories.get(sandboxId);
    if (!memory) return null;

    const item = memory.learnedItems?.find((i) => i.id === itemId);
    if (!item) return null;
    if (!item.promotionClaim) return item;
    if (item.promotionClaim.attemptId !== attemptId) return null;

    const updated: SandboxLearnedItemV1 = { ...item, promotionClaim: undefined };
    const learnedItems = (memory.learnedItems ?? []).map((i) => (i.id === itemId ? updated : i));
    const nextMemory: SandboxMemoryV1 = { ...memory, learnedItems, updatedAt: Date.now() };
    await this.updateMemory(sandboxId, nextMemory);
    return updated;
  }

  async getLastRun(sandboxId: string): Promise<SandboxRunRecordV1 | null> {
    const list = this.runs.get(sandboxId) ?? [];
    return list[list.length - 1] ?? null;
  }

  async addRun(sandboxId: string, run: SandboxRunRecordV1): Promise<void> {
    const list = this.runs.get(sandboxId) ?? [];
    list.push(run);

    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox && sandbox.settings.maxRunLogs > 0 && list.length > sandbox.settings.maxRunLogs) {
      list.splice(0, list.length - sandbox.settings.maxRunLogs);
    }

    this.runs.set(sandboxId, list);
    if (sandbox) {
      await this.persistRun(sandbox.projectPath, run);
    }
  }

  /**
   * List run reports, reading from DISK every time.
   *
   * The directory is the sandbox's source of truth, and reports are written there by
   * the member mid-flight — not through this store. Serving a memory cache here meant
   * that in a long-running process `listRuns()` never saw reports written after
   * startup, so the fold found nothing and the sandbox silently stopped learning;
   * only a restart made progress visible. A cache that can diverge from the source of
   * truth is the bug, not an optimisation — this runs once per fire, so a readdir is
   * not worth the risk of being wrong.
   *
   * THROWS on a real read fault (anything but a missing runs directory). Returning a
   * stale cache instead would make "here is the current state" and "the disk failed,
   * here is what I remember" indistinguishable at the call site — and a caller that
   * cannot tell the difference will happily conclude there is nothing to fold. The
   * decision to degrade belongs to the caller: `foldPendingRuns()` catches this, keeps
   * the previous memory and warns.
   */
  async listRuns(sandboxId: string, limit?: number): Promise<SandboxRunRecordV1[]> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      const cached = this.runs.get(sandboxId) ?? [];
      return limit === undefined ? cached : cached.slice(-limit);
    }

    const fromDisk = await this.listRunFiles(sandbox.projectPath);
    this.runs.set(sandboxId, fromDisk);
    return limit === undefined ? fromDisk : fromDisk.slice(-limit);
  }

  async readStateFile(projectPath: string): Promise<SandboxStateFileV1 | null> {
    try {
      const content = await readFile(getStateFilePath(projectPath), 'utf-8');
      return JSON.parse(content) as SandboxStateFileV1;
    } catch {
      return null;
    }
  }

  async writeStateFile(projectPath: string, state: SandboxStateFileV1): Promise<void> {
    const path = getStateFilePath(projectPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2));
  }

  async delete(sandboxId: string): Promise<boolean> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return false;

    this.sandboxes.delete(sandboxId);
    this.memories.delete(sandboxId);
    this.runs.delete(sandboxId);
    if (sandbox.threadId) {
      this.threadIndex.delete(sandbox.threadId);
    }

    // v1: do not delete directory files; only remove from runtime cache.
    return true;
  }

  /**
   * Rehydrate runtime state from disk. Must be called once at process startup
   * after the optional indexFilePath is configured.
   */
  async rehydrate(): Promise<void> {
    if (!this.indexFilePath) return;

    let raw: string;
    try {
      raw = await readFile(this.indexFilePath, 'utf-8');
    } catch {
      return;
    }

    const seen = new Set<string>();
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SandboxIndexEntry;
        if (!entry.sandboxId || !entry.projectPath) continue;
        if (seen.has(entry.sandboxId)) continue;
        seen.add(entry.sandboxId);

        const state = await this.readStateFile(entry.projectPath);
        if (!state || state.sandboxId !== entry.sandboxId) continue;

        const sandbox: Sandbox = {
          id: state.sandboxId,
          title: state.title,
          projectPath: entry.projectPath,
          threadId: state.threadId,
          createdBy: '', // Unknown after restart; not used for runtime routing
          members: state.members,
          spec: await this.readSpec(entry.projectPath),
          settings: state.settings,
          status: state.status,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        };

        this.sandboxes.set(sandbox.id, sandbox);
        if (sandbox.threadId) {
          this.threadIndex.set(sandbox.threadId, sandbox.id);
        }

        const memory = await this.readMemoryFile(entry.projectPath);
        if (memory) {
          this.memories.set(sandbox.id, memory);
        }

        this.runs.set(sandbox.id, await this.listRunFiles(entry.projectPath));
      } catch (err) {
        // Best-effort, but never silent: a skipped entry means a sandbox vanishes from
        // the runtime while its data still sits on disk. For a project meant to run for
        // months, that failure has to be visible or it reads as "the sandbox is gone".
        log.warn({ err, line: line.slice(0, 200) }, 'Failed to rehydrate sandbox index entry — skipped');
      }
    }
  }

  private async appendIndex(entry: SandboxIndexEntry): Promise<void> {
    if (!this.indexFilePath) return;
    await mkdir(dirname(this.indexFilePath), { recursive: true });
    await appendFile(this.indexFilePath, `${JSON.stringify(entry)}\n`);
  }

  private async readSpec(projectPath: string): Promise<SandboxSpecV1> {
    try {
      const content = await readFile(getSpecFilePath(projectPath), 'utf-8');
      return fromYamlString<SandboxSpecV1>(content);
    } catch {
      return {
        specVersion: '1',
        name: 'Recovered sandbox',
        goal: 'Recovered from disk',
        members: [],
      };
    }
  }

  private async readMemoryFile(projectPath: string): Promise<SandboxMemoryV1 | null> {
    try {
      const content = await readFile(getMemoryFilePath(projectPath), 'utf-8');
      return JSON.parse(content) as SandboxMemoryV1;
    } catch {
      return null;
    }
  }

  private async listRunFiles(projectPath: string): Promise<SandboxRunRecordV1[]> {
    const { readdir, stat } = await import('node:fs/promises');
    const dir = getRunsDir(projectPath);
    const results: SandboxRunRecordV1[] = [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      // ONLY a missing directory is normal (fresh sandbox with no runs yet). Every
      // other fault — EACCES, EIO — must propagate: silently returning [] would make a
      // broken disk indistinguishable from "this sandbox has never run", which is the
      // difference between an alert and months of learning quietly disappearing.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return results;
      throw err;
    }

    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      // Per-file isolation: a single unreadable/corrupt report must not abort the scan.
      // The previous try wrapped the whole loop, so one transient read error silently
      // hid every other run — i.e. a whole project's accumulated learning could vanish
      // because of one bad file.
      try {
        const path = join(dir, name);
        const content = await readFile(path, 'utf-8');
        const statResult = await stat(path);
        const runId = name.replace(/\.md$/, '');
        const triggerMatch = /- Trigger: (\w+)/.exec(content);
        const specVersionMatch = /- Spec Version: (.+)/.exec(content);

        // Prefer the timestamp recorded IN the report over the file's mtime. The fold
        // cursor is derived from this, and copying a sandbox directory — the stated
        // migration path — rewrites mtimes, which would re-fold or skip runs.
        const triggeredAtMatch = /- Triggered At: (.+)/.exec(content);
        const parsedTriggeredAt = triggeredAtMatch ? Date.parse(triggeredAtMatch[1].trim()) : Number.NaN;
        const triggeredAt = Number.isFinite(parsedTriggeredAt) ? parsedTriggeredAt : statResult.mtimeMs;

        // `## Summary` runs until `## Learned`. Without this split the durable-learning
        // section would be swallowed back into the ephemeral summary, collapsing the
        // very distinction the run report exists to express.
        const afterSummary = content.split('## Summary')[1] ?? content;
        const [summaryPart, learnedPart] = afterSummary.split('## Learned');
        const parsedLearned = parseLearnedBullets(learnedPart);

        // Completeness is judged on RAW bullets, before the placeholder is filtered out:
        // "nothing durable today" is a normal, fully-written report, and most days look
        // like that. Judging on filtered learnings would have branded every ordinary run
        // as half-written and deferred it forever.
        const hasLearnedHeading = content.includes('## Learned');
        const hasAnyLearnedBullet = countBullets(learnedPart) > 0;

        // IN-FLIGHT GATE. listRuns() reads the directory live, so a scan can land in the
        // middle of a member writing its report. Folding a half-written file marks the
        // run processed, so anything written a moment later is lost for good.
        //
        // An earlier version gated on "does `## Learned` appear", which was the wrong
        // invariant: the renderer emits the heading and only THEN the bullets, so a scan
        // in that gap still saw a "complete" report. What actually distinguishes
        // mid-write from finished is whether the file is still changing — so freshness
        // decides, and structure only gets a veto while the file is fresh.
        //
        // Deliberately NOT a completion sentinel the member must write: a member that
        // forgets it would have its run skipped forever, trading one silent loss for
        // another. This judgement stays with the system.
        const looksComplete = hasLearnedHeading && hasAnyLearnedBullet;
        if (!looksComplete && Date.now() - statResult.mtimeMs < REPORT_QUIESCENCE_MS) {
          log.warn({ projectPath, file: name }, 'Sandbox run report still being written — deferred to the next scan');
          continue;
        }

        // Malformed learning sections must not be silently partially parsed: a mix of
        // id-ed and bare lines, duplicate ids, or an incomplete `id:` attempt would either
        // drop valid lines or invent false retractions on the next fold. A settled report
        // that lacks a `## Learned` section or any bullet at all is similarly malformed.
        // Keep the run on record (the summary is real), but do not emit any learnings and
        // mark the parse error so the fold does not treat this as a retraction.
        let learned: string[] | undefined;
        let learnedWithIds: Array<{ id: string; content: string }> | undefined;
        let learningParseError = false;
        if (parsedLearned.kind === 'mixed') {
          log.warn(
            { projectPath, file: name },
            'Sandbox run report mixes id-ed and bare learnings — treated as no learnings',
          );
          learningParseError = true;
        } else if (parsedLearned.kind === 'duplicate') {
          log.warn(
            { projectPath, file: name },
            'Sandbox run report has duplicate learning ids — treated as no learnings',
          );
          learningParseError = true;
        } else if (parsedLearned.kind === 'malformed') {
          log.warn(
            { projectPath, file: name },
            'Sandbox run report has malformed stable-id lines — treated as no learnings',
          );
          learningParseError = true;
        } else if (!looksComplete) {
          log.warn(
            { projectPath, file: name },
            'Sandbox run report has settled without a parseable ## Learned section — treated as no learnings',
          );
          learningParseError = true;
        } else if (parsedLearned.kind === 'stable') {
          learnedWithIds = parsedLearned.items;
        } else {
          learned = parsedLearned.items;
        }

        results.push({
          v: 1,
          runId,
          trigger: (triggerMatch?.[1] as 'scheduled' | 'manual') ?? 'manual',
          triggeredAt,
          specVersion: specVersionMatch?.[1] ?? 'unknown',
          summary: (summaryPart ?? content).trim(),
          ...(learnedWithIds && learnedWithIds.length > 0
            ? { learnedWithIds }
            : learned && learned.length > 0
              ? { learned }
              : {}),
          ...(learningParseError ? { learningParseError } : {}),
        });
      } catch (err) {
        log.warn({ err, projectPath, file: name }, 'Failed to read sandbox run report — skipped this file only');
      }
    }
    return results.sort((a, b) => a.triggeredAt - b.triggeredAt);
  }

  private async persist(sandbox: Sandbox): Promise<void> {
    const dir = getSandboxDir(sandbox.projectPath);
    await mkdir(dir, { recursive: true });

    const state: SandboxStateFileV1 = {
      v: 1,
      sandboxId: sandbox.id,
      title: sandbox.title,
      threadId: sandbox.threadId,
      members: sandbox.members,
      settings: sandbox.settings,
      status: sandbox.status,
      currentSpecRef: getSpecFilePath(sandbox.projectPath),
      createdAt: sandbox.createdAt,
      updatedAt: sandbox.updatedAt,
    };

    await Promise.all([
      this.writeStateFile(sandbox.projectPath, state),
      this.persistSpec(sandbox.projectPath, sandbox.spec),
    ]);
  }

  private async persistSpec(projectPath: string, spec: SandboxSpecV1): Promise<void> {
    const dir = getSandboxDir(projectPath);
    const specPath = getSpecFilePath(projectPath);
    const historyDir = getSpecHistoryDir(projectPath);

    await mkdir(dir, { recursive: true });
    await mkdir(historyDir, { recursive: true });

    const timestamp = Date.now();
    const historyPath = join(historyDir, `spec-${timestamp}.yaml`);

    await Promise.all([writeFile(specPath, toYamlString(spec)), writeFile(historyPath, toYamlString(spec))]);
  }

  private async persistMemory(projectPath: string, memory: SandboxMemoryV1): Promise<void> {
    const path = getMemoryFilePath(projectPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(memory, null, 2));
  }

  /**
   * Write a run report programmatically.
   *
   * Goes through `renderSandboxRunReport()` — the SAME renderer the member's prompt
   * documents — so the two writers cannot drift. A previous hand-rolled layout here
   * omitted `## Learned`, which meant every programmatically recorded run silently
   * lost its durable learnings on the way back through the parser.
   */
  private async persistRun(projectPath: string, run: SandboxRunRecordV1): Promise<void> {
    const dir = getRunsDir(projectPath);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${run.runId}.md`);

    // Programmatic writes often arrive as plain string arrays. Give them stable ids so
    // they round-trip through the parser and match any legacy memory items that were
    // derived from the same run under the old runId-index scheme.
    const learnedWithIds =
      run.learnedWithIds ?? run.learned?.map((content, index) => ({ id: `${run.runId}-${index}`, content }));

    await writeFile(
      path,
      renderSandboxRunReport({
        runId: run.runId,
        trigger: run.trigger,
        specVersion: run.specVersion,
        summary: run.summary,
        ...(learnedWithIds && learnedWithIds.length > 0 ? { learnedWithIds } : {}),
        triggeredAt: run.triggeredAt,
      }),
    );
  }
}
