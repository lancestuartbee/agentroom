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
 * InMemorySandboxStore emit/parse the same markers (`- Trigger:`, `- Triggered At:`,
 * `- Spec Version:`, `## Summary`, `## Learned`). If they ever drift, every run is
 * dropped silently — no error, no log, just a sandbox that stops learning.
 *
 * There are TWO writers, and both must go through the renderer below: the member
 * follows it as a template, and `persistRun()` calls it directly. Review caught
 * persistRun hand-rolling its own layout without `## Learned`, which silently dropped
 * every durable learning it recorded — a hole the original contract test missed
 * because it only pinned the member's path. `test/sandbox-run-prompt.test.js` now
 * round-trips BOTH writers through the real store; change any side and it goes red.
 */

/** Location of run reports, relative to the sandbox project directory. */
export const SANDBOX_RUNS_RELATIVE_DIR = '.a2a-sandbox/runs';

/**
 * How many durable learnings get injected verbatim into a run prompt. Storage is
 * unbounded (learnings are the accumulated asset); only the injection is capped,
 * and the prompt discloses how many were held back.
 */
const MAX_INJECTED_LEARNINGS = 20;

/**
 * The one placeholder the template offers when a run has nothing durable to add.
 * The parser drops exactly this string and nothing else — an earlier version matched
 * any fully-parenthesised line, which would have silently discarded real conclusions
 * that happen to be written inside brackets.
 */
export const SANDBOX_NO_LEARNING_PLACEHOLDER = '（本次没有可沉淀的新结论）';

export interface SandboxRunReportInput {
  runId: string;
  trigger: 'scheduled' | 'manual';
  specVersion: string;
  summary: string;
  /** Durable conclusions — these, and only these, become accumulated knowledge. */
  learned?: string[];
  /**
   * When the run was triggered. Emitted into the report so the fold cursor comes from
   * the report itself rather than file mtime — copying a sandbox directory (the stated
   * migration path) rewrites mtimes and would otherwise re-fold or skip runs.
   */
  triggeredAt?: number;
}

/**
 * Render a run report in the exact shape `listRunFiles()` parses.
 *
 * SINGLE SOURCE OF FORMAT: both writers go through here — the member follows this
 * template, and `InMemorySandboxStore.persistRun()` calls it directly. An earlier
 * version had persistRun hand-roll its own layout without `## Learned`, so any
 * programmatically recorded run silently lost every durable learning.
 */
export function renderSandboxRunReport(input: SandboxRunReportInput): string {
  const learned = (input.learned ?? []).filter((line) => line.trim().length > 0);
  return [
    `# Sandbox Run ${input.runId}`,
    '',
    `- Trigger: ${input.trigger}`,
    `- Triggered At: ${new Date(input.triggeredAt ?? 0).toISOString()}`,
    `- Spec Version: ${input.specVersion}`,
    '',
    '## Summary',
    '',
    input.summary.trim(),
    '',
    '## Learned',
    '',
    ...(learned.length > 0 ? learned.map((line) => `- ${line.trim()}`) : [`- ${SANDBOX_NO_LEARNING_PLACEHOLDER}`]),
    '',
  ].join('\n');
}

export interface SandboxRunPromptInput {
  spec: SandboxSpecV1;
  memory: SandboxMemoryV1 | null;
  runId: string;
  trigger: 'scheduled' | 'manual';
  /** Dispatch time, pre-filled into the report template so the cursor is authoritative. */
  triggeredAt?: number;
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
    // Bound what we inject, not what we store. After months of runs the full list
    // would crowd out the actual task; injecting the newest slice keeps the prompt
    // usable. Disclose the remainder — silently truncating would read as "this is
    // everything I know", which is worse than a smaller honest window.
    const shown = learned.slice(-MAX_INJECTED_LEARNINGS);
    const held = learned.length - shown.length;
    lines.push('', '已学到的结论：', ...shown.map((item) => `- ${item.content}`));
    if (held > 0) {
      lines.push(`（另外还有 ${held} 条更早的学习条目未在此展开，需要时可查阅沙盒记忆文件。）`);
    }
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
  lines.push('3. 报告分两部分，请严格区分——这是本沙盒能不能越跑越懂行的关键：');
  lines.push('   - `## Summary`：**今天发生了什么**。当日观察、当日结论，允许过期。');
  lines.push(
    '   - `## Learned`：**从此以后都成立的判断**。只写你有信心长期复用的结论，它们会累积进沙盒的长期记忆，并出现在以后每一次运行里。',
  );
  lines.push('   宁可 `## Learned` 为空，也不要把当日噪音写进去——写错的长期结论会持续误导后续所有运行。');
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
      triggeredAt: input.triggeredAt,
      summary: '（今天做了什么、观察到什么，写在这里）',
      learned: [`（一条可长期复用的结论；本次没有就写「${SANDBOX_NO_LEARNING_PLACEHOLDER}」）`],
    }).trimEnd(),
  );
  lines.push('```');

  return lines.join('\n');
}
