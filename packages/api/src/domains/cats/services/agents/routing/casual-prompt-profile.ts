import type { CatId, ContextBudget } from '@cat-cafe/shared';
import { getCatContextBudget } from '../../../../../config/cat-budgets.js';
import { resolveThreadArtifactPaths } from '../../../../../utils/artifact-store-paths.js';
import { buildCasualStaticIdentity } from '../../context/SystemPromptBuilder.js';
import type { PromptProfile } from '../../types.js';
import { isCasualModePrompt } from './prompt-segment-diagnostics.js';

export const CASUAL_CONTEXT_BUDGET: ContextBudget = {
  maxPromptTokens: 3200,
  maxContextTokens: 900,
  maxMessages: 8,
  maxContentLengthPerMsg: 1200,
};

export function resolvePromptProfile(
  promptProfile: PromptProfile | undefined,
  modeSystemPrompt: string | undefined,
): PromptProfile {
  if (promptProfile === 'casual' || isCasualModePrompt(modeSystemPrompt)) return 'casual';
  return 'development';
}

export function getPromptProfileContextBudget(catId: string, promptProfile: PromptProfile): ContextBudget {
  if (promptProfile === 'casual') return CASUAL_CONTEXT_BUDGET;
  return getCatContextBudget(catId);
}

export function buildPromptProfileStaticIdentity(
  catId: CatId,
  threadId: string,
  promptProfile: PromptProfile,
  fallback: () => string,
): string {
  if (promptProfile !== 'casual') return fallback();
  const artifactPaths = resolveThreadArtifactPaths(threadId);
  return buildCasualStaticIdentity(catId, { reportsDir: artifactPaths.reportsDir });
}
