import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
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

async function createRouterWithThreadStore() {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const threadStore = new ThreadStore();
  const router = new AgentRouter(
    await migrateRouterOpts({
      claudeService: createNoopService('opus'),
      codexService: createNoopService('codex'),
      geminiService: createNoopService('gemini'),
      registry: createNoopRegistry(),
      messageStore: createNoopMessageStore(),
      threadStore,
    }),
  );
  return { router, threadStore };
}

const sortCats = (cats) => [...cats].sort();

describe('casual mode routing', () => {
  test('no mention routes to all routable agents and keeps all audience', async () => {
    const { router, threadStore } = await createRouterWithThreadStore();
    const thread = threadStore.create('user-1', 'Casual room');
    threadStore.updateThreadMode(thread.id, 'casual');

    const result = await router.resolveTargetsAndIntent('大家怎么看？', thread.id, { persist: true });

    assert.deepEqual(sortCats(result.targetCats), ['codex', 'gemini', 'opus']);
    assert.equal(result.intent.intent, 'ideate');
    assert.equal(result.hasMentions, false);
    assert.deepEqual(threadStore.get(thread.id).audience, { mode: 'all' });
  });

  test('@agent switches casual audience to sticky selected agent', async () => {
    const { router, threadStore } = await createRouterWithThreadStore();
    const thread = threadStore.create('user-1', 'Casual room');
    threadStore.updateThreadMode(thread.id, 'casual');

    const selected = await router.resolveTargetsAndIntent('@codex 你怎么看？', thread.id, { persist: true });
    assert.deepEqual(selected.targetCats, ['codex']);
    assert.deepEqual(threadStore.get(thread.id).audience, { mode: 'selected', agentIds: ['codex'] });

    const followUp = await router.resolveTargetsAndIntent('继续说', thread.id, { persist: true });
    assert.deepEqual(followUp.targetCats, ['codex']);
  });

  test('@all restores sticky all audience in casual mode', async () => {
    const { router, threadStore } = await createRouterWithThreadStore();
    const thread = threadStore.create('user-1', 'Casual room');
    threadStore.updateThreadMode(thread.id, 'casual');

    await router.resolveTargetsAndIntent('@codex 先说', thread.id, { persist: true });
    const restored = await router.resolveTargetsAndIntent('现在 @all 都说一下', thread.id, { persist: true });
    assert.deepEqual(sortCats(restored.targetCats), ['codex', 'gemini', 'opus']);
    assert.deepEqual(threadStore.get(thread.id).audience, { mode: 'all' });

    const followUp = await router.resolveTargetsAndIntent('继续', thread.id, { persist: true });
    assert.deepEqual(sortCats(followUp.targetCats), ['codex', 'gemini', 'opus']);
  });

  test('preferredCats scope casual all-audience participants', async () => {
    const { router, threadStore } = await createRouterWithThreadStore();
    const thread = threadStore.create('user-1', 'Casual room');
    threadStore.updateThreadMode(thread.id, 'casual');
    threadStore.updatePreferredCats(thread.id, ['codex', 'opus']);

    const firstTurn = await router.resolveTargetsAndIntent('大家怎么看？', thread.id, { persist: true });

    assert.deepEqual(sortCats(firstTurn.targetCats), ['codex', 'opus']);
    assert.deepEqual(threadStore.get(thread.id).audience, { mode: 'all' });

    const selected = await router.resolveTargetsAndIntent('@codex 你先说', thread.id, { persist: true });
    assert.deepEqual(selected.targetCats, ['codex']);
    assert.deepEqual(threadStore.get(thread.id).audience, { mode: 'selected', agentIds: ['codex'] });

    const restored = await router.resolveTargetsAndIntent('@all 都说一下', thread.id, { persist: true });
    assert.deepEqual(sortCats(restored.targetCats), ['codex', 'opus']);
    assert.deepEqual(threadStore.get(thread.id).audience, { mode: 'all' });
  });

  test('preferredCats also constrain explicit casual mentions', async () => {
    const { router, threadStore } = await createRouterWithThreadStore();
    const thread = threadStore.create('user-1', 'Casual room');
    threadStore.updateThreadMode(thread.id, 'casual');
    threadStore.updatePreferredCats(thread.id, ['codex']);

    const outOfScope = await router.resolveTargetsAndIntent('@opus 你怎么看？', thread.id, { persist: true });
    assert.deepEqual(outOfScope.targetCats, ['codex']);
    assert.equal(outOfScope.hasMentions, false);
    assert.deepEqual(threadStore.get(thread.id).audience, { mode: 'all' });

    const inScope = await router.resolveTargetsAndIntent('@codex 你怎么看？', thread.id, { persist: true });
    assert.deepEqual(inScope.targetCats, ['codex']);
    assert.equal(inScope.hasMentions, true);
    assert.deepEqual(threadStore.get(thread.id).audience, { mode: 'selected', agentIds: ['codex'] });
  });

  test('development mode keeps legacy single-agent fallback', async () => {
    const { router, threadStore } = await createRouterWithThreadStore();
    const thread = threadStore.create('user-1', 'Development room');

    const result = await router.resolveTargetsAndIntent('继续', thread.id, { persist: true });

    assert.deepEqual(result.targetCats, ['opus']);
    assert.equal(result.intent.intent, 'execute');
  });

  test('roundtable ignores mentions and routes to fixed preferredCats', async () => {
    const { router, threadStore } = await createRouterWithThreadStore();
    const thread = threadStore.create('user-1', 'Roundtable room');
    threadStore.updateThreadMode(thread.id, 'roundtable');
    threadStore.updatePreferredCats(thread.id, ['codex', 'opus']);

    const result = await router.resolveTargetsAndIntent('@gemini 你先说，然后 @codex 补充', thread.id, {
      persist: true,
    });

    assert.deepEqual(sortCats(result.targetCats), ['codex', 'opus']);
    assert.equal(result.intent.intent, 'ideate');
    assert.equal(result.intent.explicit, false);
    assert.equal(result.hasMentions, false);
    assert.deepEqual(sortCats(threadStore.getParticipants(thread.id)), ['codex', 'opus']);
  });

  test('roundtable strict point question routes only to named fixed participant', async () => {
    const { router, threadStore } = await createRouterWithThreadStore();
    const thread = threadStore.create('user-1', 'Roundtable room');
    threadStore.updateThreadMode(thread.id, 'roundtable');
    threadStore.updatePreferredCats(thread.id, ['codex', 'opus']);

    const result = await router.resolveTargetsAndIntent('只让 @codex 回答刚才这个点', thread.id, {
      persist: true,
    });

    assert.deepEqual(result.targetCats, ['codex']);
    assert.equal(result.intent.intent, 'ideate');
    assert.equal(result.intent.explicit, false);
    assert.equal(result.hasMentions, false);
    assert.deepEqual(threadStore.getParticipants(thread.id), ['codex']);
  });
});
