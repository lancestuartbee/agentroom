import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mergeLedger, type RecentArtifact } from '../domains/cats/services/agents/routing/artifact-tracking.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, Thread, ThreadMemoryV1 } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  type ArtifactStoreEnv,
  resolveArtifactProfileKey,
  resolveArtifactRoot,
  resolveThreadArtifactPaths,
  sanitizeArtifactPathSegment,
} from '../utils/artifact-store-paths.js';
import { resolveUserId } from '../utils/request-identity.js';
import { formatThreadAsMarkdown } from './export.js';

const execFileAsync = promisify(execFile);

const MARKDOWN_MAX_BYTES = 5 * 1024 * 1024;
const ARTIFACT_ID_RE = /^[a-zA-Z0-9._-]{1,120}$/;

const saveMarkdownBodySchema = z
  .object({
    title: z.string().min(1).max(180).optional(),
    content: z.string().max(MARKDOWN_MAX_BYTES).optional(),
    source: z.enum(['thread-export', 'agent-report', 'manual']).optional(),
    sourceMessageId: z.string().min(1).max(120).nullable().optional(),
    catId: z.string().min(1).max(120).nullable().optional(),
  })
  .strict();

const downloadPathQuerySchema = z
  .object({
    path: z.string().min(1).max(4096),
  })
  .strict();

const storedMarkdownArtifactSchema = z
  .object({
    v: z.literal(1),
    artifactId: z.string().regex(ARTIFACT_ID_RE),
    threadId: z.string().min(1),
    userId: z.string().min(1),
    title: z.string().min(1),
    filename: z.string().min(1),
    relativePath: z.string().min(1),
    mimeType: z.literal('text/markdown'),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().min(64).max(64),
    createdAt: z.number().int().positive(),
    source: z.enum(['thread-export', 'agent-report', 'manual']),
    sourceMessageId: z.string().nullable(),
    catId: z.string().nullable(),
  })
  .strict();

type StoredMarkdownArtifact = z.infer<typeof storedMarkdownArtifactSchema>;
type ThreadMemoryRecentArtifact = NonNullable<ThreadMemoryV1['recentArtifacts']>[number];

interface LoadedMarkdownArtifact extends StoredMarkdownArtifact {
  absolutePath: string;
}

export interface ArtifactStoreRoutesOptions {
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  artifactRoot?: string;
  env?: ArtifactStoreEnv;
}

function artifactEnv(opts: ArtifactStoreRoutesOptions): ArtifactStoreEnv {
  return { ...process.env, ...opts.env, ...(opts.artifactRoot ? { CAT_CAFE_ARTIFACT_ROOT: opts.artifactRoot } : {}) };
}

function timestampForFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`;
}

function sanitizeFilenameStem(input: string): string {
  const withoutExt = input.replace(/\.(md|markdown)$/i, '');
  return sanitizeArtifactPathSegment(withoutExt, 'report').slice(0, 80);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function artifactContentUrl(threadId: string, artifactId: string): string {
  return `/api/artifact-store/threads/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}/content`;
}

function artifactDownloadUrl(threadId: string, artifactId: string): string {
  return `/api/artifact-store/threads/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}/download`;
}

function metadataPathFor(threadId: string, artifactId: string, env: ArtifactStoreEnv): string {
  const paths = resolveThreadArtifactPaths(threadId, env);
  return join(paths.metadataDir, `${artifactId}.json`);
}

function expandHomePath(raw: string, env: ArtifactStoreEnv): string {
  const home = env.HOME || env.USERPROFILE;
  if (!home) return raw;
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return raw;
}

function stripLinkFragment(raw: string): string {
  return raw.split('#')[0]?.trim() ?? '';
}

function resolveThreadReportDownloadPath(threadId: string, rawPath: string, env: ArtifactStoreEnv): string | null {
  const paths = resolveThreadArtifactPaths(threadId, env);
  const cleanPath = stripLinkFragment(expandHomePath(rawPath, env));
  if (!cleanPath) return null;

  const candidate = isAbsolute(cleanPath) ? resolve(cleanPath) : resolve(paths.reportsDir, cleanPath);
  if (!isInside(paths.profileRoot, candidate) || !isInside(paths.reportsDir, candidate)) {
    return null;
  }
  return candidate;
}

function contentTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown; charset=utf-8';
  if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.csv')) return 'text/plain; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function guardThreadAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  threadStore: IThreadStore,
  threadId: string,
): Promise<{ userId: string; thread: Thread } | null> {
  const userId = resolveUserId(request, {});
  if (!userId) {
    reply.status(401);
    reply.send({ error: 'Identity required' });
    return null;
  }

  const thread = await threadStore.get(threadId);
  if (!thread) {
    reply.status(404);
    reply.send({ error: 'Thread not found' });
    return null;
  }

  if (thread.createdBy !== userId && thread.createdBy !== 'system') {
    reply.status(403);
    reply.send({ error: 'Access denied' });
    return null;
  }

  return { userId, thread };
}

async function loadMarkdownArtifact(
  threadId: string,
  artifactId: string,
  env: ArtifactStoreEnv,
): Promise<LoadedMarkdownArtifact | null> {
  if (!ARTIFACT_ID_RE.test(artifactId)) return null;
  const paths = resolveThreadArtifactPaths(threadId, env);
  const raw = await readFile(metadataPathFor(threadId, artifactId, env), 'utf-8').catch(() => null);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = storedMarkdownArtifactSchema.safeParse(parsed);
  if (!result.success || result.data.threadId !== threadId || result.data.artifactId !== artifactId) {
    return null;
  }

  const absolutePath = resolve(paths.profileRoot, result.data.relativePath);
  if (!isInside(paths.profileRoot, absolutePath)) return null;
  return { ...result.data, absolutePath };
}

function buildArtifactDto(input: LoadedMarkdownArtifact): ThreadArtifactDTO {
  return {
    type: 'file',
    name: input.filename,
    catId: input.catId,
    createdAt: input.createdAt,
    sourceMessageId: input.sourceMessageId,
    ref: input.relativePath,
    url: artifactContentUrl(input.threadId, input.artifactId),
    artifactId: input.artifactId,
    downloadUrl: artifactDownloadUrl(input.threadId, input.artifactId),
    localPath: input.absolutePath,
    storageScope: 'thread',
  };
}

function createMemoryIfMissing(now: number): ThreadMemoryV1 {
  return { v: 1, summary: '', sessionsIncorporated: 0, updatedAt: now };
}

function isRecentArtifact(value: ThreadMemoryRecentArtifact): value is RecentArtifact {
  return value.type === 'pr' || value.type === 'file' || value.type === 'plan' || value.type === 'feature-doc';
}

async function registerThreadArtifact(threadStore: IThreadStore, metadata: LoadedMarkdownArtifact): Promise<void> {
  const existing = (await threadStore.getThreadMemory(metadata.threadId)) ?? createMemoryIfMissing(metadata.createdAt);
  const incoming: RecentArtifact = {
    type: 'file',
    ref: metadata.relativePath,
    label: metadata.filename,
    updatedAt: metadata.createdAt,
    updatedBy: metadata.catId ?? 'platform',
    url: artifactContentUrl(metadata.threadId, metadata.artifactId),
    artifactId: metadata.artifactId,
    downloadUrl: artifactDownloadUrl(metadata.threadId, metadata.artifactId),
    localPath: metadata.absolutePath,
    storageScope: 'thread',
  };
  await threadStore.updateThreadMemory(metadata.threadId, {
    ...existing,
    updatedAt: metadata.createdAt,
    recentArtifacts: mergeLedger((existing.recentArtifacts ?? []).filter(isRecentArtifact), [incoming]),
  });
}

async function saveMarkdownArtifact(input: {
  threadId: string;
  userId: string;
  title: string;
  content: string;
  source: StoredMarkdownArtifact['source'];
  sourceMessageId: string | null;
  catId: string | null;
  env: ArtifactStoreEnv;
}): Promise<LoadedMarkdownArtifact> {
  const createdAt = Date.now();
  const artifactId = `md-${createdAt}-${randomUUID().slice(0, 8)}`;
  const paths = resolveThreadArtifactPaths(input.threadId, input.env);
  const filename = `${timestampForFilename(new Date(createdAt))}-${sanitizeFilenameStem(input.title)}.md`;
  const absolutePath = join(paths.reportsDir, filename);

  if (!isInside(paths.profileRoot, absolutePath)) {
    throw new Error('Resolved artifact path escaped profile root');
  }

  const content = input.content.endsWith('\n') ? input.content : `${input.content}\n`;
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MARKDOWN_MAX_BYTES) {
    throw new Error('Markdown artifact exceeds size limit');
  }

  await mkdir(paths.reportsDir, { recursive: true });
  await mkdir(paths.metadataDir, { recursive: true });
  await writeFile(absolutePath, content, { encoding: 'utf-8', flag: 'wx' });

  const metadata: StoredMarkdownArtifact = {
    v: 1,
    artifactId,
    threadId: input.threadId,
    userId: input.userId,
    title: input.title,
    filename,
    relativePath: relative(paths.profileRoot, absolutePath),
    mimeType: 'text/markdown',
    bytes,
    sha256: createHash('sha256').update(content).digest('hex'),
    createdAt,
    source: input.source,
    sourceMessageId: input.sourceMessageId,
    catId: input.catId,
  };
  await writeFile(metadataPathFor(input.threadId, artifactId, input.env), `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: 'utf-8',
    flag: 'wx',
  });

  return { ...metadata, absolutePath };
}

