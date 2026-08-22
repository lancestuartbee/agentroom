import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

describe('Sandbox store', () => {
  // Regression: sandbox ids double as evidence collection ids. A bare UUID starts
  // with a hex digit ~62.5% of the time, which violates COLLECTION_ID_RE's
  // "name must start with a letter" rule — measured 641/1000 failures before the fix.
  // Loop many ids so the probabilistic failure cannot slip through as a flake.
  test('generated sandbox ids are always valid evidence collection ids', async () => {
    const { InMemorySandboxStore } = await import('../dist/domains/sandbox/stores/InMemorySandboxStore.js');
    const { validateCollectionId } = await import('../dist/domains/memory/collection-types.js');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-idtest-'));
    const projectPath = join(tmpDir, 'project');
    await import('node:fs/promises').then((fs) => fs.mkdir(projectPath, { recursive: true }));

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });

    for (let i = 0; i < 200; i++) {
      const sandbox = await store.create(
        {
          title: `Sandbox ${i}`,
          projectPath,
          members: ['opus'],
          spec: { specVersion: '1', name: `S${i}`, goal: 'goal', members: ['opus'] },
        },
        'user-1',
      );
      assert.doesNotThrow(
        () => validateCollectionId(sandbox.id),
        `sandbox id must be a valid collection id: ${sandbox.id}`,
      );
      assert.equal(sandbox.id.startsWith('sandbox:'), true);
    }

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('InMemorySandboxStore persists to disk and rehydrates on restart', async () => {
    const { InMemorySandboxStore } = await import('../dist/domains/sandbox/stores/InMemorySandboxStore.js');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-test-'));
    const indexFilePath = join(tmpDir, 'a2a-sandbox-index.jsonl');
    const projectPath = join(tmpDir, 'project');
    await import('node:fs/promises').then((fs) => fs.mkdir(projectPath, { recursive: true }));

    // First process lifetime: create sandbox + bind thread + update memory
    const store1 = new InMemorySandboxStore({ indexFilePath });
    const sandbox = await store1.create(
      {
        title: 'Test sandbox',
        projectPath,
        members: ['opus', 'kimi'],
        spec: {
          specVersion: '1',
          name: 'Test',
          goal: 'Test goal',
          members: ['opus', 'kimi'],
        },
      },
      'user-1',
    );
    await store1.bindThread(sandbox.id, 'thread-1');
    await store1.updateMemory(sandbox.id, {
      v: 1,
      summary: 'Learned something important',
      runsIncorporated: 3,
      updatedAt: Date.now(),
    });

    // Simulate restart: new store instance, same disk files
    const store2 = new InMemorySandboxStore({ indexFilePath });
    await store2.rehydrate();

    const rehydrated = await store2.getByThreadId('thread-1');
    assert.ok(rehydrated, 'sandbox should be rehydrated from disk');
    assert.equal(rehydrated.id, sandbox.id);
    assert.equal(rehydrated.title, 'Test sandbox');
    assert.equal(rehydrated.threadId, 'thread-1');
    assert.deepEqual(rehydrated.members, ['opus', 'kimi']);

    const memory = await store2.getMemory(sandbox.id);
    assert.ok(memory, 'memory should be rehydrated');
    assert.equal(memory.summary, 'Learned something important');
    assert.equal(memory.runsIncorporated, 3);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('a report mixing id-ed and bare learnings yields no learnings (not a partial parse)', async () => {
    const { InMemorySandboxStore } = await import('../dist/domains/sandbox/stores/InMemorySandboxStore.js');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-mixed-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });

    await writeFile(
      join(runsDir, 'run-mixed.md'),
      [
        '# Sandbox Run run-mixed',
        '',
        '- Trigger: scheduled',
        '- Triggered At: 2026-01-01T00:00:00.000Z',
        '- Spec Version: 1',
        '',
        '## Summary',
        '',
        'mixed format report',
        '',
        '## Learned',
        '',
        '- id:a this line has an id',
        '- this line does not',
        '',
      ].join('\n'),
      'utf-8',
    );

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      {
        title: 'Mixed',
        projectPath,
        members: ['opus'],
        spec: { specVersion: '1', name: 'Mixed', goal: 'g', members: ['opus'] },
      },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const runs = await store.listRuns(sandbox.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].learned, undefined);
    assert.equal(runs[0].learnedWithIds, undefined);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('a report with duplicate learning ids yields no learnings (not a partial parse)', async () => {
    const { InMemorySandboxStore } = await import('../dist/domains/sandbox/stores/InMemorySandboxStore.js');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-dup-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });

    await writeFile(
      join(runsDir, 'run-dup.md'),
      [
        '# Sandbox Run run-dup',
        '',
        '- Trigger: scheduled',
        '- Triggered At: 2026-01-01T00:00:00.000Z',
        '- Spec Version: 1',
        '',
        '## Summary',
        '',
        'duplicate id report',
        '',
        '## Learned',
        '',
        '- id:same first use',
        '- id:same second use',
        '',
      ].join('\n'),
      'utf-8',
    );

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      {
        title: 'Dup',
        projectPath,
        members: ['opus'],
        spec: { specVersion: '1', name: 'Dup', goal: 'g', members: ['opus'] },
      },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const runs = await store.listRuns(sandbox.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].learned, undefined);
    assert.equal(runs[0].learnedWithIds, undefined);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('an incomplete id: line is a parse error and does not retract existing memory', async () => {
    const { InMemorySandboxStore } = await import('../dist/domains/sandbox/stores/InMemorySandboxStore.js');
    const { foldRunsIntoMemory } = await import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-incomplete-id-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    const memoryDir = join(projectPath, '.a2a-sandbox', 'memory');
    await mkdir(runsDir, { recursive: true });
    await mkdir(memoryDir, { recursive: true });

    // First run: a complete stable-id report that becomes durable memory.
    await writeFile(
      join(runsDir, 'run-1.md'),
      [
        '# Sandbox Run run-1',
        '',
        '- Trigger: scheduled',
        '- Triggered At: 2026-01-01T00:00:00.000Z',
        '- Spec Version: 1',
        '',
        '## Summary',
        '',
        'first run',
        '',
        '## Learned',
        '',
        '- id:a original conclusion',
        '',
      ].join('\n'),
      'utf-8',
    );

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      {
        title: 'Incomplete',
        projectPath,
        members: ['opus'],
        spec: { specVersion: '1', name: 'Incomplete', goal: 'g', members: ['opus'] },
      },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const firstRuns = await store.listRuns(sandbox.id);
    const firstFold = foldRunsIntoMemory(null, firstRuns);
    await store.updateMemory(sandbox.id, firstFold.memory);

    // Second run: the member left `- id:a` with no conclusion. This is a malformed
    // stable-id attempt, not a retraction, and must not delete `a`.
    await writeFile(
      join(runsDir, 'run-2.md'),
      [
        '# Sandbox Run run-2',
        '',
        '- Trigger: scheduled',
        '- Triggered At: 2026-01-02T00:00:00.000Z',
        '- Spec Version: 1',
        '',
        '## Summary',
        '',
        'second run',
        '',
        '## Learned',
        '',
        '- id:a',
        '',
      ].join('\n'),
      'utf-8',
    );

    const secondRuns = await store.listRuns(sandbox.id);
    assert.equal(secondRuns[1].learningParseError, true, 'incomplete id: line must be flagged');

    const secondFold = foldRunsIntoMemory(firstFold.memory, secondRuns);
    assert.equal(secondFold.memory.learnedItems.length, 1, 'incomplete id must not retract existing learning');
    assert.equal(secondFold.memory.learnedItems[0].content, 'original conclusion');

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('a settled report without a ## Learned section is a parse error and does not retract memory', async () => {
    const { InMemorySandboxStore } = await import('../dist/domains/sandbox/stores/InMemorySandboxStore.js');
    const { foldRunsIntoMemory } = await import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-missing-learned-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    const memoryDir = join(projectPath, '.a2a-sandbox', 'memory');
    await mkdir(runsDir, { recursive: true });
    await mkdir(memoryDir, { recursive: true });

    await writeFile(
      join(runsDir, 'run-1.md'),
      [
        '# Sandbox Run run-1',
        '',
        '- Trigger: scheduled',
        '- Triggered At: 2026-01-01T00:00:00.000Z',
        '- Spec Version: 1',
        '',
        '## Summary',
        '',
        'first run',
        '',
        '## Learned',
        '',
        '- id:a original conclusion',
        '',
      ].join('\n'),
      'utf-8',
    );

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      {
        title: 'Missing',
        projectPath,
        members: ['opus'],
        spec: { specVersion: '1', name: 'Missing', goal: 'g', members: ['opus'] },
      },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const firstRuns = await store.listRuns(sandbox.id);
    const firstFold = foldRunsIntoMemory(null, firstRuns);
    await store.updateMemory(sandbox.id, firstFold.memory);

    // Second run has no ## Learned section at all. After the in-flight window passes,
    // this is a parse error, not a retraction.
    const run2Path = join(runsDir, 'run-2.md');
    await writeFile(
      run2Path,
      [
        '# Sandbox Run run-2',
        '',
        '- Trigger: scheduled',
        '- Triggered At: 2026-01-02T00:00:00.000Z',
        '- Spec Version: 1',
        '',
        '## Summary',
        '',
        'missing learned section',
        '',
      ].join('\n'),
      'utf-8',
    );
    // Backdate so the in-flight gate treats it as settled.
    await utimes(run2Path, new Date('2020-01-01'), new Date('2020-01-01'));

    const secondRuns = await store.listRuns(sandbox.id);
    assert.equal(secondRuns[1].learningParseError, true, 'missing ## Learned must be flagged once settled');

    const secondFold = foldRunsIntoMemory(firstFold.memory, secondRuns);
    assert.equal(secondFold.memory.learnedItems.length, 1, 'missing section must not retract existing learning');

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('bare stable id migration is persisted through the store path', async () => {
    const { InMemorySandboxStore } = await import('../dist/domains/sandbox/stores/InMemorySandboxStore.js');
    const { foldRunsIntoMemory } = await import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-migrate-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });

    const indexFilePath = join(tmpDir, 'index.jsonl');
    const store1 = new InMemorySandboxStore({ indexFilePath });
    const sandbox = await store1.create(
      {
        title: 'Migrate',
        projectPath,
        members: ['opus'],
        spec: { specVersion: '1', name: 'Migrate', goal: 'g', members: ['opus'] },
      },
      'user-1',
    );
    await store1.bindThread(sandbox.id, 'thread-1');

    // Seed an old memory with a bare local id, as if written by a pre-namespace version.
    const oldMemory = {
      v: 1,
      summary: '- [1970-01-01] first run',
      runsIncorporated: 1,
      processedRunIds: ['run-1'],
      lastRunAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      learnedItems: [
        { id: 'a', content: 'old bare id', sourceRunId: 'run-1', sourceRunAt: 1_700_000_000_000, promoted: false },
      ],
    };
    await store1.updateMemory(sandbox.id, oldMemory);

    // A report that agrees with the old memory.
    await writeFile(
      join(runsDir, 'run-1.md'),
      [
        '# Sandbox Run run-1',
        '',
        '- Trigger: scheduled',
        '- Triggered At: 2026-11-14T22:13:20.000Z',
        '- Spec Version: 1',
        '',
        '## Summary',
        '',
        'first run',
        '',
        '## Learned',
        '',
        '- id:a old bare id',
        '',
      ].join('\n'),
      'utf-8',
    );

    // Simulate restart: a fresh store reads the bare-id memory from disk.
    const store2 = new InMemorySandboxStore({ indexFilePath });
    await store2.rehydrate();
    const memoryBefore = await store2.getMemory(sandbox.id);
    assert.ok(memoryBefore, 'memory must survive restart');
    assert.equal(memoryBefore.learnedItems[0].id, 'a', 'fresh store must load the pre-namespace bare id');

    const runs = await store2.listRuns(sandbox.id);
    const folded = foldRunsIntoMemory(memoryBefore, runs);
    assert.equal(folded.changed, true, 'migration must be reported as a change');
    await store2.updateMemory(sandbox.id, folded.memory);

    // Another restart: the migration must now be persisted on disk.
    const store3 = new InMemorySandboxStore({ indexFilePath });
    await store3.rehydrate();
    const memoryAfter = await store3.getMemory(sandbox.id);
    assert.ok(memoryAfter, 'memory must survive second restart');
    assert.equal(memoryAfter.learnedItems.length, 1);
    assert.equal(memoryAfter.learnedItems[0].id, 'run-1\x1fa', 'bare id must be persisted as namespaced id');
    assert.equal(memoryAfter.learnedItems[0].content, 'old bare id');

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('promoteLearning marks an item promoted and records provenance', async () => {
    const { InMemorySandboxStore } = await import('../dist/domains/sandbox/stores/InMemorySandboxStore.js');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-promote-store-'));
    const projectPath = join(tmpDir, 'project');
    await mkdir(join(projectPath, '.a2a-sandbox', 'runs'), { recursive: true });

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      {
        title: 'Promote',
        projectPath,
        members: ['opus'],
        spec: { specVersion: '1', name: 'Promote', goal: 'g', members: ['opus'] },
      },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    await store.updateMemory(sandbox.id, {
      v: 1,
      summary: '',
      runsIncorporated: 1,
      updatedAt: 1000,
      learnedItems: [{ id: 'run-1\x1fa', content: 'A', sourceRunId: 'run-1', sourceRunAt: 1000, promoted: false }],
    });

    const promotedAt = Date.now();
    const provenance = {
      sandboxId: sandbox.id,
      sourceRunId: 'run-1',
      originalContent: 'A',
      promotedAt,
    };
    const evidenceAnchor = `sandbox:${sandbox.id}:learned:run-1\x1fa`;
    const updated = await store.promoteLearning(sandbox.id, 'run-1\x1fa', provenance, evidenceAnchor);

    assert.ok(updated);
    assert.equal(updated.promoted, true);
    assert.equal(updated.promotedAt, promotedAt);
    assert.equal(updated.promotedEvidenceAnchor, evidenceAnchor);
    assert.deepEqual(updated.promotionProvenance, provenance);

    const memory = await store.getMemory(sandbox.id);
    assert.equal(memory.learnedItems[0].promoted, true);
    assert.equal(memory.updatedAt, promotedAt);

    // Missing item returns null and must not mutate other items.
    const missing = await store.promoteLearning(sandbox.id, 'missing', provenance, 'anchor:missing');
    assert.equal(missing, null);
    assert.equal((await store.getMemory(sandbox.id)).learnedItems.length, 1);

    // Fingerprint mismatch rejects the promotion: a concurrent fold rewrote the same
    // stable id with new content/sourceRunId. Returning null prevents the stale evidence
    // content from being frozen as the promoted version.
    await store.updateMemory(sandbox.id, {
      v: 1,
      summary: '',
      runsIncorporated: 1,
      updatedAt: 2000,
      learnedItems: [{ id: 'run-1\x1fa', content: 'B', sourceRunId: 'run-2', sourceRunAt: 2000, promoted: false }],
    });
    const mismatch = await store.promoteLearning(sandbox.id, 'run-1\x1fa', provenance, evidenceAnchor, {
      sourceRunId: 'run-1',
      content: 'A',
    });
    assert.equal(mismatch, null);
    const memoryAfterMismatch = await store.getMemory(sandbox.id);
    assert.equal(memoryAfterMismatch.learnedItems[0].promoted, false);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
