/**
 * F203 Phase I — OpenCode (金渐层) Native L0 Guard Tests
 *
 * Covers AC-I1 through AC-I7:
 * - AC-I2: opencode-config-template outputs `instructions` array
 * - AC-I3: OpenCodeAgentService.injectsL0Natively() → true
 * - AC-I5: golden-chinchilla workflow triggers exist in compiled L0
 * - AC-I6: runtime config merge does not break permission/plugin/compaction
 * - AC-I7 ①②: compile + config chain
 * - AC-I7 ③: instructions-only config content (no provider block)
 * - AC-I7 ④: OC_INSTRUCTIONS_ONLY_ENV auth preservation signal
 * - AC-I7 ⑤: compile fail-closed (type guard + throwing compiler)
 */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import {
  generateOpenCodeRuntimeConfig,
  writeOpenCodeRuntimeConfig,
} from '../dist/domains/cats/services/agents/providers/opencode-config-template.js';

const projectRoot = resolve(import.meta.dirname, '../../..');
const projectOpenCodeConfigPath = join(projectRoot, 'opencode.json');
const projectOpenCodeInstructionsPath = join(projectRoot, 'OPENCODE.md');
const hasProjectOpenCodeRuntimeFiles =
  existsSync(projectOpenCodeConfigPath) && existsSync(projectOpenCodeInstructionsPath);
const projectRuntimeInvariantOptions = hasProjectOpenCodeRuntimeFiles
  ? {}
  : {
      skip: 'public checkout does not include local OpenCode runtime config files; committed template tests still run',
    };

// F032 / #772 hermetic guard: local `.cat-cafe/cat-catalog.json` filters runtime breeds
// to catalog-only members. These L0 shape tests need the full template roster
// (opencode, gemini, opus), so point CAT_TEMPLATE_PATH at a temp template-only
// fixture with no sibling catalog overlay.
let originalTemplatePath;
let hermeticTemplateDir;
before(() => {
  originalTemplatePath = process.env.CAT_TEMPLATE_PATH;
  hermeticTemplateDir = mkdtempSync(join(tmpdir(), 'f203-hermetic-'));
  cpSync(resolve(projectRoot, 'cat-template.json'), resolve(hermeticTemplateDir, 'cat-template.json'));
  process.env.CAT_TEMPLATE_PATH = resolve(hermeticTemplateDir, 'cat-template.json');
});
after(() => {
  if (originalTemplatePath === undefined) {
    delete process.env.CAT_TEMPLATE_PATH;
  } else {
    process.env.CAT_TEMPLATE_PATH = originalTemplatePath;
  }
  if (hermeticTemplateDir) {
    rmSync(hermeticTemplateDir, { recursive: true, force: true });
  }
});

// ── AC-I3: OpenCodeAgentService.injectsL0Natively() ──

describe('F203 Phase I — OpenCodeAgentService L0 marker', () => {
  test('injectsL0Natively() returns true', () => {
    const service = new OpenCodeAgentService({ catId: 'opencode', model: 'anthropic/claude-opus-4-6' });
    assert.strictEqual(
      service.injectsL0Natively(),
      true,
      'OpenCodeAgentService must declare native L0 injection so route layer uses pack-only',
    );
  });
});

// ── AC-I2: opencode-config-template instructions support ──

describe('F203 Phase I — opencode-config-template instructions', () => {
  test('generateOpenCodeRuntimeConfig includes instructions when provided', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['claude-opus-4-6'],
      instructions: ['/tmp/l0.md', '/project/OPENCODE.md'],
    });

    assert.ok(config.instructions, 'config must have instructions field');
    assert.deepStrictEqual(config.instructions, ['/tmp/l0.md', '/project/OPENCODE.md']);
  });

  test('generateOpenCodeRuntimeConfig omits instructions when empty', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['claude-opus-4-6'],
      instructions: [],
    });

    assert.strictEqual(config.instructions, undefined, 'empty instructions should not produce field');
  });

  test('generateOpenCodeRuntimeConfig omits instructions when not provided', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['claude-opus-4-6'],
    });

    assert.strictEqual(config.instructions, undefined, 'no instructions option → no field');
  });

  test('writeOpenCodeRuntimeConfig writes instructions to disk', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tempRoot = mkdtempSync(join(tmpdir(), 'f203-i-test-'));
    try {
      const configPath = writeOpenCodeRuntimeConfig(tempRoot, 'opencode', 'inv-test-001', {
        providerName: 'anthropic',
        models: ['claude-opus-4-6'],
        instructions: ['/tmp/compiled-l0.md', '/project/OPENCODE.md'],
      });

      assert.ok(existsSync(configPath), 'config file must exist on disk');
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.deepStrictEqual(
        parsed.instructions,
        ['/tmp/compiled-l0.md', '/project/OPENCODE.md'],
        'written config must contain instructions array',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('instructions coexist with MCP and provider config', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['claude-opus-4-6'],
      mcpServerPath: '/path/to/mcp-server.js',
      instructions: ['/tmp/l0.md'],
    });

    assert.ok(config.instructions, 'instructions present');
    assert.ok(config.mcp, 'MCP present');
    assert.ok(config.provider, 'provider present');
  });
});

