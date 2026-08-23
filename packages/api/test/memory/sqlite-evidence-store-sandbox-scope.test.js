import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

let passageVectorKey;

function createEmbedding(vector) {
  return {
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    embed: async () => [vector],
    getModelInfo: () => ({ modelId: 'test-sandbox-scope', modelRev: 'v1', dim: 3 }),
  };
}

describe('SqliteEvidenceStore sandbox scope (F247 Phase B)', () => {
  let store;
  let passageVectorStore;
  let vectorStore;
  const savedEnv = {};

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { PassageVectorStore, passageVectorKey: pvk } = await import('../../dist/domains/memory/PassageVectorStore.js');
    passageVectorKey = pvk;
    const { VectorStore } = await import('../../dist/domains/memory/VectorStore.js');
    const { ensurePassageVectorTable, ensureVectorTable } = await import('../../dist/domains/memory/schema.js');

    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 3);
    ensurePassageVectorTable(db, 3);
    vectorStore = new VectorStore(db, 3);
    passageVectorStore = new PassageVectorStore(db, 3);

    store.setEmbedDeps({
      embedding: createEmbedding(new Float32Array([1, 0, 0])),
      vectorStore,
      passageVectorStore,
      mode: 'on',
    });

    savedEnv.F163 = process.env.F163_AUTHORITY_BOOST;
    savedEnv.F200 = process.env.F200_CONSUMPTION_RERANK;
    delete process.env.F163_AUTHORITY_BOOST;
    delete process.env.F200_CONSUMPTION_RERANK;
  });

  afterEach(() => {
    if (savedEnv.F163 === undefined) delete process.env.F163_AUTHORITY_BOOST;
    else process.env.F163_AUTHORITY_BOOST = savedEnv.F163;
    if (savedEnv.F200 === undefined) delete process.env.F200_CONSUMPTION_RERANK;
    else process.env.F200_CONSUMPTION_RERANK = savedEnv.F200;
  });

  it('lexical search scopes to sandbox anchor prefix before top-K truncation', async () => {
    const normalItems = Array.from({ length: 8 }, (_, i) => ({
      anchor: `doc:project/feature-${i}`,
      kind: 'feature',
      status: 'active',
      title: `Project feature ${i} mentions the keyword`,
      summary: `Summary ${i}`,
      updatedAt: '2026-08-23T00:00:00Z',
    }));

    const sandboxItem = {
      anchor: 'sandbox:sandbox:sb-scope-test:learned:alpha',
      kind: 'lesson',
      status: 'active',
      title: 'Sandbox lesson mentions the keyword',
      summary: 'This belongs to the sandbox',
      updatedAt: '2026-08-23T00:00:00Z',
    };

    await store.upsert([...normalItems, sandboxItem]);

    // Without scope, the sandbox item is ranked behind the 8 project items
    // and gets truncated by limit=1.
    const unscoped = await store.search('keyword', { mode: 'lexical', limit: 1 });
    assert.equal(unscoped.length, 1);
    assert.ok(
      unscoped[0].anchor.startsWith('doc:project/'),
      'unscoped top-1 should be a project item, proving the truncation window exists',
    );

    // With sandboxId, the store applies the scope at the SQL level, so the
    // sandbox item is the only candidate and wins even with limit=1.
    const scoped = await store.search('keyword', {
      mode: 'lexical',
      limit: 1,
      sandboxId: 'sandbox:sb-scope-test',
    });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].anchor, sandboxItem.anchor);
  });

  it('contains backfill also scopes to sandbox anchor prefix', async () => {
    // "reticulum" is unlikely to be tokenized as a whole by FTS5 unicode61,
    // so this exercises the LOWER(...) LIKE '%word%' backfill path.
    await store.upsert([
      {
        anchor: 'doc:project/reticulum-notes',
        kind: 'note',
        status: 'active',
        title: 'Project reticulum notes',
        summary: 'project only',
        updatedAt: '2026-08-23T00:00:00Z',
      },
      {
        anchor: 'sandbox:sandbox:sb-contains:learned:reticulum',
        kind: 'lesson',
        status: 'active',
        title: 'Sandbox reticulum insight',
        summary: 'sandbox only',
        updatedAt: '2026-08-23T00:00:00Z',
      },
    ]);

    const scoped = await store.search('reticulum', {
      mode: 'lexical',
      limit: 1,
      sandboxId: 'sandbox:sb-contains',
    });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].anchor, 'sandbox:sandbox:sb-contains:learned:reticulum');
  });

  it('LIKE wildcards in sandboxId are escaped, not interpreted', async () => {
    // A malicious/malformed sandboxId containing % or _ must not broaden the scope.
    await store.upsert([
      {
        anchor: 'sandbox:sandbox:sb-escape:learned:x',
        kind: 'lesson',
        status: 'active',
        title: 'Exact sandbox item with keyword',
        updatedAt: '2026-08-23T00:00:00Z',
      },
      {
        anchor: 'sandbox:sandbox:sb-other:learned:y',
        kind: 'lesson',
        status: 'active',
        title: 'Other sandbox item with keyword',
        updatedAt: '2026-08-23T00:00:00Z',
      },
    ]);

    // % in the id should match literally, not as a wildcard.
    const scoped = await store.search('keyword', {
      mode: 'lexical',
      limit: 10,
      sandboxId: 'sandbox:sb-%scape',
    });
    assert.equal(scoped.length, 0);
  });

  it('depth=raw scopes passage hits to sandbox anchor prefix before top-K truncation', async () => {
    // Global doc only matches at the passage level; its parent doc must not leak
    // into a sandbox-scoped raw search even when the global passage is the top
    // passage hit.
    await store.upsert([
      {
        anchor: 'doc:global-secret',
        kind: 'thread',
        status: 'active',
        title: 'Unrelated global thread',
        summary: 'No sandbox keyword here',
        updatedAt: '2026-08-23T00:00:00Z',
      },
      {
        anchor: 'sandbox:sandbox:sb-raw:learned:own',
        kind: 'lesson',
        status: 'active',
        title: 'Sandbox lesson',
        summary: 'needle insight',
        updatedAt: '2026-08-23T00:00:00Z',
      },
    ]);

    const db = store.getDb();
    const stmt = db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    // Global passage is the only passage hit; sandbox doc matches at doc level only.
    stmt.run('doc:global-secret', 'msg-001', 'the needle is in the haystack', 'user', 0, '2026-08-23T00:00:00Z');
    stmt.run('sandbox:sandbox:sb-raw:learned:own', 'msg-001', 'sandbox conclusion without keyword', 'opus', 0, '2026-08-23T00:00:00Z');

    // Unscoped raw search surfaces the passage-only global doc first.
    const unscoped = await store.search('needle', { mode: 'lexical', depth: 'raw', limit: 1 });
    assert.equal(unscoped.length, 1);
    assert.equal(unscoped[0].anchor, 'doc:global-secret');

    // Scoped raw search must not include the global doc even with limit=1.
    const scoped = await store.search('needle', {
      mode: 'lexical',
      depth: 'raw',
      limit: 1,
      sandboxId: 'sandbox:sb-raw',
    });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].anchor, 'sandbox:sandbox:sb-raw:learned:own');
  });

  it('depth=raw semantic scopes ANN search to sandbox before top-K truncation', async () => {
    // 20 global passages are nearer to the query vector than the single sandbox
    // passage. Unscoped ANN with k=20 returns only global hits; scoped ANN must
    // still find the sandbox hit.
    const globalItems = Array.from({ length: 20 }, (_, i) => ({
      anchor: `doc:global-passage-${i}`,
      kind: 'thread',
      status: 'active',
      title: `Global thread ${i}`,
      summary: 'Global coordination note',
      updatedAt: '2026-08-23T00:00:00Z',
    }));
    const sandboxItem = {
      anchor: 'sandbox:sandbox:sb-semantic:learned:own',
      kind: 'lesson',
      status: 'active',
      title: 'Sandbox lesson',
      summary: 'Sandbox coordination insight',
      updatedAt: '2026-08-23T00:00:00Z',
    };
    await store.upsert([...globalItems, sandboxItem]);

    const db = store.getDb();
    const insertPassage = db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );

    const queryVec = new Float32Array([1, 0, 0]);
    for (let i = 0; i < 20; i++) {
      insertPassage.run(
        `doc:global-passage-${i}`,
        'msg-001',
        `Global coordination detail ${i}`,
        'user',
        i,
        '2026-08-23T00:00:00Z',
      );
      // Each global vector is closer to [1,0,0] than the sandbox vector below.
      passageVectorStore.upsert(
        passageVectorKey(`doc:global-passage-${i}`, 'msg-001'),
        new Float32Array([0.99 - i * 0.001, 0.01, 0]),
      );
    }
    insertPassage.run(
      'sandbox:sandbox:sb-semantic:learned:own',
      'msg-001',
      'Sandbox coordination insight',
      'opus',
      0,
      '2026-08-23T00:00:00Z',
    );
    // Sandbox vector is farther from [1,0,0] than all 20 global vectors.
    passageVectorStore.upsert(
      passageVectorKey('sandbox:sandbox:sb-semantic:learned:own', 'msg-001'),
      new Float32Array([0.5, 0.5, 0]),
    );

    // Unscoped semantic ANN (k=20) only sees the 20 nearer global passages.
    const unscoped = await store.search('coordination', {
      mode: 'semantic',
      depth: 'raw',
      limit: 1,
    });
    assert.equal(unscoped.length, 1);
    assert.equal(unscoped[0].anchor, 'doc:global-passage-0');

    // Scoped semantic ANN must apply the scope inside sqlite-vec so the sandbox
    // passage wins even though it is vector-ranked behind all global items.
    const scoped = await store.search('coordination', {
      mode: 'semantic',
      depth: 'raw',
      limit: 1,
      sandboxId: 'sandbox:sb-semantic',
    });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].anchor, 'sandbox:sandbox:sb-semantic:learned:own');
  });

  it('depth=raw hybrid keeps scoped semantic hit when lexical side has no sandbox match', async () => {
    // Same vector layout as the semantic test, but query tokens intentionally
    // absent from every doc title/summary so lexical returns nothing. Hybrid
    // must still surface the sandbox passage via scoped semantic ANN.
    const globalItems = Array.from({ length: 20 }, (_, i) => ({
      anchor: `doc:global-passage-${i}`,
      kind: 'thread',
      status: 'active',
      title: `Global thread ${i}`,
      summary: 'Global note',
      updatedAt: '2026-08-23T00:00:00Z',
    }));
    const sandboxItem = {
      anchor: 'sandbox:sandbox:sb-hybrid:learned:own',
      kind: 'lesson',
      status: 'active',
      title: 'Sandbox lesson',
      summary: 'Sandbox note',
      updatedAt: '2026-08-23T00:00:00Z',
    };
    await store.upsert([...globalItems, sandboxItem]);

    const db = store.getDb();
    const insertPassage = db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );

    for (let i = 0; i < 20; i++) {
      insertPassage.run(
        `doc:global-passage-${i}`,
        'msg-001',
        `Global note content ${i}`,
        'user',
        i,
        '2026-08-23T00:00:00Z',
      );
      passageVectorStore.upsert(
        passageVectorKey(`doc:global-passage-${i}`, 'msg-001'),
        new Float32Array([0.99 - i * 0.001, 0.01, 0]),
      );
    }
    insertPassage.run(
      'sandbox:sandbox:sb-hybrid:learned:own',
      'msg-001',
      'Sandbox note content',
      'opus',
      0,
      '2026-08-23T00:00:00Z',
    );
    passageVectorStore.upsert(
      passageVectorKey('sandbox:sandbox:sb-hybrid:learned:own', 'msg-001'),
      new Float32Array([0.5, 0.5, 0]),
    );

    // Query token "uniquetoken" appears nowhere, so lexical is empty.
    // Unscoped hybrid falls back to global semantic top-1.
    const unscoped = await store.search('uniquetoken', {
      mode: 'hybrid',
      depth: 'raw',
      limit: 1,
    });
    assert.equal(unscoped.length, 1);
    assert.equal(unscoped[0].anchor, 'doc:global-passage-0');

    // Scoped hybrid should find the sandbox passage through scoped semantic ANN.
    const scoped = await store.search('uniquetoken', {
      mode: 'hybrid',
      depth: 'raw',
      limit: 1,
      sandboxId: 'sandbox:sb-hybrid',
    });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].anchor, 'sandbox:sandbox:sb-hybrid:learned:own');
  });
});
