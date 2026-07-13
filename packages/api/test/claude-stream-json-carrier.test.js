import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

const { ClaudeStreamJsonCarrierService } = await import(
  '../dist/domains/cats/services/agents/providers/ClaudeStreamJsonCarrierService.js'
);

ensureFakeCliOnPath('claude');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function createMockProcess(pid = 32100) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinWrites = [];
  const killCalls = [];
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') {
      process.nextTick(() => originalEmit('close', ...args));
    }
    return emitted;
  };
  stdin.on('data', (chunk) => {
    stdinWrites.push(chunk.toString());
    emitter.emit('stdin-write');
  });

  const proc = {
    stdin,
    stdout,
    stderr,
    pid,
    kill(signal) {
      killCalls.push(signal);
      process.nextTick(() => {
        if (!stdout.destroyed && !stdout.writableEnded) stdout.end();
        if (!stderr.destroyed && !stderr.writableEnded) stderr.end();
        emitter.emit('exit', null, signal ?? 'SIGTERM');
      });
      return true;
    },
    on(event, listener) {
      emitter.on(event, listener);
      return proc;
    },
    once(event, listener) {
      emitter.once(event, listener);
      return proc;
    },
    _emitter: emitter,
    stdinWrites,
    killCalls,
  };
  return proc;
}

function createSpawnFn(processes) {
  const queue = [...processes];
  const fn = (cmd, args, opts) => {
    const proc = queue.shift();
    assert.ok(proc, 'spawnFn process queue exhausted');
    fn.calls.push({ cmd, args, opts, proc });
    return proc;
  };
  fn.calls = [];
  return fn;
}

async function waitForStdinWrites(proc, count) {
  if (proc.stdinWrites.length >= count) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc._emitter.off('stdin-write', check);
      reject(new Error(`Timed out waiting for ${count} stdin writes`));
    }, 1000);
    const check = () => {
      if (proc.stdinWrites.length < count) return;
      clearTimeout(timeout);
      proc._emitter.off('stdin-write', check);
      resolve();
    };
    proc._emitter.on('stdin-write', check);
  });
}

function emitNdjson(proc, event) {
  proc.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitClaudeTurn(proc, { sessionId, messageId, text }) {
  if (sessionId) {
    emitNdjson(proc, { type: 'system', subtype: 'init', session_id: sessionId });
  }
  emitNdjson(proc, {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id: messageId,
        usage: { input_tokens: 12, cache_read_input_tokens: 88, output_tokens: 0 },
      },
    },
  });
  emitNdjson(proc, {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  });
  emitNdjson(proc, { type: 'stream_event', event: { type: 'message_stop' } });
  emitNdjson(proc, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: { input_tokens: 12, cache_read_input_tokens: 88, output_tokens: 5 },
    total_cost_usd: 0.001,
    duration_ms: 100,
  });
}

function endProcess(proc, code = 0, signal = null) {
  if (!proc.stdout.destroyed && !proc.stdout.writableEnded) proc.stdout.end();
  if (!proc.stderr.destroyed && !proc.stderr.writableEnded) proc.stderr.end();
  proc._emitter.emit('exit', code, signal);
}

function casualOptions(invocationId, nativeSystemPrompt = 'CASUAL-L0') {
  return {
    promptProfile: 'casual',
    nativeSystemPrompt,
    callbackEnv: {
      CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
      CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
      CAT_CAFE_INVOCATION_ID: invocationId,
      CAT_CAFE_CALLBACK_TOKEN: `token-${invocationId}`,
      CAT_CAFE_THREAD_ID: 'thread-stream-json',
      CAT_CAFE_CAT_ID: 'opus',
      CAT_CAFE_USER_ID: 'user-stream-json',
    },
    auditContext: {
      invocationId,
      threadId: 'thread-stream-json',
      userId: 'user-stream-json',
      catId: 'opus',
    },
    invocationId,
  };
}

function developmentOptions(invocationId) {
  return {
    promptProfile: 'development',
    callbackEnv: {
      CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
    },
    auditContext: {
      invocationId,
      threadId: 'thread-stream-json-dev',
      userId: 'user-stream-json',
      catId: 'opus',
    },
    invocationId,
  };
}

