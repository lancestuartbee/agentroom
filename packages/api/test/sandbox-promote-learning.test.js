import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const AUTH = { 'x-cat-cafe-user': 'user-1' };
const SPEC = { specVersion: '1', name: 'Stock sandbox', goal: 'g', members: ['opus'] };

function fakeThreadStore(thread) {
  return {
    get: async (id) => (id === thread.id ? thread : null),
    create: async () => thread,
    updateThreadMode: async () => {},
    updatePreferredCats: async () => {},
    updateSandboxId: async () => {},
  };
}

function fakeEvidenceStore() {
  const upserted = [];
  return {
    upsert: async (items) => {
      upserted.push(...items);
    },
    getUpserted: () => upserted,
  };
}

async function buildApp(options = {}) {
  const Fastify = (await import('fastify')).default;
  const { sandboxesRoutes } = await import('../dist/routes/sandboxes.js');
  const { InMemorySandboxStore } = await import('../dist/domains/sandbox/stores/InMemorySandboxStore.js');

  const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-promote-'));
  const projectPath = join(tmpDir, 'project');
  await mkdir(join(projectPath, '.a2a-sandbox', 'runs'), { recursive: true });

  const sandboxStore = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
  const sandbox = await sandboxStore.create(
    {
      title: 'S',
      projectPath,
      members: ['opus'],
      spec: SPEC,
      settings: { allowBackflow: options.allowBackflow ?? true },
    },
    'user-1',
  );
  await sandboxStore.bindThread(sandbox.id, 'thread-1');

  if (options.memory) {
    await sandboxStore.updateMemory(sandbox.id, options.memory);
  }

  const thread = { id: 'thread-1', createdBy: 'user-1', projectPath, mode: 'sandbox' };
  const evidenceStore = options.evidenceStore ?? fakeEvidenceStore();
  const app = Fastify();
  await app.register(sandboxesRoutes, {
    threadStore: fakeThreadStore(thread),
    sandboxStore,
    callbackRegistry: { verify: async () => ({ ok: false, reason: 'invalid' }) },
    evidenceStore,
  });

  return { app, sandboxStore, sandbox, tmpDir, evidenceStore };
}

function makeMemoryWithItem(item) {
  return {
    v: 1,
    summary: '',
    runsIncorporated: 1,
    learnedItems: [item],
    updatedAt: Date.now(),
  };
}

