import { randomUUID } from 'node:crypto';
import type { CatId, RoundtableIssueStateV1 } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { resolveThreadArtifactPaths } from '../../../../../utils/artifact-store-paths.js';
import type { AgentMessage } from '../../types.js';
import { accumulateTextParts, flattenTextParts } from '../text-aggregation.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';
import { routeParallel } from './route-parallel.js';

const MAX_CRITIQUE_ROUNDS = 5;
const ROUNDTABLE_RECENT_CONTEXT_LIMIT = 180;
const ROUNDTABLE_RECENT_CONTEXT_TEXT_LIMIT = 48000;

type RoundtablePhase =
  | 'independent_stance'
  | 'critique_challenge'
  | 'critique_response'
  | 'consensus_vote'
  | 'final_summary'
  | 'followup'
  | 'single_response'
  | 'artifact_save';
type Vote = 'accept' | 'accept_with_conditions' | 'reject' | 'unknown';
type RoundtableControlKey = 'CHANGE' | 'NEW_CHALLENGE' | 'READY_TO_VOTE' | 'BLOCKER' | 'VOTE';
type RoundtableAction =
  | 'new_deliberation'
  | 'continue_critique'
  | 'vote_and_summary'
  | 'followup'
  | 'single_response'
  | 'artifact_request';

interface RoundtablePhaseDefinition {
  readonly phase: RoundtablePhase;
  readonly prompt: string;
  readonly modeSystemPromptByCat?: Record<string, string>;
  readonly allowArtifactWrites?: boolean;
  readonly reportsDir?: string;
}

interface RoundtableActionPlan {
  readonly action: RoundtableAction;
  readonly focusCats: CatId[];
  readonly strictFocusOnly: boolean;
}

function catLabel(catId: CatId): string {
  const config = catRegistry.tryGet(catId as string)?.config;
  if (!config) return String(catId);
  return config.nickname ? `${config.displayName}/${config.nickname} (@${catId})` : `${config.displayName} (@${catId})`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncateText(value: string, maxLength: number): string {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 20)).trimEnd()}\n...[truncated]`;
}

function oneLine(value: string, maxLength = 220): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 15)).trimEnd()}...`;
}

function roundtableControlKeyFromLabel(label: string): RoundtableControlKey | null {
  const normalized = label.trim().replace(/\s+/g, '').toUpperCase();
  if (normalized === 'CHANGE') return 'CHANGE';
  if (normalized === 'NEW_CHALLENGE') return 'NEW_CHALLENGE';
  if (normalized === 'READY_TO_VOTE') return 'READY_TO_VOTE';
  if (normalized === 'BLOCKER') return 'BLOCKER';
  if (normalized === 'VOTE') return 'VOTE';
  if (/^(立场|判断|当前立场|当前判断).*(变化|改变|修订)$/.test(label)) return 'CHANGE';
  if (/^新(的)?挑战$/.test(label)) return 'NEW_CHALLENGE';
  if (/^(准备投票|可进入投票|是否准备投票)$/.test(label)) return 'READY_TO_VOTE';
  if (/^(阻塞|仍有阻塞|仍有阻碍|关键阻塞)$/.test(label)) return 'BLOCKER';
  if (/^(投票|票型|表决)$/.test(label)) return 'VOTE';
  return null;
}

function normalizeRoundtableControlValue(value: string): 'yes' | 'no' | null {
  const normalized = value.trim().toLowerCase();
  if (/^(yes|y|true|1|是|有|已|变化|改变|修订|可|可以|准备好)(?:\b|$)/.test(normalized)) return 'yes';
  if (/^(no|n|false|0|否|无|没有|不|未|无需|不变|保持)(?:\b|$)/.test(normalized)) return 'no';
  if (/(可以|准备好|进入投票|有阻塞|有挑战|改变|修订)/.test(value)) return 'yes';
  if (/(没有|无|不变|保持|不需要|不进入|不能|不可以)/.test(value)) return 'no';
  return null;
}

function parseRoundtableControlLine(line: string): { key: RoundtableControlKey; value: string } | null {
  const match = /^\s*([^:：]{1,32})\s*[:：]\s*(.+?)\s*$/.exec(line);
  if (!match) return null;
  const key = roundtableControlKeyFromLabel(match[1] ?? '');
  if (!key) return null;
  return { key, value: match[2]?.trim() ?? '' };
}

function controlYesNo(text: string, key: Exclude<RoundtableControlKey, 'VOTE'>): boolean | null {
  for (const line of text.slice(0, 1200).split(/\r?\n/)) {
    const parsed = parseRoundtableControlLine(line);
    if (parsed?.key !== key) continue;
    return normalizeRoundtableControlValue(parsed.value) === 'yes';
  }
  return null;
}

function stripRoundtableControlLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !parseRoundtableControlLine(line))
    .join('\n')
    .trim();
}

function extractMarkdownSection(text: string, titles: readonly string[]): string {
  const normalizedTitles = new Set(titles.map((title) => title.trim()));
  const lines = stripRoundtableControlLines(text).split(/\r?\n/);
  let collecting = false;
  const body: string[] = [];
  for (const line of lines) {
    const heading = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[2]?.trim() ?? '';
      if (collecting) break;
      collecting = normalizedTitles.has(title);
      continue;
    }
    if (collecting) body.push(line);
  }
  return body.join('\n').trim();
}

function summarizeVoteReason(raw: string): string {
  const section =
    extractMarkdownSection(raw, ['投票理由']) ||
    extractMarkdownSection(raw, ['条件或阻塞']) ||
    stripRoundtableControlLines(raw);
  return oneLine(section || '未提供明确理由。');
}

function summarizeVoteCondition(raw: string): string {
  const section =
    extractMarkdownSection(raw, ['条件或阻塞']) ||
    extractMarkdownSection(raw, ['若要改变我的投票，需要什么证据']) ||
    stripRoundtableControlLines(raw);
  return oneLine(section || '未列出具体条件。');
}

