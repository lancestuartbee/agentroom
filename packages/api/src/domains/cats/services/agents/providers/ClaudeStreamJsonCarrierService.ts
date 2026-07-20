/**
 * Claude stream-json carrier
 *
 * Experimental opt-in carrier for Claude Code CLI's streaming input mode:
 *   claude -p --input-format stream-json --output-format stream-json
 *
 * Unlike ClaudeAgentService, this keeps one CLI process alive per conversation
 * key and writes one JSONL user message per turn. Attachment-heavy calls and
 * development turns that require per-invocation callback MCP credentials
 * deliberately fall back to ClaudeAgentService so collaboration semantics are
 * not changed by this carrier.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { type CliEffortLevel, getCatEffort } from '../../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { buildSilentCompletionDiagnostic } from '../../../../../utils/cli-diagnostics.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { buildChildEnv } from '../../../../../utils/cli-spawn.js';
import { resolveCliTimeoutMs } from '../../../../../utils/cli-timeout.js';
import type { ChildProcessLike, SpawnFn } from '../../../../../utils/cli-types.js';
import { isParseError, parseNDJSON } from '../../../../../utils/ndjson-parser.js';
import { sanitizeCliStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import {
  type AgentMessage,
  type AgentService,
  type AgentServiceOptions,
  isLightweightPromptProfile,
  type MessageMetadata,
} from '../../types.js';
import type { RawArchiveSink } from '../providers/codex-audit-hooks.js';
import { sanitizeRawEvent } from '../providers/codex-audit-hooks.js';
import { extractImagePaths } from '../providers/image-paths.js';
import {
  ANTHROPIC_PROFILE_MODE_KEY,
  buildClaudeEnvOverrides,
  ClaudeAgentService,
  resolveClaudeModelSelection,
  SUBSCRIPTION_MODE_DENY_KEYS,
} from './ClaudeAgentService.js';
import { extractClaudeUsage, isResultErrorEvent, transformClaudeEvent } from './claude-ndjson-parser.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';

const log = createModuleLogger('claude-stream-json-carrier');

const PERMISSION_MODE = 'bypassPermissions';
const DEFAULT_IDLE_CLOSE_MS = 30 * 60 * 1000;
const STDERR_BUFFER_LIMIT = 16_384;
const CASUAL_MAX_EFFORT: CliEffortLevel = 'medium';
const VOLATILE_CALLBACK_ENV_KEYS = ['CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN'] as const;

interface ClaudeStreamJsonCarrierOptions {
  catId?: CatId;
  spawnFn?: SpawnFn;
  model?: string;
  l0CompilerFn?: typeof compileL0ViaSubprocess;
  rawArchive?: RawArchiveSink;
  fallbackService?: AgentService;
}

interface LaunchPlan {
  processKey: string;
  signature: string;
  command: string;
  baseArgs: readonly string[];
  resumeSessionId?: string;
  cwd?: string;
  env: Record<string, string | null>;
  effectiveModel: string;
  nativeSystemPrompt: string;
}

interface PersistentClaudeProcess {
  key: string;
  signature: string;
  command: string;
  args: readonly string[];
  child: ChildProcessLike;
  systemPromptPath: string;
  launchSessionId?: string;
  sessionId?: string;
  activeTurn?: AsyncEventQueue<unknown>;
  pendingEvents: unknown[];
  closed: boolean;
  closing: boolean;
  stderrBuffer: string;
  idleTimer?: ReturnType<typeof setTimeout>;
}

class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (err: Error) => void;
  }> = [];
  private ended = false;
  private failed: Error | undefined;

  push(item: T): void {
    if (this.ended || this.failed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: item });
      return;
    }
    this.items.push(item);
  }

  end(): void {
    if (this.ended || this.failed) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }

  fail(err: Error): void {
    if (this.ended || this.failed) return;
    this.failed = err;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(err);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ done: false, value: this.items.shift() as T });
    }
    if (this.failed) return Promise.reject(this.failed);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] },
): ChildProcessLike {
  return nodeSpawn(command, args, options) as unknown as ChildProcessLike;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stableRecordDigest(record: Record<string, string | null>): string {
  const entries = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return sha256(JSON.stringify(entries));
}

function writeSystemPromptToTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-claude-stream-l0-'));
  const path = join(dir, 'system-prompt-l0.md');
  writeFileSync(path, content, 'utf8');
  return path;
}

function removeSystemPromptTempDir(path: string | undefined): void {
  if (!path) return;
  try {
    rmSync(dirname(path), { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, path }, 'Failed to remove Claude stream-json system prompt temp dir');
  }
}

function resolveIdleCloseMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CAT_CAFE_CLAUDE_STREAM_IDLE_MS?.trim();
  if (!raw) return DEFAULT_IDLE_CLOSE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IDLE_CLOSE_MS;
  return parsed;
}

function getEventType(event: unknown): string {
  if (typeof event !== 'object' || event === null) return '__unknown';
  const type = (event as Record<string, unknown>).type;
  return typeof type === 'string' ? type : '__unknown';
}

function inspectAssistantContentBlocks(event: unknown): {
  hasAssistantEvent: boolean;
  hasToolUse: boolean;
  hasText: boolean;
} {
  if (typeof event !== 'object' || event === null) {
    return { hasAssistantEvent: false, hasToolUse: false, hasText: false };
  }
  const raw = event as Record<string, unknown>;
  if (raw.type !== 'assistant') return { hasAssistantEvent: false, hasToolUse: false, hasText: false };
  const message = raw.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return { hasAssistantEvent: true, hasToolUse: false, hasText: false };
  return {
    hasAssistantEvent: true,
    hasToolUse: content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as Record<string, unknown>).type === 'tool_use' &&
        typeof (block as Record<string, unknown>).name === 'string',
    ),
    hasText: content.some(
      (block) => typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text',
    ),
  };
}

function buildStreamJsonInput(content: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
  })}\n`;
}

function withMessageSystemPrompt(prompt: string, options?: AgentServiceOptions): string {
  const systemPrompt = options?.systemPrompt?.trim();
  if (!systemPrompt) return prompt;
  return `${systemPrompt}\n\n---\n\n${prompt}`;
}

function resolveStreamJsonEffort(catId: string, options?: AgentServiceOptions): CliEffortLevel {
  const configured = getCatEffort(catId, undefined, 'anthropic');
  if (!isLightweightPromptProfile(options?.promptProfile)) return configured;
  return configured === 'low' ? 'low' : CASUAL_MAX_EFFORT;
}

function stripVolatileCallbackEnv(env: Record<string, string | null>): Record<string, string | null> {
  const next = { ...env };
  for (const key of VOLATILE_CALLBACK_ENV_KEYS) {
    next[key] = null;
  }
  return next;
}

function isResultEvent(event: unknown): boolean {
  return typeof event === 'object' && event !== null && (event as Record<string, unknown>).type === 'result';
}

function hasPerTurnCallbackCredentials(callbackEnv?: Record<string, string>): boolean {
  return Boolean(callbackEnv?.CAT_CAFE_INVOCATION_ID || callbackEnv?.CAT_CAFE_CALLBACK_TOKEN);
}

/**
 * Keeps Claude Code CLI alive for eligible conversations using streaming
 * input. This is explicitly not the default production carrier yet.
 */
