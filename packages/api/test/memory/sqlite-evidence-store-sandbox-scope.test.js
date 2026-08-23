import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('SqliteEvidenceStore sandbox scope (F247 Phase B)', () => {
  let store;
  const savedEnv = {};

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
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
});
