/**
 * Sandbox API Routes
 * POST   /api/sandboxes     - 创建 A2A 沙盒
 * GET    /api/sandboxes/:id - 获取沙盒详情
 * PATCH  /api/sandboxes/:id - 更新沙盒 spec/settings/status
 */

import type {
  CatId,
  CreateSandboxInput,
  Sandbox,
  SandboxSpecV1,
  UpdateSandboxSettingsInput,
  UpdateSandboxSpecInput,
  UpdateSandboxStatusInput,
} from '@cat-cafe/shared';
import {
  isThreadMode,
  mergeSandboxSchedule,
  sandboxSchedulePatchSchema,
  sandboxScheduleSchema,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ISandboxStore } from '../domains/sandbox/ports/SandboxStore.js';
import type { SandboxScheduleDeps } from '../domains/sandbox/services/sandbox-schedule.js';
import { syncSandboxSchedule, triggerSandboxRunNow } from '../domains/sandbox/services/sandbox-schedule.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import { type CallbackAuthRegistry, registerCallbackAuthHook } from './callback-auth-prehandler.js';

const log = createModuleLogger('routes/sandboxes');

export interface SandboxesRoutesOptions {
  threadStore: IThreadStore;
  sandboxStore: ISandboxStore;
  /**
   * F247 Phase C: scheduler surface. Optional so the routes stay usable (and testable)
   * without a live task runner — a sandbox without it simply never fires on cron.
   */
  scheduleDeps?: SandboxScheduleDeps;
  /**
   * Callback auth registry. REQUIRED for the dev-pane write path: Fastify hooks are
   * encapsulated per plugin, so registering callbackAuthRoutes as a sibling does NOT
   * give this plugin `request.callbackAuth` — review found the route returning 401 to
   * every real MCP call while its tests passed, because the tests hand-decorated the
   * field instead of registering the real hook.
   */
  callbackRegistry: CallbackAuthRegistry;
}

/**
 * The cron task is a projection of `spec.schedule`, so every mutation path converges
 * it rather than hand-rolling register/unregister. Failures are logged, never fatal:
 * losing a schedule must not lose the sandbox itself.
 */
async function syncSchedule(sandbox: Sandbox, scheduleDeps: SandboxScheduleDeps | undefined): Promise<void> {
  if (!scheduleDeps) return;
  try {
    await syncSandboxSchedule(sandbox, scheduleDeps);
  } catch (err) {
    log.error({ err, sandboxId: sandbox.id }, 'Failed to sync sandbox schedule');
  }
}

const sandboxSpecSchema = z
  .object({
    specVersion: z.literal('1'),
    name: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(2000),
    learningGoal: z.string().trim().max(2000).optional(),
    schedule: sandboxScheduleSchema.optional(),
    members: z.array(z.string().min(1).max(100)).min(1).max(10),
    dataSources: z
      .array(
        z.object({
          type: z.string().min(1).max(100),
          name: z.string().min(1).max(200),
          config: z.record(z.unknown()).optional(),
        }),
      )
      .optional(),
    extensions: z.record(z.unknown()).optional(),
  })
  .strict();

const createSandboxSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    projectPath: z.string().min(1).max(500),
    members: z.array(z.string().min(1).max(100)).min(1).max(10),
    spec: sandboxSpecSchema,
    settings: z
      .object({
        allowBackflow: z.boolean().optional(),
        autoStartSchedule: z.boolean().optional(),
        maxRunLogs: z.number().int().min(0).max(10000).optional(),
      })
      .optional(),
  })
  .strict();

const updateSandboxSpecSchema = z
  .object({
    spec: sandboxSpecSchema.partial(),
  })
  .strict();

/**
 * The dev pane's schema. Unlike the operator-facing PATCH, the schedule is NESTED-partial:
 * a member told "move it to 09:00" knows the new cron but has never seen the stored
 * prompt or timezone. Demanding the whole object would make that ordinary request fail,
 * or silently drop the timezone — so accept the fragment and merge it server-side.
 */
const callbackUpdateSpecSchema = z
  .object({
    spec: sandboxSpecSchema.partial().extend({ schedule: sandboxSchedulePatchSchema.optional() }).strict(),
  })
  .strict();

