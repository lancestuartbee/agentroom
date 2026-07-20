import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry, createCatId } from '@cat-cafe/shared';

const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
const { buildCasualStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
const { CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');
const profile = await import('../dist/domains/cats/services/agents/routing/casual-prompt-profile.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAT_TEMPLATE_PATH = join(__dirname, '..', '..', '..', 'cat-template.json');

async function withRealRoster(run) {
  const original = catRegistry.getAllConfigs();
  const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
  try {
    return await run();
  } finally {
    catRegistry.reset();
    for (const [id, config] of Object.entries(original)) {
      catRegistry.register(id, config);
    }
  }
}

describe('casual prompt profile', () => {
  it('builds a lightweight identity without development governance sections', async () => {
    await withRealRoster(async () => {
      const prompt = buildCasualStaticIdentity(createCatId('codex'), {
        reportsDir: '/tmp/agentroom/thread-example/reports',
      });

      assert.match(prompt, /\[Casual profile\]/);
      assert.match(prompt, /闲聊模式/);
      assert.match(prompt, /thread-example\/reports/);
      assert.match(prompt, /Markdown 链接/);
      assert.match(prompt, /\[下载报告\]\(绝对路径\)/);
      assert.doesNotMatch(prompt, /## 队友名册/);
      assert.doesNotMatch(prompt, /MCP 工具文档/);
      assert.doesNotMatch(prompt, /工作流触发点/);
      assert.doesNotMatch(prompt, /治理摘要/);
      assert.ok(prompt.length < 1400, `casual prompt should stay compact, got ${prompt.length} chars`);
    });
  });

  it('uses the casual context budget instead of development budgets', () => {
    assert.equal(profile.resolvePromptProfile(undefined, '[Casual mode]\nhello'), 'casual');
    assert.deepEqual(profile.getPromptProfileContextBudget('codex', 'casual'), profile.CASUAL_CONTEXT_BUDGET);
  });

  it('keeps a larger context window for roundtable critique loops', () => {
    const budget = profile.getPromptProfileContextBudget('codex', 'roundtable');

    assert.deepEqual(budget, profile.ROUNDTABLE_CONTEXT_BUDGET);
    assert.ok(budget.maxMessages >= 160, 'roundtable should cover multi-round participant history');
    assert.ok(budget.maxContextTokens >= 16000, 'roundtable should not truncate five critique rounds too aggressively');
  });

  it('does not compile full Codex L0 when casual native prompt override is present', async () => {
    await withRealRoster(async () => {
      let l0CompileCalls = 0;
      const service = new CodexAgentService({
        catId: createCatId('codex'),
        model: 'gpt-test',
        cliCommand: 'definitely-not-a-real-codex-command-for-casual-test',
        l0CompilerFn: async () => {
          l0CompileCalls += 1;
          throw new Error('full L0 compiler should not be called in casual override path');
        },
      });

      const messages = [];
      for await (const msg of service.invoke('hello', {
        promptProfile: 'casual',
        nativeSystemPrompt: '[Casual profile]\nminimal identity',
      })) {
        messages.push(msg);
      }

      assert.equal(l0CompileCalls, 0);
      assert.equal(messages[0]?.type, 'error');
      assert.match(messages[0]?.error ?? '', /not found|未找到/i);
    });
  });
});