test('stream-json carrier keeps one Claude CLI process for repeated casual turns', async () => {
  const proc = createMockProcess();
  const spawnFn = createSpawnFn([proc]);
  const service = new ClaudeStreamJsonCarrierService({
    catId: 'opus',
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn: async () => 'COMPILED-L0',
  });

  const firstPending = collect(service.invoke('hello', casualOptions('inv-1', 'CASUAL-L0')));
  await waitForStdinWrites(proc, 1);

  assert.equal(spawnFn.calls.length, 1);
  const call = spawnFn.calls[0];
  assert.equal(call.cmd.endsWith('/claude') || call.cmd === 'claude', true);
  assert.deepEqual(call.opts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(call.args.includes('-p'));
  assert.ok(call.args.includes('--input-format'));
  assert.equal(call.args[call.args.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(call.args[call.args.indexOf('--effort') + 1], 'medium');
  assert.ok(call.args.includes('--include-partial-messages'));
  assert.ok(!call.args.includes('--append-system-prompt-file'));
  assert.ok(!call.args.includes('--chrome'));
  assert.ok(!call.args.includes('--mcp-config'));
  assert.ok(!call.args.includes('hello'), 'prompt must not be passed in argv');
  assert.equal(call.opts.env.CAT_CAFE_INVOCATION_ID, undefined);
  assert.equal(call.opts.env.CAT_CAFE_CALLBACK_TOKEN, undefined);
  const systemPromptPath = call.args[call.args.indexOf('--system-prompt-file') + 1];
  assert.equal(readFileSync(systemPromptPath, 'utf8'), 'CASUAL-L0');

  const firstPayload = JSON.parse(proc.stdinWrites[0]);
  assert.equal(firstPayload.type, 'user');
  assert.equal(firstPayload.message.role, 'user');
  assert.equal(firstPayload.message.content, 'hello');

  emitClaudeTurn(proc, { sessionId: 'claude-session-1', messageId: 'msg-1', text: 'hello back' });
  const firstEvents = await firstPending;
  assert.equal(firstEvents.find((event) => event.type === 'session_init')?.sessionId, 'claude-session-1');
  assert.equal(firstEvents.filter((event) => event.type === 'text').map((event) => event.content).join(''), 'hello back');
  assert.equal(firstEvents.at(-1).type, 'done');

  const secondPending = collect(
    service.invoke('again', {
      ...casualOptions('inv-2', 'CASUAL-L0'),
      sessionId: 'claude-session-1',
    }),
  );
  await waitForStdinWrites(proc, 2);
  assert.equal(spawnFn.calls.length, 1, 'second casual turn reuses the same process');

  const secondPayload = JSON.parse(proc.stdinWrites[1]);
  assert.equal(secondPayload.message.content, 'again');
  emitClaudeTurn(proc, { messageId: 'msg-2', text: 'again back' });
  const secondEvents = await secondPending;
  assert.equal(secondEvents.filter((event) => event.type === 'text').map((event) => event.content).join(''), 'again back');
  assert.equal(secondEvents.at(-1).metadata.sessionId, 'claude-session-1');

  endProcess(proc);
});

test('stream-json carrier preserves fallback behavior when prompt profile is omitted', async () => {
  const spawnFn = createSpawnFn([]);
  const fallbackCalls = [];
  const fallbackService = {
    async *invoke(prompt, options) {
      fallbackCalls.push({ prompt, options });
      yield { type: 'done', catId: 'opus', metadata: { provider: 'anthropic', model: 'fallback' }, timestamp: Date.now() };
    },
  };
  const service = new ClaudeStreamJsonCarrierService({
    catId: 'opus',
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn: async () => 'COMPILED-L0',
    fallbackService,
  });

  const events = await collect(service.invoke('legacy hello', { invocationId: 'inv-legacy' }));

  assert.equal(spawnFn.calls.length, 0);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].prompt, 'legacy hello');
  assert.equal(events.at(-1).type, 'done');
});

test('stream-json carrier keeps one Claude CLI process for development turns without callback MCP credentials', async () => {
  const proc = createMockProcess();
  const spawnFn = createSpawnFn([proc]);
  const service = new ClaudeStreamJsonCarrierService({
    catId: 'opus',
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn: async () => 'COMPILED-L0',
  });

  const firstPending = collect(service.invoke('dev hello', developmentOptions('inv-dev-1')));
  await waitForStdinWrites(proc, 1);

  assert.equal(spawnFn.calls.length, 1);
  const call = spawnFn.calls[0];
  assert.equal(call.args[call.args.indexOf('--system-prompt-file') + 1] !== undefined, true);
  const systemPromptPath = call.args[call.args.indexOf('--system-prompt-file') + 1];
  assert.equal(readFileSync(systemPromptPath, 'utf8'), 'COMPILED-L0');

  emitClaudeTurn(proc, { sessionId: 'claude-dev-session-1', messageId: 'msg-dev-1', text: 'dev back' });
  await firstPending;

  const secondPending = collect(
    service.invoke('dev again', {
      ...developmentOptions('inv-dev-2'),
      sessionId: 'claude-dev-session-1',
    }),
  );
  await waitForStdinWrites(proc, 2);
  assert.equal(spawnFn.calls.length, 1, 'development turn without callback MCP credentials reuses the same process');

  emitClaudeTurn(proc, { messageId: 'msg-dev-2', text: 'dev again back' });
  const secondEvents = await secondPending;
  assert.equal(secondEvents.at(-1).metadata.sessionId, 'claude-dev-session-1');

  endProcess(proc);
});

test('stream-json carrier falls back for development turns with per-turn callback MCP credentials', async () => {
  const proc = createMockProcess();
  const spawnFn = createSpawnFn([proc]);
  const fallbackCalls = [];
  const fallbackService = {
    async *invoke(prompt, options) {
      fallbackCalls.push({ prompt, options });
      yield { type: 'done', catId: 'opus', metadata: { provider: 'anthropic', model: 'fallback' }, timestamp: Date.now() };
    },
  };
  const service = new ClaudeStreamJsonCarrierService({
    catId: 'opus',
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn: async () => 'COMPILED-L0',
    fallbackService,
  });

  const events = await collect(
    service.invoke('dev with mcp', {
      ...developmentOptions('inv-dev-mcp'),
      callbackEnv: {
        CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
        CAT_CAFE_INVOCATION_ID: 'inv-dev-mcp',
        CAT_CAFE_CALLBACK_TOKEN: 'tok-dev-mcp',
      },
    }),
  );

  assert.equal(spawnFn.calls.length, 0, 'stream-json must not own development callback MCP credentials');
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].prompt, 'dev with mcp');
  assert.equal(events.at(-1).type, 'done');
});