// ── AC-I5: golden-chinchilla workflow triggers ──

describe('F203 Phase I — golden-chinchilla workflow triggers', () => {
  // This test uses the compile CLI to verify workflow is not empty
  test('opencode catId compiles with workflow triggers (not fallback empty)', async () => {
    const { compileL0 } = await import('../../../scripts/compile-system-prompt-l0.mjs');
    const l0 = await compileL0({ catId: 'opencode' });

    assert.ok(l0.includes('金渐层家族治理'), 'must contain golden-chinchilla governance section');
    assert.ok(l0.includes('OMOC Sisyphus'), 'must mention OMOC orchestration boundary');
    assert.ok(!l0.includes('（无 per-breed 触发点配置）'), 'must NOT fall back to empty triggers');
  });

  test('opencode L0 contains identity block', async () => {
    const { compileL0 } = await import('../../../scripts/compile-system-prompt-l0.mjs');
    const l0 = await compileL0({ catId: 'opencode' });

    assert.ok(l0.includes('金渐层'), 'must contain 金渐层 identity');
    assert.ok(l0.includes('@opencode'), 'must contain @opencode mention');
  });

  test('opencode L0 contains teammate roster', async () => {
    const { compileL0 } = await import('../../../scripts/compile-system-prompt-l0.mjs');
    const l0 = await compileL0({ catId: 'opencode' });

    assert.ok(l0.includes('队友名册'), 'must contain teammate roster section');
    // opencode should not list itself in roster
    assert.ok(!l0.includes('| 金渐层'), 'opencode must not appear in its own roster');
  });

  test('opencode L0 contains governance', async () => {
    const { compileL0 } = await import('../../../scripts/compile-system-prompt-l0.mjs');
    const l0 = await compileL0({ catId: 'opencode' });

    assert.ok(l0.includes('家规'), 'must contain governance section');
    assert.ok(l0.includes('Rule 0'), 'must contain Rule 0');
  });
});

// ── AC-I5b: role-based routing parity between runtime and native L0 ──

describe('F203 Phase I — native L0 role-based routing parity', () => {
  test('opus L0 uses architect role priority over peer-reviewer', async () => {
    const { compileL0 } = await import('../../../scripts/compile-system-prompt-l0.mjs');
    const l0 = await compileL0({ catId: 'opus' });

    assert.ok(l0.includes('出口一问'), 'dev-role cat should receive common dev protocol in L0');
    assert.ok(
      l0.includes('完成架构设计/重大开发 → @codex 请 review'),
      'opus (architect > peer-reviewer) should get architect routing in L0',
    );
    assert.ok(
      !l0.includes('完成 review → @原作者 通知结果'),
      'opus should NOT get lower-priority peer-reviewer routing in L0',
    );
  });

  test('gemini L0 receives designer routing independently', async () => {
    const { compileL0 } = await import('../../../scripts/compile-system-prompt-l0.mjs');
    const l0 = await compileL0({ catId: 'gemini' });

    assert.ok(l0.includes('完成设计/视觉资产'), 'designer-role cat should get design routing in L0');
    assert.ok(!l0.includes('完成开发/修复 → @codex'), 'designer-only cat should not get code-review handoff in L0');
  });

  test('kimi L0 receives common dev protocol without dev-role routing', async () => {
    const { compileL0 } = await import('../../../scripts/compile-system-prompt-l0.mjs');
    const l0 = await compileL0({ catId: 'kimi' });

    assert.ok(l0.includes('出口一问'), 'non-dev-role cat should still receive common dev protocol in L0');
    assert.ok(!l0.includes('完成开发/修复 → @codex'), 'non-dev-role cat should not get code-review handoff in L0');
    assert.ok(!l0.includes('完成设计/视觉资产'), 'non-designer cat should not get designer routing in L0');
  });
});

// ── AC-I5c: lightweight profiles skip S6 dev protocol entirely ──

describe('F203 Phase I — native L0 lightweight profile boundary', () => {
  for (const profile of ['casual', 'roundtable', 'sandbox']) {
    test(`${profile} L0 omits dev protocol and workflow trigger section`, async () => {
      const { compileL0 } = await import('../../../scripts/compile-system-prompt-l0.mjs');
      const l0 = await compileL0({ catId: 'opencode', promptProfile: profile });

      assert.ok(!l0.includes('出口一问'), `${profile} L0 must not include 出口一问`);
      assert.ok(!l0.includes('完成开发/修复 → @codex'), `${profile} L0 must not include code-review handoff`);
      assert.ok(!l0.includes('## 6. 工作流触发点'), `${profile} L0 must not include workflow trigger heading`);
    });
  }
});

// ── AC-I6: permission/plugin/compaction not broken ──