const updateSandboxSettingsSchema = z
  .object({
    settings: z
      .object({
        allowBackflow: z.boolean().optional(),
        autoStartSchedule: z.boolean().optional(),
        maxRunLogs: z.number().int().min(0).max(10000).optional(),
      })
      .partial(),
  })
  .strict();

const updateSandboxStatusSchema = z
  .object({
    status: z.enum(['active', 'paused', 'archived']),
  })
  .strict();

function sanitizeSandboxForResponse(sandbox: Sandbox): Sandbox {
  return sandbox;
}

export const sandboxesRoutes: FastifyPluginAsync<SandboxesRoutesOptions> = async (app, opts) => {
  const { threadStore, sandboxStore, scheduleDeps, callbackRegistry } = opts;
  // Fail FAST rather than degrading. When this was optional, a missing registry silently
  // turned the whole dev-pane write path into a 401 — production was broken for a wiring
  // omission no startup check would surface. Crashing at boot is the cheap failure.
  if (!callbackRegistry) {
    throw new Error(
      'sandboxesRoutes requires callbackRegistry — the dev-pane write path cannot authenticate without it',
    );
  }
  registerCallbackAuthHook(app, callbackRegistry);

  // POST /api/sandboxes - 创建沙盒（同时创建绑定 Thread）
  app.post('/api/sandboxes', async (request, reply) => {
    const parseResult = createSandboxSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { title, projectPath, members, spec, settings } = parseResult.data;
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    // Membership is fixed for the life of a v1 sandbox (KD-5) and is stored TWICE:
    // Sandbox.members drives authorization, spec.members drives the scheduler's runner
    // choice. Letting them differ at creation bakes in a state where the member that gets
    // woken is not the one allowed to edit the spec — so refuse rather than silently
    // picking one as authoritative.
    const membersMatch = members.length === spec.members.length && members.every((m, i) => m === spec.members[i]);
    if (!membersMatch) {
      reply.status(400);
      return {
        error: 'members and spec.members must be identical — sandbox membership is a single fixed list in v1',
      };
    }

    const validatedProjectPath = await validateProjectPath(projectPath);
    if (!validatedProjectPath) {
      reply.status(400);
      return { error: 'Invalid projectPath: must be an existing directory under allowed roots' };
    }

    try {
      // Create sandbox first to get the id
      const input: CreateSandboxInput = {
        title,
        projectPath: validatedProjectPath,
        members: members as CatId[],
        spec: spec as SandboxSpecV1,
        settings,
      };
      const sandbox = await sandboxStore.create(input, userId);

      // Create the bound thread in sandbox mode
      const thread = await threadStore.create(userId, title, validatedProjectPath);
      await threadStore.updateThreadMode(thread.id, 'sandbox');
      await threadStore.updatePreferredCats(thread.id, members as CatId[]);

      // Bind sandbox to thread. Persist the link: assigning to the returned object only
      // mutates a local copy, so against Redis the binding would silently disappear.
      thread.sandboxId = sandbox.id;
      await threadStore.updateSandboxId(thread.id, sandbox.id);
      await sandboxStore.bindThread(sandbox.id, thread.id);

      // bindThread mutates threadId, which the schedule needs as its delivery target.
      const bound = (await sandboxStore.get(sandbox.id)) ?? sandbox;
      await syncSchedule(bound, scheduleDeps);

      reply.status(201);
      return {
        sandbox: sanitizeSandboxForResponse(sandbox),
        thread: { ...thread, mode: 'sandbox', preferredCats: members },
      };
    } catch (err) {
      log.error({ err, userId, projectPath }, 'Failed to create sandbox');
      reply.status(500);
      return { error: 'Failed to create sandbox', detail: String(err) };
    }
  });

  // GET /api/sandboxes/:id
  app.get('/api/sandboxes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const sandbox = await sandboxStore.get(id);
    if (!sandbox) {
      reply.status(404);
      return { error: 'Sandbox not found' };
    }

    // Basic ownership check via thread
    const thread = await threadStore.get(sandbox.threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Sandbox does not belong to this user' };
    }

    return { sandbox: sanitizeSandboxForResponse(sandbox) };
  });

  // GET /api/sandboxes/:id/runtime — everything the run pane shows, in one round-trip.
  //
  // Kept separate from GET /:id because this one touches the disk: it is the read side
  // of the run loop, and the run pane polls it.
  app.get('/api/sandboxes/:id/runtime', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const sandbox = await sandboxStore.get(id);
    if (!sandbox) {
      reply.status(404);
      return { error: 'Sandbox not found' };
    }

    const thread = await threadStore.get(sandbox.threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Sandbox does not belong to this user' };
    }

    const memory = await sandboxStore.getMemory(id);

    // listRuns() throws on a real read fault by design — "the disk failed" must not be
    // indistinguishable from "this sandbox has never run". The run pane needs the same
    // distinction, so surface it as a degraded state rather than an empty history or a
    // blank 500: the sandbox and its accumulated memory are still worth showing.
    try {
      const runs = await sandboxStore.listRuns(id);
      return {
        sandbox: sanitizeSandboxForResponse(sandbox),
        memory,
        runs: [...runs].reverse(), // newest first — the run pane reads top-down
        runsAvailable: true,
      };
    } catch (err) {
      log.warn({ err, sandboxId: id }, 'Failed to read sandbox runs for the run pane');
      return {
        sandbox: sanitizeSandboxForResponse(sandbox),
        memory,
        runs: [],
        runsAvailable: false,
        runsError: 'Run history is temporarily unreadable',
      };
    }
  });

  // PATCH /api/sandboxes/:id/spec
  app.patch('/api/sandboxes/:id/spec', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parseResult = updateSandboxSpecSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const sandbox = await sandboxStore.get(id);
    if (!sandbox) {
      reply.status(404);
      return { error: 'Sandbox not found' };
    }

    const thread = await threadStore.get(sandbox.threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Sandbox does not belong to this user' };
    }

    // Same fixed-membership rule as the callback path. Enforcing it in only ONE mutation
    // path is exactly how the two member lists drift apart.
    if (parseResult.data.spec.members) {
      reply.status(400);
      return { error: 'Sandbox membership is fixed in v1 and cannot be changed through the spec' };
    }

    const updated = await sandboxStore.updateSpec(id, parseResult.data as UpdateSandboxSpecInput);
    // Editing the spec in the dev pane is how the schedule changes — converge it now so
    // a new/removed cron takes effect without the operator restarting anything.
    if (updated) await syncSchedule(updated, scheduleDeps);
    reply.status(200);
    return { sandbox: sanitizeSandboxForResponse(updated!) };
  });

  // PATCH /api/callback/sandbox/spec — the DEV PANE's write path (F247 AC-D4).
  //
  // The operator shapes the spec by talking to a member, so the member needs to write
  // it. Two properties make this a separate route rather than a shared one:
  //
  //  - No sandboxId parameter. The target is derived from the invocation's own thread,
  //    so a member editing another sandbox's spec is structurally impossible rather
  //    than merely checked.
  //  - It goes through updateSpec() + syncSchedule() like every other mutation. A member
  //    writing spec.yaml directly would persist the change but never reconverge the cron,
  //    so editing the schedule would silently do nothing until a restart — the exact
  //    "writes fine, never connects" failure this feature keeps producing.
  app.patch('/api/callback/sandbox/spec', async (request, reply) => {
    const auth = request.callbackAuth;
    if (!auth) {
      reply.status(401);
      return { error: 'Callback authentication required' };
    }

    const parseResult = callbackUpdateSpecSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const sandbox = await sandboxStore.getByThreadId(auth.threadId);
    if (!sandbox) {
      reply.status(404);
      return { error: 'This thread is not bound to an A2A sandbox' };
    }

    // Deriving the target from the thread is SCOPE, not authorization — review's point.
    // A scheduler/connector trigger carries an explicit catId, so a member that is not
    // part of this sandbox can still be routed into its thread. Rewriting the project's
    // spec is the most consequential thing in the mode; require actual membership.
    if (!sandbox.members.includes(auth.catId as CatId)) {
      log.warn(
        { sandboxId: sandbox.id, catId: auth.catId, members: sandbox.members },
        'Rejected sandbox spec update from a non-member',
      );
      reply.status(403);
      return { error: 'Only a member of this sandbox may edit its spec' };
    }

    // v1 keeps membership fixed (F247 KD-5), and members live in BOTH Sandbox.members and
    // spec.members. Accepting an edit here would fork them and silently desync routing
    // from the spec, so the write path refuses rather than half-applying it.
    if (parseResult.data.spec.members) {
      reply.status(400);
      return { error: 'Sandbox membership is fixed in v1 and cannot be changed through the spec' };
    }

    // Editing takes a fragment; creating the first one does not. Both rules live in
    // mergeSandboxSchedule so the member callback and the operator route cannot disagree
    // about what counts as a complete schedule — review found the earlier version checking
    // only for a cron, which let a schedule with no prompt reach the scheduler.
    const patch = { ...parseResult.data.spec };
    if (patch.schedule) {
      const merged = mergeSandboxSchedule(sandbox.spec.schedule, patch.schedule);
      if (!merged.ok) {
        reply.status(400);
        return { error: merged.error };
      }
      patch.schedule = merged.schedule;
    }

    try {
      const updated = await sandboxStore.updateSpec(sandbox.id, { spec: patch } as UpdateSandboxSpecInput);
      if (!updated) {
        reply.status(404);
        return { error: 'Sandbox not found' };
      }
      await syncSchedule(updated, scheduleDeps);
      reply.status(200);
      return { sandbox: sanitizeSandboxForResponse(updated) };
    } catch (err) {
      log.error({ err, sandboxId: sandbox.id, threadId: auth.threadId }, 'Failed to update sandbox spec via callback');
      reply.status(500);
      return { error: 'Failed to update sandbox spec' };
    }
  });

  // PATCH /api/sandboxes/:id/settings
  app.patch('/api/sandboxes/:id/settings', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parseResult = updateSandboxSettingsSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const sandbox = await sandboxStore.get(id);
    if (!sandbox) {
      reply.status(404);
      return { error: 'Sandbox not found' };
    }

    const thread = await threadStore.get(sandbox.threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Sandbox does not belong to this user' };
    }

    const updated = await sandboxStore.updateSettings(id, parseResult.data as UpdateSandboxSettingsInput);
    reply.status(200);
    return { sandbox: sanitizeSandboxForResponse(updated!) };
  });

  // PATCH /api/sandboxes/:id/status
  app.patch('/api/sandboxes/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parseResult = updateSandboxStatusSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const sandbox = await sandboxStore.get(id);
    if (!sandbox) {
      reply.status(404);
      return { error: 'Sandbox not found' };
    }

    const thread = await threadStore.get(sandbox.threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Sandbox does not belong to this user' };
    }

    const updated = await sandboxStore.updateStatus(id, parseResult.data as UpdateSandboxStatusInput);
    // Pause/resume is expressed purely as status — converge the cron so a paused sandbox
    // actually stops firing instead of quietly running on in the background.
    if (updated) await syncSchedule(updated, scheduleDeps);
    reply.status(200);
    return { sandbox: sanitizeSandboxForResponse(updated!) };
  });

  // POST /api/sandboxes/:id/run — run once now, from the run pane.
  // The main way an operator smoke-tests a freshly written spec instead of waiting a day.
  app.post('/api/sandboxes/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const sandbox = await sandboxStore.get(id);
    if (!sandbox) {
      reply.status(404);
      return { error: 'Sandbox not found' };
    }

    const thread = await threadStore.get(sandbox.threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Sandbox does not belong to this user' };
    }

    if (sandbox.status !== 'active') {
      reply.status(409);
      return { error: `Sandbox is ${sandbox.status}; resume it before running` };
    }

    if (!scheduleDeps) {
      reply.status(503);
      return { error: 'Scheduler not available' };
    }

    try {
      const result = await triggerSandboxRunNow(sandbox, scheduleDeps);
      reply.status(202);
      return { success: true, taskId: result.taskId };
    } catch (err) {
      log.error({ err, sandboxId: id }, 'Failed to trigger sandbox run');
      reply.status(500);
      return { error: 'Failed to trigger sandbox run', detail: String(err) };
    }
  });
};

// Re-export route type guard helper for tests
export { isThreadMode };