describe('POST /api/sandboxes/:id/learned-items/:itemId/promote', () => {
  test('promotes a learned item to global evidence and marks it in memory', async () => {
    const { app, sandbox, sandboxStore, tmpDir, evidenceStore } = await buildApp({
      memory: makeMemoryWithItem({
        id: 'r1\x1fa',
        content: 'Low turnover + volume breakout is a strong signal',
        sourceRunId: 'r1',
        sourceRunAt: 1000,
        promoted: false,
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${encodeURIComponent(sandbox.id)}/learned-items/${encodeURIComponent('r1\x1fa')}/promote`,
      headers: AUTH,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.evidenceAnchor, `sandbox:${sandbox.id}:learned:r1\x1fa`);
    assert.equal(body.item.promoted, true);
    assert.equal(body.item.promotionProvenance.sandboxId, sandbox.id);
    assert.equal(body.item.promotionProvenance.sourceRunId, 'r1');
    assert.equal(body.item.promotionProvenance.originalContent, 'Low turnover + volume breakout is a strong signal');
    assert.ok(body.item.promotionProvenance.promotedAt > 0);

    const memory = await sandboxStore.getMemory(sandbox.id);
    const storedItem = memory.learnedItems.find((i) => i.id === 'r1\x1fa');
    assert.equal(storedItem.promoted, true);
    assert.equal(storedItem.promotedEvidenceAnchor, `sandbox:${sandbox.id}:learned:r1\x1fa`);

    const upserted = evidenceStore.getUpserted();
    assert.equal(upserted.length, 1);
    assert.equal(upserted[0].anchor, `sandbox:${sandbox.id}:learned:r1\x1fa`);
    assert.equal(upserted[0].kind, 'lesson');
    assert.equal(upserted[0].status, 'active');
    assert.equal(upserted[0].generalizable, true);
    assert.equal(upserted[0].summary, 'Low turnover + volume breakout is a strong signal');
    assert.equal(upserted[0].provenance.tier, 'derived');
    assert.ok(upserted[0].provenance.source.includes('r1'));
    assert.equal(upserted[0].sourcePath, undefined, 'project directory must not be used as sourcePath');

    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('rejects promotion when allowBackflow is false', async () => {
    const { app, sandbox, tmpDir } = await buildApp({
      allowBackflow: false,
      memory: makeMemoryWithItem({
        id: 'r1\x1fa',
        content: 'A',
        sourceRunId: 'r1',
        sourceRunAt: 1000,
        promoted: false,
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${encodeURIComponent(sandbox.id)}/learned-items/${encodeURIComponent('r1\x1fa')}/promote`,
      headers: AUTH,
    });

    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.match(body.error, /backflow/i);

    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('rejects promotion from a non-owner', async () => {
    const { app, sandbox, tmpDir } = await buildApp({
      memory: makeMemoryWithItem({
        id: 'r1\x1fa',
        content: 'A',
        sourceRunId: 'r1',
        sourceRunAt: 1000,
        promoted: false,
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${encodeURIComponent(sandbox.id)}/learned-items/${encodeURIComponent('r1\x1fa')}/promote`,
      headers: { 'x-cat-cafe-user': 'someone-else' },
    });

    assert.equal(res.statusCode, 403);

    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('returns 404 when the learned item does not exist', async () => {
    const { app, sandbox, tmpDir } = await buildApp({
      memory: makeMemoryWithItem({
        id: 'r1\x1fa',
        content: 'A',
        sourceRunId: 'r1',
        sourceRunAt: 1000,
        promoted: false,
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${encodeURIComponent(sandbox.id)}/learned-items/${encodeURIComponent('missing')}/promote`,
      headers: AUTH,
    });

    assert.equal(res.statusCode, 404);

    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('is idempotent: repromoting uses the same anchor', async () => {
    const { app, sandbox, sandboxStore, tmpDir, evidenceStore } = await buildApp({
      memory: makeMemoryWithItem({
        id: 'r1\x1fa',
        content: 'A',
        sourceRunId: 'r1',
        sourceRunAt: 1000,
        promoted: false,
      }),
    });

    const url = `/api/sandboxes/${encodeURIComponent(sandbox.id)}/learned-items/${encodeURIComponent('r1\x1fa')}/promote`;
    const first = await app.inject({ method: 'POST', url, headers: AUTH });
    assert.equal(first.statusCode, 200);
    const firstAnchor = first.json().evidenceAnchor;

    const second = await app.inject({ method: 'POST', url, headers: AUTH });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().evidenceAnchor, firstAnchor);

    const upserted = evidenceStore.getUpserted();
    assert.equal(upserted.length, 2);
    assert.equal(upserted[0].anchor, upserted[1].anchor);

    const memory = await sandboxStore.getMemory(sandbox.id);
    assert.equal(memory.learnedItems[0].promoted, true);

    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('evidence store failure leaves the item promotable on retry', async () => {
    const failOnceStore = fakeEvidenceStore();
    let calls = 0;
    failOnceStore.upsert = async (items) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated evidence outage');
      failOnceStore.getUpserted().push(...items);
    };

    const { app, sandbox, sandboxStore, tmpDir, evidenceStore } = await buildApp({
      evidenceStore: failOnceStore,
      memory: makeMemoryWithItem({
        id: 'r1\x1fa',
        content: 'A',
        sourceRunId: 'r1',
        sourceRunAt: 1000,
        promoted: false,
      }),
    });

    const url = `/api/sandboxes/${encodeURIComponent(sandbox.id)}/learned-items/${encodeURIComponent('r1\x1fa')}/promote`;
    const first = await app.inject({ method: 'POST', url, headers: AUTH });
    assert.equal(first.statusCode, 500);

    const memoryAfterFailure = await sandboxStore.getMemory(sandbox.id);
    assert.equal(
      memoryAfterFailure.learnedItems[0].promoted,
      false,
      'failed evidence write must not mark item promoted',
    );

    const second = await app.inject({ method: 'POST', url, headers: AUTH });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().item.promoted, true);
    assert.equal(evidenceStore.getUpserted().length, 1);

    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
