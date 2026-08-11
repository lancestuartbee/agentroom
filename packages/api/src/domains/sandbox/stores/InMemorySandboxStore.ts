/**
 * F247: A2A 沙盒内存存储实现
 *
 * v1 同时维护内存缓存和目录持久化：
 * - 目录 (<projectPath>/.a2a-sandbox/) 是真相源
 * - 内存 Map 是运行时缓存
 *
 * 后续可替换为 Redis / SQLite 实现。
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CreateSandboxInput,
  Sandbox,
  SandboxMemoryV1,
  SandboxRunRecordV1,
  SandboxSettingsV1,
  SandboxSpecV1,
  SandboxStateFileV1,
  UpdateSandboxSettingsInput,
  UpdateSandboxSpecInput,
  UpdateSandboxStatusInput,
} from '@cat-cafe/shared';
import { randomUUID } from 'node:crypto';
import type { ISandboxStore } from '../ports/SandboxStore.js';

const DEFAULT_SETTINGS: SandboxSettingsV1 = {
  allowBackflow: false,
  autoStartSchedule: true,
  maxRunLogs: 100,
};

/**
 * Sandbox ids double as evidence collection ids (`<kind>:<name>`), so they must
 * satisfy COLLECTION_ID_RE (`^[a-z]+:[a-z][a-z0-9-]*$`) — the name segment has to
 * START WITH A LETTER. A bare UUID starts with a hex digit ~62.5% of the time, so
 * `sandbox:${uuid}` failed collection registration for most sandboxes (measured:
 * 641/1000). The `sb-` prefix makes every generated id collection-compatible.
 */
function generateSandboxId(): string {
  return `sandbox:sb-${randomUUID()}`;
}

function sanitizeProjectPath(projectPath: string): string {
  // Prevent directory traversal; projectPath is expected to be validated upstream.
  return projectPath.replace(/\.\./g, '');
}

function getSandboxDir(projectPath: string): string {
  return join(sanitizeProjectPath(projectPath), '.a2a-sandbox');
}

function getStateFilePath(projectPath: string): string {
  return join(getSandboxDir(projectPath), 'state.json');
}

function getMemoryFilePath(projectPath: string): string {
  return join(getSandboxDir(projectPath), 'memory', 'sandbox-memory.json');
}

function getRunsDir(projectPath: string): string {
  return join(getSandboxDir(projectPath), 'runs');
}

function getSpecFilePath(projectPath: string): string {
  return join(getSandboxDir(projectPath), 'spec.yaml');
}

function getSpecHistoryDir(projectPath: string): string {
  return join(getSandboxDir(projectPath), 'spec');
}

function toYamlString(obj: unknown): string {
  // Minimal YAML serialization for v1. Replace with a proper YAML library if needed.
  return JSON.stringify(obj, null, 2);
}

function fromYamlString<T>(value: string): T {
  // Minimal YAML parsing for v1. Replace with a proper YAML library if needed.
  return JSON.parse(value) as T;
}

interface SandboxIndexEntry {
  sandboxId: string;
  threadId: string;
  projectPath: string;
}

export interface InMemorySandboxStoreOptions {
  /** Path to a global append-only index for rehydration after restart */
  indexFilePath?: string;
}

export class InMemorySandboxStore implements ISandboxStore {
  private sandboxes: Map<string, Sandbox> = new Map();
  private memories: Map<string, SandboxMemoryV1> = new Map();
  private runs: Map<string, SandboxRunRecordV1[]> = new Map();
  private threadIndex: Map<string, string> = new Map();
  private indexFilePath?: string;

  constructor(options?: InMemorySandboxStoreOptions) {
    this.indexFilePath = options?.indexFilePath;
  }

  async create(input: CreateSandboxInput, createdBy: string): Promise<Sandbox> {
    const now = Date.now();
    const id = generateSandboxId();
    const settings: SandboxSettingsV1 = {
      ...DEFAULT_SETTINGS,
      ...input.settings,
    };

    const sandbox: Sandbox = {
      id,
      title: input.title,
      projectPath: input.projectPath,
      threadId: '', // Bound later when thread is created
      createdBy,
      members: input.members,
      spec: input.spec,
      settings,
      status: settings.autoStartSchedule ? 'active' : 'paused',
      createdAt: now,
      updatedAt: now,
    };

    this.sandboxes.set(id, sandbox);
    this.memories.set(id, {
      v: 1,
      summary: '',
      runsIncorporated: 0,
      updatedAt: now,
    });
    this.runs.set(id, []);

    await this.persist(sandbox);
    return sandbox;
  }

