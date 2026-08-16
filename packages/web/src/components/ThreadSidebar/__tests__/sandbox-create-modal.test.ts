/**
 * F247 AC-D1 — the "A2A 沙盒" option in the new-thread modal.
 *
 * Written from what the operator does, not from the fields I added: pick 沙盒, say what it
 * should watch, pick who runs it, create. Before this, the option existed and produced a
 * thread with no sandbox behind it — the form is the part that was missing, so the tests
 * check that the choice actually leaves the modal carrying everything a sandbox needs.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryPickerModal } from '../DirectoryPickerModal';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const TEST_CATS = [
  {
    id: 'opus',
    displayName: '布偶猫',
    nickname: '宪宪',
    breedId: 'ragdoll',
    breedDisplayName: '布偶猫',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: ['@opus'],
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    avatar: '',
    roleDescription: '',
    personality: '',
  },
];

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName: string }) => cat.displayName,
  useCatData: () => ({
    cats: TEST_CATS,
    isLoading: false,
    hasFetched: true,
    getCatById: (id: string) => TEST_CATS.find((cat) => cat.id === id),
    getCatsByBreed: () => new Map(TEST_CATS.map((cat) => [cat.breedId, [cat]])),
    refresh: async () => TEST_CATS,
  }),
}));

const CWD_PATH = '/path/to/project';

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

describe('DirectoryPickerModal — A2A sandbox creation', () => {
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
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/projects/cwd') return jsonOk({ path: CWD_PATH });
      if (path === '/api/backlog/items') return jsonOk({ items: [] });
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'fail' }) });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function render() {
    const props = { existingProjects: [] as string[], onSelect: vi.fn(), onCancel: vi.fn() };
    act(() => {
      root.render(React.createElement(DirectoryPickerModal, props));
    });
    return props;
  }

  async function flush() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  function clickText(text: string) {
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
    expect(btn, `no button matching ${text}`).toBeTruthy();
    act(() => btn?.click());
  }

  function fill(placeholderFragment: string, value: string) {
    const field = Array.from(container.querySelectorAll('input, textarea')).find((el) =>
      (el as HTMLInputElement).placeholder?.includes(placeholderFragment),
    ) as HTMLInputElement | HTMLTextAreaElement | undefined;
    expect(field, `no field with placeholder ~ ${placeholderFragment}`).toBeTruthy();
    if (!field) return;
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    act(() => {
      setter?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function openSandboxForm() {
    const props = render();
    await flush();
    clickText('A2A沙盒');
    return props;
  }

  // A sandbox thinks inside <projectPath>/.a2a-sandbox/ — memory, spec history and run
  // reports all live there. Treating it as a "lightweight" mode hid the picker entirely.
  it('asks for a project directory instead of silently landing in the lobby', async () => {
    await openSandboxForm();
    expect(container.textContent).toContain('选择项目');
    expect(container.textContent).toContain(CWD_PATH);
    expect(container.textContent).not.toContain('大厅 (无项目)');
  });

  it('carries the whole sandbox draft out of the modal', async () => {
    const props = await openSandboxForm();
    fill('沙盒名称', '港股盯盘');
    fill('目标', '每天盯住持仓的异动');
    fill('cron', '0 9 * * *');
    fill('到点', '看一遍持仓并写报告');
    clickText('布偶猫');
    clickText('创建A2A沙盒');

    expect(props.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'sandbox',
        title: '港股盯盘',
        projectPath: CWD_PATH,
        preferredCats: ['opus'],
        sandbox: expect.objectContaining({
          goal: '每天盯住持仓的异动',
          cron: '0 9 * * *',
          schedulePrompt: '看一遍持仓并写报告',
        }),
      }),
    );
  });

  // The operator should learn what is missing here, not from a 400 after the modal closed.
  it('refuses to submit an incomplete sandbox and says what is missing', async () => {
    const props = await openSandboxForm();
    fill('沙盒名称', '港股盯盘');
    clickText('布偶猫');
    clickText('创建A2A沙盒');

    expect(props.onSelect).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/目标/);
  });

  it('refuses a sandbox with nobody to run it', async () => {
    const props = await openSandboxForm();
    fill('沙盒名称', '港股盯盘');
    fill('目标', '盯住异动');
    clickText('创建A2A沙盒');

    expect(props.onSelect).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/成员/);
  });

  // Other modes must not inherit the sandbox form or its gate.
  it('leaves casual mode exactly as it was', async () => {
    const props = render();
    await flush();
    clickText('闲聊');
    expect(container.textContent).not.toContain('沙盒目标');
    clickText('创建闲聊');
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ mode: 'casual', projectPath: undefined }));
  });
});
