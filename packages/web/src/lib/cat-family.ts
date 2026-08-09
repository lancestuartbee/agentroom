import type { CatData } from '@/hooks/useCatData';

/** Display label for a model-family key (gpt → GPT, claude → Claude, …). */
export function familyLabel(family?: string): string {
  switch (family) {
    case 'claude':
      return 'Claude';
    case 'gpt':
      return 'GPT';
    case 'gemini':
      return 'Gemini';
    case 'kimi':
      return 'Kimi';
    case 'opencode':
      return 'OpenCode';
    case 'dare':
      return 'Dare';
    default:
      return family ?? '未知';
  }
}

/**
 * Group cats by model family. Post model-member migration, each user-created member is its own
 * breed, so grouping by breed splits same-family members (e.g. several GPT members). Grouping by
 * model family (all "gpt") keeps them under one header. Members without a modelFamily fall back to
 * a breed-namespaced key so a stray breed id can't collide with a real family key.
 *
 * Lives outside useCatData so consumers can group the flat `cats` list without the hook needing a
 * new method — that would break every partial useCatData mock in the suite.
 */
export function groupCatsByModelFamily(cats: CatData[]): Map<string, CatData[]> {
  const groups = new Map<string, CatData[]>();
  for (const cat of cats) {
    const key = cat.modelFamily ? `family:${cat.modelFamily}` : `breed:${cat.breedId ?? cat.id}`;
    const arr = groups.get(key) ?? [];
    arr.push(cat);
    groups.set(key, arr);
  }
  return groups;
}
