import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the props HubCatEditor is mounted with so we can assert the wiring.
let capturedEditorProps: Record<string, unknown> | null = null;
vi.mock('../../HubCatEditor', () => ({
  HubCatEditor: (props: Record<string, unknown>) => {
    capturedEditorProps = props;
    return null;
  },
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [{ id: 'opus', mentionPatterns: ['@opus'] }], refresh: vi.fn() }),
}));
vi.mock('@/hooks/useDossierProfiles', () => ({
  useDossierProfiles: () => ({ data: null }),
  catDossierCoversStrengths: () => false,
}));
vi.mock('@/utils/api-client', () => ({
  // Config fetch is irrelevant here — the editor opens via initialEditCatId, not the members list.
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))),
}));
vi.mock('../../useConfirm', () => ({ useConfirm: () => vi.fn() }));

import { SettingsContent } from '../SettingsContent';

describe('SettingsContent → HubCatEditor wiring', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    capturedEditorProps = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('passes existingCats to the editor so catId/alias auto-uniquing can see other members', async () => {
    // Opening via initialEditCatId mounts the same <HubCatEditor> used for create; without
    // existingCats={cats} the reserved-id/alias sets are empty and dedupe silently no-ops.
    await act(async () => {
      root.render(React.createElement(SettingsContent, { section: 'members', initialEditCatId: 'opus' }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(capturedEditorProps, 'editor should mount for the deep-linked member').not.toBeNull();
    const existing = capturedEditorProps?.existingCats as Array<{ id: string }> | undefined;
    expect(existing, 'existingCats must be wired through so dedupe works').toBeTruthy();
    expect(existing?.some((c) => c.id === 'opus')).toBe(true);
  });
});
