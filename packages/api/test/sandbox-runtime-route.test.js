import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, rm, mkdir, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUTH = { 'x-cat-cafe-user': 'user-1' };
const SPEC = { specVersion: '1', name: 'Stock sandbox', goal: 'g', members: ['opus'] };

/** Minimal thread store: the routes only need ownership resolution. */
function fakeThreadStore(thread) {
  return {
    get: async (id) => (id === thread.id ? thread : null),
    create: async () => thread,
    updateThreadMode: async () => {},
    updatePreferredCats: async () => {},
    updateSandboxId: async () => {},
  };
}

async function buildApp() {
  const Fastify = (await import('fastify')).default;
  const { sandboxesRoutes } = await import('../dist/routes/sandboxes.js');
  const { InMemorySandboxStore } = await import(
    '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
  );

  const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-route-'));
  const projectPath = join(tmpDir, 'project');
  const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
  await mkdir(runsDir, { recursive: true });

  const sandboxStore = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
  const sandbox = await sandboxStore.create(
    { title: 'S', projectPath, members: ['opus'], spec: SPEC },
    'user-1',
  );
  await sandboxStore.bindThread(sandbox.id, 'thread-1');

  const thread = { id: 'thread-1', createdBy: 'user-1', projectPath, mode: 'sandbox' };
  const app = Fastify();
  await app.register(sandboxesRoutes, { threadStore: fakeThreadStore(thread), sandboxStore });

  return { app, sandboxStore, sandbox, tmpDir, runsDir };
}

async function writeReport(runsDir, runId, { summary, learned, triggeredAt }) {
  const { renderSandboxRunReport } = await import(
    '../dist/domains/sandbox/services/sandbox-run-prompt.js'
  );
  await writeFile(
    join(runsDir, `${runId}.md`),
    renderSandboxRunReport({ runId, trigger: 'scheduled', specVersion: '1', summary, learned, triggeredAt }),
    'utf-8',
  );
}

describe('GET /api/sandboxes/:id/runtime', () => {
  test('returns what the run pane shows: sandbox, memory and newest-first history', async () => {
    const { app, sandbox, tmpDir, runsDir } = await buildApp();

    await writeReport(runsDir, 'run-1', { summary: 'day one', learned: ['A'], triggeredAt: 1000 });
    await writeReport(runsDir, 'run-2', { summary: 'day two', learned: ['B'], triggeredAt: 2000 });

    const res = await app.inject({ method: 'GET', url: `/api/sandboxes/${sandbox.id}/runtime`, headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.equal(body.sandbox.id, sandbox.id);
    assert.equal(body.runsAvailable, true);
    assert.deepEqual(
      body.runs.map((r) => r.runId),
      ['run-2', 'run-1'],
      'the run pane reads top-down, so the newest run comes first',
    );
    assert.ok(body.memory, 'memory is part of the run pane state');

    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // listRuns() throws on a real read fault by design. The run pane must degrade
  // visibly — an empty history would read as "this sandbox has never run", which is
  // the exact confusion that contract exists to prevent.
  test('a disk fault degrades visibly instead of looking like an empty history', async () => {
    const { app, sandbox, tmpDir, runsDir } = await buildApp();
    await writeReport(runsDir, 'run-1', { summary: 's', learned: ['A'], triggeredAt: 1000 });

    await chmod(runsDir, 0o000);
    try {
      const res = await app.inject({ method: 'GET', url: `/api/sandboxes/${sandbox.id}/runtime`, headers: AUTH });
      assert.equal(res.statusCode, 200, 'the sandbox itself is still viewable');
      const body = res.json();
      assert.equal(body.runsAvailable, false, 'the pane must be able to tell "unreadable" from "none"');
      assert.ok(body.runsError);
      assert.ok(body.sandbox, 'spec and settings remain visible during a read fault');
    } finally {
      await chmod(runsDir, 0o755);
      await app.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('rejects a caller who does not own the bound thread', async () => {
    const { app, sandbox, tmpDir } = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `/api/sandboxes/${sandbox.id}/runtime`,
      headers: { 'x-cat-cafe-user': 'someone-else' },
    });
    assert.equal(res.statusCode, 403);

    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('requires identity', async () => {
    const { app, sandbox, tmpDir } = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/sandboxes/${sandbox.id}/runtime` });
    assert.equal(res.statusCode, 401);
    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
