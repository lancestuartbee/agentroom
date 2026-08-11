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
import { isThreadMode } from '@cat-cafe/shared';
import type { Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ISandboxStore } from '../domains/sandbox/ports/SandboxStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';

const log = createModuleLogger('routes/sandboxes');

export interface SandboxesRoutesOptions {
  threadStore: IThreadStore;
  sandboxStore: ISandboxStore;
}

const sandboxSpecSchema = z
  .object({
    specVersion: z.literal('1'),
    name: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(2000),
    learningGoal: z.string().trim().max(2000).optional(),
    schedule: z
      .object({
        cron: z.string().trim().min(1).max(100),
        prompt: z.string().trim().min(1).max(2000),
        timezone: z.string().trim().max(100).optional(),
      })
      .optional(),
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
  const { threadStore, sandboxStore } = opts;

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

      // Bind sandbox to thread
      thread.sandboxId = sandbox.id;
      await sandboxStore.bindThread(sandbox.id, thread.id);

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

    const updated = await sandboxStore.updateSpec(id, parseResult.data as UpdateSandboxSpecInput);
    reply.status(200);
    return { sandbox: sanitizeSandboxForResponse(updated!) };
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
    reply.status(200);
    return { sandbox: sanitizeSandboxForResponse(updated!) };
  });
};

// Re-export route type guard helper for tests
export { isThreadMode };
