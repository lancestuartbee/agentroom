/**
 * F247 Phase E — promote a sandbox learned item to system-level evidence.
 *
 * The default isolation rule (KD-6) means this only happens when the operator explicitly
 * created the sandbox with `allowBackflow=true` and then manually promotes a specific item.
 * Nothing here is automatic: the member writes the report, the fold produces the learned item,
 * and the operator decides it is worth keeping outside the sandbox.
 */

import { randomUUID } from 'node:crypto';
import type {
  Sandbox,
  SandboxLearnedItemV1,
  SandboxLearningPromotionClaimV1,
  SandboxLearningPromotionProvenanceV1,
} from '@cat-cafe/shared';
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

  // Idempotent re-promote: the item is already exported, so just refresh the evidence
  // anchor and return. Do not create a new claim or rewrite provenance.
  if (item.promoted) {
    await evidenceStore.upsert([evidenceItem]);
    return { item, evidenceAnchor };
  }

  const attemptId = randomUUID();
  const attemptedAt = Date.now();
  const claim: SandboxLearningPromotionClaimV1 = {
    attemptId,
    attemptedAt,
    fingerprint,
    evidenceAnchor,
  };

  // Claim the item BEFORE writing evidence. The claim tells fold to leave this item alone
  // until we either complete or release it. If the item has already been retracted or
  // rewritten (claim returns null), we never write evidence — fold wins cleanly.
  const claimed = await sandboxStore.claimPromotion(sandboxId, itemId, claim);
  if (!claimed) {
    const err = new Error('Learned item changed during promotion');
    (err as Error & { statusCode?: number }).statusCode = 409;
    throw err;
  }

  // If the returned claim belongs to another active request, we must not share its
  // attemptId: do not write evidence and do not release someone else's claim. Surface the
  // in-progress state so the caller can retry later. A stale crashed claim is resumed by
  // claimPromotion with our own attemptId, which passes this check.
  if (claimed.promotionClaim?.attemptId !== attemptId) {
    const err = new Error('Promotion already in progress');
    (err as Error & { statusCode?: number }).statusCode = 409;
    throw err;
  }

  try {
    await evidenceStore.upsert([evidenceItem]);
  } catch (upsertErr) {
    // Evidence write failed: release the claim so the item remains promotable on retry.
    await sandboxStore.releasePromotionClaim(sandboxId, itemId, attemptId);
    throw upsertErr;
  }

  const promotedAt = Date.now();
  const provenance: SandboxLearningPromotionProvenanceV1 = {
    sandboxId,
    sourceRunId: item.sourceRunId,
    originalContent: item.content,
    promotedAt,
  };

  const updated = await sandboxStore.completePromotion(
    sandboxId,
    itemId,
    provenance,
    evidenceAnchor,
    fingerprint,
    attemptId,
  );
  if (!updated) {
    // The claim did not survive to completion (the item changed or the claim was lost).
    // Release the claim so a retry can converge; the evidence anchor is stable, so the
    // next successful promotion will overwrite it with the current content.
    await sandboxStore.releasePromotionClaim(sandboxId, itemId, attemptId);
    const err = new Error('Learned item changed during promotion');
    (err as Error & { statusCode?: number }).statusCode = 409;
    throw err;
  }

  return { item: updated, evidenceAnchor };
}
