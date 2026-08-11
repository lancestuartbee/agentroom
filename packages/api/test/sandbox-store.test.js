import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Sandbox store', () => {
  test('InMemorySandboxStore persists to disk and rehydrates on restart', async () => {
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );

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
});
