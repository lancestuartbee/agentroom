import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function makeDeps() {
  const registered = new Map();
  const inserted = new Map();
  const triggered = [];
  return {
    deps: {
      dynamicTaskStore: {
        insert: (def) => inserted.set(def.id, def),
        remove: (id) => inserted.delete(id),
        getById: (id) => inserted.get(id) ?? null,
      },
      taskRunner: {
        registerDynamic: (spec, id) => registered.set(id, spec),
        unregister: (id) => registered.delete(id),
        triggerNow: async (id, opts) => triggered.push({ id, opts }),
      },
    },
    registered,
    inserted,
    triggered,
  };
}

const sandboxWith = (schedule, status = 'active') => ({
  id: 'sandbox:sb-abc',
  title: 'S',
  projectPath: '/tmp/p',
  threadId: 'thread-1',
  createdBy: 'user-1',
  members: ['opus'],
  status,
  spec: {
    specVersion: '1',
    name: 'S',
    goal: 'g',
    members: ['opus'],
    ...(schedule ? { schedule } : {}),
  },
  settings: { allowBackflow: false, autoStartSchedule: true, maxRunLogs: 100 },
  createdAt: 1,
  updatedAt: 1,
});

describe('Sandbox schedule sync', () => {
  test('registers a cron task when the spec declares a schedule', async () => {
    const { syncSandboxSchedule } = await import(
      '../dist/domains/sandbox/services/sandbox-schedule.js'
    );
    const { registered, inserted, deps } = makeDeps();

    const result = await syncSandboxSchedule(
      sandboxWith({ cron: '0 9 * * *', prompt: 'run', timezone: 'Asia/Shanghai' }),
      deps,
    );

    assert.equal(result.action, 'registered');
    assert.equal(registered.size, 1);
    const [id, spec] = [...registered.entries()][0];
    assert.match(id, /^sandbox-run-/);
    assert.equal(spec.trigger.type, 'cron');
    assert.equal(spec.trigger.expression, '0 9 * * *');
    // Real slow-run against a real market: the timezone must survive to the trigger.
    assert.equal(spec.trigger.timezone, 'Asia/Shanghai');
    assert.equal(inserted.size, 1, 'task must be persisted so it survives restart');
  });

  test('re-syncing after a cron edit replaces the task instead of stacking duplicates', async () => {
    const { syncSandboxSchedule } = await import(
      '../dist/domains/sandbox/services/sandbox-schedule.js'
    );
    const { registered, deps } = makeDeps();

    await syncSandboxSchedule(sandboxWith({ cron: '0 9 * * *', prompt: 'run' }), deps);
    await syncSandboxSchedule(sandboxWith({ cron: '30 16 * * *', prompt: 'run' }), deps);

    assert.equal(registered.size, 1, 'editing the cron must not leave two schedules firing');
    const spec = [...registered.values()][0];
    assert.equal(spec.trigger.expression, '30 16 * * *');
  });

  test('unregisters when the schedule is removed or the sandbox is paused', async () => {
    const { syncSandboxSchedule } = await import(
      '../dist/domains/sandbox/services/sandbox-schedule.js'
    );

    const a = makeDeps();
    await syncSandboxSchedule(sandboxWith({ cron: '0 9 * * *', prompt: 'r' }), a.deps);
    const removed = await syncSandboxSchedule(sandboxWith(null), a.deps);
    assert.equal(removed.action, 'unregistered');
    assert.equal(a.registered.size, 0);

    const b = makeDeps();
    await syncSandboxSchedule(sandboxWith({ cron: '0 9 * * *', prompt: 'r' }), b.deps);
    const paused = await syncSandboxSchedule(
      sandboxWith({ cron: '0 9 * * *', prompt: 'r' }, 'paused'),
      b.deps,
    );
    assert.equal(paused.action, 'unregistered');
    assert.equal(b.registered.size, 0, 'a paused sandbox must not keep firing daily');
  });

  test('manual trigger runs the sandbox now, registering on demand if needed', async () => {
    const { triggerSandboxRunNow } = await import(
      '../dist/domains/sandbox/services/sandbox-schedule.js'
    );
    const { triggered, registered, deps } = makeDeps();

    await triggerSandboxRunNow(sandboxWith({ cron: '0 9 * * *', prompt: 'r' }), deps);

    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].opts?.manual, true);
    assert.equal(registered.size, 1);
  });

  test('manual trigger works even when the sandbox has no cron at all', async () => {
    const { triggerSandboxRunNow } = await import(
      '../dist/domains/sandbox/services/sandbox-schedule.js'
    );
    const { triggered, deps } = makeDeps();

    // A sandbox with no schedule is still runnable on demand from the run pane.
    await triggerSandboxRunNow(sandboxWith(null), deps);
    assert.equal(triggered.length, 1);
  });
});