const TOPIC_ANSWER_SECTION_TITLES = [
  '我对议题的最终回答',
  '对议题的最终回答',
  '对议题的直接回答',
  '最终回答',
  '最终结论',
  '我的立场',
  '立场',
] as const;

const STANCE_SECTION_TITLES = ['我的立场', '对议题的直接回答', '立场', '结论'] as const;

function getLatestCritiqueForCat(critiques: readonly ReadonlyMap<string, string>[], catId: CatId): string {
  for (let i = critiques.length - 1; i >= 0; i--) {
    const raw = critiques[i]?.get(catId);
    if (raw?.trim()) return raw;
  }
  return '';
}

function summarizeTopicAnswer(
  catId: CatId,
  rawVote: string,
  stances: ReadonlyMap<string, string>,
  critiques: readonly ReadonlyMap<string, string>[],
): string {
  const voteAnswer = extractMarkdownSection(rawVote, TOPIC_ANSWER_SECTION_TITLES);
  if (voteAnswer) return oneLine(voteAnswer, 320);

  const stance = stances.get(catId) ?? '';
  const stanceAnswer = extractMarkdownSection(stance, STANCE_SECTION_TITLES);
  if (stanceAnswer) return oneLine(stanceAnswer, 320);

  const latestCritique = getLatestCritiqueForCat(critiques, catId);
  const critiqueAnswer =
    extractMarkdownSection(latestCritique, ['当前立场是否变化']) ||
    extractMarkdownSection(latestCritique, ['我接受的论点']) ||
    extractMarkdownSection(latestCritique, ['我仍然反对的论点']);
  if (critiqueAnswer) return oneLine(critiqueAnswer, 320);

  return summarizeVoteReason(rawVote);
}

function formatOutputs(title: string, outputs: ReadonlyMap<string, string>, maxLength = 1600): string {
  if (outputs.size === 0) return `${title}\n\n（暂无有效发言）`;
  const parts = [...outputs.entries()].map(([catId, text]) => {
    return `### ${catLabel(catId as CatId)}\n${truncateText(text || '（空回复）', maxLength)}`;
  });
  return `${title}\n\n${parts.join('\n\n')}`;
}

