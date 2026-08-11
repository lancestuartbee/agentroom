import type { CatId, ContextBudget } from '@cat-cafe/shared';
import { getCatContextBudget } from '../../../../../config/cat-budgets.js';
import { resolveThreadArtifactPaths } from '../../../../../utils/artifact-store-paths.js';
import {
  buildCasualStaticIdentity,
  buildRoundtableStaticIdentity,
  buildSandboxStaticIdentity,
} from '../../context/SystemPromptBuilder.js';
import type { PromptProfile } from '../../types.js';
import { isCasualModePrompt } from './prompt-segment-diagnostics.js';

export const CASUAL_CONTEXT_BUDGET: ContextBudget = {
  maxPromptTokens: 3200,
  maxContextTokens: 900,
  maxMessages: 8,
  maxContentLengthPerMsg: 1200,
};

export const ROUNDTABLE_CONTEXT_BUDGET: ContextBudget = {
  maxPromptTokens: 32000,
  maxContextTokens: 18000,
  maxMessages: 180,
  maxContentLengthPerMsg: 5000,
};

/**
 * F247: a sandbox run does real project work over months, so it needs far more working
 * context than casual chat — but still without the full development worldview. Sized
 * between the two deliberately: light on inherited setup, generous on task context.
 */
export const SANDBOX_CONTEXT_BUDGET: ContextBudget = {
  maxPromptTokens: 24000,
  maxContextTokens: 12000,
  maxMessages: 60,
  maxContentLengthPerMsg: 4000,
};

export function resolvePromptProfile(
  promptProfile: PromptProfile | undefined,
  modeSystemPrompt: string | undefined,
): PromptProfile {
  if (promptProfile === 'roundtable') return 'roundtable';
  // F247: without this branch, sandbox silently resolved back to 'development' and its
  // members loaded the full compiled L0 — the exact worldview inheritance the mode exists
  // to avoid.
  if (promptProfile === 'sandbox') return 'sandbox';
  if (promptProfile === 'casual' || isCasualModePrompt(modeSystemPrompt)) return 'casual';
  return 'development';
}

export function getPromptProfileContextBudget(catId: string, promptProfile: PromptProfile): ContextBudget {
  if (promptProfile === 'casual') return CASUAL_CONTEXT_BUDGET;
  if (promptProfile === 'roundtable') return ROUNDTABLE_CONTEXT_BUDGET;
  if (promptProfile === 'sandbox') return SANDBOX_CONTEXT_BUDGET;
  return getCatContextBudget(catId);
}

export function buildPromptProfileStaticIdentity(
  catId: CatId,
  threadId: string,
  promptProfile: PromptProfile,
  fallback: () => string,
  sandbox?: { name?: string | undefined; projectPath?: string | undefined },
): string {
  if (promptProfile === 'roundtable') {
    const artifactPaths = resolveThreadArtifactPaths(threadId);
    return buildRoundtableStaticIdentity(catId, { reportsDir: artifactPaths.reportsDir });
  }
  if (promptProfile === 'sandbox') {
    return buildSandboxStaticIdentity(catId, {
      sandboxName: sandbox?.name,
      projectPath: sandbox?.projectPath,
    });
  }
  if (promptProfile !== 'casual') return fallback();
  const artifactPaths = resolveThreadArtifactPaths(threadId);
  return buildCasualStaticIdentity(catId, { reportsDir: artifactPaths.reportsDir });
}
