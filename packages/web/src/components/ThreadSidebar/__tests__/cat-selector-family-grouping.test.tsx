/**
 * Regression: members of the same model family (e.g. several GPT members the operator added)
 * must render under ONE family group in CatSelector, even though each is its own breed.
 * Before the fix, CatSelector grouped by breed → three separate "家族" headers.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';

const gptMembers: CatData[] = [
  { id: 'cat-k7noygiu', displayName: 'GPT luna', modelFamily: 'gpt', breedId: 'cat-k7noygiu' },
  { id: 'gpt', displayName: 'GPT sol', modelFamily: 'gpt', breedId: 'gpt' },
  { id: 'gpt-2', displayName: 'GPT terra', modelFamily: 'gpt', breedId: 'gpt-2' },
].map((c) => ({
  ...c,
  color: { primary: '#16a34a', secondary: '#bbf7d0' },
  clientId: 'openai',
  defaultModel: 'gpt-5.6',
  avatar: '',
  mentionPatterns: [`@${c.id}`],
  roleDescription: '',
  personality: '',
})) as CatData[];

// CatSelector groups the flat `cats` list itself via the real groupCatsByModelFamily/familyLabel
// (imported from @/lib/cat-family, not mocked), so the mock only needs to supply `cats`.
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: gptMembers,
    isLoading: false,
    getCatById: (id: string) => gptMembers.find((c) => c.id === id),
  }),
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
}));

describe('CatSelector family grouping', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders all GPT members under a single "GPT 家族" group', async () => {
    const { CatSelector } = await import('../CatSelector');
    act(() => {
      root.render(React.createElement(CatSelector, { selectedCats: [], onSelectionChange: vi.fn() }));
    });

    const headers = Array.from(container.querySelectorAll('.text-micro')).map((el) => el.textContent ?? '');
    const familyHeaders = headers.filter((t) => t.includes('家族'));
    expect(familyHeaders).toHaveLength(1);
    expect(familyHeaders[0]).toContain('GPT 家族');

    // All three members render as selectable chips within that single group.
    const chipTexts = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(chipTexts.some((t) => t.includes('GPT luna'))).toBe(true);
    expect(chipTexts.some((t) => t.includes('GPT sol'))).toBe(true);
    expect(chipTexts.some((t) => t.includes('GPT terra'))).toBe(true);
  });
});
