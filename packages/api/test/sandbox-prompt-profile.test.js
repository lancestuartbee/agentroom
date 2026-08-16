import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('Sandbox prompt profile', () => {
  // The whole premise of the mode: members join a sandbox WITHOUT inheriting the
  // full system worldview. If the profile resolves back to 'development', they load
  // the entire compiled L0 and the mode is a lie.
  test("resolves to 'sandbox', not back to 'development'", async () => {
    const { resolvePromptProfile } = await import(
      '../dist/domains/cats/services/agents/routing/casual-prompt-profile.js'
    );

    assert.equal(resolvePromptProfile('sandbox', undefined), 'sandbox');
    // Existing profiles must be unaffected.
    assert.equal(resolvePromptProfile('casual', undefined), 'casual');
    assert.equal(resolvePromptProfile('roundtable', undefined), 'roundtable');
    assert.equal(resolvePromptProfile(undefined, undefined), 'development');
  });

  // isLightweightPromptProfile gates the native system-prompt override — i.e. whether
  // the CLI gets our slim instruction or the fully compiled household L0.
  test('counts as a lightweight profile so the heavy worldview is not compiled in', async () => {
    const { isLightweightPromptProfile } = await import('../dist/domains/cats/services/types.js');

    assert.equal(isLightweightPromptProfile('sandbox'), true);
    assert.equal(isLightweightPromptProfile('casual'), true);
    assert.equal(isLightweightPromptProfile('roundtable'), true);
    assert.equal(isLightweightPromptProfile('development'), false);
  });

  test('gets its own context budget, not the full development one', async () => {
    const { getPromptProfileContextBudget, SANDBOX_CONTEXT_BUDGET } = await import(
      '../dist/domains/cats/services/agents/routing/casual-prompt-profile.js'
    );

    const budget = getPromptProfileContextBudget('opus', 'sandbox');
    assert.deepEqual(budget, SANDBOX_CONTEXT_BUDGET);
    // A months-long project run needs real working context — far more than casual chat.
    const { CASUAL_CONTEXT_BUDGET } = await import(
      '../dist/domains/cats/services/agents/routing/casual-prompt-profile.js'
    );
    assert.ok(budget.maxPromptTokens > CASUAL_CONTEXT_BUDGET.maxPromptTokens);
  });

  test('identity addresses members formally — no pet/persona framing', async () => {
    const { buildSandboxStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

    const identity = buildSandboxStaticIdentity('opus', { sandboxName: '股票模拟沙盘' });
    assert.ok(identity.length > 0, 'sandbox identity must be produced');

    // Formal register: this is a project workspace, not the household.
    assert.match(identity, /成员/);
    assert.doesNotMatch(identity, /猫/, 'A2A mode prompts must not use pet framing');
    assert.doesNotMatch(identity, /铲屎官/);
    assert.doesNotMatch(identity, /喵/);

    // Scoped to the sandbox, not the household worldview.
    assert.match(identity, /股票模拟沙盘/);
  });

  test('sandbox identity is used by the profile dispatcher instead of the dev fallback', async () => {
    const { buildPromptProfileStaticIdentity } = await import(
      '../dist/domains/cats/services/agents/routing/casual-prompt-profile.js'
    );

    let fallbackCalled = false;
    const identity = buildPromptProfileStaticIdentity('opus', 'thread-1', 'sandbox', () => {
      fallbackCalled = true;
      return 'FULL_DEVELOPMENT_IDENTITY';
    });

    assert.equal(fallbackCalled, false, 'sandbox must not fall through to the development identity');
    assert.doesNotMatch(identity, /FULL_DEVELOPMENT_IDENTITY/);
  });

  // AC-D4: the dev pane only works if the member knows the tool exists. Without this the
  // member either refuses ("I cannot change the schedule") or edits spec.yaml by hand,
  // which persists the change but never re-registers the cron — a schedule edit that
  // silently does nothing. Pinning it here because a prompt line is exactly the kind of
  // wiring that disappears in a refactor without any test noticing.
  test('tells the member how to edit the spec, and not to edit the file', async () => {
    const { buildSandboxStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

    const identity = buildSandboxStaticIdentity('opus', { sandboxName: 'S' });
    assert.match(identity, /cat_cafe_sandbox_update_spec/);
    assert.match(identity, /不要直接编辑 spec\.yaml/);
  });
});
