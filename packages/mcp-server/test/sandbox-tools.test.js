import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * F247 AC-D4 — the member-side write path for the dev pane.
 *
 * The properties worth pinning are the two things the tool deliberately does NOT let a
 * member do: target another sandbox, or bypass the API and edit spec.yaml.
 */

const savedEnv = {};
const savedFetch = globalThis.fetch;

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('cat_cafe_sandbox_update_spec', () => {
  let calls;

  beforeEach(() => {
    calls = [];
    setEnv({
      CAT_CAFE_API_URL: 'http://api.test',
      CAT_CAFE_INVOCATION_ID: 'inv-1',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-1',
    });
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ sandbox: { spec: { goal: 'updated goal' } } }),
      };
    };
  });

  afterEach(() => {
    restoreEnv();
    globalThis.fetch = savedFetch;
  });

  it('sends the edit through the callback API, not the filesystem', async () => {
    const { handleSandboxUpdateSpec } = await import('../dist/tools/sandbox-tools.js');

    const result = await handleSandboxUpdateSpec({ goal: 'track A-share turnover' });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/callback\/sandbox\/spec$/);
    assert.equal(calls[0].init.method, 'PATCH');
    // Only the API path re-registers the cron; writing spec.yaml would silently skip it.
    assert.deepEqual(JSON.parse(calls[0].init.body), { spec: { goal: 'track A-share turnover' } });
    assert.equal(result.isError, undefined);
  });

  // No sandbox id in the schema at all: the server resolves it from the caller's own
  // invocation thread, so cross-sandbox edits are impossible rather than merely denied.
  it('offers no way to name a different sandbox', async () => {
    const { sandboxUpdateSpecInputSchema } = await import('../dist/tools/sandbox-tools.js');
    const keys = Object.keys(sandboxUpdateSpecInputSchema);

    assert.deepEqual(keys.sort(), ['goal', 'learningGoal', 'name', 'schedule']);
    assert.ok(!keys.some((k) => /sandbox|thread|id$/i.test(k)), 'no target-selection field may exist');
  });

  it('passes a schedule edit through so the cron can reconverge', async () => {
    const { handleSandboxUpdateSpec } = await import('../dist/tools/sandbox-tools.js');

    await handleSandboxUpdateSpec({
      schedule: { cron: '30 16 * * *', prompt: 'run', timezone: 'Asia/Shanghai' },
    });

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.spec.schedule.cron, '30 16 * * *');
    assert.equal(body.spec.schedule.timezone, 'Asia/Shanghai');
  });

  it('rejects an empty edit instead of issuing a pointless request', async () => {
    const { handleSandboxUpdateSpec } = await import('../dist/tools/sandbox-tools.js');

    const result = await handleSandboxUpdateSpec({});
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });

  // A member on an ordinary thread must be told plainly, not left retrying.
  it('explains clearly when the thread has no sandbox', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'This thread is not bound to an A2A sandbox' }),
    });
    const { handleSandboxUpdateSpec } = await import('../dist/tools/sandbox-tools.js');

    const result = await handleSandboxUpdateSpec({ goal: 'x' });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /not bound to an A2A sandbox/);
  });

  it('fails cleanly without callback credentials', async () => {
    setEnv({ CAT_CAFE_INVOCATION_ID: undefined, CAT_CAFE_CALLBACK_TOKEN: undefined });
    const { handleSandboxUpdateSpec } = await import('../dist/tools/sandbox-tools.js');

    const result = await handleSandboxUpdateSpec({ goal: 'x' });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });
});
