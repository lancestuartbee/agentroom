import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

/**
 * F247 AC-D1 — a sandbox thread may only be born together with its sandbox.
 *
 * `Thread.mode === 'sandbox'` is not a label, it is a claim that `thread.sandboxId`
 * points at a real Sandbox: the run pane reads it, the dev-pane write path derives
 * authorization from it, and the scheduler delivers into it. The generic thread routes
 * happily set the mode without any of that, which produced a thread that looks like a
 * sandbox everywhere in the UI and has no brain behind it.
 *
 * Auto-creating a sandbox here is not the fix — a sandbox needs a goal and members that
 * this endpoint never receives, so it would only invent them. The contract is: refuse,
 * and say where the real door is.
 */
describe('sandbox threads are born only with a sandbox', () => {
  async function buildApp() {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');
    const app = Fastify();
    const threadStore = new ThreadStore();
    await app.register(threadsRoutes, { threadStore });
    return { app, threadStore };
  }

  test('POST /api/threads refuses mode=sandbox and leaves no orphan thread behind', async () => {
    const { app, threadStore } = await buildApp();

    const before = threadStore.list('user-1').length;
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { title: 'Stock sandbox', mode: 'sandbox' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'SANDBOX_THREAD_REQUIRES_SANDBOX');
    assert.match(res.json().error, /\/api\/sandboxes/, 'the error must point at the real creation door');
    assert.equal(
      threadStore.list('user-1').length,
      before,
      'rejection must happen before creation — a half-created sandbox thread is the bug itself',
    );

    await app.close();
  });

  test('PATCH /api/threads/:id refuses to promote an ordinary thread into sandbox mode', async () => {
    const { app, threadStore } = await buildApp();
    const thread = threadStore.create('user-1', 'Ordinary');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { mode: 'sandbox' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'SANDBOX_THREAD_REQUIRES_SANDBOX');
    assert.equal(threadStore.get(thread.id).mode, 'development', 'mode must not have moved');

    await app.close();
  });

  test('PATCH /api/threads/:id still repairs a thread that already owns a sandbox', async () => {
    const { app, threadStore } = await buildApp();
    const thread = threadStore.create('user-1', 'Real sandbox');
    threadStore.updateSandboxId(thread.id, 'sbx-1');
    threadStore.updateThreadMode(thread.id, 'casual');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { mode: 'sandbox' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(threadStore.get(thread.id).mode, 'sandbox');

    await app.close();
  });

  test('the other modes are untouched by the guard', async () => {
    const { app } = await buildApp();

    for (const mode of ['casual', 'roundtable', 'development']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: { title: `t-${mode}`, mode },
      });
      assert.equal(res.statusCode, 201, `${mode} must still be creatable`);
      assert.equal(res.json().mode, mode);
    }

    await app.close();
  });
});
