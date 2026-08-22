import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});