function buildRoundtableModeSystemPrompt(
  threadId: string,
  phase: RoundtablePhase,
  extra?: string,
  options?: { allowArtifactWrites?: boolean; reportsDir?: string },
): string {
  const reportsDir = options?.reportsDir;
  const fileRule = options?.allowArtifactWrites
    ? [
        'Artifact-save exception: the user explicitly asked to save/export meeting output.',
        reportsDir
          ? `You may create or update Markdown artifacts only inside this shared reports directory: ${reportsDir}`
          : 'You may create or update Markdown artifacts only inside the current thread reports directory.',
        'Do not modify repository files, provider private files, agent private files, runtime config, persistent stores, or any path outside the shared reports directory.',
        'Use only the minimal file operations required for the requested artifact; do not enter development workflow.',
      ].join('\n')
    : 'Do not modify files, run shell commands, create tasks, use free-form A2A handoff, review gates, or merge workflow.';
  return [
    '[Roundtable mode]',
    `Thread ${threadId}. Phase: ${phase}.`,
    'Use the roundtable deliberation profile.',
    'Do not enter development workflow.',
    fileRule,
    'If your judgment depends on missing current facts, use available read-only research/search tools before answering. Do not merely say data is needed when a read-only lookup can resolve it.',
    'Respond only to the current roundtable instruction.',
    extra ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildIssueId(): string {
  return `roundtable_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function buildIssueState(
  threadId: string,
  topic: string,
  participants: readonly CatId[],
  previous?: RoundtableIssueStateV1 | null,
): RoundtableIssueStateV1 {
  return {
    v: 1,
    issueId: previous?.issueId ?? buildIssueId(),
    threadId,
    topic,
    status: previous?.status ?? 'open',
    stage: previous?.stage ?? 'independent_stance',
    ...(previous?.critiqueStep ? { critiqueStep: previous.critiqueStep } : {}),
    critiqueRound: previous?.critiqueRound ?? 0,
    maxCritiqueRounds: previous?.maxCritiqueRounds ?? MAX_CRITIQUE_ROUNDS,
    participants: participants.map(String),
    ...(previous?.lastPhaseMessageId ? { lastPhaseMessageId: previous.lastPhaseMessageId } : {}),
    ...(previous?.finalSummaryMessageId ? { finalSummaryMessageId: previous.finalSummaryMessageId } : {}),
    updatedAt: Date.now(),
  };
}

async function persistRoundtableState(
  deps: RouteStrategyDeps,
  threadId: string,
  state: RoundtableIssueStateV1,
): Promise<void> {
  await Promise.resolve(deps.invocationDeps.threadStore?.updateRoundtableIssueState?.(threadId, state));
  deps.socketManager?.broadcastToRoom(`thread:${threadId}`, 'thread_updated', {
    threadId,
    roundtableIssueState: state,
  });
}

async function markRoundtablePhase(
  deps: RouteStrategyDeps,
  threadId: string,
  primaryCat: CatId,
  state: RoundtableIssueStateV1,
  patch: Partial<RoundtableIssueStateV1>,
  label: string,
): Promise<{ state: RoundtableIssueStateV1; message: AgentMessage }> {
  const now = Date.now();
  const nextState: RoundtableIssueStateV1 = {
    ...state,
    ...patch,
    updatedAt: now,
  };
  const stored = await Promise.resolve(
    deps.messageStore.append({
      userId: 'system',
      catId: null,
      content: `圆桌会议：${label}`,
      mentions: [],
      timestamp: now,
      threadId,
    }),
  );
  const persistedState = {
    ...nextState,
    lastPhaseMessageId: stored.id,
    updatedAt: stored.timestamp,
  };
  await persistRoundtableState(deps, threadId, persistedState);
  return {
    state: persistedState,
    message: {
      type: 'system_info',
      catId: primaryCat,
      content: stored.content,
      timestamp: stored.timestamp,
      messageId: stored.id,
    },
  };
}

function buildIndependentStancePrompt(topic: string, participants: readonly CatId[]): string {
  return [
    '# 圆桌会议阶段 1/4：独立立场',
    '',
    `议题：${topic}`,
    `固定参与者：${participants.map(catLabel).join('、')}`,
    '',
    '请先独立给出你的判断。本阶段不要总结他人，也不要寻求共识。',
    '如果该议题依赖当前事实、产品信息、价格、法规、新闻、技术版本或其他外部资料，请先使用可用的只读检索/搜索工具获取关键事实，再给出立场；不要只说“需要数据”。',
    '你的第一段必须回答议题本身，不要只评价讨论流程或说需要别人补充。',
    '',
    '输出格式：',
    '## 我的立场',
    '## 对议题的直接回答',
    '## 关键依据',
    '## 风险与不确定',
    '## 希望其他成员挑战的问题',
  ].join('\n');
}

function buildCritiqueChallengePrompt(
  topic: string,
  round: number,
  maxRounds: number,
  stances: ReadonlyMap<string, string>,
  previousCritiques: readonly ReadonlyMap<string, string>[],
): string {
  const previousRoundSections = previousCritiques.map((outputs, index) => {
    return formatOutputs(`互评循环第 ${index + 1} 轮记录`, outputs, 1100);
  });

  return [
    `# 圆桌会议阶段 2/4：互评循环 ${round}/${maxRounds} · 评价/挑战`,
    '',
    `议题：${topic}`,
    '',
    formatOutputs('独立立场', stances, 1300),
    '',
    ...previousRoundSections,
    previousRoundSections.length > 0 ? '' : '',
    '本轮第一步：评价/挑战。',
    '请评价其他成员对议题本身的立场，指出你认为最需要澄清、补证或修正的地方。',
    '不要在这一步替对方澄清，也不要急着投票；同轮澄清会在下一步发生。',
    '如果分歧依赖缺失事实，请使用可用的只读检索/搜索工具补证，而不是只要求别人补数据。',
    '',
    '输出格式要求：',
    '- 必须使用下面这些 Markdown 二级标题；不要用加粗标签、列表项或段首冒号代替标题。',
    '- 针对具体成员的认可、挑战或澄清请求，使用三级标题：### 对 <成员名> 的认可/挑战/问题。',
    '- 如果某一节没有内容，写“无”。',
    '',
    '## 我认可的论点',
    '（如需分成员，使用：### 对 成员名 的认可）',
    '## 我挑战的论点',
    '（如需分成员，使用：### 对 成员名 的挑战）',
    '## 我请求澄清的问题',
    '（如需分成员，使用：### 对 成员名 的问题）',
    '## 目前阻碍共识的点',
  ].join('\n');
}

function buildCritiqueResponsePrompt(
  topic: string,
  round: number,
  maxRounds: number,
  stances: ReadonlyMap<string, string>,
  previousCritiques: readonly ReadonlyMap<string, string>[],
  currentChallenges: ReadonlyMap<string, string>,
): string {
  const previousRoundSections = previousCritiques.map((outputs, index) => {
    return formatOutputs(`互评循环第 ${index + 1} 轮记录`, outputs, 1100);
  });

  return [
    `# 圆桌会议阶段 2/4：互评循环 ${round}/${maxRounds} · 澄清/修订`,
    '',
    `议题：${topic}`,
    '',
    formatOutputs('独立立场', stances, 1100),
    '',
    ...previousRoundSections,
    previousRoundSections.length > 0 ? '' : '',
    formatOutputs(`本轮 ${round} 的评价/挑战`, currentChallenges, 1300),
    '',
    '本轮第二步：澄清/修订。',
    '请回应本轮其他成员对你的挑战，并说明这些挑战是否改变了你对议题本身的判断。',
    '你可以接受并修订、部分接受、拒绝、要求证据，或保持立场。',
    '你也可以继续提出新的实质挑战，但只能指向固定参会成员。',
    '不要为了结束会议而假装同意；如果仍未被说服，明确保留分歧。',
    '如果分歧依赖缺失事实，请使用可用的只读检索/搜索工具补证，而不是只要求别人补数据。',
    '',
    '前四行必须严格使用以下格式，不得省略、不得翻译键名、不得使用中文冒号、不得放入代码块；不确定时填 no：',
    'CHANGE: yes|no',
    'NEW_CHALLENGE: yes|no',
    'READY_TO_VOTE: yes|no',
    'BLOCKER: yes|no',
    '',
    '随后按格式输出。必须使用下面这些 Markdown 二级/三级标题；不要用加粗标签、列表项或段首冒号代替标题。',
    '## 立场修订',
    '## 对其他成员挑战的回应',
    '（每个被回应成员一段，使用：### 对 成员名 的回应）',
    '## 我接受的论点',
    '## 我仍然反对的论点',
    '## 新的挑战',
    '（如有新挑战，使用：### 对 成员名 的新挑战；没有则写“无”）',
  ].join('\n');
}

function buildVotePrompt(
  topic: string,
  stances: ReadonlyMap<string, string>,
  critiques: readonly ReadonlyMap<string, string>[],
  recentContext?: string,
): string {
  const critiqueSections = critiques.map((outputs, index) => formatOutputs(`互评循环第 ${index + 1} 轮`, outputs, 900));
  return [
    '# 圆桌会议阶段 3/4：共识投票',
    '',
    `议题：${topic}`,
    '',
    formatOutputs('独立立场摘要', stances, 1000),
    '',
    ...critiqueSections,
    recentContext ? `最近圆桌上下文\n\n${recentContext}` : '',
    '',
    '请只代表你自己投票。若仍有关键分歧或证据不足，可以拒绝共识。',
    '投票不是评价谁说服了谁；必须写清楚你最终对议题本身的回答。',
    '如果投票仍依赖一个可通过只读检索解决的事实，请先检索再投票。',
    '',
    '第一行必须是以下三者之一：',
    'VOTE: accept',
    'VOTE: accept_with_conditions',
    'VOTE: reject',
    '',
    '随后按格式说明：',
    '## 我对议题的最终回答',
    '## 投票理由',
    '## 条件或阻塞',
    '## 若要改变我的投票，需要什么证据',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildFollowupPrompt(
  topic: string,
  userMessage: string,
  participants: readonly CatId[],
  focusCats: readonly CatId[],
  recentContext: string,
): string {
  return [
    '# 圆桌会议追问/澄清',
    '',
    `当前议题：${topic}`,
    `固定参会者：${participants.map(catLabel).join('、')}`,
    `用户点名对象：${focusCats.map(catLabel).join('、') || '无'}`,
    '',
    '最近圆桌上下文：',
    recentContext || '（暂无可用历史上下文）',
    '',
    `用户追问：${userMessage}`,
    '',
    '规则：',
    '- 如果你是用户点名对象，请优先澄清你自己的观点。',
    '- 如果你不是点名对象，只有存在实质补充、反驳、事实纠错或风险提示时才发言。',
    '- 如果你不是点名对象且没有实质补充，请只输出一行：NO_COMMENT',
    '- 本阶段不投票、不总结为共识、不改变固定参会名单。',
    '',
    '输出格式：',
    '## 回应',
    '## 是否改变我对当前议题的判断',
    '## 其他成员应注意的点',
  ].join('\n');
}

function buildSingleResponsePrompt(currentTopic: string | null, userMessage: string, recentContext: string): string {
  return [
    '# 圆桌会议简短回应',
    '',
    currentTopic ? `当前圆桌议题：${currentTopic}` : '当前没有正在推进的圆桌议题。',
    recentContext ? `最近圆桌上下文\n\n${recentContext}` : '',
    '',
    `用户消息：${userMessage}`,
    '',
    '规则：',
    '- 这不是新的圆桌议题，不进入独立立场、互评、投票或会议总结。',
    '- 简短回答用户当前消息；如果用户显然只是问事实、确认、感谢或顺手追问，不要拉全员讨论。',
    '- 如果用户想把它作为新圆桌议题，请提示用户明确“开启新议题/大家讨论”。',
    '',
    '输出格式：',
    '## 回应',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildArtifactSavePrompt(
  topic: string,
  userMessage: string,
  reportsDir: string,
  recentContext: string,
): string {
  return [
    '# 圆桌会议产物保存',
    '',
    `圆桌议题：${topic}`,
    `共享产物目录：${reportsDir}`,
    '',
    '最近圆桌上下文：',
    recentContext || '（暂无可用历史上下文）',
    '',
    `用户保存/导出要求：${userMessage}`,
    '',
    '规则：',
    '- 只根据已经形成的圆桌材料和用户要求整理产物，不重新开启互评或投票。',
    '- 必须实际创建或更新 Markdown 文件；文件只能保存在上面的共享产物目录内。',
    '- 不要写入仓库源码、配置、provider 私有目录、agent 私有目录或其他路径。',
    '- 保存后在回复中给出产物标题、简短说明和指向绝对路径的 Markdown 链接。',
    '',
    '输出格式：',
    '## 产物',
    '## 保存位置',
    '## 说明',
  ].join('\n');
}

function isNoCommentOutput(text: string): boolean {
  const meaningfulLines = stripRoundtableControlLines(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s+/.test(line));
  return meaningfulLines.length === 1 && /^NO[_\s-]?COMMENT\.?$/i.test(meaningfulLines[0] ?? '');
}

function parseVote(text: string): Vote {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const normalized = (firstLine ?? text.slice(0, 200)).toLowerCase();
  if (/vote:\s*accept_with_conditions\b/.test(normalized)) return 'accept_with_conditions';
  if (/vote:\s*reject\b/.test(normalized)) return 'reject';
  if (/vote:\s*accept\b/.test(normalized)) return 'accept';
  if (/(拒绝|反对|不接受|未达成)/.test(text)) return 'reject';
  if (/(有条件接受|条件接受|保留接受)/.test(text)) return 'accept_with_conditions';
  if (/(接受|同意|赞成)/.test(text)) return 'accept';
  return 'unknown';
}

export function parseCritiqueMeta(text: string): {
  changed: boolean;
  newChallenge: boolean;
  readyToVote: boolean;
  blocker: boolean;
} {
  const explicitChanged = controlYesNo(text, 'CHANGE');
  const explicitNewChallenge = controlYesNo(text, 'NEW_CHALLENGE');
  const explicitReadyToVote = controlYesNo(text, 'READY_TO_VOTE');
  const explicitBlocker = controlYesNo(text, 'BLOCKER');
  const changed =
    explicitChanged ??
    /(立场修订|我修正|修订后的|接受.*(?:修订|修正)|部分接受|改变了?我的立场|我改变立场|调整为)/.test(text);
  const newChallenge =
    explicitNewChallenge ??
    /(^|\n)\s*(?:[-*]\s*)?(?:#{2,4}\s*)?(?:\*\*)?新的?挑战(?:\*\*)?\s*[:：]?|我挑战|挑战\s*@|继续挑战|新的实质挑战/.test(
      text,
    );
  const readyToVote =
    explicitReadyToVote ?? /(可以进入投票|可进入投票|准备投票|可以投票|足够收束|进入投票)/.test(text);
  const blocker =
    explicitBlocker ??
    /(仍未解决|关键分歧|证据不足|缺少证据|不能投票|不能达成|无法达成|仍然反对|仍未消除|仍有.*不确定|不确定性)/.test(
      text,
    );
  return { changed, newChallenge, readyToVote, blocker };
}

export function buildFinalSummary(
  topic: string,
  participants: readonly CatId[],
  stances: ReadonlyMap<string, string>,
  critiques: readonly ReadonlyMap<string, string>[],
  votes: ReadonlyMap<string, string>,
  _recentContext?: string,
): string {
  const voteEntries = participants.map((catId) => {
    const raw = votes.get(catId) ?? '';
    return { catId, raw, vote: parseVote(raw) };
  });
  const fullConsensus = voteEntries.length > 0 && voteEntries.every((entry) => entry.vote === 'accept');
  const blockers = voteEntries.filter((entry) => entry.vote === 'reject' || entry.vote === 'unknown');
  const conditional = voteEntries.filter((entry) => entry.vote === 'accept_with_conditions');
  const acceptCount = voteEntries.filter((entry) => entry.vote === 'accept').length;
  const conditionalCount = conditional.length;
  const rejectCount = blockers.filter((entry) => entry.vote === 'reject').length;
  const unknownCount = blockers.filter((entry) => entry.vote === 'unknown').length;
  const supportCount = acceptCount + conditionalCount;
  const hasMajoritySupport = voteEntries.length > 0 && supportCount > voteEntries.length / 2;
  const viewEntries = voteEntries.map((entry) => ({
    ...entry,
    topicAnswer: summarizeTopicAnswer(entry.catId, entry.raw, stances, critiques),
    voteReason: summarizeVoteReason(entry.raw),
    condition: summarizeVoteCondition(entry.raw || entry.vote),
  }));

  const voteLines = viewEntries.map((entry) => {
    return `- ${catLabel(entry.catId)}: ${entry.vote} — ${entry.voteReason}`;
  });

  const supportLines = viewEntries
    .filter((entry) => entry.vote === 'accept' || entry.vote === 'accept_with_conditions')
    .map((entry) => `- ${catLabel(entry.catId)}: ${entry.topicAnswer}`);
  const conditionLines = viewEntries
    .filter((entry) => entry.vote === 'accept_with_conditions')
    .map((entry) => {
      return `- ${catLabel(entry.catId)}: ${entry.condition}`;
    });
  const minorityLines = viewEntries
    .filter((entry) => entry.vote === 'reject' || entry.vote === 'unknown')
    .map((entry) => {
      const prefix = entry.vote === 'reject' ? 'reject' : 'unknown';
      return `- ${catLabel(entry.catId)} (${prefix}): ${entry.topicAnswer}；保留原因：${entry.condition}`;
    });
  const resultLines = fullConsensus
    ? ['全体最终接受以下对议题本身的回答：', ...supportLines]
    : hasMajoritySupport
      ? ['多数成员支持以下对议题本身的回答，但仍存在条件或保留：', ...supportLines]
      : [
          '本轮没有形成可代表多数的议题答案。以下是仍需用户参考的主要立场：',
          ...viewEntries.map((entry) => `- ${catLabel(entry.catId)} (${entry.vote}): ${entry.topicAnswer}`),
        ];
  const nextStep = fullConsensus
    ? '按上述议题答案推进；如进入执行场景，再补充事实校验或实施计划。'
    : hasMajoritySupport
      ? '优先处理条件票和反对票提出的阻塞；处理后可重新投票或要求保存会议结论。'
      : '先缩小议题范围或补充关键证据，再进入下一轮互评或重新投票。';

  const statusText = fullConsensus
    ? '达成全体无条件共识'
    : hasMajoritySupport
      ? '形成多数倾向但未达成全体共识'
      : '未达成共识';

  const finalConclusion = resultLines.length > 1 ? resultLines.join('\n') : resultLines[0] ?? '暂无明确结论。';

  return [
    '# 圆桌会议总结',
    '',
    `议题：${topic}`,
    `参与者：${participants.map(catLabel).join('、')}`,
    `互评轮次：${critiques.length}/${MAX_CRITIQUE_ROUNDS}`,
    `共识状态：${statusText}`,
    '',
    '## 会议结论',
    finalConclusion,
    '',
    '## 票型分布',
    `accept: ${acceptCount}`,
    `accept_with_conditions: ${conditionalCount}`,
    `reject: ${rejectCount}`,
    `unknown: ${unknownCount}`,
    '',
    '## 投票记录',
    voteLines.length > 0 ? voteLines.join('\n') : '（暂无投票）',
    '',
    '## 多数或可采纳观点',
    supportLines.length > 0 ? supportLines.join('\n') : '暂无明确支持票。',
    '',
    '## 条件与阻塞',
    conditionLines.length > 0 ? conditionLines.join('\n') : '无条件接受票提出的额外阻塞。',
    '',
    '## 少数或保留观点',
    minorityLines.length > 0 ? minorityLines.join('\n') : '无 reject 或 unknown 票。',
    '',
    '## 下一步',
    nextStep,
  ]
    .filter(Boolean)
    .join('\n');
}

async function* runRoundtablePhase(
  deps: RouteStrategyDeps,
  targetCats: CatId[],
  userId: string,
  threadId: string,
  options: RouteOptions,
  definition: RoundtablePhaseDefinition,
): AsyncGenerator<AgentMessage, Map<string, string>, void> {
  const partsByCat = new Map<string, string[]>();
  const phaseOptions: RouteOptions = {
    ...options,
    contentBlocks: undefined,
    uploadDir: undefined,
    promptProfile: 'roundtable',
    modeSystemPrompt: buildRoundtableModeSystemPrompt(threadId, definition.phase, undefined, {
      allowArtifactWrites: definition.allowArtifactWrites,
      reportsDir: definition.reportsDir,
    }),
    modeSystemPromptByCat: definition.modeSystemPromptByCat,
    maxA2ADepth: 0,
    promptTags: [],
  };

  for await (const msg of routeParallel(deps, targetCats, definition.prompt, userId, threadId, phaseOptions)) {
    if (msg.type === 'text' && msg.catId && typeof msg.content === 'string') {
      const parts = partsByCat.get(msg.catId) ?? [];
      accumulateTextParts(parts, msg.content, msg.textMode);
      partsByCat.set(msg.catId, parts);
    }
    yield msg;
  }

  const result = new Map<string, string>();
  for (const [catId, parts] of partsByCat.entries()) {
    result.set(catId, flattenTextParts(parts).trim());
  }
  return result;
}

async function getCurrentIssueState(deps: RouteStrategyDeps, threadId: string): Promise<RoundtableIssueStateV1 | null> {
  try {
    return (await Promise.resolve(deps.invocationDeps.threadStore?.get(threadId)))?.roundtableIssueState ?? null;
  } catch {
    return null;
  }
}

async function getRecentRoundtableContext(
  deps: RouteStrategyDeps,
  threadId: string,
  userId: string,
  limit = ROUNDTABLE_RECENT_CONTEXT_LIMIT,
): Promise<string> {
  const messages = await Promise.resolve(deps.messageStore.getByThread(threadId, limit, userId));
  const lines = messages
    .filter((msg) => !msg.deletedAt && msg.content.trim().length > 0)
    .slice(-limit)
    .map((msg) => {
      const speaker = msg.catId ? catLabel(msg.catId) : msg.userId === 'system' ? 'System' : 'User';
      return `### ${speaker}\n${truncateText(msg.content, 2200)}`;
    });
  return truncateText(lines.join('\n\n'), ROUNDTABLE_RECENT_CONTEXT_TEXT_LIMIT);
}

function findMentionedParticipants(message: string, participants: readonly CatId[]): CatId[] {
  const result: CatId[] = [];
  for (const catId of participants) {
    const config = catRegistry.tryGet(catId as string)?.config;
    const aliases = config?.mentionPatterns?.length ? config.mentionPatterns : [`@${catId}`];
    const matched = aliases.some((alias) => {
      const pattern = alias.startsWith('@') ? alias : `@${alias}`;
      const re = new RegExp(`(^|[^a-zA-Z0-9_.-])${escapeRegExp(pattern)}(?=$|[^a-zA-Z0-9_.-])`, 'i');
      return re.test(message);
    });
    if (matched) result.push(catId);
  }
  return result;
}

function hasAllMention(message: string): boolean {
  return /(^|[\s,，。！？!?:：;；])@(?:all|全体)(?=$|[\s,，。！？!?:：;；])/i.test(message);
}

function hasStrictFocusCue(message: string): boolean {
  return /(只让|只要|只需|只请|仅让|仅要|仅需|仅请|只听|只看)/.test(message);
}

function hasVoteCue(message: string): boolean {
  return /(重新投票|开始投票|进入投票|投票|表决)/.test(message);
}

function hasSummaryCue(message: string): boolean {
  return /(重新总结|总结一下|会议总结|最终总结|收束总结)/.test(message);
}

function hasContinueCue(message: string): boolean {
  return /(继续圆桌|继续讨论|继续互评|继续收束|大家讨论|大家继续|形成共识|重新收束|继续推进)/.test(message);
}

function hasCollectiveCue(message: string): boolean {
  return hasAllMention(message) || hasVoteCue(message) || hasSummaryCue(message) || hasContinueCue(message);
}

function hasArtifactRequestCue(message: string): boolean {
  return /(保存|存成|写成|导出|生成|整理|归档|落盘|下载|产物|报告|文档|markdown|md文件|文件)/i.test(message);
}

function isClearlyLightweightMessage(message: string): boolean {
  const text = message.trim();
  if (!text) return true;
  if (text.length <= 30 && /(谢谢|多谢|好的|可以|收到|明白|了解|ok|OK|嗯|辛苦|今天星期几|现在几点|日期|星期几)/.test(text)) {
    return true;
  }
  if (text.length <= 18 && !/[？?]/.test(text)) return true;
  return false;
}

export function isLikelyNewRoundtableTopic(message: string, currentIssue?: RoundtableIssueStateV1 | null): boolean {
  const text = message.trim();
  if (!text) return false;
  if (/(新议题|下一个议题|另一个议题|换个议题|开启.*圆桌|开始.*圆桌|开.*圆桌|圆桌讨论|大家讨论|大家怎么看|各自观点)/.test(text)) {
    return true;
  }
  if (hasVoteCue(text) || hasSummaryCue(text) || hasContinueCue(text) || hasArtifactRequestCue(text)) return false;
  if (isClearlyLightweightMessage(text)) return false;

  const depthCue =
    /(是否|要不要|能不能|该不该|应不应该|如何|怎么|为什么|评估|比较|取舍|风险|方案|策略|选择|决策|利弊|优先级|规划|结论|判断|分析|复盘|设计|路线|架构|成本|收益)/.test(
      text,
    );
  if (depthCue && text.length >= 24) return true;
  if (!currentIssue && depthCue) return true;
  return false;
}

export function planRoundtableAction(
  message: string,
  participants: readonly CatId[],
  currentIssue: RoundtableIssueStateV1 | null,
): RoundtableActionPlan {
  const mentioned = findMentionedParticipants(message, participants);
  const strictFocusOnly = mentioned.length > 0 && hasStrictFocusCue(message) && !hasCollectiveCue(message);
  if (currentIssue?.status === 'summarized' && hasArtifactRequestCue(message)) {
    return {
      action: 'artifact_request',
      focusCats: mentioned,
      strictFocusOnly,
    };
  }
  if (mentioned.length > 0 && !hasCollectiveCue(message)) {
    return {
      action: 'followup',
      focusCats: mentioned,
      strictFocusOnly,
    };
  }
  if (currentIssue && (hasVoteCue(message) || hasSummaryCue(message))) {
    return { action: 'vote_and_summary', focusCats: [], strictFocusOnly: false };
  }
  if (currentIssue && hasContinueCue(message)) {
    return { action: 'continue_critique', focusCats: [], strictFocusOnly: false };
  }
  if (currentIssue && !isLikelyNewRoundtableTopic(message, currentIssue)) {
    return {
      action: isClearlyLightweightMessage(message) || currentIssue.status === 'summarized' ? 'single_response' : 'followup',
      focusCats: [],
      strictFocusOnly: false,
    };
  }
  if (!currentIssue && !isLikelyNewRoundtableTopic(message, null)) {
    return { action: 'single_response', focusCats: [], strictFocusOnly: false };
  }
  return { action: 'new_deliberation', focusCats: [], strictFocusOnly: false };
}

export function allCritiquesSettled(outputs: ReadonlyMap<string, string>): boolean {
  if (outputs.size === 0) return false;
  return [...outputs.values()].every((text) => {
    const meta = parseCritiqueMeta(text);
    return meta.readyToVote && !meta.blocker && !meta.changed && !meta.newChallenge;
  });
}

function combineCritiqueRoundOutputs(
  participants: readonly CatId[],
  challenges: ReadonlyMap<string, string>,
  responses: ReadonlyMap<string, string>,
): Map<string, string> {
  const combined = new Map<string, string>();
  for (const catId of participants) {
    const challenge = challenges.get(catId) ?? '';
    const response = responses.get(catId) ?? '';
    combined.set(
      catId,
      [
        '## 本轮评价与挑战',
        challenge.trim() || '（本轮未提出明确评价或挑战）',
        '',
        '## 本轮澄清与修订',
        response.trim() || '（本轮未提供明确澄清或修订）',
      ].join('\n'),
    );
  }
  return combined;
}

async function* runCritiqueLoop(
  deps: RouteStrategyDeps,
  participants: CatId[],
  userId: string,
  threadId: string,
  options: RouteOptions,
  state: RoundtableIssueStateV1,
  primaryCat: CatId,
  topic: string,
  stances: ReadonlyMap<string, string>,
  previousCritiques: Map<string, string>[] = [],
): AsyncGenerator<AgentMessage, { state: RoundtableIssueStateV1; critiques: Map<string, string>[] }, void> {
  let nextState = state;
  const critiques = [...previousCritiques];
  const startRound = Math.max(1, state.critiqueRound + 1);
  for (let round = startRound; round <= nextState.maxCritiqueRounds; round++) {
    const challengePhase = await markRoundtablePhase(
      deps,
      threadId,
      primaryCat,
      nextState,
      {
        status: 'open',
        stage: 'critique_loop',
        critiqueStep: 'challenge',
        critiqueRound: round,
      },
      `阶段 2/4 互评循环 ${round}/${nextState.maxCritiqueRounds} · 评价`,
    );
    nextState = challengePhase.state;
    yield challengePhase.message;

    const challenges = yield* runRoundtablePhase(deps, participants, userId, threadId, options, {
      phase: 'critique_challenge',
      prompt: buildCritiqueChallengePrompt(topic, round, nextState.maxCritiqueRounds, stances, critiques),
    });

    const responsePhase = await markRoundtablePhase(
      deps,
      threadId,
      primaryCat,
      nextState,
      {
        status: 'open',
        stage: 'critique_loop',
        critiqueStep: 'response',
        critiqueRound: round,
      },
      `阶段 2/4 互评循环 ${round}/${nextState.maxCritiqueRounds} · 澄清`,
    );
    nextState = responsePhase.state;
    yield responsePhase.message;

    const responses = yield* runRoundtablePhase(deps, participants, userId, threadId, options, {
      phase: 'critique_response',
      prompt: buildCritiqueResponsePrompt(topic, round, nextState.maxCritiqueRounds, stances, critiques, challenges),
    });
    critiques.push(combineCritiqueRoundOutputs(participants, challenges, responses));

    if (allCritiquesSettled(responses)) break;
  }
  return { state: nextState, critiques };
}

async function* runVoteAndSummary(
  deps: RouteStrategyDeps,
  participants: CatId[],
  userId: string,
  threadId: string,
  options: RouteOptions,
  state: RoundtableIssueStateV1,
  primaryCat: CatId,
  topic: string,
  stances: ReadonlyMap<string, string>,
  critiques: readonly Map<string, string>[],
  recentContext?: string,
): AsyncGenerator<AgentMessage, RoundtableIssueStateV1, void> {
  let nextState = state;
  const votePhase = await markRoundtablePhase(
    deps,
    threadId,
    primaryCat,
    nextState,
    {
      status: 'voting',
      stage: 'consensus_vote',
      critiqueStep: undefined,
    },
    '阶段 3/4 共识投票',
  );
  nextState = votePhase.state;
  yield votePhase.message;

  const votes = yield* runRoundtablePhase(deps, participants, userId, threadId, options, {
    phase: 'consensus_vote',
    prompt: buildVotePrompt(topic, stances, critiques, recentContext),
  });

  const summaryPhase = await markRoundtablePhase(
    deps,
    threadId,
    primaryCat,
    nextState,
    {
      status: 'summarized',
      stage: 'final_summary',
      critiqueStep: undefined,
    },
    '阶段 4/4 会议总结',
  );
  nextState = summaryPhase.state;
  yield summaryPhase.message;

  const finalSummary = buildFinalSummary(topic, participants, stances, critiques, votes, recentContext);
  const stored = await Promise.resolve(
    deps.messageStore.append({
      userId: 'system',
      catId: null,
      content: finalSummary,
      mentions: [],
      timestamp: Date.now(),
      threadId,
    }),
  );
  nextState = {
    ...nextState,
    finalSummaryMessageId: stored.id,
    updatedAt: stored.timestamp,
  };
  await persistRoundtableState(deps, threadId, nextState);

  yield {
    type: 'system_info',
    catId: primaryCat,
    content: finalSummary,
    timestamp: stored.timestamp,
    messageId: stored.id,
  };
  return nextState;
}

async function* runFollowup(
  deps: RouteStrategyDeps,
  participants: CatId[],
  message: string,
  userId: string,
  threadId: string,
  options: RouteOptions,
  state: RoundtableIssueStateV1,
  primaryCat: CatId,
  focusCats: CatId[],
  strictFocusOnly: boolean,
): AsyncGenerator<AgentMessage, void, void> {
  const targets = strictFocusOnly ? focusCats : participants;
  const rolePrompts: Record<string, string> = {};
  const focusSet = new Set(focusCats.map(String));
  for (const catId of targets) {
    rolePrompts[String(catId)] = buildRoundtableModeSystemPrompt(
      threadId,
      'followup',
      focusSet.has(String(catId))
        ? 'You are directly named by the user. Clarify your own view first.'
        : 'You are an observer in this follow-up. Only speak when you have substantive correction, challenge, or risk. Otherwise reply exactly: NO_COMMENT',
    );
  }

  const marked = await markRoundtablePhase(
    deps,
    threadId,
    primaryCat,
    state,
    {
      status: state.status,
      stage: state.stage,
    },
    strictFocusOnly ? '点名追问' : '点名追问与有限旁听',
  );
  yield marked.message;

  const recentContext = await getRecentRoundtableContext(deps, threadId, userId);
  const observerCats = targets.filter((catId) => !focusSet.has(String(catId)));
  const followupOptions: RouteOptions =
    observerCats.length > 0
      ? {
          ...options,
          bufferTextUntilDoneForCats: observerCats,
          suppressTextPredicate: ({ catId, content }) => !focusSet.has(String(catId)) && isNoCommentOutput(content),
        }
      : options;
  yield* runRoundtablePhase(deps, targets, userId, threadId, followupOptions, {
    phase: 'followup',
    prompt: buildFollowupPrompt(state.topic, message, participants, focusCats, recentContext),
    modeSystemPromptByCat: rolePrompts,
  });
}

async function* runSingleResponse(
  deps: RouteStrategyDeps,
  primaryCat: CatId,
  message: string,
  userId: string,
  threadId: string,
  options: RouteOptions,
  state: RoundtableIssueStateV1 | null,
): AsyncGenerator<AgentMessage, void, void> {
  const recentContext = state ? await getRecentRoundtableContext(deps, threadId, userId, 24) : '';
  yield* runRoundtablePhase(deps, [primaryCat], userId, threadId, options, {
    phase: 'single_response',
    prompt: buildSingleResponsePrompt(state?.topic ?? null, message, recentContext),
  });
}

async function* runArtifactRequest(
  deps: RouteStrategyDeps,
  message: string,
  userId: string,
  threadId: string,
  options: RouteOptions,
  state: RoundtableIssueStateV1,
  primaryCat: CatId,
  focusCats: CatId[],
): AsyncGenerator<AgentMessage, void, void> {
  const reportsDir = resolveThreadArtifactPaths(threadId).reportsDir;
  const targets = focusCats.length > 0 ? [focusCats[0] as CatId] : [primaryCat];
  const marked = await markRoundtablePhase(
    deps,
    threadId,
    primaryCat,
    state,
    {
      status: state.status,
      stage: state.stage,
      critiqueStep: undefined,
    },
    `会后产物保存（${targets.map(catLabel).join('、')}）`,
  );
  yield marked.message;

  const recentContext = await getRecentRoundtableContext(deps, threadId, userId);
  yield* runRoundtablePhase(deps, targets, userId, threadId, options, {
    phase: 'artifact_save',
    prompt: buildArtifactSavePrompt(state.topic, message, reportsDir, recentContext),
    allowArtifactWrites: true,
    reportsDir,
  });
}

export async function* routeRoundtable(
  deps: RouteStrategyDeps,
  targetCats: CatId[],
  message: string,
  userId: string,
  threadId: string,
  options: RouteOptions = {},
): AsyncGenerator<AgentMessage, void, void> {
  const primaryCat = targetCats[0];
  if (!primaryCat) return;

  const participants = targetCats;
  const currentIssue = await getCurrentIssueState(deps, threadId);
  const actionPlan = planRoundtableAction(message, participants, currentIssue);

  if (actionPlan.action === 'single_response') {
    yield* runSingleResponse(deps, primaryCat, message, userId, threadId, options, currentIssue);
    return;
  }

  if (actionPlan.action === 'artifact_request' && currentIssue) {
    yield* runArtifactRequest(
      deps,
      message,
      userId,
      threadId,
      options,
      currentIssue,
      primaryCat,
      actionPlan.focusCats,
    );
    return;
  }

  if (actionPlan.action === 'followup') {
    const followupState = currentIssue ?? buildIssueState(threadId, truncateText(message, 2400), participants, null);
    yield* runFollowup(
      deps,
      participants,
      message,
      userId,
      threadId,
      options,
      followupState,
      primaryCat,
      actionPlan.focusCats,
      actionPlan.strictFocusOnly,
    );
    return;
  }

  const topic =
    actionPlan.action === 'new_deliberation' || !currentIssue
      ? truncateText(message, 2400)
      : truncateText(currentIssue.topic, 2400);
  let state = buildIssueState(
    threadId,
    topic,
    participants,
    actionPlan.action === 'new_deliberation' ? null : currentIssue,
  );
  let stances = new Map<string, string>();
  let critiques: Map<string, string>[] = [];
  let recentContext = '';

  if (actionPlan.action === 'new_deliberation' || !currentIssue) {
    const stancePhase = await markRoundtablePhase(
      deps,
      threadId,
      primaryCat,
      state,
      {
        status: 'open',
        stage: 'independent_stance',
        critiqueStep: undefined,
        critiqueRound: 0,
      },
      '阶段 1/4 独立立场',
    );
    state = stancePhase.state;
    yield stancePhase.message;

    stances = yield* runRoundtablePhase(deps, participants, userId, threadId, options, {
      phase: 'independent_stance',
      prompt: buildIndependentStancePrompt(topic, participants),
    });

    const critiqueResult = yield* runCritiqueLoop(
      deps,
      participants,
      userId,
      threadId,
      options,
      state,
      primaryCat,
      topic,
      stances,
    );
    state = critiqueResult.state;
    critiques = critiqueResult.critiques;
  } else {
    recentContext = await getRecentRoundtableContext(deps, threadId, userId);
    stances = new Map([['history', recentContext || '（从历史消息继续推进，未复制完整会议内容到状态存储。）']]);
    if (actionPlan.action === 'continue_critique') {
      const critiqueResult = yield* runCritiqueLoop(
        deps,
        participants,
        userId,
        threadId,
        options,
        state,
        primaryCat,
        topic,
        stances,
      );
      state = critiqueResult.state;
      critiques = critiqueResult.critiques;
    }
  }

  yield* runVoteAndSummary(
    deps,
    participants,
    userId,
    threadId,
    options,
    state,
    primaryCat,
    topic,
    stances,
    critiques,
    recentContext,
  );
}
