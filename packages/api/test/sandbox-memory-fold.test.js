import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const run = (runId, triggeredAt, summary, learned) => ({
  v: 1,
  runId,
  trigger: 'scheduled',
  triggeredAt,
  specVersion: '1',
  summary,
  ...(learned ? { learned } : {}),
});

describe('Sandbox memory fold', () => {
  test('first fold seeds memory from runs', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );

    const result = foldRunsIntoMemory(null, [
      run('r1', 1000, '大盘缩量', ['低换手率+放量突破是较强信号']),
    ]);

    assert.ok(result.changed);
    assert.equal(result.memory.runsIncorporated, 1);
    assert.equal(result.memory.lastRunAt, 1000);
    assert.equal(result.memory.learnedItems.length, 1);
    assert.match(result.memory.learnedItems[0].content, /低换手率/);
  });

  // The whole point of the mode: day 100 must not repeat day 1's work.
  test('only folds runs newer than lastRunAt — re-folding is idempotent', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );

    const runs = [
      run('r1', 1000, 's1', ['learned-A']),
      run('r2', 2000, 's2', ['learned-B']),
    ];

    const first = foldRunsIntoMemory(null, runs);
    assert.equal(first.memory.runsIncorporated, 2);
    assert.equal(first.memory.learnedItems.length, 2);

    // Same runs again (e.g. next fire re-reads the directory) → nothing changes.
    const second = foldRunsIntoMemory(first.memory, runs);
    assert.equal(second.changed, false, 're-folding the same runs must be a no-op');
    assert.equal(second.memory.runsIncorporated, 2);
    assert.equal(second.memory.learnedItems.length, 2, 'must not duplicate learnings');

    // A genuinely new run does get folded.
    const third = foldRunsIntoMemory(second.memory, [...runs, run('r3', 3000, 's3', ['learned-C'])]);
    assert.equal(third.changed, true);
    assert.equal(third.memory.runsIncorporated, 3);
    assert.equal(third.memory.learnedItems.length, 3);
    assert.equal(third.memory.lastRunAt, 3000);
  });

  // Durable knowledge vs today's noise. Mixing them is what turns month-long
  // memory into an unreadable log.
  test('run summaries feed the rolling summary; only `learned` becomes durable items', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );

    const result = foldRunsIntoMemory(null, [
      run('r1', 1000, '今天大盘缩量，无买点', ['财报季前一周波动放大']),
    ]);

    // Ephemeral detail stays in the rolling summary...
    assert.match(result.memory.summary, /今天大盘缩量/);
    // ...and does NOT become a durable learning.
    assert.equal(result.memory.learnedItems.length, 1);
    assert.match(result.memory.learnedItems[0].content, /财报季/);
    assert.doesNotMatch(result.memory.learnedItems[0].content, /今天大盘缩量/);
  });

  test('a run with no learnings still counts as incorporated', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );

    const result = foldRunsIntoMemory(null, [run('r1', 1000, '今天没跑出结论')]);
    assert.equal(result.memory.runsIncorporated, 1);
    assert.equal(result.memory.learnedItems.length, 0);
    assert.equal(result.memory.lastRunAt, 1000, 'must advance the cursor or the run replays forever');
  });

  // Months of daily runs: the rolling summary must stay bounded or it eventually
  // eats the whole prompt budget and gets dropped wholesale by SessionBootstrap.
  test('rolling summary stays bounded across many runs, newest kept', async () => {
    const { foldRunsIntoMemory } = await import(
      '../dist/domains/sandbox/services/fold-runs-into-memory.js'
    );

    let memory = null;
    for (let i = 1; i <= 200; i++) {
      const res = foldRunsIntoMemory(memory, [run(`r${i}`, i * 1000, `第${i}天的运行摘要`, [`第${i}条学习`])]);
      memory = res.memory;
    }

    assert.equal(memory.runsIncorporated, 200);
    assert.ok(memory.summary.length < 4000, `rolling summary must stay bounded, got ${memory.summary.length}`);
    assert.match(memory.summary, /第200天/, 'newest run must survive');
    assert.doesNotMatch(memory.summary, /第1天的运行摘要/, 'ancient run detail must age out of the summary');

    // Durable learnings are NOT dropped — they are the accumulated asset. Bounding
    // happens at injection time (prompt), not at storage time.
    assert.equal(memory.learnedItems.length, 200, 'learnings must never be silently discarded');
  });

  test('prompt injection caps learnings and says so instead of silently truncating', async () => {
    const { buildSandboxRunPrompt } = await import(
      '../dist/domains/sandbox/services/sandbox-run-prompt.js'
    );

    const learnedItems = Array.from({ length: 100 }, (_, i) => ({
      id: `l${i}`,
      content: `学习条目-${i}`,
      sourceRunAt: i,
      promoted: false,
    }));

    const prompt = buildSandboxRunPrompt({
      spec: { specVersion: '1', name: 'S', goal: 'g', members: ['opus'] },
      memory: { v: 1, summary: 's', runsIncorporated: 100, learnedItems, updatedAt: 1 },
      runId: 'run-x',
      trigger: 'scheduled',
    });

    assert.match(prompt, /学习条目-99/, 'newest learnings must be injected');
    assert.doesNotMatch(prompt, /学习条目-0\b/, 'oldest learnings are not injected verbatim');
    assert.match(prompt, /还有\s*\d+\s*条/, 'must disclose that older learnings exist rather than hide them');
  });
});