async function buildMarkdownContent(input: {
  thread: Thread;
  body: z.infer<typeof saveMarkdownBodySchema>;
  messageStore: IMessageStore;
  userId: string;
}): Promise<{ content: string; title: string; source: StoredMarkdownArtifact['source'] }> {
  const source = input.body.source ?? (input.body.content ? 'manual' : 'thread-export');
  if (input.body.content) {
    return {
      content: input.body.content,
      title: input.body.title ?? input.thread.title ?? 'report',
      source,
    };
  }

  const messages = await input.messageStore.getByThread(input.thread.id, 10000, input.userId);
  return {
    content: formatThreadAsMarkdown(input.thread, messages),
    title: input.body.title ?? input.thread.title ?? `thread-${input.thread.id}`,
    source: 'thread-export',
  };
}

async function revealPath(path: string): Promise<void> {
  const fileStat = await stat(path);
  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-R', path], { timeout: 5000 });
  } else if (process.platform === 'win32') {
    await execFileAsync('explorer', ['/select,', path], { timeout: 5000 });
  } else {
    await execFileAsync('xdg-open', [fileStat.isDirectory() ? path : dirname(path)], { timeout: 5000 });
  }
}

export const artifactStoreRoutes: FastifyPluginAsync<ArtifactStoreRoutesOptions> = async (app, opts) => {
  app.get('/api/artifact-store/info', async () => {
    const env = artifactEnv(opts);
    return {
      root: resolveArtifactRoot(env),
      profileKey: resolveArtifactProfileKey(env),
    };
  });

  app.post<{ Params: { threadId: string } }>('/api/threads/:threadId/artifacts/markdown', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadAccess(request, reply, opts.threadStore, threadId);
    if (!guard) return reply;

    const parsed = saveMarkdownBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid markdown artifact payload', details: parsed.error.flatten() };
    }

    try {
      const env = artifactEnv(opts);
      const markdown = await buildMarkdownContent({
        thread: guard.thread,
        body: parsed.data,
        messageStore: opts.messageStore,
        userId: guard.userId,
      });
      const saved = await saveMarkdownArtifact({
        threadId,
        userId: guard.userId,
        title: markdown.title,
        content: markdown.content,
        source: markdown.source,
        sourceMessageId: parsed.data.sourceMessageId ?? null,
        catId: parsed.data.catId ?? null,
        env,
      });
      await registerThreadArtifact(opts.threadStore, saved);

      reply.status(201);
      return {
        root: resolveArtifactRoot(env),
        profileKey: resolveArtifactProfileKey(env),
        artifact: buildArtifactDto(saved),
      };
    } catch (error) {
      request.log.error({ err: error }, 'failed to save markdown artifact');
      reply.status(500);
      return { error: error instanceof Error ? error.message : 'Failed to save markdown artifact' };
    }
  });

  app.get<{ Params: { threadId: string; artifactId: string } }>(
    '/api/artifact-store/threads/:threadId/:artifactId/content',
    async (request, reply) => {
      const { threadId, artifactId } = request.params;
      const guard = await guardThreadAccess(request, reply, opts.threadStore, threadId);
      if (!guard) return reply;

      const metadata = await loadMarkdownArtifact(threadId, artifactId, artifactEnv(opts));
      if (!metadata) {
        reply.status(404);
        return { error: 'Artifact not found' };
      }

      const content = await readFile(metadata.absolutePath, 'utf-8');
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      return content;
    },
  );

  app.get<{ Params: { threadId: string; artifactId: string } }>(
    '/api/artifact-store/threads/:threadId/:artifactId/download',
    async (request, reply) => {
      const { threadId, artifactId } = request.params;
      const guard = await guardThreadAccess(request, reply, opts.threadStore, threadId);
      if (!guard) return reply;

      const metadata = await loadMarkdownArtifact(threadId, artifactId, artifactEnv(opts));
      if (!metadata) {
        reply.status(404);
        return { error: 'Artifact not found' };
      }

      const content = await readFile(metadata.absolutePath, 'utf-8');
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${basename(metadata.filename)}"`);
      return content;
    },
  );

  app.get<{ Params: { threadId: string }; Querystring: { path?: string } }>(
    '/api/artifact-store/threads/:threadId/download-path',
    async (request, reply) => {
      const { threadId } = request.params;
      const guard = await guardThreadAccess(request, reply, opts.threadStore, threadId);
      if (!guard) return reply;

      const parsed = downloadPathQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid artifact path', details: parsed.error.flatten() };
      }

      const absolutePath = resolveThreadReportDownloadPath(threadId, parsed.data.path, artifactEnv(opts));
      if (!absolutePath) {
        reply.status(403);
        return { error: 'Artifact path is outside this thread reports directory' };
      }

      const fileStat = await stat(absolutePath).catch(() => null);
      if (!fileStat?.isFile()) {
        reply.status(404);
        return { error: 'Artifact file not found' };
      }

      reply.header('Content-Type', contentTypeForPath(absolutePath));
      reply.header('Content-Disposition', `attachment; filename="${basename(absolutePath)}"`);
      return reply.send(createReadStream(absolutePath));
    },
  );

  app.post<{ Params: { threadId: string; artifactId: string } }>(
    '/api/artifact-store/threads/:threadId/:artifactId/reveal',
    async (request, reply) => {
      const { threadId, artifactId } = request.params;
      const guard = await guardThreadAccess(request, reply, opts.threadStore, threadId);
      if (!guard) return reply;

      const metadata = await loadMarkdownArtifact(threadId, artifactId, artifactEnv(opts));
      if (!metadata) {
        reply.status(404);
        return { error: 'Artifact not found' };
      }

      try {
        await revealPath(metadata.absolutePath);
        return { ok: true, path: metadata.absolutePath };
      } catch (error) {
        request.log.error({ err: error }, 'failed to reveal markdown artifact');
        reply.status(500);
        return { error: 'Failed to reveal artifact path' };
      }
    },
  );
};
