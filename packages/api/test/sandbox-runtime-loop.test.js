import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC = { specVersion: '1', name: 'S', goal: 'g', members: ['opus'] };

async function makeSandbox() {
  const { InMemorySandboxStore } = await import(
    '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
  );
  const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-runtime-'));
  const projectPath = join(tmpDir, 'project');
  const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
  await mkdir(runsDir, { recursive: true });

  const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
  const sandbox = await store.create(
    { title: 'S', projectPath, members: ['opus'], spec: SPEC },
    'user-1',
  );
  await store.bindThread(sandbox.id, 'thread-1');
  return { store, sandbox, tmpDir, runsDir };
}

async function writeReport(runsDir, runId, { summary, learned, triggeredAt }) {
  const { renderSandboxRunReport } = await import(
    '../dist/domains/sandbox/services/sandbox-run-prompt.js'
  );
  await writeFile(
    join(runsDir, `${runId}.md`),
    renderSandboxRunReport({ runId, trigger: 'scheduled', specVersion: '1', summary, learned, triggeredAt }),
    'utf-8',
  );
}

describe('Sandbox runtime loop', () => {
  // Review finding (luna P1-1). The earlier test wrote its report BEFORE rehydrate(),
  // so it only ever exercised the restart path. The real timing is: the service is
  // already up, the member writes a report mid-flight, and the NEXT fire must see it.
  // Serving listRuns() from a memory cache made that return nothing — the sandbox kept
  // running and silently stopped learning until someone restarted the process.
  test('a report written while the service is running is visible to the next fold', async () => {
    const { store, sandbox, tmpDir, runsDir } = await makeSandbox();

    // Same live store instance — no restart, no rehydrate.
    await writeReport(runsDir, 'run-live', {
      summary: '运行中写入的摘要',
      learned: ['运行中学到的结论'],
      triggeredAt: 1_700_000_000_000,
    });

    const runs = await store.listRuns(sandbox.id);
    assert.equal(runs.length, 1, 'listRuns must read from disk, not a stale memory cache');
    assert.equal(runs[0].runId, 'run-live');
    assert.deepEqual(runs[0].learned, ['运行中学到的结论']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  // Review finding (luna P2-4): one unreadable report must not hide all the others.
  test('one corrupt report does not abort the whole directory scan', async () => {
    const { store, sandbox, tmpDir, runsDir } = await makeSandbox();

    await writeReport(runsDir, 'run-ok-1', { summary: 'a', learned: ['A'], triggeredAt: 1000 });
    await writeReport(runsDir, 'run-ok-2', { summary: 'b', learned: ['B'], triggeredAt: 2000 });
    // A directory where a .md file is expected: reading it throws EISDIR.
    await mkdir(join(runsDir, 'run-broken.md'), { recursive: true });

    const runs = await store.listRuns(sandbox.id);
    const ids = runs.map((r) => r.runId).sort();
    assert.deepEqual(ids, ['run-ok-1', 'run-ok-2'], 'healthy reports must survive a bad neighbour');

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('Sandbox fold idempotence', () => {
  // Review finding (luna P1-2): a triggeredAt cursor loses data in three ways.
  test('two reports sharing a timestamp are both folded', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const mk = (runId) => ({
      v: 1,
      runId,
      trigger: 'scheduled',
      triggeredAt: 5000,
      specVersion: '1',
      summary: runId,
      learned: [`learned-${runId}`],
    });

    const first = foldRunsIntoMemory(null, [mk('r1')]);
    // r2 arrives later but carries the SAME timestamp — a strict `>` cursor drops it.
    const second = foldRunsIntoMemory(first.memory, [mk('r1'), mk('r2')]);

    assert.equal(second.changed, true, 'same-timestamp late report must still fold');
    assert.deepEqual(second.foldedRunIds, ['r2']);
    assert.equal(second.memory.learnedItems.length, 2);
  });

  test('a backwards clock step does not permanently lose later reports', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const mk = (runId, triggeredAt) => ({
      v: 1,
      runId,
      trigger: 'scheduled',
      triggeredAt,
      specVersion: '1',
      summary: runId,
      learned: [`learned-${runId}`],
    });

    const first = foldRunsIntoMemory(null, [mk('r1', 9000)]);
    // Clock steps back; the next run legitimately carries an EARLIER timestamp.
    const second = foldRunsIntoMemory(first.memory, [mk('r1', 9000), mk('r2', 3000)]);

    assert.equal(second.changed, true, 'a report after a clock rollback must not be discarded');
    assert.deepEqual(second.foldedRunIds, ['r2']);
    assert.equal(second.memory.learnedItems.length, 2);
    // Display time must not go backwards even though the folded run is older.
    assert.equal(second.memory.lastRunAt, 9000);
  });

  test('re-folding the same disk state stays a no-op', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const runs = [
      { v: 1, runId: 'r1', trigger: 'scheduled', triggeredAt: 1000, specVersion: '1', summary: 'a', learned: ['A'] },
      { v: 1, runId: 'r2', trigger: 'scheduled', triggeredAt: 2000, specVersion: '1', summary: 'b', learned: ['B'] },
    ];
    const first = foldRunsIntoMemory(null, runs);
    const again = foldRunsIntoMemory(first.memory, runs);

    assert.equal(again.changed, false);
    assert.equal(again.memory.learnedItems.length, 2);
  });

  // A lost update (concurrent fold) drops ids from processedRunIds, so those runs fold
  // again. That must converge, not duplicate: learnedItems dedupe by id.
  test('a lost update re-folds without duplicating learnings', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const runs = [
      { v: 1, runId: 'r1', trigger: 'scheduled', triggeredAt: 1000, specVersion: '1', summary: 'a', learned: ['A'] },
    ];
    const folded = foldRunsIntoMemory(null, runs);

    // Simulate a stale writer clobbering processedRunIds but keeping learnedItems.
    const clobbered = { ...folded.memory, processedRunIds: [] };
    const refolded = foldRunsIntoMemory(clobbered, runs);

    assert.equal(refolded.memory.learnedItems.length, 1, 'a re-fold must not duplicate learnings');
  });

  // Memories written before processedRunIds existed must not re-fold their whole history.
  test('legacy memory with only lastRunAt does not replay its entire history', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const legacy = { v: 1, summary: 'old', runsIncorporated: 3, lastRunAt: 5000, learnedItems: [], updatedAt: 5000 };
    const runs = [
      { v: 1, runId: 'old1', trigger: 'scheduled', triggeredAt: 1000, specVersion: '1', summary: 'x', learned: ['X'] },
      { v: 1, runId: 'new1', trigger: 'scheduled', triggeredAt: 6000, specVersion: '1', summary: 'y', learned: ['Y'] },
    ];

    const result = foldRunsIntoMemory(legacy, runs);
    assert.deepEqual(result.foldedRunIds, ['new1'], 'pre-cursor history must stay folded');
  });
});

describe('Sandbox provider effort', () => {
  test('the two axes stay distinct: sandbox is lightweight but not effort-capped', async () => {
    const { isEffortCappedPromptProfile, isLightweightPromptProfile } = await import(
      '../dist/domains/cats/services/types.js'
    );

    assert.equal(isEffortCappedPromptProfile('sandbox'), false, 'sandbox does real work — do not cap effort');
    assert.equal(isEffortCappedPromptProfile('casual'), true);
    assert.equal(isEffortCappedPromptProfile('roundtable'), true);
    assert.equal(isEffortCappedPromptProfile('development'), false);

    // Still lightweight in worldview — that is a separate axis.
    assert.equal(isLightweightPromptProfile('sandbox'), true);
  });

  // Review finding (luna P2-3). The predicate assertions above CANNOT catch this: the
  // bug was that one provider called the wrong predicate. I split the predicates but
  // only updated Codex, leaving Claude's stream-json path capping sandbox runs from
  // max down to medium. So guard the CLASS of bug — no effort resolver may gate on
  // "lightweight", because worldview weight says nothing about how hard to think.
  test('no provider resolves reasoning effort via the lightweight predicate', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const providersDir = new URL('../src/domains/cats/services/agents/providers/', import.meta.url);
    const files = (await readdir(providersDir)).filter((f) => f.endsWith('.ts'));

    const offenders = [];
    for (const file of files) {
      const source = await readFile(new URL(file, providersDir), 'utf-8');
      // Look inside functions whose name mentions Effort.
      const fnRe = /function\s+\w*[Ee]ffort\w*\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g;
      for (const match of source.matchAll(fnRe)) {
        if (match[1].includes('isLightweightPromptProfile')) {
          offenders.push(file);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `effort resolution must gate on isEffortCappedPromptProfile, not isLightweightPromptProfile: ${offenders.join(', ')}`,
    );
  });
});