  async bindThread(sandboxId: string, threadId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return;
    sandbox.threadId = threadId;
    this.threadIndex.set(threadId, sandboxId);
    await this.persist(sandbox);
    await this.appendIndex({ sandboxId, threadId, projectPath: sandbox.projectPath });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    return this.sandboxes.get(sandboxId) ?? null;
  }

  async getByThreadId(threadId: string): Promise<Sandbox | null> {
    const sandboxId = this.threadIndex.get(threadId);
    if (!sandboxId) return null;
    return this.get(sandboxId);
  }

  async listByProject(projectPath: string): Promise<Sandbox[]> {
    const result: Sandbox[] = [];
    for (const sandbox of this.sandboxes.values()) {
      if (sandbox.projectPath === projectPath) {
        result.push(sandbox);
      }
    }
    return result;
  }

  async updateSpec(sandboxId: string, input: UpdateSandboxSpecInput): Promise<Sandbox | null> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return null;

    const newSpec: SandboxSpecV1 = {
      ...sandbox.spec,
      ...input.spec,
      // Ensure immutable fields are not overwritten by accident
      specVersion: input.spec.specVersion ?? sandbox.spec.specVersion,
    };

    const now = Date.now();
    sandbox.spec = newSpec;
    sandbox.updatedAt = now;