export class ClaudeStreamJsonCarrierService implements AgentService {
  readonly catId: CatId;
  private readonly spawnFn: SpawnFn;
  private readonly model: string;
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;
  private readonly rawArchive: RawArchiveSink;
  private readonly fallbackService: AgentService;
  private readonly processes = new Map<string, PersistentClaudeProcess>();
  private readonly turnTails = new Map<string, Promise<void>>();

  constructor(options?: ClaudeStreamJsonCarrierOptions) {
    this.catId = options?.catId ?? createCatId('opus');
    this.spawnFn = options?.spawnFn ?? defaultSpawn;
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.l0CompilerFn = options?.l0CompilerFn ?? compileL0ViaSubprocess;
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
    this.fallbackService =
      options?.fallbackService ??
      new ClaudeAgentService({
        catId: this.catId,
        spawnFn: options?.spawnFn,
        model: this.model,
        l0CompilerFn: this.l0CompilerFn,
        rawArchive: this.rawArchive,
      });
  }

  injectsL0Natively(): boolean {
    return true;
  }

  invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    if (!this.shouldUseStreamJson(options)) {
      return this.fallbackService.invoke(prompt, options);
    }

    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return self.invokeStreamJson(prompt, options);
      },
    };
  }

  private shouldUseStreamJson(options?: AgentServiceOptions): boolean {
    if (options?.spawnCliOverride) return false;
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    if (imagePaths.length > 0) return false;
    if (isLightweightPromptProfile(options?.promptProfile)) return true;
    if (options?.promptProfile !== 'development') return false;
    return !hasPerTurnCallbackCredentials(options?.callbackEnv);
  }

  private async *invokeStreamJson(prompt: string, options?: AgentServiceOptions): AsyncGenerator<AgentMessage> {
    const plan = await this.buildLaunchPlan(options);
    const previousTail = this.turnTails.get(plan.processKey) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const currentTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const nextTail = previousTail.then(() => currentTurn);
    const storedTail = nextTail.catch(() => {});
    this.turnTails.set(plan.processKey, storedTail);

    await previousTail;
    try {
      yield* this.runSingleTurn(plan, withMessageSystemPrompt(prompt, options), options);
    } finally {
      releaseTurn();
      if (this.turnTails.get(plan.processKey) === storedTail) {
        this.turnTails.delete(plan.processKey);
      }
    }
  }

  private async buildLaunchPlan(options?: AgentServiceOptions): Promise<LaunchPlan> {
    const command = resolveCliCommand('claude');
    const { effectiveModel, useEnvModelOverride } = resolveClaudeModelSelection(options?.callbackEnv, this.model);
    const isApiKeyMode = options?.callbackEnv?.[ANTHROPIC_PROFILE_MODE_KEY] === 'api_key';
    const effort = resolveStreamJsonEffort(this.catId as string, options);
    const modelArgs = !useEnvModelOverride && effectiveModel ? ['--model', effectiveModel] : [];
    const nativeSystemPrompt =
      (isLightweightPromptProfile(options?.promptProfile)
        ? options?.nativeSystemPrompt?.trim() || undefined
        : undefined) ||
      options?.resumeFallbackSystemPrompt?.trim() ||
      (await this.l0CompilerFn({ catId: this.catId as string }));

    let envOverrides = buildClaudeEnvOverrides(options?.callbackEnv);
    if (options?.accountEnv) {
      for (const [key, value] of Object.entries(options.accountEnv)) envOverrides[key] = value;
    }
    if (options?.callbackEnv?.[ANTHROPIC_PROFILE_MODE_KEY] === 'subscription') {
      for (const key of SUBSCRIPTION_MODE_DENY_KEYS) envOverrides[key] = null;
    }
    envOverrides = stripVolatileCallbackEnv(envOverrides);

    const baseArgs: string[] = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      ...modelArgs,
      '--effort',
      effort,
      '--permission-mode',
      PERMISSION_MODE,
      '--setting-sources',
      isApiKeyMode ? 'project,local' : 'project,local,user',
    ];

    const processKey = this.buildProcessKey(options);
    const signature = sha256(
      JSON.stringify({
        catId: this.catId,
        command: command ?? 'claude',
        cwd: options?.workingDirectory ?? '',
        args: baseArgs,
        envDigest: stableRecordDigest(envOverrides),
        nativeSystemPromptDigest: sha256(nativeSystemPrompt),
      }),
    );

    return {
      processKey,
      signature,
      command: command ?? '',
      baseArgs,
      ...(options?.sessionId ? { resumeSessionId: options.sessionId } : {}),
      ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
      env: envOverrides,
      effectiveModel,
      nativeSystemPrompt,
    };
  }

  private buildProcessKey(options?: AgentServiceOptions): string {
    const profile = options?.promptProfile ?? 'development';
    const audit = options?.auditContext;
    if (audit) {
      return `${audit.userId}:${audit.threadId}:${audit.catId as string}:${profile}`;
    }
    return `${this.catId as string}:${profile}:${options?.sessionId ?? options?.cliSessionId ?? 'fresh'}`;
  }

  private async *runSingleTurn(
    plan: LaunchPlan,
    prompt: string,
    options?: AgentServiceOptions,
  ): AsyncGenerator<AgentMessage, void, undefined> {
    const metadata: MessageMetadata = { provider: 'anthropic', model: plan.effectiveModel };
    const turn = new AsyncEventQueue<unknown>();
    let proc: PersistentClaudeProcess | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let signalHandler: (() => void) | undefined;

    const failTurn = (err: Error): void => {
      turn.fail(err);
      if (proc) this.closeProcess(proc, 'turn_failed');
    };
    const resetTimeout = (): void => {
      const timeoutMs = resolveCliTimeoutMs(undefined);
      if (timeoutMs === 0) return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        failTurn(new Error(`Claude stream-json CLI 响应超时 (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      timeoutTimer.unref();
    };

    try {
      if (!plan.command) {
        yield {
          type: 'error',
          catId: this.catId,
          error: formatCliNotFoundError('claude'),
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      proc = this.ensureProcess(plan, turn);
      metadata.sessionId = proc.sessionId ?? proc.launchSessionId ?? plan.resumeSessionId;

      if (options?.signal) {
        signalHandler = () => failTurn(new Error('Claude stream-json CLI invocation cancelled'));
        if (options.signal.aborted) signalHandler();
        else options.signal.addEventListener('abort', signalHandler, { once: true });
      }

      resetTimeout();
      await this.writePrompt(proc, prompt);

      const streamState = {
        partialTextMessageIds: new Set<string>(),
        currentMessageId: undefined as string | undefined,
        lastTurnInputTokens: undefined as number | undefined,
        thinkingBuffer: '' as string,
      };
      let eventCount = 0;
      let textEventCount = 0;
      let errorAlreadyYielded = false;
      let hasAssistantEvent = false;
      let lastAssistantHasToolUseBlock = false;
      let lastAssistantHasTextBlock = false;
      const uniqueEventTypes = new Set<string>();

      for await (const event of turn) {
        resetTimeout();
        eventCount++;

        if (isParseError(event)) {
          errorAlreadyYielded = true;
          yield {
            type: 'error',
            catId: this.catId,
            error: `Claude stream-json 输出解析失败: ${event.error}`,
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }

        if (options?.invocationId) {
          this.rawArchive.append(options.invocationId, sanitizeRawEvent(event)).catch((err) => {
            log.warn({ err, catId: this.catId, invocationId: options.invocationId }, 'Raw archive write failed');
          });
        }

        const eventType = getEventType(event);
        uniqueEventTypes.add(eventType);
        const assistantBlocks = inspectAssistantContentBlocks(event);
        if (assistantBlocks.hasAssistantEvent) {
          hasAssistantEvent = true;
          lastAssistantHasToolUseBlock = assistantBlocks.hasToolUse;
          lastAssistantHasTextBlock = assistantBlocks.hasText;
        }

        const rawEvt = event as Record<string, unknown>;
        if (rawEvt.type === 'result' && rawEvt.subtype === 'success') {
          metadata.usage = extractClaudeUsage(rawEvt);
          if (streamState.lastTurnInputTokens != null && metadata.usage) {
            metadata.usage.lastTurnInputTokens = streamState.lastTurnInputTokens;
          }
        }

        const fromResultError = isResultErrorEvent(event);
        const result = transformClaudeEvent(event, this.catId, streamState);
        if (result !== null) {
          const messages = Array.isArray(result) ? result : [result];
          for (const msg of messages) {
            if (msg.type === 'session_init' && msg.sessionId) {
              proc.sessionId = msg.sessionId;
              metadata.sessionId = msg.sessionId;
            }
            if (msg.type === 'text') textEventCount++;
            if (msg.type === 'error') errorAlreadyYielded = true;
            yield { ...msg, metadata };
          }
        }

        if (fromResultError) errorAlreadyYielded = true;
        if (isResultEvent(event)) break;
      }

      if (
        eventCount > 0 &&
        textEventCount === 0 &&
        !errorAlreadyYielded &&
        !(hasAssistantEvent && lastAssistantHasToolUseBlock)
      ) {
        const silentDiag = buildSilentCompletionDiagnostic({
          command: 'claude',
          ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
          eventCount,
          eventTypes: Array.from(uniqueEventTypes),
          model: metadata.model,
          ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
          stderrPresent: proc.stderrBuffer.trim().length > 0,
          ...(proc.stderrBuffer.trim() ? { stderrExcerpt: sanitizeCliStderr(proc.stderrBuffer).slice(0, 800) } : {}),
        });
        yield {
          type: 'system_info',
          catId: this.catId,
          content: JSON.stringify({
            type: 'silent_completion',
            detail: 'Claude stream-json CLI 完成但无文字输出（见 cliDiagnostics 详情）',
          }),
          metadata: { ...metadata, cliDiagnostics: silentDiag },
          timestamp: Date.now(),
        };
      }

      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (err) {
      yield {
        type: 'error',
        catId: this.catId,
        error: err instanceof Error ? err.message : String(err),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (signalHandler && options?.signal) options.signal.removeEventListener('abort', signalHandler);
      turn.end();
      if (proc?.activeTurn === turn) proc.activeTurn = undefined;
      if (proc && !proc.closed && !proc.closing) this.scheduleIdleClose(proc);
    }
  }

  private ensureProcess(plan: LaunchPlan, turn: AsyncEventQueue<unknown>): PersistentClaudeProcess {
    const existing = this.processes.get(plan.processKey);
    if (existing && this.canReuseProcess(existing, plan)) {
      this.cancelIdleClose(existing);
      existing.activeTurn = turn;
      while (existing.pendingEvents.length > 0) {
        turn.push(existing.pendingEvents.shift());
      }
      return existing;
    }

    if (existing) this.closeProcess(existing, 'signature_changed');

    const systemPromptPath = writeSystemPromptToTempFile(plan.nativeSystemPrompt);
    const args = [
      ...plan.baseArgs,
      ...(plan.resumeSessionId ? ['--resume', plan.resumeSessionId] : []),
      '--system-prompt-file',
      systemPromptPath,
    ];
    const child = this.spawnFn(plan.command, args, {
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      env: buildChildEnv(plan.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const proc: PersistentClaudeProcess = {
      key: plan.processKey,
      signature: plan.signature,
      command: plan.command,
      args,
      child,
      systemPromptPath,
      ...(plan.resumeSessionId ? { launchSessionId: plan.resumeSessionId } : {}),
      activeTurn: turn,
      pendingEvents: [],
      closed: false,
      closing: false,
      stderrBuffer: '',
    };
    this.processes.set(plan.processKey, proc);
    this.attachProcessHandlers(proc);
    log.info(
      {
        catId: this.catId,
        key: plan.processKey,
        pid: child.pid,
        model: plan.effectiveModel,
        resumed: Boolean(plan.resumeSessionId),
      },
      'Claude stream-json CLI process started',
    );
    return proc;
  }

  private canReuseProcess(proc: PersistentClaudeProcess, plan: LaunchPlan): boolean {
    if (proc.closed || proc.closing) return false;
    if (proc.signature !== plan.signature) return false;
    const requestedSessionId = plan.resumeSessionId;
    if (!requestedSessionId) return true;
    const knownSessionId = proc.sessionId ?? proc.launchSessionId;
    return !knownSessionId || knownSessionId === requestedSessionId;
  }

  private attachProcessHandlers(proc: PersistentClaudeProcess): void {
    proc.child.stderr?.on('data', (chunk: Buffer | string) => {
      const next = `${proc.stderrBuffer}${chunk.toString()}`;
      proc.stderrBuffer = next.length > STDERR_BUFFER_LIMIT ? next.slice(-STDERR_BUFFER_LIMIT) : next;
    });

    proc.child.once('error', (err: Error) => {
      this.finalizeProcess(proc, `spawn error: ${err.message}`);
    });
    proc.child.once('exit', (code, signal) => {
      this.finalizeProcess(proc, `exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });
    proc.child.once('close', (code: unknown, signal: unknown) => {
      const codeLabel = typeof code === 'number' ? code : 'null';
      const signalLabel = typeof signal === 'string' ? signal : 'null';
      this.finalizeProcess(proc, `closed code=${codeLabel} signal=${signalLabel}`);
    });

    void this.readStdout(proc);
  }

  private async readStdout(proc: PersistentClaudeProcess): Promise<void> {
    try {
      if (!proc.child.stdout) {
        this.finalizeProcess(proc, 'stdout unavailable');
        return;
      }
      for await (const event of parseNDJSON(proc.child.stdout)) {
        if (proc.activeTurn) proc.activeTurn.push(event);
        else proc.pendingEvents.push(event);
      }
      if (!proc.closed && !proc.closing) this.finalizeProcess(proc, 'stdout ended');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.finalizeProcess(proc, `stdout read failed: ${message}`);
    }
  }

  private finalizeProcess(proc: PersistentClaudeProcess, reason: string): void {
    if (proc.closed) return;
    proc.closed = true;
    this.cancelIdleClose(proc);
    if (this.processes.get(proc.key) === proc) this.processes.delete(proc.key);
    removeSystemPromptTempDir(proc.systemPromptPath);
    const stderrExcerpt = sanitizeCliStderr(proc.stderrBuffer).slice(0, 800);
    const details = stderrExcerpt ? `${reason}: ${stderrExcerpt}` : reason;
    if (!proc.closing && proc.activeTurn) {
      proc.activeTurn.fail(new Error(`Claude stream-json CLI process ${details}`));
    }
    log.info(
      { catId: this.catId, key: proc.key, pid: proc.child.pid, reason },
      'Claude stream-json CLI process closed',
    );
  }

  private closeProcess(proc: PersistentClaudeProcess, reason: string): void {
    if (proc.closed || proc.closing) return;
    proc.closing = true;
    this.cancelIdleClose(proc);
    if (this.processes.get(proc.key) === proc) this.processes.delete(proc.key);
    if (proc.activeTurn) proc.activeTurn.fail(new Error(`Claude stream-json CLI process closed: ${reason}`));
    try {
      proc.child.stdin?.end();
    } catch {
      // Ignore stdin close races; the process is being terminated.
    }
    try {
      proc.child.kill('SIGTERM');
    } catch {
      this.finalizeProcess(proc, reason);
    }
  }

  private scheduleIdleClose(proc: PersistentClaudeProcess): void {
    this.cancelIdleClose(proc);
    const idleMs = resolveIdleCloseMs();
    if (idleMs === 0) return;
    proc.idleTimer = setTimeout(() => {
      if (!proc.activeTurn) this.closeProcess(proc, 'idle_timeout');
    }, idleMs);
    proc.idleTimer.unref();
  }

  private cancelIdleClose(proc: PersistentClaudeProcess): void {
    if (!proc.idleTimer) return;
    clearTimeout(proc.idleTimer);
    proc.idleTimer = undefined;
  }

  private async writePrompt(proc: PersistentClaudeProcess, prompt: string): Promise<void> {
    const stdin = proc.child.stdin;
    if (!stdin) throw new Error('Claude stream-json CLI stdin unavailable');
    const line = buildStreamJsonInput(prompt);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        stdin.off('error', onError);
      };
      stdin.once('error', onError);
      stdin.write(line, (err) => {
        cleanup();
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
