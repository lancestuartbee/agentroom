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

const runWithIds = (runId, triggeredAt, summary, learnedWithIds) => ({
  v: 1,
  runId,
  trigger: 'scheduled',
  triggeredAt,
  specVersion: '1',
  summary,
  ...(learnedWithIds ? { learnedWithIds } : {}),
});

describe('Sandbox memory fold', () => {
  test('first fold seeds memory from runs', async () => {
    const { foldRunsIntoMemory } = await import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

    const result = foldRunsIntoMemory(null, [run('r1', 1000, '大盘缩量', ['低换手率+放量突破是较强信号'])]);

    assert.ok(result.changed);
    assert.equal(result.memory.runsIncorporated, 1);
    assert.equal(result.memory.lastRunAt, 1000);
    assert.equal(result.memory.learnedItems.length, 1);
    assert.match(result.memory.learnedItems[0].content, /低换手率/);
  });

  // The whole point of the mode: day 100 must not repeat day 1's work.
  test('only folds runs newer than lastRunAt — re-folding is idempotent', async () => {
    const { foldRunsIntoMemory } = await import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

    const runs = [run('r1', 1000, 's1', ['learned-A']), run('r2', 2000, 's2', ['learned-B'])];

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
    const { foldRunsIntoMemory } = await import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

    const result = foldRunsIntoMemory(null, [run('r1', 1000, '今天大盘缩量，无买点', ['财报季前一周波动放大'])]);

    // Ephemeral detail stays in the rolling summary...
    assert.match(result.memory.summary, /今天大盘缩量/);
    // ...and does NOT become a durable learning.
    assert.equal(result.memory.learnedItems.length, 1);
    assert.match(result.memory.learnedItems[0].content, /财报季/);
    assert.doesNotMatch(result.memory.learnedItems[0].content, /今天大盘缩量/);
  });

  test('a run with no learnings still counts as incorporated', async () => {
    const { foldRunsIntoMemory } = await import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

    const result = foldRunsIntoMemory(null, [run('r1', 1000, '今天没跑出结论')]);
    assert.equal(result.memory.runsIncorporated, 1);
    assert.equal(result.memory.learnedItems.length, 0);
    assert.equal(result.memory.lastRunAt, 1000, 'must advance the cursor or the run replays forever');
  });

  // Months of daily runs: the rolling summary must stay bounded or it eventually
  // eats the whole prompt budget and gets dropped wholesale by SessionBootstrap.
  test('rolling summary stays bounded across many runs, newest kept', async () => {
    const { foldRunsIntoMemory } = await import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

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
    const { buildSandboxRunPrompt } = await import('../dist/domains/sandbox/services/sandbox-run-prompt.js');

    const learnedItems = Array.from({ length: 100 }, (_, i) => ({
      id: `l${i}`,
      content: `学习条目-${i}`,
      sourceRunId: 'run-x',
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

/**
 * F247 Phase E prerequisite — what it means for a learning to disappear from its report.
 *
 * The projection model made memory converge to what the reports SAY, but the loop only ever
 * walked what the reports currently contain. A member who rewrites a report and drops a
 * bullet was therefore invisible: the old `runId-index` stayed in memory forever, no
 * divergence was raised, and the scheduler never warned.
 *
 * The semantics this pins down, and why:
 *
 *  - A bullet removed from a report that is STILL THERE is a retraction. The member decided
 *    it was wrong. Learnings are injected into every future run's prompt, so keeping a
 *    retracted one is worse than losing it — it actively reasons from something its own
 *    author withdrew.
 *  - A learning whose whole report is GONE is not retracted, it is archived. Reports get
 *    pruned over a months-long project; learnings are the accumulated asset. Keep it.
 *  - A PROMOTED learning is never removed either way. It has been exported out of the
 *    sandbox, and silently dropping the local copy desyncs it from the published one — the
 *    same reason a promoted rewrite is reported rather than applied. Report the divergence
 *    and let the operator decide.
 *
 * And the divergence has to survive the process: log-only cannot drive an operator-facing
 * UX, so it is recorded on the item itself with what the report says now.
 */
describe('a learning that vanishes from its report', () => {
  const load = () => import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

  async function seed(learned) {
    const { foldRunsIntoMemory } = await load();
    return foldRunsIntoMemory(null, [run('r1', 1000, '第一天', learned)]).memory;
  }

  test('a bullet deleted from a still-visible report is retracted, not kept', async () => {
    const { foldRunsIntoMemory } = await load();
    const memory = await seed(['第一条', '第二条']);
    assert.equal(memory.learnedItems.length, 2);

    // The member rewrites the report keeping only the first bullet.
    const result = foldRunsIntoMemory(memory, [run('r1', 1000, '第一天', ['第一条'])]);

    assert.ok(result.changed, 'a retraction is a real change worth persisting');
    assert.deepEqual(
      result.memory.learnedItems.map((i) => i.content),
      ['第一条'],
    );
  });

  test('a learning whose whole report is gone is archived, not retracted', async () => {
    const { foldRunsIntoMemory } = await load();
    const memory = await seed(['第一条', '第二条']);

    // The report itself was pruned — no runs visible at all.
    const result = foldRunsIntoMemory(memory, []);

    assert.equal(result.memory.learnedItems.length, 2, 'pruning reports must not cause amnesia');
  });

  test('a promoted learning is reported as retracted rather than removed', async () => {
    const { foldRunsIntoMemory } = await load();
    const memory = await seed(['第一条', '第二条']);
    memory.learnedItems[1].promoted = true;

    const result = foldRunsIntoMemory(memory, [run('r1', 1000, '第一天', ['第一条'])]);

    assert.deepEqual(result.divergedPromotedIds, ['r1-1']);
    const kept = result.memory.learnedItems.find((i) => i.id === 'r1-1');
    assert.ok(kept, 'the exported copy still exists outside the sandbox — do not drop ours');
    assert.equal(kept.content, '第二条', 'the published content must not be silently altered');
    assert.equal(kept.divergence.kind, 'retracted');
  });

  test('divergence is persisted on the item, not merely logged', async () => {
    const { foldRunsIntoMemory } = await load();
    const memory = await seed(['原始内容']);
    memory.learnedItems[0].promoted = true;

    const result = foldRunsIntoMemory(memory, [run('r1', 1000, '第一天', ['改写后的内容'])]);

    const item = result.memory.learnedItems[0];
    assert.equal(item.content, '原始内容', 'a promoted item is frozen');
    assert.equal(item.divergence.kind, 'rewritten');
    assert.equal(item.divergence.reportContent, '改写后的内容', 'record what the report says now');
    assert.equal(item.divergence.observedAt, 1000);
  });

  test('divergence clears itself when the report agrees again', async () => {
    const { foldRunsIntoMemory } = await load();
    const memory = await seed(['原始内容']);
    memory.learnedItems[0].promoted = true;

    const diverged = foldRunsIntoMemory(memory, [run('r1', 1000, '第一天', ['改写后的内容'])]).memory;
    assert.ok(diverged.learnedItems[0].divergence);

    // The member puts it back — a half-written report that completed, not a real conflict.
    const healed = foldRunsIntoMemory(diverged, [run('r1', 1000, '第一天', ['原始内容'])]);
    assert.equal(healed.memory.learnedItems[0].divergence, undefined);
  });

  test("an unrelated run being folded does not retract another run's learnings", async () => {
    const { foldRunsIntoMemory } = await load();
    const memory = await seed(['第一天学到的']);

    const result = foldRunsIntoMemory(memory, [
      run('r1', 1000, '第一天', ['第一天学到的']),
      run('r2', 2000, '第二天', ['第二天学到的']),
    ]);

    assert.deepEqual(result.memory.learnedItems.map((i) => i.content).sort(), ['第一天学到的', '第二天学到的']);
  });
});

/**
 * Divergence must be IDEMPOTENT. A promoted item that disagrees with its report disagrees
 * on every future fold, so re-recording an identical divergence must not count as a change
 * — otherwise `changed` stops meaning anything and memory is rewritten on every single run
 * for the rest of the sandbox's life.
 */
describe('recording a divergence is idempotent', () => {
  const load = () => import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

  test('re-folding an unchanged rewrite reports it again but rewrites nothing', async () => {
    const { foldRunsIntoMemory } = await load();
    const seeded = foldRunsIntoMemory(null, [run('r1', 1000, '第一天', ['原始内容'])]).memory;
    seeded.learnedItems[0].promoted = true;

    const first = foldRunsIntoMemory(seeded, [run('r1', 1000, '第一天', ['改写后的内容'])]);
    assert.ok(first.changed);

    const second = foldRunsIntoMemory(first.memory, [run('r1', 1000, '第一天', ['改写后的内容'])]);
    assert.equal(second.changed, false, 'the same disagreement is not a new change');
    assert.deepEqual(second.divergedPromotedIds, ['r1-0'], 'but it is still reported every fold');
  });

  test('re-folding an unchanged retraction rewrites nothing either', async () => {
    const { foldRunsIntoMemory } = await load();
    const seeded = foldRunsIntoMemory(null, [run('r1', 1000, '第一天', ['甲', '乙'])]).memory;
    seeded.learnedItems[1].promoted = true;

    const first = foldRunsIntoMemory(seeded, [run('r1', 1000, '第一天', ['甲'])]);
    assert.ok(first.changed);

    const second = foldRunsIntoMemory(first.memory, [run('r1', 1000, '第一天', ['甲'])]);
    assert.equal(second.changed, false);
  });
});

/**
 * Stable identities for learned items (F247 Phase E follow-up).
 *
 * An earlier version derived item ids from `runId-arrayIndex`. That made deletion or
 * reordering inside a report indistinguishable from retraction/rewrite, because the
 * index of every subsequent bullet changed. Promoted items then collected false
 * divergence metadata on the wrong content.
 *
 * The fix: each learning carries its own stable id in the report. The fold uses that
 * id for identity; only absence of a still-visible id means retraction.
 */
describe('stable learned item ids', () => {
  const load = () => import('../dist/domains/sandbox/services/fold-runs-into-memory.js');

  test('deleting the first item does not renumber the rest', async () => {
    const { foldRunsIntoMemory } = await load();
    const seeded = foldRunsIntoMemory(null, [
      runWithIds('r1', 1000, '第一天', [
        { id: 'r1-a', content: '第一条' },
        { id: 'r1-b', content: '第二条' },
      ]),
    ]).memory;

    const result = foldRunsIntoMemory(seeded, [runWithIds('r1', 1000, '第一天', [{ id: 'r1-b', content: '第二条' }])]);

    assert.deepEqual(
      result.memory.learnedItems.map((i) => ({ id: i.id, content: i.content })),
      [{ id: 'r1-b', content: '第二条' }],
    );
    assert.equal(result.divergedPromotedIds.length, 0);
  });

  test('deleting the first promoted item does not create a false divergence on the second', async () => {
    const { foldRunsIntoMemory } = await load();
    const seeded = foldRunsIntoMemory(null, [
      runWithIds('r1', 1000, '第一天', [
        { id: 'r1-a', content: '第一条' },
        { id: 'r1-b', content: '第二条' },
      ]),
    ]).memory;
    seeded.learnedItems.find((i) => i.id === 'r1-b').promoted = true;

    const result = foldRunsIntoMemory(seeded, [runWithIds('r1', 1000, '第一天', [{ id: 'r1-b', content: '第二条' }])]);

    const b = result.memory.learnedItems.find((i) => i.id === 'r1-b');
    assert.ok(b, 'the promoted item must remain');
    assert.equal(b.promoted, true, 'promotion must survive');
    assert.equal(b.divergence, undefined, 'no false divergence: the promoted item is still there');
    assert.deepEqual(result.divergedPromotedIds, []);
  });

  test('deleting a middle item does not shift promoted siblings', async () => {
    const { foldRunsIntoMemory } = await load();
    const seeded = foldRunsIntoMemory(null, [
      runWithIds('r1', 1000, '第一天', [
        { id: 'r1-a', content: '甲' },
        { id: 'r1-b', content: '乙' },
        { id: 'r1-c', content: '丙' },
      ]),
    ]).memory;
    seeded.learnedItems.find((i) => i.id === 'r1-c').promoted = true;

    const result = foldRunsIntoMemory(seeded, [
      runWithIds('r1', 1000, '第一天', [
        { id: 'r1-a', content: '甲' },
        { id: 'r1-c', content: '丙' },
      ]),
    ]);

    assert.deepEqual(result.memory.learnedItems.map((i) => i.id).sort(), ['r1-a', 'r1-c']);
    const c = result.memory.learnedItems.find((i) => i.id === 'r1-c');
    assert.equal(c.promoted, true);
    assert.equal(c.divergence, undefined);
    assert.deepEqual(result.divergedPromotedIds, []);
  });

  test('pure reorder does not produce false divergence', async () => {
    const { foldRunsIntoMemory } = await load();
    const seeded = foldRunsIntoMemory(null, [
      runWithIds('r1', 1000, '第一天', [
        { id: 'r1-a', content: '甲' },
        { id: 'r1-b', content: '乙' },
      ]),
    ]).memory;
    seeded.learnedItems.find((i) => i.id === 'r1-a').promoted = true;

    const result = foldRunsIntoMemory(seeded, [
      runWithIds('r1', 1000, '第一天', [
        { id: 'r1-b', content: '乙' },
        { id: 'r1-a', content: '甲' },
      ]),
    ]);

    assert.deepEqual(result.memory.learnedItems.map((i) => i.id).sort(), ['r1-a', 'r1-b']);
    const a = result.memory.learnedItems.find((i) => i.id === 'r1-a');
    assert.equal(a.promoted, true);
    assert.equal(a.divergence, undefined);
    assert.deepEqual(result.divergedPromotedIds, []);
  });

  test('editing content keeps the same id and tracks divergence for promoted items', async () => {
    const { foldRunsIntoMemory } = await load();
    const seeded = foldRunsIntoMemory(null, [
      runWithIds('r1', 1000, '第一天', [{ id: 'r1-a', content: '原始内容' }]),
    ]).memory;
    seeded.learnedItems[0].promoted = true;

    const result = foldRunsIntoMemory(seeded, [
      runWithIds('r1', 1000, '第一天', [{ id: 'r1-a', content: '改写后的内容' }]),
    ]);

    const a = result.memory.learnedItems[0];
    assert.equal(a.id, 'r1-a');
    assert.equal(a.content, '原始内容');
    assert.equal(a.divergence.kind, 'rewritten');
    assert.equal(a.divergence.reportContent, '改写后的内容');
    assert.deepEqual(result.divergedPromotedIds, ['r1-a']);
  });

  test('legacy runId-index reports still work as a fallback', async () => {
    const { foldRunsIntoMemory } = await load();
    const result = foldRunsIntoMemory(null, [run('r1', 1000, '第一天', ['甲', '乙'])]);

    assert.deepEqual(
      result.memory.learnedItems.map((i) => ({ id: i.id, content: i.content })),
      [
        { id: 'r1-0', content: '甲' },
        { id: 'r1-1', content: '乙' },
      ],
    );
  });

  test('legacy promoted items keep their provenance after migration', async () => {
    const { foldRunsIntoMemory } = await load();
    const seeded = foldRunsIntoMemory(null, [run('r1', 1000, '第一天', ['甲', '乙'])]).memory;
    seeded.learnedItems[1].promoted = true;

    // The same report without explicit ids — legacy fallback.
    const result = foldRunsIntoMemory(seeded, [run('r1', 1000, '第一天', ['甲'])]);

    assert.deepEqual(result.divergedPromotedIds, ['r1-1']);
    const b = result.memory.learnedItems.find((i) => i.id === 'r1-1');
    assert.equal(b.content, '乙');
    assert.equal(b.divergence.kind, 'retracted');
  });
});
