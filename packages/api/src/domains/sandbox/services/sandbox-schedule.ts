import type { Sandbox } from '@cat-cafe/shared';
import {
  buildSandboxRunInstanceId,
  sandboxRunTemplate,
} from '../../../infrastructure/scheduler/templates/sandbox-run.js';
import type { TaskSpec_P1 } from '../../../infrastructure/scheduler/types.js';

/**
 * F247 Phase C — keeping the run pane's schedule in sync with the dev pane's spec.
 *
 * The sandbox schedule is derived state: `spec.schedule` is the single source of truth,
 * and the registered cron task is only a projection of it. Every mutation path
 * (create / spec edit / pause / resume) calls `syncSandboxSchedule()` and lets it
 * converge, rather than each path hand-rolling register/unregister — which is how you
 * end up with two cron tasks firing for one sandbox after an edit.
 */

/** Narrow slices of the scheduler surface, so this stays unit-testable without a live runner. */
export interface SandboxScheduleDeps {
  dynamicTaskStore: {
    insert: (def: SandboxDynamicTaskDef) => void;
    remove: (id: string) => unknown;
    getById: (id: string) => unknown;
  };
  taskRunner: {
    registerDynamic: (spec: TaskSpec_P1, dynamicDefId: string) => void;
    unregister: (taskId: string) => unknown;
    triggerNow: (taskId: string, opts?: { manual?: boolean }) => Promise<void>;
  };
}

export interface SandboxDynamicTaskDef {
  id: string;
  templateId: string;
  trigger: { type: 'cron'; expression: string; timezone?: string };
  params: Record<string, unknown>;
  display: { label: string; category: 'thread'; description: string };
  deliveryThreadId: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

export type SandboxScheduleAction = 'registered' | 'unregistered' | 'noop';

export interface SandboxScheduleResult {
  action: SandboxScheduleAction;
  taskId: string;
}

/** A sandbox should be firing on cron only while it is active AND declares a cron. */
function shouldRunOnSchedule(sandbox: Sandbox): boolean {
  return sandbox.status === 'active' && Boolean(sandbox.spec.schedule?.cron);
}

function buildTaskDef(sandbox: Sandbox, taskId: string): SandboxDynamicTaskDef {
  const schedule = sandbox.spec.schedule;
  return {
    id: taskId,
    templateId: sandboxRunTemplate.templateId,
    trigger: {
      type: 'cron',
      expression: schedule?.cron ?? '0 9 * * *',
      // A real-time slow run against a real market lives or dies on the timezone:
      // "09:00" means nothing without it. Carry it all the way to the trigger.
      ...(schedule?.timezone ? { timezone: schedule.timezone } : {}),
    },
    params: { sandboxId: sandbox.id, triggerUserId: sandbox.createdBy },
    display: {
      label: `沙盒运行 · ${sandbox.title}`,
      category: 'thread',
      description: sandbox.spec.goal.slice(0, 200),
    },
    deliveryThreadId: sandbox.threadId,
    enabled: true,
    createdBy: sandbox.createdBy,
    createdAt: new Date().toISOString(),
  };
}

function registerRunTask(sandbox: Sandbox, taskId: string, deps: SandboxScheduleDeps): void {
  const def = buildTaskDef(sandbox, taskId);

  // Converge, don't accumulate: drop any prior projection before installing the new one,
  // otherwise a cron edit leaves the old schedule firing alongside the new one.
  deps.taskRunner.unregister(taskId);
  deps.dynamicTaskStore.remove(taskId);

  deps.dynamicTaskStore.insert(def);
  const spec = sandboxRunTemplate.createSpec(taskId, {
    trigger: def.trigger,
    params: def.params,
    deliveryThreadId: def.deliveryThreadId,
  });
  deps.taskRunner.registerDynamic(spec, taskId);
}

/**
 * Converge the registered cron task to whatever `spec.schedule` + status now say.
 * Safe to call on every sandbox mutation; idempotent.
 */
export async function syncSandboxSchedule(sandbox: Sandbox, deps: SandboxScheduleDeps): Promise<SandboxScheduleResult> {
  const taskId = buildSandboxRunInstanceId(sandbox.id);

  if (!shouldRunOnSchedule(sandbox)) {
    const had = deps.dynamicTaskStore.getById(taskId);
    deps.taskRunner.unregister(taskId);
    deps.dynamicTaskStore.remove(taskId);
    return { action: had ? 'unregistered' : 'noop', taskId };
  }

  registerRunTask(sandbox, taskId, deps);
  return { action: 'registered', taskId };
}

/**
 * Run the sandbox once, right now, from the run pane.
 *
 * Registers on demand when needed: a sandbox with no cron is still runnable manually,
 * and that is the main way an operator smoke-tests a freshly written spec without
 * waiting a day for the next fire.
 */
export async function triggerSandboxRunNow(
  sandbox: Sandbox,
  deps: SandboxScheduleDeps,
): Promise<SandboxScheduleResult> {
  const taskId = buildSandboxRunInstanceId(sandbox.id);

  if (!deps.dynamicTaskStore.getById(taskId)) {
    registerRunTask(sandbox, taskId, deps);
  }

  await deps.taskRunner.triggerNow(taskId, { manual: true });
  return { action: 'registered', taskId };
}
