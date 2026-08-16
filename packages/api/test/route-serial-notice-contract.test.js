import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createInlineMentionService(catId) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Done. Ready for @codex review', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createLineStartMentionService(catId) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: '@codex 请 review', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendCalls, feedbackWrites, broadcasts) {
  let invocationSeq = 0;
  let messageSeq = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        async getParticipantsWithActivity() {
          return [];
        },
        async get(threadId) {
          return {
            id: threadId,
            title: 'Test Thread',
            createdBy: 'user1',
            participants: [],
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            projectPath: 'default',
          };
        },
        async consumeMentionRoutingFeedback() {
          return null;
        },
        async setMentionRoutingFeedback(threadId, catId, payload) {
          feedbackWrites.push({ threadId, catId, payload });
        },
        async getVotingState() {
          return null;
        },
        async updateVotingState() {},
        async updateParticipantActivity() {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        appendCalls.push(msg);
        return {
          id: `msg-${++messageSeq}`,
          userId: msg.userId,
          catId: msg.catId,
          content: msg.content,
          mentions: msg.mentions,
          timestamp: msg.timestamp,
          threadId: msg.threadId ?? 'default',
          source: msg.source,
          extra: msg.extra,
        };
      },
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    socketManager: {
      broadcastToRoom(room, event, payload) {
        broadcasts.push({ room, event, payload });
      },
    },
  };
}

describe('route-serial notice contract', () => {
  it('emits routing-syntax-hint with explicit system_notice presentation metadata', async () => {
    // F167 Phase H AC-H5 (2026-04-24): Phase H `routing-syntax-hint` is now the
    // primary emission for slot-internal inline @handles. It suppresses the
    // legacy `inline-mention-hint` (#417) on the same turn. The legacy
    // setMentionRoutingFeedback path remains — cats get next-turn correction.
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const feedbackWrites = [];
    const broadcasts = [];
    const deps = createMockDeps({ opus: createInlineMentionService('opus') }, appendCalls, feedbackWrites, broadcasts);

    for await (const _msg of routeSerial(deps, ['opus'], 'review this', 'user1', 'thread-1')) {
    }

    assert.equal(feedbackWrites.length, 1, 'should still write routing feedback (next-turn correction preserved)');

    const hintAppend = appendCalls.find((msg) => msg.source?.connector === 'routing-syntax-hint');
    assert.ok(hintAppend, 'should append a routing-syntax-hint (Phase H primary)');
    assert.equal(hintAppend.userId, 'system');
    assert.equal(hintAppend.catId, null);
    assert.equal(hintAppend.source.meta.presentation, 'system_notice');
    assert.equal(hintAppend.source.meta.noticeTone, 'warning');

    // AC-H5: legacy inline-mention-hint is suppressed when Phase H hits
    const legacyHint = appendCalls.find((msg) => msg.source?.connector === 'inline-mention-hint');
    assert.equal(legacyHint, undefined, 'AC-H5: legacy inline-mention-hint must be suppressed when Phase H hits');

    const hintBroadcast = broadcasts.find(
      (entry) =>
        entry.event === 'connector_message' && entry.payload.message.source?.connector === 'routing-syntax-hint',
    );
    assert.ok(hintBroadcast, 'should broadcast the routing-syntax-hint in real-time');
    assert.equal(hintBroadcast.payload.message.source.meta.presentation, 'system_notice');
    assert.equal(hintBroadcast.payload.message.source.meta.noticeTone, 'warning');
  });

  it('writes depth_limit routing feedback when A2A chain reaches max depth', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const feedbackWrites = [];
    const deps = createMockDeps({ opus: createLineStartMentionService('opus') }, [], feedbackWrites, []);

    for await (const _msg of routeSerial(deps, ['opus'], 'go', 'user1', 'thread-1', { maxA2ADepth: 0 })) {
    }

    assert.equal(feedbackWrites.length, 1, 'should write routing feedback for blocked @mention');
    assert.equal(feedbackWrites[0].catId, 'opus');
    assert.deepEqual(feedbackWrites[0].payload.items, [{ targetCatId: 'codex', reason: 'depth_limit' }]);
  });

  it('writes fairness_gate routing feedback when non-agent messages are queued', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const feedbackWrites = [];
    const deps = createMockDeps({ opus: createLineStartMentionService('opus') }, [], feedbackWrites, []);

    for await (const _msg of routeSerial(deps, ['opus'], 'go', 'user1', 'thread-1', {
      maxA2ADepth: 5,
      queueHasQueuedMessages: () => true,
    })) {
    }

    assert.equal(feedbackWrites.length, 1, 'should write routing feedback for fairness-gated @mention');
    assert.equal(feedbackWrites[0].catId, 'opus');
    assert.deepEqual(feedbackWrites[0].payload.items, [{ targetCatId: 'codex', reason: 'fairness_gate' }]);
  });

  it('writes pingpong_terminated routing feedback when streak >= 4', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const feedbackWrites = [];

    function createPongService(catId, reply) {
      return {
        async *invoke() {
          yield { type: 'text', catId, content: reply, timestamp: Date.now() };
          yield { type: 'done', catId, timestamp: Date.now() };
        },
      };
    }

    const deps = createMockDeps(
      {
        opus: createPongService('opus', '@codex 请 review'),
        codex: createPongService('codex', '@opus 请确认'),
      },
      [],
      feedbackWrites,
      [],
    );

    const events = [];
    for await (const msg of routeSerial(deps, ['opus'], 'ping-pong', 'user1', 'thread-pp-feedback', {
      maxA2ADepth: 10,
    })) {
      events.push(msg);
    }

    const terminated = events.some(
      (m) => m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('a2a_pingpong_terminated'),
    );
    assert.ok(terminated, 'should emit a2a_pingpong_terminated system_info');

    const pingpongFeedback = feedbackWrites.find((w) =>
      w.payload.items.some((i) => i.reason === 'pingpong_terminated'),
    );
    assert.ok(pingpongFeedback, 'should write pingpong_terminated routing feedback for next-turn D9');
  });

  it('writes feedback for all blocked targets in a single turn without overwriting', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const feedbackWrites = [];

    function createMultiMentionService(catId) {
      return {
        async *invoke() {
          yield {
            type: 'text',
            catId,
            content: '@codex 请 review\n@gemini 请确认设计',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId, timestamp: Date.now() };
        },
      };
    }

    const deps = createMockDeps({ opus: createMultiMentionService('opus') }, [], feedbackWrites, []);

    for await (const _msg of routeSerial(deps, ['opus'], 'multi', 'user1', 'thread-multi-feedback', {
      maxA2ADepth: 0,
    })) {
    }

    assert.equal(feedbackWrites.length, 1, 'should write exactly one feedback payload per turn');
    assert.equal(feedbackWrites[0].catId, 'opus');
    assert.equal(feedbackWrites[0].payload.items.length, 2, 'should include both blocked targets');
    const targetIds = feedbackWrites[0].payload.items.map((i) => i.targetCatId).sort();
    assert.deepEqual(targetIds, ['codex', 'gemini']);
    assert.ok(
      feedbackWrites[0].payload.items.every((i) => i.reason === 'depth_limit'),
      'every blocked target should carry depth_limit reason',
    );
  });
});