    await this.persist(sandbox);
    return sandbox;
  }

  async updateSettings(sandboxId: string, input: UpdateSandboxSettingsInput): Promise<Sandbox | null> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return null;

    sandbox.settings = { ...sandbox.settings, ...input.settings };
    sandbox.updatedAt = Date.now();

    await this.persist(sandbox);
    return sandbox;
  }

  async updateStatus(sandboxId: string, input: UpdateSandboxStatusInput): Promise<Sandbox | null> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return null;

    sandbox.status = input.status;
    sandbox.updatedAt = Date.now();

    await this.persist(sandbox);
    return sandbox;
  }

  async getMemory(sandboxId: string): Promise<SandboxMemoryV1 | null> {
    return this.memories.get(sandboxId) ?? null;
  }

  async updateMemory(sandboxId: string, memory: SandboxMemoryV1): Promise<void> {
    this.memories.set(sandboxId, memory);
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox) {
      await this.persistMemory(sandbox.projectPath, memory);
    }
  }

  async getLastRun(sandboxId: string): Promise<SandboxRunRecordV1 | null> {
    const list = this.runs.get(sandboxId) ?? [];
    return list[list.length - 1] ?? null;
  }

  async addRun(sandboxId: string, run: SandboxRunRecordV1): Promise<void> {
    const list = this.runs.get(sandboxId) ?? [];
    list.push(run);

    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox && sandbox.settings.maxRunLogs > 0 && list.length > sandbox.settings.maxRunLogs) {
      list.splice(0, list.length - sandbox.settings.maxRunLogs);
    }

    this.runs.set(sandboxId, list);
    if (sandbox) {
      await this.persistRun(sandbox.projectPath, run);
    }
  }

  async listRuns(sandboxId: string, limit = 50): Promise<SandboxRunRecordV1[]> {
    const list = this.runs.get(sandboxId) ?? [];
    return list.slice(-limit);
  }

  async readStateFile(projectPath: string): Promise<SandboxStateFileV1 | null> {
    try {
      const content = await readFile(getStateFilePath(projectPath), 'utf-8');
      return JSON.parse(content) as SandboxStateFileV1;
    } catch {
      return null;
    }
  }

  async writeStateFile(projectPath: string, state: SandboxStateFileV1): Promise<void> {
    const path = getStateFilePath(projectPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2));
  }

  async delete(sandboxId: string): Promise<boolean> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return false;

    this.sandboxes.delete(sandboxId);
    this.memories.delete(sandboxId);
    this.runs.delete(sandboxId);
    if (sandbox.threadId) {
      this.threadIndex.delete(sandbox.threadId);
    }

    // v1: do not delete directory files; only remove from runtime cache.
    return true;
  }

  /**
   * Rehydrate runtime state from disk. Must be called once at process startup
   * after the optional indexFilePath is configured.
   */
  async rehydrate(): Promise<void> {
    if (!this.indexFilePath) return;

    let raw: string;
    try {
      raw = await readFile(this.indexFilePath, 'utf-8');
    } catch {
      return;
    }

    const seen = new Set<string>();
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SandboxIndexEntry;
        if (!entry.sandboxId || !entry.projectPath) continue;
        if (seen.has(entry.sandboxId)) continue;
        seen.add(entry.sandboxId);

        const state = await this.readStateFile(entry.projectPath);
        if (!state || state.sandboxId !== entry.sandboxId) continue;

        const sandbox: Sandbox = {
          id: state.sandboxId,
          title: state.title,
          projectPath: entry.projectPath,
          threadId: state.threadId,
          createdBy: '', // Unknown after restart; not used for runtime routing
          members: state.members,
          spec: await this.readSpec(entry.projectPath),
          settings: state.settings,
          status: state.status,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        };

        this.sandboxes.set(sandbox.id, sandbox);
        if (sandbox.threadId) {
          this.threadIndex.set(sandbox.threadId, sandbox.id);
        }

        const memory = await this.readMemoryFile(entry.projectPath);
        if (memory) {
          this.memories.set(sandbox.id, memory);
        }

        this.runs.set(sandbox.id, await this.listRunFiles(entry.projectPath));
      } catch {
        // Skip malformed entries best-effort
      }
    }
  }

  private async appendIndex(entry: SandboxIndexEntry): Promise<void> {
    if (!this.indexFilePath) return;
    await mkdir(dirname(this.indexFilePath), { recursive: true });
    await appendFile(this.indexFilePath, `${JSON.stringify(entry)}\n`);
  }

  private async readSpec(projectPath: string): Promise<SandboxSpecV1> {
    try {
      const content = await readFile(getSpecFilePath(projectPath), 'utf-8');
      return fromYamlString<SandboxSpecV1>(content);
    } catch {
      return {
        specVersion: '1',
        name: 'Recovered sandbox',
        goal: 'Recovered from disk',
        members: [],
      };
    }
  }

  private async readMemoryFile(projectPath: string): Promise<SandboxMemoryV1 | null> {
    try {
      const content = await readFile(getMemoryFilePath(projectPath), 'utf-8');
      return JSON.parse(content) as SandboxMemoryV1;
    } catch {
      return null;
    }
  }

  private async listRunFiles(projectPath: string): Promise<SandboxRunRecordV1[]> {
    const { readdir, stat } = await import('node:fs/promises');
    const dir = getRunsDir(projectPath);
    const results: SandboxRunRecordV1[] = [];
    try {
      const entries = await readdir(dir);
      for (const name of entries) {
        if (!name.endsWith('.md')) continue;
        const path = join(dir, name);
        const content = await readFile(path, 'utf-8');
        const statResult = await stat(path);
        const runId = name.replace(/\.md$/, '');
        const triggerMatch = /- Trigger: (\w+)/.exec(content);
        const specVersionMatch = /- Spec Version: (.+)/.exec(content);
        results.push({
          v: 1,
          runId,
          trigger: (triggerMatch?.[1] as 'scheduled' | 'manual') ?? 'manual',
          triggeredAt: statResult.mtimeMs,
          specVersion: specVersionMatch?.[1] ?? 'unknown',
          summary: content.split('## Summary')[1]?.trim() ?? content,
        });
      }
    } catch {
      // best-effort
    }
    return results.sort((a, b) => a.triggeredAt - b.triggeredAt);
  }

  private async persist(sandbox: Sandbox): Promise<void> {
    const dir = getSandboxDir(sandbox.projectPath);
    await mkdir(dir, { recursive: true });

    const state: SandboxStateFileV1 = {
      v: 1,
      sandboxId: sandbox.id,
      title: sandbox.title,
      threadId: sandbox.threadId,
      members: sandbox.members,
      settings: sandbox.settings,
      status: sandbox.status,
      currentSpecRef: getSpecFilePath(sandbox.projectPath),
      createdAt: sandbox.createdAt,
      updatedAt: sandbox.updatedAt,
    };

    await Promise.all([
      this.writeStateFile(sandbox.projectPath, state),
      this.persistSpec(sandbox.projectPath, sandbox.spec),
    ]);
  }

  private async persistSpec(projectPath: string, spec: SandboxSpecV1): Promise<void> {
    const dir = getSandboxDir(projectPath);
    const specPath = getSpecFilePath(projectPath);
    const historyDir = getSpecHistoryDir(projectPath);

    await mkdir(dir, { recursive: true });
    await mkdir(historyDir, { recursive: true });

    const timestamp = Date.now();
    const historyPath = join(historyDir, `spec-${timestamp}.yaml`);

    await Promise.all([
      writeFile(specPath, toYamlString(spec)),
      writeFile(historyPath, toYamlString(spec)),
    ]);
  }

  private async persistMemory(projectPath: string, memory: SandboxMemoryV1): Promise<void> {
    const path = getMemoryFilePath(projectPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(memory, null, 2));
  }

  private async persistRun(projectPath: string, run: SandboxRunRecordV1): Promise<void> {
    const dir = getRunsDir(projectPath);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${run.runId}.md`);
    const content = [`# Run ${run.runId}`, ``, `- Trigger: ${run.trigger}`, `- Triggered At: ${new Date(run.triggeredAt).toISOString()}`, `- Spec Version: ${run.specVersion}`, ``, `## Summary`, ``, run.summary].join('\n');
    await writeFile(path, content);
  }
}
