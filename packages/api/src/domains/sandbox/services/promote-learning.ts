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
    sourcePath: sandbox.projectPath,
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

  const evidenceAnchor = buildPromotedEvidenceAnchor(sandbox.id, itemId);
  const promotedAt = Date.now();
  const provenance: SandboxLearningPromotionProvenanceV1 = {
    sandboxId,
    sourceRunId: '', // filled in after we locate the item
    originalContent: '',
    promotedAt,
  };

  // First mark the item in memory. If the item does not exist we stop before touching
  // the global evidence store — promoting a phantom item would be a worse failure than
  // returning a 404.
  const item = await sandboxStore.promoteLearning(sandboxId, itemId, provenance, evidenceAnchor);
  if (!item) {
    const err = new Error('Learned item not found');
    (err as Error & { statusCode?: number }).statusCode = 404;
    throw err;
  }

  // Now that we have the real sourceRunId and content, update the provenance and write
  // the evidence item. We re-call promoteLearning to persist the corrected provenance.
  const correctedProvenance: SandboxLearningPromotionProvenanceV1 = {
    sandboxId,
    sourceRunId: item.sourceRunId,
    originalContent: item.content,
    promotedAt,
  };
  const correctedItem = await sandboxStore.promoteLearning(sandboxId, itemId, correctedProvenance, evidenceAnchor);
  if (!correctedItem) {
    // Extremely unlikely: the item was deleted between the two calls. Roll back the
    // evidence write by not performing it and surface the failure.
    const err = new Error('Learned item disappeared during promotion');
    (err as Error & { statusCode?: number }).statusCode = 500;
    throw err;
  }

  const evidenceItem = buildEvidenceItem(sandbox, correctedItem);
  await evidenceStore.upsert([evidenceItem]);

  return { item: correctedItem, evidenceAnchor };
}
