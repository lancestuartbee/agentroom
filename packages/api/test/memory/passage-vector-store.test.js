import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

describe('PassageVectorStore', () => {
  let db;

  beforeEach(async () => {
    const { applyMigrations, ensurePassageVectorTable, ensureVectorTable } = await import(
      '../../dist/domains/memory/schema.js'
    );

    db = new Database(':memory:');
    applyMigrations(db);
    sqliteVec.load(db);
    assert.equal(ensureVectorTable(db, 4), true);
    assert.equal(ensurePassageVectorTable(db, 4), true);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('round-trips arbitrary passage vector keys without ad hoc splitting', async () => {
    const { parsePassageVectorKey, passageVectorKey } = await import('../../dist/domains/memory/PassageVectorStore.js');

    const key = passageVectorKey('thread-thread_abc::with-delimiter', 'msg-001/with/slash');
    assert.deepEqual(parsePassageVectorKey(key), {
      docAnchor: 'thread-thread_abc::with-delimiter',
      passageId: 'msg-001/with/slash',
    });
  });

  it('stores and searches passage vectors independently from document vectors', async () => {
    const { VectorStore } = await import('../../dist/domains/memory/VectorStore.js');
    const { PassageVectorStore, passageVectorKey } = await import('../../dist/domains/memory/PassageVectorStore.js');

    const docVectors = new VectorStore(db, 4);
    const passageVectors = new PassageVectorStore(db, 4);

    docVectors.upsert('F102', new Float32Array([0, 0, 1, 0]));
    passageVectors.upsert(passageVectorKey('thread-thread_a', 'msg-001'), new Float32Array([1, 0, 0, 0]));
    passageVectors.upsert(passageVectorKey('thread-thread_b', 'msg-002'), new Float32Array([0, 1, 0, 0]));

    const hits = passageVectors.search(new Float32Array([1, 0, 0, 0]), 2);
    assert.equal(hits[0].passageKey, passageVectorKey('thread-thread_a', 'msg-001'));
    assert.equal(passageVectors.count(), 2);
    assert.equal(docVectors.count(), 1);

    passageVectors.delete(passageVectorKey('thread-thread_a', 'msg-001'));
    assert.equal(passageVectors.count(), 1);
    assert.equal(docVectors.count(), 1);

    passageVectors.clearAll();
    assert.equal(passageVectors.count(), 0);
    assert.equal(docVectors.count(), 1);
  });

  it('scoped search deduplicates across widening pools and returns k distinct hits', async () => {
    const { PassageVectorStore, passageVectorKey } = await import('../../dist/domains/memory/PassageVectorStore.js');

    const passageVectors = new PassageVectorStore(db, 4);
    const queryVec = new Float32Array([1, 0, 0, 0]);
    const sandboxId = 'sandbox:sb-dedup';

    // Layout: ranks 1-10 are sandbox early, 11-20 are global, 21-30 are sandbox late.
    // Without cross-pool deduplication the early sandbox hits would be counted
    // again in the second pool and the search would return before scanning the
    // late sandbox hits.
    for (let i = 0; i < 10; i++) {
      passageVectors.upsert(
        passageVectorKey(`sandbox:${sandboxId}:learned:early-${i}`, 'msg-001'),
        new Float32Array([0.99 - i * 0.001, 0.01, 0, 0]),
      );
    }
    for (let i = 0; i < 10; i++) {
      passageVectors.upsert(
        passageVectorKey(`doc:global-passage-${i}`, 'msg-001'),
        new Float32Array([0.9 - i * 0.001, 0.01, 0, 0]),
      );
    }
    for (let i = 0; i < 10; i++) {
      passageVectors.upsert(
        passageVectorKey(`sandbox:${sandboxId}:learned:late-${i}`, 'msg-001'),
        new Float32Array([0.5 - i * 0.001, 0.01, 0, 0]),
      );
    }

    const hits = passageVectors.search(queryVec, 20, { sandboxId });
    const keys = hits.map((h) => h.passageKey);
    const distinct = new Set(keys);

    assert.equal(hits.length, 20, 'should return exactly k distinct hits');
    assert.equal(distinct.size, 20, 'no duplicate keys across widening pools');
    assert.ok(
      keys.every((k) => k.startsWith(`["sandbox:${sandboxId}:`)),
      'all hits belong to the sandbox',
    );
    assert.ok(
      keys.some((k) => k.includes('late-')),
      'late sandbox hits must be reachable after widening',
    );
  });
});