test('stream-json carrier restarts when stable native prompt changes', async () => {
  const proc1 = createMockProcess(32101);
  const proc2 = createMockProcess(32102);
  const spawnFn = createSpawnFn([proc1, proc2]);
  const service = new ClaudeStreamJsonCarrierService({
    catId: 'opus',
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn: async () => 'COMPILED-L0',
  });

  const firstPending = collect(service.invoke('hello', casualOptions('inv-3', 'CASUAL-L0-A')));
  await waitForStdinWrites(proc1, 1);
  emitClaudeTurn(proc1, { sessionId: 'claude-session-2', messageId: 'msg-3', text: 'first' });
  await firstPending;

  const secondPending = collect(
    service.invoke('again', {
      ...casualOptions('inv-4', 'CASUAL-L0-B'),
      sessionId: 'claude-session-2',
    }),
  );
  await waitForStdinWrites(proc2, 1);
  assert.equal(spawnFn.calls.length, 2);
  assert.deepEqual(proc1.killCalls, ['SIGTERM']);
  const secondSystemPromptPath = spawnFn.calls[1].args[spawnFn.calls[1].args.indexOf('--system-prompt-file') + 1];
  assert.equal(readFileSync(secondSystemPromptPath, 'utf8'), 'CASUAL-L0-B');

  emitClaudeTurn(proc2, { sessionId: 'claude-session-2', messageId: 'msg-4', text: 'second' });
  const secondEvents = await secondPending;
  assert.equal(secondEvents.filter((event) => event.type === 'text').map((event) => event.content).join(''), 'second');

  endProcess(proc2);
});
