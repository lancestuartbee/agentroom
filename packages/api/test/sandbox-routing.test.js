import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';

function createNoopService(catId) {
  return {
    invoke: async function* () {
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createNoopRegistry() {
  return {
    create: () => ({ invocationId: 'inv-1', callbackToken: 'cb-1' }),
    update: () => {},
    get: () => null,
  };
}

function createNoopMessageStore() {
  return {
    append: () => ({}),
    getRecent: () => [],
    getMentionsFor: () => [],
    getByThread: () => [],
    getByThreadBefore: () => [],
    getByThreadAfter: () => [],
    getById: () => null,
    updateExtra: () => null,
    softDelete: () => null,
    restore: () => null,
  };
}

async function createRouterWithSandboxStore() {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { InMemorySandboxStore } = await import('../dist/domains/sandbox/stores/InMemorySandboxStore.js');

  const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-routing-'));
  const projectPath = join(tmpDir, 'project');
  await mkdir(join(projectPath, '.a2a-sandbox', 'runs'), { recursive: true });

  const threadStore = new ThreadStore();
  const sandboxStore = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });

  const router = new AgentRouter(
    await migrateRouterOpts({
      claudeService: createNoopService('opus'),
      codexService: createNoopService('codex'),
      geminiService: createNoopService('gemini'),
      registry: createNoopRegistry(),
      messageStore: createNoopMessageStore(),
      threadStore,
      sandboxStore,
    }),
  );

  return { router, threadStore, sandboxStore, tmpDir, projectPath };
}

const sortCats = (cats) => [...cats].sort();

describe('sandbox mode routing (F247 AC-B2)', () => {
  test('routes to all Sandbox.members when no mention is given', async () => {
    const { router, threadStore, sandboxStore, projectPath } = await createRouterWithSandboxStore();
    const sandbox = await sandboxStore.create(
      {
        title: 'Stock sandbox',
        projectPath,
        members: ['opus', 'gemini'],
        spec: { specVersion: '1', name: 'S', goal: 'g', members: ['opus', 'gemini'] },
      },
      'user-1',
    );
    const thread = threadStore.create('user-1', 'Stock sandbox', projectPath);
    threadStore.updateThreadMode(thread.id, 'sandbox');
    threadStore.updatePreferredCats(thread.id, ['opus', 'gemini']);
    threadStore.updateSandboxId(thread.id, sandbox.id);
    await sandboxStore.bindThread(sandbox.id, thread.id);

    const result = await router.resolveTargetsAndIntent('今天调研什么主题？', thread.id);

    assert.deepEqual(sortCats(result.targetCats), ['gemini', 'opus']);
    assert.equal(result.intent.intent, 'ideate');

    await rm(projectPath, { recursive: true, force: true });
  });

  test('out-of-sandbox mentions are ignored and fall back to all members', async () => {
    const { router, threadStore, sandboxStore, projectPath } = await createRouterWithSandboxStore();
    const sandbox = await sandboxStore.create(
      {
        title: 'Stock sandbox',
        projectPath,
        members: ['opus'],
        spec: { specVersion: '1', name: 'S', goal: 'g', members: ['opus'] },
      },
      'user-1',
    );
    const thread = threadStore.create('user-1', 'Stock sandbox', projectPath);
    threadStore.updateThreadMode(thread.id, 'sandbox');
    threadStore.updatePreferredCats(thread.id, ['opus']);
    threadStore.updateSandboxId(thread.id, sandbox.id);
    await sandboxStore.bindThread(sandbox.id, thread.id);

    // codex is a real cat but not a sandbox member; it must not route there.
    const result = await router.resolveTargetsAndIntent('@codex 你来调研', thread.id);

    assert.deepEqual(result.targetCats, ['opus']);
    assert.equal(result.hasMentions, false);

    await rm(projectPath, { recursive: true, force: true });
  });

  test('uses Sandbox.members even when Thread.preferredCats has been tampered with', async () => {
    const { router, threadStore, sandboxStore, projectPath } = await createRouterWithSandboxStore();
    const sandbox = await sandboxStore.create(
      {
        title: 'Stock sandbox',
        projectPath,
        members: ['opus', 'gemini'],
        spec: { specVersion: '1', name: 'S', goal: 'g', members: ['opus', 'gemini'] },
      },
      'user-1',
    );
    const thread = threadStore.create('user-1', 'Stock sandbox', projectPath);
    threadStore.updateThreadMode(thread.id, 'sandbox');
    // Simulate a bypass: someone somehow changed the thread copy.
    threadStore.updatePreferredCats(thread.id, ['opus', 'codex']);
    threadStore.updateSandboxId(thread.id, sandbox.id);
    await sandboxStore.bindThread(sandbox.id, thread.id);

    const result = await router.resolveTargetsAndIntent('大家怎么看？', thread.id);

    // Authority is Sandbox.members, not the stale/tampered thread copy.
    assert.deepEqual(sortCats(result.targetCats), ['gemini', 'opus']);
    assert.ok(!result.targetCats.includes('codex'));

    await rm(projectPath, { recursive: true, force: true });
  });

  test('intra-sandbox mention routes to that member only', async () => {
    const { router, threadStore, sandboxStore, projectPath } = await createRouterWithSandboxStore();
    const sandbox = await sandboxStore.create(
      {
        title: 'Stock sandbox',
        projectPath,
        members: ['opus', 'gemini'],
        spec: { specVersion: '1', name: 'S', goal: 'g', members: ['opus', 'gemini'] },
      },
      'user-1',
    );
    const thread = threadStore.create('user-1', 'Stock sandbox', projectPath);
    threadStore.updateThreadMode(thread.id, 'sandbox');
    threadStore.updatePreferredCats(thread.id, ['opus', 'gemini']);
    threadStore.updateSandboxId(thread.id, sandbox.id);
    await sandboxStore.bindThread(sandbox.id, thread.id);

    const result = await router.resolveTargetsAndIntent('@gemini 你负责数据', thread.id);

    assert.deepEqual(result.targetCats, ['gemini']);
    assert.equal(result.hasMentions, true);

    await rm(projectPath, { recursive: true, force: true });
  });
});
