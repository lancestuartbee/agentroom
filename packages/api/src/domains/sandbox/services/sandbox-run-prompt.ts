import type { SandboxMemoryV1, SandboxSpecV1 } from '@cat-cafe/shared';

/**
 * F247 Phase C — the sandbox run loop closure.
 *
 * The scheduler wakes a cat fire-and-forget: `ScheduleInvokeTrigger.trigger()`
 * resolves at dispatch, never at completion, so there is NO callback in which the
 * platform could record "what happened / what was learned". Without a closure the
 * sandbox would run every day and accumulate nothing — running for a hundred days
 * would leave it exactly as ignorant as day one, silently.
 *
 * The closure therefore runs through the filesystem, which is already the sandbox's
 * source of truth: the cat writes a run report into `<projectPath>/.a2a-sandbox/runs/`
 * and `InMemorySandboxStore.listRunFiles()` picks it up on the next read. No new
 * completion hook, no new MCP surface — the directory IS the brain, so the directory
 * is also the completion channel.
 *
 * CONTRACT WARNING: `renderSandboxRunReport()` below and `listRunFiles()` in
 * InMemorySandboxStore parse/emit the same three markers (`- Trigger:`,
 * `- Spec Version:`, `## Summary`). If they ever drift, every run is dropped
 * silently — no error, no log, just a sandbox that stops learning. The contract is
 * pinned by `test/sandbox-run-prompt.test.js`, which round-trips a rendered report
 * back through the real store. Change one side and that test goes red.
 */

/** Location of run reports, relative to the sandbox project directory. */
export const SANDBOX_RUNS_RELATIVE_DIR = '.a2a-sandbox/runs';

export interface SandboxRunReportInput {
  runId: string;
  trigger: 'scheduled' | 'manual';
  specVersion: string;
  summary: string;
}

/**
 * Render a run report in the exact shape `listRunFiles()` parses.
 * Also used verbatim in the prompt as the template the cat must follow.
 */
export function renderSandboxRunReport(input: SandboxRunReportInput): string {
  return [
    `# Sandbox Run ${input.runId}`,
    '',
    `- Trigger: ${input.trigger}`,
    `- Spec Version: ${input.specVersion}`,
    '',
    '## Summary',
    '',
    input.summary.trim(),
    '',
  ].join('\n');
}

export interface SandboxRunPromptInput {
  spec: SandboxSpecV1;
  memory: SandboxMemoryV1 | null;
  runId: string;
  trigger: 'scheduled' | 'manual';
}

/**
 * The accumulated-knowledge section. Kept separate so the sandbox's "compounding"
 * behaviour is one readable unit: everything here exists to stop the cat from
 * restarting from zero on day 100.
 */
function buildMemorySection(memory: SandboxMemoryV1 | null): string[] {
  const hasContent = Boolean(memory && (memory.summary || memory.learnedItems?.length));
  if (!memory || !hasContent) {
    return ['', '## 已积累的认知', '这是本沙盒的第一次运行，尚无积累。请为后续运行打下基线。'];
  }

  const lines = ['', `## 已积累的认知（截至第 ${memory.runsIncorporated} 次运行）`];
  if (memory.summary) lines.push(memory.summary);

  const learned = memory.learnedItems ?? [];
  if (learned.length > 0) {
    lines.push('', '已学到的结论：', ...learned.map((item) => `- ${item.content}`));
  }

  const openQuestions = memory.openQuestions ?? [];
  if (openQuestions.length > 0) {
    lines.push('', '尚未解决的问题：', ...openQuestions.map((q) => `- ${q}`));
  }

  lines.push('', '请在既有认知之上推进，不要从零重来；如果新证据推翻了旧结论，明确说明推翻了哪一条。');
  return lines;
}

/**
 * Build the instruction a sandbox member receives for one run.
 *
 * Spec is read at FIRE TIME (not at schedule-registration time) so edits made in the
 * dev pane take effect on the very next run — that is the whole point of "spec is the
 * only interface between the dev pane and the run pane".
 */
export function buildSandboxRunPrompt(input: SandboxRunPromptInput): string {
  const { spec, memory, runId, trigger } = input;
  const lines: string[] = [];

  lines.push(`[A2A 沙盒运行 · ${spec.name}]`);
  lines.push('');
  lines.push(`本次运行 ID：${runId}（触发方式：${trigger === 'scheduled' ? '定时' : '手动'}）`);
  lines.push('');
  lines.push('## 项目目标');
  lines.push(spec.goal);

  if (spec.learningGoal) {
    lines.push('');
    lines.push('## 学习目标');
    lines.push(spec.learningGoal);
  }

  lines.push(...buildMemorySection(memory));

  lines.push('');
  lines.push('## 本次运行要求');
  lines.push('1. 按项目目标执行本次运行。');
  lines.push('2. 运行结束前，必须把本次结论写入运行报告文件（见下），否则本次运行不会被记录，积累会断档。');
  lines.push('3. 报告里的结论要具体、可验证；写清楚学到了什么、以及哪些判断还需要更多证据。');
  lines.push('');
  lines.push('## 运行报告（必须写，格式不可改）');
  lines.push(`写入路径：\`${SANDBOX_RUNS_RELATIVE_DIR}/${runId}.md\`（相对本沙盒项目目录）`);
  lines.push('');
  lines.push(
    '文件内容必须严格采用下面的模板 —— 前两个字段和 `## Summary` 标题会被系统解析，改动会导致本次运行被丢弃：',
  );
  lines.push('');
  lines.push('```markdown');
  lines.push(
    renderSandboxRunReport({
      runId,
      trigger,
      specVersion: spec.specVersion,
      summary: '（本次运行的结论写在这里）',
    }).trimEnd(),
  );
  lines.push('```');

  return lines.join('\n');
}
