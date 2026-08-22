/**
 * F247 Phase E — promote a sandbox learned item to system-level evidence.
 *
 * The default isolation rule (KD-6) means this only happens when the operator explicitly
 * created the sandbox with `allowBackflow=true` and then manually promotes a specific item.
 * Nothing here is automatic: the member writes the report, the fold produces the learned item,
 * and the operator decides it is worth keeping outside the sandbox.
 */

import type { Sandbox, SandboxLearnedItemV1, SandboxLearningPromotionProvenanceV1 } from '@cat-cafe/shared';
import type { EvidenceItem, IEvidenceStore } from '../../memory/interfaces.js';
import type { ISandboxStore } from '../ports/SandboxStore.js';

export interface PromoteLearningDeps {
  sandboxStore: ISandboxStore;
  evidenceStore: IEvidenceStore;
}

export interface PromoteLearningInput {
  sandboxId: string;
  itemId: string;
}

export interface PromoteLearningResult {
  item: SandboxLearnedItemV1;
  evidenceAnchor: string;
}

/**
 * Build a stable, globally-unique evidence anchor from the sandbox/item identity.
 *
 * `sandbox:<sandboxId>:learned:<itemId>` is unique per memory item and round-trips:
 * given an anchor we can tell exactly which sandbox and which item it came from.
 */
export function buildPromotedEvidenceAnchor(sandboxId: string, itemId: string): string {
  return `sandbox:${sandboxId}:learned:${itemId}`;
}

function truncateTitle(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength - 1)}…`;
}

export function buildEvidenceItem(sandbox: Sandbox, item: SandboxLearnedItemV1): EvidenceItem {
  const evidenceAnchor = buildPromotedEvidenceAnchor(sandbox.id, item.id);
  const now = new Date().toISOString();
  return {
    anchor: evidenceAnchor,
    kind: 'lesson',
    status: 'active',
    title: truncateTitle(`${sandbox.title}: ${item.content}`, 200),
    summary: item.content,
    // sourcePath is intentionally omitted: the project directory is not the concrete
    // source file, and an absolute path would be misinterpreted as relative to repoRoot
    // by global evidence health checks. Provenance lives in `provenance.source`.
    provenance: {
      tier: 'derived',
      source: `sandbox:${sandbox.id}:run:${item.sourceRunId}`,
    },
    generalizable: true,
    updatedAt: now,
  };
}

export async function promoteSandboxLearning(
  deps: PromoteLearningDeps,
  input: PromoteLearningInput,
): Promise<PromoteLearningResult> {
  const { sandboxStore, evidenceStore } = deps;
  const { sandboxId, itemId } = input;

  const sandbox = await sandboxStore.get(sandboxId);
  if (!sandbox) {
    const err = new Error('Sandbox not found');
    (err as Error & { statusCode?: number }).statusCode = 404;
    throw err;
  }

  if (!sandbox.settings.allowBackflow) {
    const err = new Error('Sandbox does not allow backflow');
    (err as Error & { statusCode?: number }).statusCode = 409;
    throw err;
  }

  // Locate the item before touching the global evidence store. Promoting a phantom
  // item must not write an orphan evidence doc.
  const memory = await sandboxStore.getMemory(sandboxId);
  const item = memory?.learnedItems?.find((i) => i.id === itemId);
  if (!item) {
    const err = new Error('Learned item not found');
    (err as Error & { statusCode?: number }).statusCode = 404;
    throw err;
  }

  const evidenceAnchor = buildPromotedEvidenceAnchor(sandbox.id, itemId);
  const evidenceItem = buildEvidenceItem(sandbox, item);
  const fingerprint = { sourceRunId: item.sourceRunId, content: item.content };

  // Write evidence FIRST. If this fails the local item is still promotable on retry;
  // the opposite order would mark it done while leaving no system-level evidence.
  await evidenceStore.upsert([evidenceItem]);

  const promotedAt = Date.now();
  const provenance: SandboxLearningPromotionProvenanceV1 = {
    sandboxId,
    sourceRunId: item.sourceRunId,
    originalContent: item.content,
    promotedAt,
  };

  // Pass a fingerprint so the store can reject a race where fold rewrote this stable id
  // between our read above and the mark-below. Without this guard the local item could be
  // marked promoted while the evidence doc contains stale content.
  const updated = await sandboxStore.promoteLearning(sandboxId, itemId, provenance, evidenceAnchor, fingerprint);
  if (!updated) {
    // The item disappeared or changed identity between the read and the write. The evidence
    // doc already exists with a stable anchor; the operator can retry and the upsert will
    // converge to the current content. Surface the conflict rather than freezing stale data.
    const err = new Error('Learned item changed during promotion');
    (err as Error & { statusCode?: number }).statusCode = 409;
    throw err;
  }

  return { item: updated, evidenceAnchor };
}
