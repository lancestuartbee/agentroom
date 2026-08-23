/**
 * Cloud codex P1 + P2 scope guards (PR #1958 third-round findings)
 *
 * P1: force-reset cross-user scope bug
 *   force-reset 's releaseThread(threadId) has NO user scope — on a shared/system thread,
 *   one user can clear another user's processingSlots without aborting their controller or
 *   canceling their records → broken liveness state for other users.
 *   Fix: use per-cat releaseSlot(tid, cid) scoped to cancelledCatIds from cancelAll.
 *
 * P2: orphan cancel multi-cat record false positive
 *   orphan cancel finds a record by targetCats.includes(catId) and marks the ENTIRE record
 *   canceled, even if sibling cats are still actively running in the tracker.
 *   Fix: only apply orphan cancel when record is single-cat OR all sibling slots are gone.
 *
 * RED → GREEN after fixes in packages/api/src/routes/queue.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { queueRoutes } = await import('../dist/routes/queue.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

const THREAD_ID = 'thread-scope-guard';
const USER_A = 'user-a';
const USER_B = 'user-b';
const CAT_OPUS = 'opus';
const CAT_CODEX = 'codex';

function makeRecordStore(records = []) {
  const map = new Map(records.map((r) => [r.id, { ...r }]));
  const updates = [];
  return {
    get: async (id) => map.get(id) ?? null,
    create: () => ({ outcome: 'created', invocationId: 'inv-new' }),
    update: async (id, input) => {
      updates.push({ id, input });
      const rec = map.get(id);
      if (!rec) return null;
      const updated = { ...rec, ...input, updatedAt: Date.now() };
      map.set(id, updated);
      return updated;
    },
    getByIdempotencyKey: () => null,
    listRunningByThread: (tid, uid) =>
      [...map.values()].filter((r) => r.status === 'running' && r.threadId === tid && r.userId === uid),
    updates,
    map,
  };
}

function makeThread(overrides = {}) {
  return {
    id: THREAD_ID,
    createdBy: USER_A,
    participants: [CAT_OPUS, CAT_CODEX],
    preferredCats: [CAT_OPUS, CAT_CODEX],
    mode: 'roundtable',
    roundtableIssueState: {
      v: 1,
      issueId: 'issue-test',
      threadId: THREAD_ID,
      topic: 'polluted test topic',
      status: 'open',
      stage: 'critique_loop',
      critiqueRound: 1,
      maxCritiqueRounds: 5,
      participants: [CAT_OPUS, CAT_CODEX],
      updatedAt: Date.now(),
    },
    ...overrides,
  };
}

function makeTracker({ activeSlots = {} } = {}) {
  // activeSlots: { 'threadId:catId': userId }
  const cancelAllCalls = [];
  const cancelAllReturnFn = (tid, uid) =>
    // Return only slots owned by uid in this thread
    Object.entries(activeSlots)
      .filter(([key, owner]) => key.startsWith(`${tid}:`) && owner === uid)
      .map(([key]) => key.split(':')[1]);

  return {
    has: (tid, cid) => {
      const key = cid ? `${tid}:${cid}` : Object.keys(activeSlots).some((k) => k.startsWith(`${tid}:`));
      return Boolean(activeSlots[`${tid}:${cid}`]);
    },
    getUserId: (tid, cid) => activeSlots[`${tid}:${cid}`] ?? null,
    cancel: () => ({ cancelled: false, catIds: [] }),
    getActiveSlots: (tid) =>
      Object.entries(activeSlots)
        .filter(([k]) => k.startsWith(`${tid}:`))
        .map(([k]) => ({ catId: k.split(':')[1], startedAt: Date.now() })),
    cancelAll: (tid, uid, reason) => {
      const catIds = cancelAllReturnFn(tid, uid);
      cancelAllCalls.push({ tid, uid, reason, catIds });
      return catIds;
    },
    cancelAllCalls,
  };
}

function makeQueueProcessor() {
  const actions = [];
  return {
    clearPause: (tid, cid) => actions.push({ op: 'clearPause', tid, cid }),
    releaseSlot: (tid, cid) => actions.push({ op: 'releaseSlot', tid, cid }),
    releaseThread: (tid) => actions.push({ op: 'releaseThread', tid }),
    hasActiveExecution: () => false,
    isCatBusy: () => false,
    actions,
  };
}

function makeMessageStore(messages = []) {
  const map = new Map(messages.map((message) => [message.id, { ...message }]));
  const softDeletes = [];
  return {
    getByThread: async (threadId, limit = 10000) =>
      [...map.values()]
        .filter(
          (message) => message.threadId === threadId && !message.deletedAt && message.deliveryStatus !== 'canceled',
        )
        .slice(0, limit),
    softDelete: async (id, deletedBy) => {
      const message = map.get(id);
      if (!message) return null;
      const deleted = { ...message, deletedAt: Date.now(), deletedBy };
      map.set(id, deleted);
      softDeletes.push({ id, deletedBy });
      return deleted;
    },
    markCanceled: async (id) => {
      const message = map.get(id);
      if (!message) return null;
      const canceled = { ...message, deliveryStatus: 'canceled' };
      map.set(id, canceled);
      return canceled;
    },
    map,
    softDeletes,
  };
}

async function buildApp({
  userId = USER_A,
  tracker = makeTracker(),
  queueProcessor = makeQueueProcessor(),
  recordStore = makeRecordStore(),
  thread = makeThread({ createdBy: userId }),
  messageStore,
  sessionManager,
  sessionChainStore,
  sessionSealer,
} = {}) {
  const app = Fastify({ logger: false });
  const invocationQueue = new InvocationQueue();
  const threadStoreUpdates = [];
  const socketEvents = [];

  await app.register(queueRoutes, {
    threadStore: {
      get: async (id) => (id === thread.id ? thread : { ...thread, id }),
      addParticipants: async () => {},
      updateLastActive: async () => {},
      updateRoundtableIssueState: async (id, state) => {
        threadStoreUpdates.push({ op: 'updateRoundtableIssueState', id, state });
        if (state === null) delete thread.roundtableIssueState;
        else thread.roundtableIssueState = state;
      },
    },
    invocationQueue,
    queueProcessor,
    invocationTracker: tracker,
    socketManager: {
      broadcastToRoom: (room, event, data) => socketEvents.push({ op: 'broadcastToRoom', room, event, data }),
      broadcastAgentMessage: (message, threadId) =>
        socketEvents.push({ op: 'broadcastAgentMessage', message, threadId }),
      getIO: () => ({}),
      emitToUser: () => {},
    },
    invocationRecordStore: recordStore,
    ...(messageStore ? { messageStore } : {}),
    ...(sessionManager ? { sessionManager } : {}),
    ...(sessionChainStore ? { sessionChainStore } : {}),
    ...(sessionSealer ? { sessionSealer } : {}),
  });

  await app.ready();
  return { app, tracker, queueProcessor, recordStore, threadStoreUpdates, socketEvents };
}

// ── P1: force-reset cross-user scope ──

describe('force-reset: does not affect other users processingSlots (P1 scope guard)', () => {
  it('only releases slots for the requesting user, not other users on shared thread', async () => {
    // User A owns opus slot, user B owns codex slot — both on same thread
    const tracker = makeTracker({
      activeSlots: {
        [`${THREAD_ID}:${CAT_OPUS}`]: USER_A, // user A's slot
        [`${THREAD_ID}:${CAT_CODEX}`]: USER_B, // user B's slot
      },
    });

    // Records for user A only (listRunningByThread is user-scoped)
    const recordStore = makeRecordStore([
      {
        id: 'inv-user-a',
        threadId: THREAD_ID,
        userId: USER_A,
        targetCats: [CAT_OPUS],
        status: 'running',
        idempotencyKey: 'idem-a',
        intent: 'execute',
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
      },
    ]);

    const qp = makeQueueProcessor();
    const { app } = await buildApp({ userId: USER_A, tracker, queueProcessor: qp, recordStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_A },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.canceledRecords, 1);

    // releaseThread must NOT have been called (it's unscoped and would clear user B's slot)
    const releaseThreadCall = qp.actions.find((a) => a.op === 'releaseThread');
    assert.equal(
      releaseThreadCall,
      undefined,
      `releaseThread must NOT be called (cross-user scope risk). Actions: ${JSON.stringify(qp.actions)}`,
    );

    // Instead, releaseSlot should be called only for user A's opus slot
    const releaseOpusSlot = qp.actions.find((a) => a.op === 'releaseSlot' && a.cid === CAT_OPUS);
    assert.ok(releaseOpusSlot, 'releaseSlot must be called for user A opus slot');

    // User B's codex slot must NOT have been released
    const releaseCodexSlot = qp.actions.find((a) => a.op === 'releaseSlot' && a.cid === CAT_CODEX);
    assert.equal(releaseCodexSlot, undefined, 'user B codex slot must NOT be released by user A force-reset');
  });
});

describe('session-reset: cuts provider context without deleting thread history', () => {
  it('defaults to roundtable profile and clears current issue runtime state', async () => {
    const sessionManagerDeletes = [];
    const sessionManager = {
      delete: async (...args) => sessionManagerDeletes.push(args),
    };
    const thread = makeThread();
    const { app, threadStoreUpdates, socketEvents } = await buildApp({ thread, sessionManager });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/session-reset`,
      headers: { 'x-cat-cafe-user': USER_A },
      payload: { catIds: [CAT_OPUS], cancelRunning: false },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.catIds, [CAT_OPUS]);
    assert.deepEqual(body.promptProfiles, ['roundtable']);
    assert.equal(body.providerSessionBindingsCleared, 1);
    assert.equal(body.roundtableIssueReset, true);
    assert.deepEqual(sessionManagerDeletes, [[USER_A, CAT_OPUS, THREAD_ID, 'roundtable']]);
    assert.equal(thread.roundtableIssueState, undefined);
    assert.ok(
      threadStoreUpdates.find((u) => u.op === 'updateRoundtableIssueState' && u.id === THREAD_ID && u.state === null),
    );
    assert.ok(
      socketEvents.find(
        (event) =>
          event.op === 'broadcastToRoom' &&
          event.room === `thread:${THREAD_ID}` &&
          event.event === 'thread_updated' &&
          event.data.roundtableIssueState === null,
      ),
    );
  });

  it('seals an active development session before clearing resume binding', async () => {
    const activeSession = {
      id: 'session-active',
      status: 'active',
      catId: CAT_CODEX,
      threadId: THREAD_ID,
    };
    const sessionManagerDeletes = [];
    const sessionChainStore = {
      getActive: async (catId, threadId, promptProfile) =>
        catId === CAT_CODEX && threadId === THREAD_ID && promptProfile === undefined ? activeSession : null,
      update: async () => null,
    };
    const sealerCalls = [];
    const sessionSealer = {
      requestSeal: async (args) => {
        sealerCalls.push({ op: 'requestSeal', args });
        return { accepted: true, status: 'sealing', sessionId: args.sessionId };
      },
      finalize: async (args) => {
        sealerCalls.push({ op: 'finalize', args });
      },
    };
    const sessionManager = {
      delete: async (...args) => sessionManagerDeletes.push(args),
    };
    const { app } = await buildApp({
      thread: makeThread({ mode: 'development', roundtableIssueState: undefined }),
      sessionManager,
      sessionChainStore,
      sessionSealer,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/session-reset`,
      headers: { 'x-cat-cafe-user': USER_A },
      payload: { catIds: [CAT_CODEX], cancelRunning: false },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.promptProfiles, ['development']);
    assert.equal(body.sealedSessions, 1);
    assert.deepEqual(sealerCalls, [
      { op: 'requestSeal', args: { sessionId: 'session-active', reason: 'manual_context_reset' } },
      { op: 'finalize', args: { sessionId: 'session-active' } },
    ]);
    assert.deepEqual(sessionManagerDeletes, [[USER_A, CAT_CODEX, THREAD_ID, undefined]]);
  });
});

describe('history-reset: hides visible messages and restarts provider context', () => {
  it('soft-deletes current thread messages and reuses session reset behavior', async () => {
    const messageStore = makeMessageStore([
      {
        id: 'msg-user',
        threadId: THREAD_ID,
        userId: USER_A,
        content: 'polluted user prompt',
        timestamp: Date.now() - 2,
        deliveryStatus: 'delivered',
      },
      {
        id: 'msg-agent',
        threadId: THREAD_ID,
        userId: 'system',
        content: 'polluted agent answer',
        timestamp: Date.now() - 1,
        deliveryStatus: 'delivered',
      },
    ]);
    const sessionManagerDeletes = [];
    const sessionManager = {
      delete: async (...args) => sessionManagerDeletes.push(args),
    };
    const thread = makeThread();
    const { app, socketEvents } = await buildApp({ thread, messageStore, sessionManager });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/history-reset`,
      headers: { 'x-cat-cafe-user': USER_A },
      payload: { mode: 'all' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.deletedMessages, 2);
    assert.deepEqual(messageStore.softDeletes, [
      { id: 'msg-user', deletedBy: USER_A },
      { id: 'msg-agent', deletedBy: USER_A },
    ]);
    assert.equal((await messageStore.getByThread(THREAD_ID)).length, 0);
    assert.equal(body.sessionReset.ok, true);
    assert.equal(body.sessionReset.roundtableIssueReset, true);
    assert.deepEqual(sessionManagerDeletes, [
      [USER_A, CAT_OPUS, THREAD_ID, 'roundtable'],
      [USER_A, CAT_CODEX, `${THREAD_ID}::provider-session:codex-roundtable-writable-v1`, 'roundtable'],
      [USER_A, CAT_CODEX, THREAD_ID, 'roundtable'],
    ]);
    const deletedEvents = socketEvents.filter((event) => event.event === 'message_deleted');
    assert.deepEqual(
      deletedEvents.map((event) => event.data.messageId),
      ['msg-user', 'msg-agent'],
    );
  });

  it('does not clear system public thread history', async () => {
    const messageStore = makeMessageStore([
      {
        id: 'msg-public',
        threadId: THREAD_ID,
        userId: USER_A,
        content: 'shared message',
        timestamp: Date.now(),
        deliveryStatus: 'delivered',
      },
    ]);
    const { app } = await buildApp({ thread: makeThread({ createdBy: 'system' }), messageStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/history-reset`,
      headers: { 'x-cat-cafe-user': USER_A },
      payload: { mode: 'all' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(messageStore.softDeletes.length, 0);
    assert.equal((await messageStore.getByThread(THREAD_ID)).length, 1);
  });
});

// ── P2: orphan cancel multi-cat record sibling guard ──

describe('orphan cancel: does not cancel multi-cat record with active siblings (P2)', () => {
  it('returns 404 (skips orphan cancel) when sibling cat has active tracker slot', async () => {
    // Multi-cat invocation: opus (orphan, no slot) + codex (STILL active in tracker)
    const tracker = makeTracker({
      activeSlots: {
        [`${THREAD_ID}:${CAT_CODEX}`]: USER_A, // codex sibling is still running
      },
    });

    const recordStore = makeRecordStore([
      {
        id: 'inv-multi-cat',
        threadId: THREAD_ID,
        userId: USER_A,
        targetCats: [CAT_OPUS, CAT_CODEX], // multi-cat record
        status: 'running',
        idempotencyKey: 'idem-multi',
        intent: 'execute',
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
      },
    ]);

    const { app } = await buildApp({ tracker, recordStore });

    // Cancel opus (orphan — no tracker slot)
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/cancel/${CAT_OPUS}`,
      headers: { 'x-cat-cafe-user': USER_A },
    });

    // Must NOT mark the entire record canceled (codex sibling is still active)
    assert.equal(
      res.statusCode,
      404,
      `Should NOT cancel multi-cat record when sibling ${CAT_CODEX} is active. Got: ${res.statusCode}`,
    );
    assert.equal(recordStore.updates.length, 0, 'multi-cat record must NOT be marked canceled');
  });

  it('cancels multi-cat record when ALL siblings have no active tracker slot', async () => {
    // Multi-cat: opus (orphan, no slot) + codex (also orphan, no slot)
    const tracker = makeTracker({ activeSlots: {} }); // no active slots at all

    const recordStore = makeRecordStore([
      {
        id: 'inv-multi-all-orphan',
        threadId: THREAD_ID,
        userId: USER_A,
        targetCats: [CAT_OPUS, CAT_CODEX],
        status: 'running',
        idempotencyKey: 'idem-all-orphan',
        intent: 'execute',
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
      },
    ]);

    const { app } = await buildApp({ tracker, recordStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/cancel/${CAT_OPUS}`,
      headers: { 'x-cat-cafe-user': USER_A },
    });

    // All siblings gone — safe to cancel the record
    assert.equal(res.statusCode, 200, `Should cancel when all siblings are orphans. Got: ${res.statusCode}`);
    const update = recordStore.updates.find((u) => u.id === 'inv-multi-all-orphan' && u.input.status === 'canceled');
    assert.ok(update, 'record should be marked canceled when all siblings are orphans');
  });
});
