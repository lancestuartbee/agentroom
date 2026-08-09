import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { groupCatsByModelFamily } from '@/lib/cat-family';

function cat(id: string, modelFamily: string | undefined, breedId: string): CatData {
  return {
    id,
    displayName: id,
    color: { primary: '#000000', secondary: '#ffffff' },
    breedId,
    clientId: 'openai',
    defaultModel: 'gpt-5.6',
    avatar: '',
    mentionPatterns: [`@${id}`],
    roleDescription: '',
    personality: '',
    ...(modelFamily ? { modelFamily } : {}),
  } as CatData;
}

describe('groupCatsByModelFamily', () => {
  it('groups same-model-family members together even when they are separate breeds', () => {
    // Repro: three GPT members the operator added — each is its own breed (catId-derived), but
    // all share modelFamily "gpt". They must land in ONE group, not three.
    const cats = [cat('cat-k7noygiu', 'gpt', 'cat-k7noygiu'), cat('gpt', 'gpt', 'gpt'), cat('gpt-2', 'gpt', 'gpt-2')];
    const groups = groupCatsByModelFamily(cats);
    expect(groups.size).toBe(1);
    expect(groups.get('family:gpt')?.map((c) => c.id)).toEqual(['cat-k7noygiu', 'gpt', 'gpt-2']);
  });

  it('keeps different model families in separate groups', () => {
    const groups = groupCatsByModelFamily([cat('opus', 'claude', 'ragdoll'), cat('gpt', 'gpt', 'gpt')]);
    expect([...groups.keys()].sort()).toEqual(['family:claude', 'family:gpt']);
  });

  it('falls back to a breed-namespaced key when modelFamily is absent', () => {
    const groups = groupCatsByModelFamily([cat('x', undefined, 'ragdoll'), cat('y', undefined, 'ragdoll')]);
    expect(groups.size).toBe(1);
    expect(groups.get('breed:ragdoll')?.length).toBe(2);
  });

  it('does not merge a model family with a breed id that shares its name', () => {
    // Namespaced keys: a "gpt" model family and a breed literally named "gpt" (on a member with
    // no modelFamily) must stay separate rather than collide in the shared Map namespace.
    const groups = groupCatsByModelFamily([cat('a', 'gpt', 'cat-x'), cat('b', undefined, 'gpt')]);
    expect(groups.size).toBe(2);
    expect(groups.get('family:gpt')?.map((c) => c.id)).toEqual(['a']);
    expect(groups.get('breed:gpt')?.map((c) => c.id)).toEqual(['b']);
  });
});
