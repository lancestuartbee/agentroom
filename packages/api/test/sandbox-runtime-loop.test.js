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

describe('Sandbox fold — legacy migration and long-run bounds', () => {
  // Re-review finding (luna P1). My previous "legacy seed" only FILTERED by the old
  // cursor without putting those ids into processedRunIds. So the second fold saw a
  // non-empty set, dropped the cursor, and replayed the whole pre-migration history.
  // My test asserted only the FIRST fold — the same mistake shape as the last round
  // (assert step one, never step two), so it certified the bug as fixed.
  test('legacy memory does not replay history on the SECOND fold either', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const legacy = { v: 1, summary: 'old', runsIncorporated: 3, lastRunAt: 5000, learnedItems: [], updatedAt: 5000 };
    const runs = [
      { v: 1, runId: 'old1', trigger: 'scheduled', triggeredAt: 1000, specVersion: '1', summary: 'x', learned: ['X'] },
      { v: 1, runId: 'new1', trigger: 'scheduled', triggeredAt: 6000, specVersion: '1', summary: 'y', learned: ['Y'] },
    ];

    const first = foldRunsIntoMemory(legacy, runs);
    assert.deepEqual(first.foldedRunIds, ['new1']);
    assert.equal(first.memory.runsIncorporated, 4);

    const second = foldRunsIntoMemory(first.memory, runs);
    assert.deepEqual(second.foldedRunIds, [], 'pre-migration history must never be replayed');
    assert.equal(second.memory.runsIncorporated, 4, 'run count must not inflate');
    assert.equal(second.changed, false);

    // And a third, for good measure — convergence, not oscillation.
    const third = foldRunsIntoMemory(second.memory, runs);
    assert.deepEqual(third.foldedRunIds, []);
    assert.equal(third.memory.runsIncorporated, 4);
  });

  // Re-review finding (luna P2): the scheduler asked for the last 500 reports, so past
  // 500 the OLDEST unprocessed report becomes permanently invisible — processedRunIds
  // cannot help with a run that is never even read.
  test('a sandbox with more than 500 reports still folds the oldest one', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );
    const { renderSandboxRunReport } = await import(
      '../dist/domains/sandbox/services/sandbox-run-prompt.js'
    );

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-500-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });

    for (let i = 0; i < 501; i++) {
      await writeFile(
        join(runsDir, `run-${String(i).padStart(4, '0')}.md`),
        renderSandboxRunReport({
          runId: `run-${String(i).padStart(4, '0')}`,
          trigger: 'scheduled',
          specVersion: '1',
          summary: `day ${i}`,
          learned: [`learned-${i}`],
          triggeredAt: 1_000_000 + i * 1000,
        }),
        'utf-8',
      );
    }

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      { title: 'S', projectPath, members: ['opus'], spec: SPEC },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const runs = await store.listRuns(sandbox.id);
    assert.equal(runs.length, 501, 'every report on disk must be readable');

    const folded = foldRunsIntoMemory(null, runs);
    assert.ok(folded.foldedRunIds.includes('run-0000'), 'the oldest report must not be permanently invisible');
    assert.equal(folded.memory.runsIncorporated, 501);

    await rm(tmpDir, { recursive: true, force: true });
  });

  // Re-review finding (luna P2): every readdir error collapsed to "no runs", and
  // listRuns then overwrote the cache with that empty result. A permissions or I/O
  // fault would read as "this sandbox has never run".
  test('a directory read fault is not reported as an empty sandbox', async () => {
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );
    const { renderSandboxRunReport } = await import(
      '../dist/domains/sandbox/services/sandbox-run-prompt.js'
    );
    const { chmod } = await import('node:fs/promises');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-eacces-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, 'run-1.md'),
      renderSandboxRunReport({
        runId: 'run-1',
        trigger: 'scheduled',
        specVersion: '1',
        summary: 's',
        learned: ['L'],
        triggeredAt: 1000,
      }),
      'utf-8',
    );

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      { title: 'S', projectPath, members: ['opus'], spec: SPEC },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const warm = await store.listRuns(sandbox.id);
    assert.equal(warm.length, 1);

    await chmod(runsDir, 0o000);
    try {
      // The contract is "never masquerade as no runs". This started out as a
      // stale-cache fallback; re-review pointed out that made fresh data and a
      // degraded fallback indistinguishable at the call site, so the fault now
      // surfaces and the caller decides how to degrade.
      await assert.rejects(() => store.listRuns(sandbox.id), 'a read fault must not masquerade as "no runs"');
    } finally {
      await chmod(runsDir, 0o755);
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // Newly load-bearing after listRuns started reading disk live: the scan can now catch
  // a member mid-write. A half-written report parsed as complete would be folded and
  // marked processed, permanently losing that run's learnings.
  test('a half-written report is skipped, not folded and marked processed', async () => {
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-partial-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });

    // Truncated mid-write: header and summary present, `## Learned` never reached.
    await writeFile(
      join(runsDir, 'run-partial.md'),
      ['# Sandbox Run run-partial', '', '- Trigger: scheduled', '- Triggered At: 2026-01-01T00:00:00.000Z', '- Spec Version: 1', '', '## Summary', '', '写到一半就断了'].join('\n'),
      'utf-8',
    );

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      { title: 'S', projectPath, members: ['opus'], spec: SPEC },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const runs = await store.listRuns(sandbox.id);
    assert.equal(runs.length, 0, 'an incomplete report must not be treated as a finished run');

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('Sandbox provider effort — real resolver behaviour', () => {
  // Re-review finding (luna): the source-regex guard proves no effort function MENTIONS
  // the wrong predicate, but it cannot prove a CALLER picked the right gate — an arrow
  // function, a method, or an aliased import would slip past it. Assert the actual
  // resolved value instead; the regex stays as defense-in-depth.
  test('sandbox keeps its configured effort on both providers; chat modes stay capped', async () => {
    const { resolveStreamJsonEffort } = await import(
      '../dist/domains/cats/services/agents/providers/ClaudeStreamJsonCarrierService.js'
    );
    const { resolveCodexEffort } = await import(
      '../dist/domains/cats/services/agents/providers/CodexAgentService.js'
    );

    for (const [label, resolve, catId] of [
      ['claude-stream-json', resolveStreamJsonEffort, 'opus'],
      ['codex', resolveCodexEffort, 'codex'],
    ]) {
      const configured = resolve(catId, { promptProfile: 'development' });
      const sandbox = resolve(catId, { promptProfile: 'sandbox' });
      const casual = resolve(catId, { promptProfile: 'casual' });

      assert.equal(sandbox, configured, `${label}: sandbox must keep the configured effort, not be capped`);
      if (configured !== 'low') {
        assert.notEqual(casual, configured, `${label}: casual must still be capped`);
      }
    }
  });
});

describe('Sandbox run report — in-flight vs settled', () => {
  const HEADER = (runId) => [
    `# Sandbox Run ${runId}`,
    '',
    '- Trigger: scheduled',
    '- Triggered At: 2026-01-01T00:00:00.000Z',
    '- Spec Version: 1',
    '',
    '## Summary',
    '',
    '摘要',
    '',
  ];

  // Re-review finding (luna P1). My previous guard checked whether `## Learned` had
  // APPEARED, but the renderer writes the heading and only then the bullets. A scan
  // landing in that gap saw a "complete" report, folded it, and marked it processed —
  // so the durable learning written a moment later was lost for good.
  test('a report caught between the ## Learned heading and its bullets is folded only once complete', async () => {
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const { appendFile } = await import('node:fs/promises');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-inflight-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });
    const file = join(runsDir, 'run-x.md');

    // Mid-write: heading flushed, bullets not yet.
    await writeFile(file, [...HEADER('run-x'), '## Learned', ''].join('\n'), 'utf-8');

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      { title: 'S', projectPath, members: ['opus'], spec: SPEC },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const firstScan = await store.listRuns(sandbox.id);
    const firstFold = foldRunsIntoMemory(null, firstScan);
    assert.deepEqual(firstFold.foldedRunIds, [], 'an in-flight report must not be folded or marked processed');

    // The member finishes writing.
    await appendFile(file, '- 真正学到的结论\n', 'utf-8');

    const secondScan = await store.listRuns(sandbox.id);
    const secondFold = foldRunsIntoMemory(firstFold.memory, secondScan);
    assert.deepEqual(secondFold.foldedRunIds, ['run-x'], 'the completed report must fold on the next pass');
    assert.equal(secondFold.memory.learnedItems.length, 1);
    assert.match(secondFold.memory.learnedItems[0].content, /真正学到的结论/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  // The other half of the tradeoff: a member that never finishes the section must not
  // have its run skipped forever. Once the file has stopped changing it is final,
  // malformed or not — the run still happened and its summary is real.
  test('a settled but malformed report is still recorded as a run', async () => {
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );
    const { utimes } = await import('node:fs/promises');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-settled-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });
    const file = join(runsDir, 'run-y.md');

    // Member wrote a summary but never produced a Learned section at all.
    await writeFile(file, HEADER('run-y').join('\n'), 'utf-8');
    // Backdate so it is unambiguously settled, not mid-write.
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old);

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      { title: 'S', projectPath, members: ['opus'], spec: SPEC },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const runs = await store.listRuns(sandbox.id);
    assert.equal(runs.length, 1, 'a settled report must not be skipped forever just for being malformed');
    assert.match(runs[0].summary, /摘要/);
    assert.equal(runs[0].learned, undefined, 'no learnings parsed, but the run itself is recorded');

    await rm(tmpDir, { recursive: true, force: true });
  });

  // Re-review finding (luna P2): stale-cache fallback made "fresh data" and "read
  // failed, here is what I remember" indistinguishable at the call site.
  test('listRuns throws on a real read fault instead of returning stale data', async () => {
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );
    const { chmod } = await import('node:fs/promises');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-throw-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      { title: 'S', projectPath, members: ['opus'], spec: SPEC },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    await chmod(runsDir, 0o000);
    try {
      await assert.rejects(
        () => store.listRuns(sandbox.id),
        /EACCES|permission/i,
        'a read fault must surface, not be smoothed into stale data',
      );
    } finally {
      await chmod(runsDir, 0o755);
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// Regression for a bug I introduced while fixing the in-flight gate: judging
// completeness on FILTERED learnings branded every "nothing durable today" report as
// half-written. Most days look exactly like that, so the sandbox would have deferred
// its ordinary runs forever. Completeness is judged on raw bullets.
describe('Sandbox run report — a run with no durable learnings is still complete', () => {
  test('the placeholder-only report is folded, not deferred as in-flight', async () => {
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-noLearn-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });

    // No `learned` — the renderer emits the placeholder bullet.
    await writeReport(runsDir, 'run-quiet', { summary: '今天没跑出结论', triggeredAt: 1000 });

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      { title: 'S', projectPath, members: ['opus'], spec: SPEC },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const runs = await store.listRuns(sandbox.id);
    assert.equal(runs.length, 1, 'a quiet day is a finished run, not a half-written one');

    const folded = foldRunsIntoMemory(null, runs);
    assert.deepEqual(folded.foldedRunIds, ['run-quiet']);
    assert.equal(folded.memory.learnedItems.length, 0, 'no learnings, but the run is on the record');

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('Sandbox fold — learnings are retriable, not gated on proving a write finished', () => {
  // Re-review finding (luna). A quiescence window only proves "unchanged for N seconds",
  // never "finished" — it just moved the race later. There is no way to prove an
  // external writer is done, so the design must not need that proof: processedRunIds
  // now gates only the SUMMARY, while learnings are re-extracted from every visible
  // report on each fold and deduped by stable id.
  test('a learning appended long after the run was folded is still absorbed', async () => {
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const { appendFile, utimes } = await import('node:fs/promises');

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-retriable-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });
    const file = join(runsDir, 'run-z.md');

    await writeFile(
      file,
      [
        '# Sandbox Run run-z',
        '',
        '- Trigger: scheduled',
        '- Triggered At: 2026-01-01T00:00:00.000Z',
        '- Spec Version: 1',
        '',
        '## Summary',
        '',
        '摘要',
        '',
        '## Learned',
        '',
      ].join('\n'),
      'utf-8',
    );
    // Well past any debounce window — the file looks settled but is not finished.
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old);

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      { title: 'S', projectPath, members: ['opus'], spec: SPEC },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const first = foldRunsIntoMemory(null, await store.listRuns(sandbox.id));
    assert.deepEqual(first.foldedRunIds, ['run-z'], 'the run itself is recorded');
    assert.equal(first.memory.learnedItems.length, 0);

    // The member finishes writing much later.
    await appendFile(file, '- 迟到但真实的结论\n', 'utf-8');

    const second = foldRunsIntoMemory(first.memory, await store.listRuns(sandbox.id));
    assert.equal(second.changed, true, 'a newly appended learning must count as a change');
    assert.equal(second.memory.learnedItems.length, 1, 'the late learning must be absorbed');
    assert.match(second.memory.learnedItems[0].content, /迟到但真实的结论/);
    // The summary must NOT be folded twice.
    assert.equal(second.memory.runsIncorporated, 1, 'the run must not be counted again');

    await rm(tmpDir, { recursive: true, force: true });
  });

  test('re-folding unchanged reports is still a no-op after decoupling', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const runs = [
      { v: 1, runId: 'r1', trigger: 'scheduled', triggeredAt: 1000, specVersion: '1', summary: 'a', learned: ['A'] },
    ];
    const first = foldRunsIntoMemory(null, runs);
    const again = foldRunsIntoMemory(first.memory, runs);

    assert.equal(again.changed, false, 'nothing new on disk means nothing to write');
    assert.equal(again.memory.learnedItems.length, 1);
    assert.equal(again.memory.runsIncorporated, 1);
  });
});
