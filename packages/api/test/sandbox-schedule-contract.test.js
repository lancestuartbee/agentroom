import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * F247 — the schedule contract, checked across the boundary it actually broke.
 *
 * The MCP tool and the API route each hand-wrote this shape. They drifted exactly once and
 * it cost the whole feature's headline path: the server was relaxed to accept a cron-only
 * edit, the tool was not, so "把它改到 9 点" was rejected inside the tool and the request
 * never left the process. Both suites were green — each was testing its own copy.
 *
 * So this suite deliberately drives BOTH schemas with the same payloads. It fails if
 * either side is edited alone.
 */
describe('sandbox schedule contract is shared, not duplicated', () => {
  async function load() {
    const shared = await import('@cat-cafe/shared');
    const mcp = await import('../../mcp-server/dist/tools/sandbox-tools.js');
    return { shared, mcp };
  }

  const FRAGMENTS = [
    { cron: '0 9 * * *' },
    { prompt: '看一遍持仓' },
    { timezone: 'Asia/Shanghai' },
    { cron: '0 9 * * *', prompt: '看一遍持仓', timezone: 'Asia/Shanghai' },
    {},
  ];

  test('the tool accepts exactly the fragments the server accepts', async () => {
    const { shared, mcp } = await load();
    const toolSchema = mcp.sandboxUpdateSpecInputSchema.schedule;

    for (const fragment of FRAGMENTS) {
      const serverOk = shared.sandboxSchedulePatchSchema.safeParse(fragment).success;
      const toolOk = toolSchema.safeParse(fragment).success;
      assert.equal(toolOk, serverOk, `divergence on ${JSON.stringify(fragment)}: tool=${toolOk} server=${serverOk}`);
    }
  });

  test('both sides reject the same malformed fragments', async () => {
    const { shared, mcp } = await load();
    const toolSchema = mcp.sandboxUpdateSpecInputSchema.schedule;

    for (const bad of [{ cron: '' }, { prompt: '' }, { cron: 'x'.repeat(101) }]) {
      assert.equal(shared.sandboxSchedulePatchSchema.safeParse(bad).success, false, JSON.stringify(bad));
      assert.equal(toolSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  // Comparing known payloads is not enough, and review proved it: the first extraction
  // rebuilt the tool's object from the shared FIELD shapes, which carried every field rule
  // across and silently left `.strict()` behind. The tool then accepted an unknown key and
  // stripped it while the API rejected the same request. Divergence lives in the shape of
  // the object too, not only in its fields.
  test('the two sides agree on the key set', async () => {
    const { shared, mcp } = await load();
    // The tool exposes the schedule as `.optional().describe(...)`, so peel the wrappers
    // before comparing the object itself.
    const unwrap = (schema) => (typeof schema.unwrap === 'function' ? unwrap(schema.unwrap()) : schema);
    const sharedKeys = Object.keys(shared.sandboxSchedulePatchSchema.shape).sort();
    const toolKeys = Object.keys(unwrap(mcp.sandboxUpdateSpecInputSchema.schedule).shape).sort();
    assert.deepEqual(toolKeys, sharedKeys, 'a field added on one side must be added on the other');
  });

  test('both sides refuse an unknown field rather than one silently dropping it', async () => {
    const { shared, mcp } = await load();
    const withUnknown = { cron: '0 9 * * *', futureField: 'x' };

    assert.equal(shared.sandboxSchedulePatchSchema.safeParse(withUnknown).success, false);
    assert.equal(
      mcp.sandboxUpdateSpecInputSchema.schedule.safeParse(withUnknown).success,
      false,
      'the tool must not accept-and-strip what the API would reject',
    );
  });
});

/**
 * The completeness rule itself. It is asymmetric on purpose — editing takes a fragment,
 * creating does not — and getting that backwards is what let a schedule with no prompt
 * reach the scheduler.
 */
describe('mergeSandboxSchedule', () => {
  test('a cron-only edit keeps the stored prompt and timezone', async () => {
    const { mergeSandboxSchedule } = await import('@cat-cafe/shared');
    const result = mergeSandboxSchedule(
      { cron: '0 20 * * *', prompt: 'keep me', timezone: 'Asia/Shanghai' },
      {
        cron: '0 9 * * *',
      },
    );
    assert.deepEqual(result, {
      ok: true,
      schedule: { cron: '0 9 * * *', prompt: 'keep me', timezone: 'Asia/Shanghai' },
    });
  });

  test('the first schedule must be whole — a fragment has nothing to merge onto', async () => {
    const { mergeSandboxSchedule } = await import('@cat-cafe/shared');
    assert.equal(mergeSandboxSchedule(undefined, { cron: '0 9 * * *' }).ok, false);
    assert.equal(mergeSandboxSchedule(undefined, { prompt: '看一遍持仓' }).ok, false);
    assert.equal(mergeSandboxSchedule(undefined, { cron: '0 9 * * *', prompt: '看一遍持仓' }).ok, true);
  });

  test('an absent timezone is omitted rather than written as undefined', async () => {
    const { mergeSandboxSchedule } = await import('@cat-cafe/shared');
    const result = mergeSandboxSchedule(undefined, { cron: '0 9 * * *', prompt: 'p' });
    assert.ok(result.ok);
    assert.equal('timezone' in result.schedule, false);
  });
});
