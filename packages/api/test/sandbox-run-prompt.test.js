import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC = {
  specVersion: '1',
  name: 'Stock sandbox',
  goal: '每天复盘 A 股大盘并积累选股方法',
  learningGoal: '沉淀可复用的选股信号',
  members: ['opus'],
};

describe('Sandbox run prompt', () => {
  test('carries the CURRENT spec goal and learning goal (hot-update path)', async () => {
    const { buildSandboxRunPrompt } = await import(
      '../dist/domains/sandbox/services/sandbox-run-prompt.js'
    );

    const prompt = buildSandboxRunPrompt({
      spec: SPEC,
      memory: null,
      runId: 'run-1',
      trigger: 'scheduled',
    });

    assert.match(prompt, /每天复盘 A 股大盘并积累选股方法/);
    assert.match(prompt, /沉淀可复用的选股信号/);

    // Editing the spec in the dev pane must change the next run's instruction.
    const edited = buildSandboxRunPrompt({
      spec: { ...SPEC, goal: '改为只盯港股' },
      memory: null,
      runId: 'run-2',
      trigger: 'scheduled',
    });
    assert.match(edited, /改为只盯港股/);
    assert.doesNotMatch(edited, /每天复盘 A 股大盘/);
  });

  test('injects accumulated memory so the sandbox compounds instead of restarting', async () => {
    const { buildSandboxRunPrompt } = await import(
      '../dist/domains/sandbox/services/sandbox-run-prompt.js'
    );

    const prompt = buildSandboxRunPrompt({
      spec: SPEC,
      memory: {
        v: 1,
        summary: '已学会：低换手率+放量突破 是较强信号',
        runsIncorporated: 12,
        learnedItems: [{ id: 'l1', content: '财报季前一周波动放大', sourceRunAt: 1, promoted: false }],
        updatedAt: 1,
      },
      runId: 'run-3',
      trigger: 'scheduled',
    });

    assert.match(prompt, /低换手率\+放量突破/);
    assert.match(prompt, /财报季前一周波动放大/);
    assert.match(prompt, /12/); // runs incorporated is visible so the cat knows it has history
  });

  // THE critical contract: what we instruct the cat to write must be parseable by
  // InMemorySandboxStore.listRunFiles(). If these two drift, every run is silently
  // dropped and the sandbox stops compounding — with no error anywhere.
  test('write-back instruction produces a file the store can actually parse', async () => {
    const { buildSandboxRunPrompt, renderSandboxRunReport } = await import(
      '../dist/domains/sandbox/services/sandbox-run-prompt.js'
    );
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );

    const runId = 'run-20260811-090000';
    const prompt = buildSandboxRunPrompt({
      spec: SPEC,
      memory: null,
      runId,
      trigger: 'scheduled',
    });

    // The prompt must tell the cat the exact destination and the exact runId.
    assert.match(prompt, /\.a2a-sandbox\/runs\//);
    assert.ok(prompt.includes(`${runId}.md`), 'prompt must name the exact run file');

    // Simulate the cat following the instruction, using the same renderer we document.
    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-run-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, `${runId}.md`),
      renderSandboxRunReport({
        runId,
        trigger: 'scheduled',
        specVersion: '1',
        summary: '今日复盘：大盘缩量，未触发买点',
      }),
      'utf-8',
    );

    // Store must round-trip it back as a real run record.
    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      { title: 'S', projectPath, members: ['opus'], spec: SPEC },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    const store2 = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    await store2.rehydrate();
    const runs = await store2.listRuns(sandbox.id);

    const found = runs.find((r) => r.runId === runId);
    assert.ok(found, 'store must pick up the cat-written run report');
    assert.equal(found.trigger, 'scheduled');
    assert.equal(found.specVersion, '1');
    assert.match(found.summary, /大盘缩量/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  // The whole loop, end to end: a cat writes a report -> the store parses it ->
  // it folds into memory -> the NEXT run is briefed with it. If any link breaks the
  // sandbox keeps running and silently stops learning, so pin the whole chain.
  test('a run report written today shows up as knowledge in tomorrow\'s prompt', async () => {
    const { buildSandboxRunPrompt, renderSandboxRunReport } = await import(
      '../dist/domains/sandbox/services/sandbox-run-prompt.js'
    );
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );
    const { InMemorySandboxStore } = await import(
      '../dist/domains/sandbox/stores/InMemorySandboxStore.js'
    );

    const tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-loop-'));
    const projectPath = join(tmpDir, 'project');
    const runsDir = join(projectPath, '.a2a-sandbox', 'runs');
    await mkdir(runsDir, { recursive: true });

    const store = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    const sandbox = await store.create(
      { title: 'S', projectPath, members: ['opus'], spec: SPEC },
      'user-1',
    );
    await store.bindThread(sandbox.id, 'thread-1');

    // Day 1: the cat runs and writes its report, separating today's noise from a
    // durable conclusion.
    await writeFile(
      join(runsDir, 'run-day1.md'),
      renderSandboxRunReport({
        runId: 'run-day1',
        trigger: 'scheduled',
        specVersion: '1',
        summary: '今日大盘缩量，未触发买点',
        learned: ['低换手率+放量突破 是较强买入信号'],
      }),
      'utf-8',
    );

    // The store must parse both halves back out.
    const store2 = new InMemorySandboxStore({ indexFilePath: join(tmpDir, 'index.jsonl') });
    await store2.rehydrate();
    const runs = await store2.listRuns(sandbox.id);
    const record = runs.find((r) => r.runId === 'run-day1');
    assert.ok(record, 'run report must be readable');
    assert.match(record.summary, /今日大盘缩量/);
    assert.deepEqual(record.learned, ['低换手率+放量突破 是较强买入信号']);
    assert.doesNotMatch(record.summary, /低换手率/, 'durable learning must not leak back into the summary');

    // Day 2: fold, then brief the next run.
    const folded = foldRunsIntoMemory(null, runs);
    assert.equal(folded.changed, true);

    const tomorrow = buildSandboxRunPrompt({
      spec: SPEC,
      memory: folded.memory,
      runId: 'run-day2',
      trigger: 'scheduled',
    });

    assert.match(tomorrow, /低换手率\+放量突破/, "yesterday's learning must brief today's run");
    assert.match(tomorrow, /今日大盘缩量/, 'recent run context is still visible in the rolling summary');

    await rm(tmpDir, { recursive: true, force: true });
  });
});
