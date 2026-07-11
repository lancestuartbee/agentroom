import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { mergeLedger, type RecentArtifact } from '../domains/cats/services/agents/routing/artifact-tracking.js';
import type { IThreadStore, ThreadMemoryV1 } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { type ArtifactStoreEnv, resolveThreadArtifactPaths } from './artifact-store-paths.js';

const MARKDOWN_MAX_BYTES = 5 * 1024 * 1024;
const MAX_SCAN_FILES = 200;
const MAX_SCAN_DEPTH = 4;
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

interface RegisteredMarkdownArtifact {
  v: 1;
  artifactId: string;
  threadId: string;
  userId: string;
  title: string;
  filename: string;
  relativePath: string;
  mimeType: 'text/markdown';
  bytes: number;
  sha256: string;
  createdAt: number;
  source: 'agent-report';
  sourceMessageId: string | null;
  catId: string | null;
  absolutePath: string;
}

function artifactContentUrl(threadId: string, artifactId: string): string {
  return `/api/artifact-store/threads/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}/content`;
}

function artifactDownloadUrl(threadId: string, artifactId: string): string {
  return `/api/artifact-store/threads/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}/download`;
}

function createMemoryIfMissing(now: number): ThreadMemoryV1 {
  return { v: 1, summary: '', sessionsIncorporated: 0, updatedAt: now };
}

function isRecentArtifact(value: NonNullable<ThreadMemoryV1['recentArtifacts']>[number]): value is RecentArtifact {
  return value.type === 'pr' || value.type === 'file' || value.type === 'plan' || value.type === 'feature-doc';
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function artifactIdForRelativePath(relativePath: string): string {
  return `md-file-${createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}`;
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.(md|markdown)$/i, '') || filename;
}

async function scanMarkdownFiles(dir: string, root: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return out;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) break;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      await scanMarkdownFiles(path, root, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const resolved = resolve(path);
    if (isInside(root, resolved)) out.push(resolved);
  }
  return out;
}

export async function registerMarkdownArtifactsFromThreadDirectory(input: {
  threadStore: Pick<IThreadStore, 'getThreadMemory' | 'updateThreadMemory'>;
  threadId: string;
  userId: string;
  catId: string | null;
  env?: ArtifactStoreEnv;
}): Promise<RegisteredMarkdownArtifact[]> {
  if (typeof input.threadStore.getThreadMemory !== 'function') return [];
  if (typeof input.threadStore.updateThreadMemory !== 'function') return [];

  const paths = resolveThreadArtifactPaths(input.threadId, input.env);
  const reportsDir = resolve(paths.reportsDir);
  const profileRoot = resolve(paths.profileRoot);
  const reportsStat = await stat(reportsDir).catch(() => null);
  if (!reportsStat?.isDirectory()) return [];

  const files = await scanMarkdownFiles(reportsDir, reportsDir);
  const registered: RegisteredMarkdownArtifact[] = [];
  await mkdir(paths.metadataDir, { recursive: true });

  for (const absolutePath of files) {
    if (!isInside(reportsDir, absolutePath) || !isInside(profileRoot, absolutePath)) continue;
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size > MARKDOWN_MAX_BYTES) continue;

    const content = await readFile(absolutePath);
    const relativePath = relative(profileRoot, absolutePath);
    const artifactId = artifactIdForRelativePath(relativePath);
    const filename = basename(absolutePath);
    const metadata: RegisteredMarkdownArtifact = {
      v: 1,
      artifactId,
      threadId: input.threadId,
      userId: input.userId,
      title: titleFromFilename(filename),
      filename,
      relativePath,
      mimeType: 'text/markdown',
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      createdAt: Math.max(1, Math.floor(fileStat.mtimeMs)),
      source: 'agent-report',
      sourceMessageId: null,
      catId: input.catId,
      absolutePath,
    };
    const stored = { ...metadata };
    delete (stored as Partial<RegisteredMarkdownArtifact>).absolutePath;
    await writeFile(join(paths.metadataDir, `${artifactId}.json`), `${JSON.stringify(stored, null, 2)}\n`, 'utf-8');
    registered.push(metadata);
  }

  if (registered.length === 0) return [];

  const now = Date.now();
  const existing = (await input.threadStore.getThreadMemory(input.threadId)) ?? createMemoryIfMissing(now);
  const incoming: RecentArtifact[] = registered.map((artifact) => ({
    type: 'file',
    ref: artifact.relativePath,
    label: artifact.filename,
    updatedAt: artifact.createdAt,
    updatedBy: artifact.catId ?? 'platform',
    url: artifactContentUrl(artifact.threadId, artifact.artifactId),
    artifactId: artifact.artifactId,
    downloadUrl: artifactDownloadUrl(artifact.threadId, artifact.artifactId),
    localPath: artifact.absolutePath,
    storageScope: 'thread',
  }));

  await input.threadStore.updateThreadMemory(input.threadId, {
    ...existing,
    updatedAt: now,
    recentArtifacts: mergeLedger((existing.recentArtifacts ?? []).filter(isRecentArtifact), incoming),
  });

  return registered;
}
