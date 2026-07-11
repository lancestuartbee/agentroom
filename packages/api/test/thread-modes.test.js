import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

describe('Thread modes', () => {
  test('ThreadStore defaults legacy-compatible mode and audience', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Regular thread');

    assert.equal(thread.mode, 'development');
    assert.deepEqual(thread.audience, { mode: 'all' });

    const defaultThread = store.get('default');
    assert.equal(defaultThread.mode, 'development');
    assert.deepEqual(defaultThread.audience, { mode: 'all' });
  });

  test('ThreadStore updates mode and normalizes audience', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Casual thread');

    store.updateThreadMode(thread.id, 'casual');
    store.updateThreadAudience(thread.id, { mode: 'selected', agentIds: ['codex', 'codex', 'opus'] });

    const updated = store.get(thread.id);
    assert.equal(updated.mode, 'casual');
    assert.deepEqual(updated.audience, { mode: 'selected', agentIds: ['codex', 'opus'] });
  });

  test('threads route accepts mode and audience on create and patch', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    const app = Fastify();
    const threadStore = new ThreadStore();
    await app.register(threadsRoutes, { threadStore });

    const createdResponse = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        title: 'Casual room',
        mode: 'casual',
        audience: { mode: 'selected', agentIds: ['codex'] },
        preferredCats: ['codex', 'opus'],
      },
    });

    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json();
    assert.equal(created.mode, 'casual');
    assert.deepEqual(created.audience, { mode: 'selected', agentIds: ['codex'] });
    assert.deepEqual(created.preferredCats, ['codex', 'opus']);

    const patchedResponse = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        mode: 'roundtable',
        audience: { mode: 'all' },
      },
    });

    assert.equal(patchedResponse.statusCode, 200);
    const patched = patchedResponse.json();
    assert.equal(patched.mode, 'roundtable');
    assert.deepEqual(patched.audience, { mode: 'all' });
  });
});
