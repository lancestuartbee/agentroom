import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_SPEC = {
  specVersion: '1',
  name: 'Stock sandbox',
  goal: 'GOAL_ORIGINAL_盯A股大盘',
  learningGoal: '沉淀选股信号',
  members: ['opus', 'kimi'],
};

async function setup() {
  const { InMemorySandboxStore } = await import(
    '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
  );
  const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-tpl-'));
  const projectPath = join(tmpDir, 'project');
  await mkdir(projectPath, { recursive: true });

  const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
  const sandbox = await store.create(
    { title: 'S', projectPath, members: ['opus', 'kimi'], spec: BASE_SPEC },
    'user-1',
  );
  await store.bindThread(sandbox.id, 'thread-1');
  return { store, sandbox, tmpDir };
}

/** Minimal ExecuteContext double that records what the scheduler would have sent. */
function makeCtx(store) {
  const delivered = [];
  const woken = [];
  return {
    ctx: {
      assignedCatId: null,
      sandboxStore: store,
      async deliver(opts) {
        delivered.push(opts);
        return `msg-${delivered.length}`;
      },
      invokeTrigger: {
        trigger(threadId, catId, userId, content, messageId) {
          woken.push({ threadId, catId, userId, messageId });
          return Promise.resolve('dispatched');
        },
      },
    },
    delivered,
    woken,
  };
}

describe('Sandbox run template', () => {
  test('dev-pane spec edits take effect on the NEXT run without re-registering the schedule', async () => {
    const { sandboxRunTemplate, buildSandboxRunInstanceId } = await import(
      '../dist/infrastructure/scheduler/templates/sandbox-run.js'
    );
    const { store, sandbox, tmpDir } = await setup();

    // Schedule is registered ONCE, here.
    const spec = sandboxRunTemplate.createSpec(buildSandboxRunInstanceId(sandbox.id), {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { sandboxId: sandbox.id, triggerUserId: 'user-1' },
      deliveryThreadId: 'thread-1',
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);

    const first = makeCtx(store);
    await spec.run.execute(sandbox.id, 'thread-thread-1', first.ctx);
    assert.equal(first.delivered.length, 1);
    assert.match(first.delivered[0].content, /GOAL_ORIGINAL_盯A股大盘/);

    // User edits the spec in the dev pane. The schedule is NOT touched.
    await store.updateSpec(sandbox.id, { spec: { goal: 'GOAL_EDITED_改盯港股' } });

    const second = makeCtx(store);
    await spec.run.execute(sandbox.id, 'thread-thread-1', second.ctx);
    assert.match(
      second.delivered[0].content,
      /GOAL_EDITED_改盯港股/,
      'the run must pick up the edited spec at fire time',
    );
    assert.doesNotMatch(
      second.delivered[0].content,
      /GOAL_ORIGINAL_盯A股大盘/,
      'the run must not use the spec frozen at registration time',
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('wakes a sandbox member in the bound thread', async () => {
    const { sandboxRunTemplate, buildSandboxRunInstanceId } = await import(
      '../dist/infrastructure/scheduler/templates/sandbox-run.js'
    );
    const { store, sandbox, tmpDir } = await setup();

    const spec = sandboxRunTemplate.createSpec(buildSandboxRunInstanceId(sandbox.id), {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { sandboxId: sandbox.id, triggerUserId: 'user-1' },
      deliveryThreadId: 'thread-1',
    });

    const { ctx, woken } = makeCtx(store);
    await spec.run.execute(sandbox.id, 'thread-thread-1', ctx);

    assert.equal(woken.length, 1);
    assert.equal(woken[0].threadId, 'thread-1');
    assert.equal(woken[0].catId, 'opus', 'v1 runs with the first declared member');
    assert.equal(woken[0].userId, 'user-1', 'run is attributed to the sandbox owner, not "scheduler"');

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('paused sandbox does not wake anyone', async () => {
    const { sandboxRunTemplate, buildSandboxRunInstanceId } = await import(
      '../dist/infrastructure/scheduler/templates/sandbox-run.js'
    );
    const { store, sandbox, tmpDir } = await setup();
    await store.updateStatus(sandbox.id, { status: 'paused' });

    const spec = sandboxRunTemplate.createSpec(buildSandboxRunInstanceId(sandbox.id), {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { sandboxId: sandbox.id, triggerUserId: 'user-1' },
      deliveryThreadId: 'thread-1',
    });

    const { ctx, delivered, woken } = makeCtx(store);
    await spec.run.execute(sandbox.id, 'thread-thread-1', ctx);

    assert.equal(delivered.length, 0);
    assert.equal(woken.length, 0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('defers while the thread is busy (user mid-edit in the dev pane)', async () => {
    const { sandboxRunTemplate, buildSandboxRunInstanceId } = await import(
      '../dist/infrastructure/scheduler/templates/sandbox-run.js'
    );
    const { sandbox, tmpDir } = await setup();

    const spec = sandboxRunTemplate.createSpec(buildSandboxRunInstanceId(sandbox.id), {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { sandboxId: sandbox.id },
      deliveryThreadId: 'thread-1',
    });

    assert.equal(spec.firePolicy?.deferWhileThreadBusy, true);
    assert.equal(spec.firePolicy?.threadId, 'thread-1');

    // Security parity with reminder.ts: a forged public `dyn-*` id cannot enable defer.
    const forged = sandboxRunTemplate.createSpec('dyn-forged', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { sandboxId: sandbox.id },
      deliveryThreadId: 'thread-1',
    });
    assert.equal(forged.firePolicy, undefined);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