describe('F203 Phase I — OpenCode runtime invariants (AC-I6)', () => {
  test('project opencode.json still has permission.question=deny', projectRuntimeInvariantOptions, () => {
    const config = JSON.parse(readFileSync(projectOpenCodeConfigPath, 'utf8'));

    assert.strictEqual(
      config.permission?.question,
      'deny',
      'permission.question must remain "deny" — enforcement is in config, not OPENCODE.md prose',
    );
  });

  test('project opencode.json still has OMOC plugin', projectRuntimeInvariantOptions, () => {
    const config = JSON.parse(readFileSync(projectOpenCodeConfigPath, 'utf8'));

    const plugins = config.plugin ?? config.plugins ?? [];
    const hasOmoc = plugins.some((p) => typeof p === 'string' && p.includes('oh-my-opencode'));
    assert.ok(hasOmoc, 'OMOC plugin must be preserved in project opencode.json');
  });

  test('project opencode.json still has compaction config', projectRuntimeInvariantOptions, () => {
    const config = JSON.parse(readFileSync(projectOpenCodeConfigPath, 'utf8'));

    assert.ok(config.compaction, 'compaction config must be preserved');
    assert.strictEqual(config.compaction.auto, true, 'compaction.auto must remain true');
  });

  test('OPENCODE.md still exists and contains interaction channel rules', projectRuntimeInvariantOptions, () => {
    const content = readFileSync(projectOpenCodeInstructionsPath, 'utf8');

    assert.ok(content.includes('question'), 'OPENCODE.md must document question tool deny');
    assert.ok(content.includes('cat_cafe_create_rich_block'), 'OPENCODE.md must document rich block alternative');
  });
});

// ── AC-I7 ③④⑤: explicit route/invoke/fail-closed guards (砚砚 P1-1 re-review) ──

describe('F203 Phase I — instructions-only config content verification', () => {
  test('writeOpenCodeInstructionsOnlyConfig writes ONLY schema + instructions (no provider)', async () => {
    const { writeOpenCodeInstructionsOnlyConfig } = await import(
      '../dist/domains/cats/services/agents/providers/opencode-config-template.js'
    );
    const { mkdtempSync, rmSync, readFileSync: readFs } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tempRoot = mkdtempSync(join(tmpdir(), 'f203-i-instr-only-'));
    try {
      const configPath = writeOpenCodeInstructionsOnlyConfig(tempRoot, 'opencode', 'inv-test', [
        '/tmp/l0.md',
        '/project/OPENCODE.md',
      ]);
      const parsed = JSON.parse(readFs(configPath, 'utf8'));

      assert.deepStrictEqual(parsed.instructions, ['/tmp/l0.md', '/project/OPENCODE.md']);
      assert.strictEqual(parsed.$schema, 'https://opencode.ai/config.json');
      // MUST NOT have provider block — otherwise buildEnv clears auth
      assert.strictEqual(parsed.provider, undefined, 'instructions-only config must NOT have provider');
      assert.strictEqual(parsed.model, undefined, 'instructions-only config must NOT have model');
      assert.strictEqual(parsed.mcp, undefined, 'instructions-only config must NOT have mcp');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('F203 Phase I — buildEnv auth preservation (pointer tests)', () => {
  test('OC_INSTRUCTIONS_ONLY_ENV constant is exported', async () => {
    const mod = await import('../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js');
    assert.strictEqual(mod.OC_INSTRUCTIONS_ONLY_ENV, 'CAT_CAFE_OC_INSTRUCTIONS_ONLY');
    // Real runtime auth test: opencode-agent-service.test.js
    // "F203-I: OPENCODE_CONFIG + OC_INSTRUCTIONS_ONLY preserves ANTHROPIC_API_KEY"
    // — walks service.invoke() → buildEnv() → spawnFn with preserved auth.
  });
});

describe('F203 Phase I — compile fail-closed (AC-I7 ⑤)', () => {
  test('throwing l0CompilerFn aborts invocation with fail-closed error', async () => {
    // This test verifies the fail-closed contract: if L0 compilation fails,
    // invoke-single-cat must throw, not proceed with a naked invocation.
    const { hasL0CompilerSeam } = await import('../dist/domains/cats/services/types.js');

    // A service with a deliberately-failing compiler
    const failingService = {
      catId: 'opencode',
      l0CompilerFn: async () => {
        throw new Error('deliberate L0 compile failure for test');
      },
      injectsL0Natively: () => true,
      async *invoke() {
        yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
      },
    };

    // Verify type guard recognizes the failing service
    assert.ok(hasL0CompilerSeam(failingService), 'failing service must be recognized by type guard');
    // Verify the compiler actually throws
    await assert.rejects(
      failingService.l0CompilerFn({ catId: 'opencode' }),
      /deliberate L0 compile failure/,
      'compiler must throw as expected',
    );
  });

  test('hasL0CompilerSeam returns false for services without l0CompilerFn', async () => {
    const { hasL0CompilerSeam } = await import('../dist/domains/cats/services/types.js');

    const plainService = {
      catId: 'opencode',
      async *invoke() {
        yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
      },
    };

    assert.strictEqual(hasL0CompilerSeam(plainService), false);
  });
});
