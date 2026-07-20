'use client';

import type { CSSProperties } from 'react';
import { type CatData, formatCatName } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useTts } from '@/hooks/useTts';
import { catColorVar, catSlug } from '@/lib/cat-slug';
import { CO_CREATOR_COLOR } from '@/lib/color-defaults';
import { hexToOklch } from '@/lib/color-utils';
import { getMentionRe, getMentionToCat } from '@/lib/mention-highlight';
import { parseDirection } from '@/lib/parse-direction';
import { type ChatMessage as ChatMessageType, resolveBubbleExpanded, useChatStore } from '@/stores/chatStore';
import { setPendingCrossPostScroll } from '@/utils/crosspost-scroll-target';
import { CatAvatar } from './CatAvatar';
import { CliDiagnosticsPanel, isKnownReason } from './CliDiagnosticsPanel';
import { CollapsibleMarkdown } from './CollapsibleMarkdown';
import { ConnectorBubble } from './ConnectorBubble';
import { ContentBlocks } from './ContentBlocks';
import { CopyIdButton } from './CopyIdButton';
import { CliOutputBlock } from './cli-output/CliOutputBlock';
import { toCliEvents } from './cli-output/toCliEvents';
import { DirectionPill } from './DirectionPill';
import { EvidencePanel } from './EvidencePanel';
import { GovernanceBlockedCard } from './GovernanceBlockedCard';
import { MarkdownContent } from './MarkdownContent';
import { MessageBubble } from './MessageBubble';
import { MetadataBadge } from './MetadataBadge';
import { ReplyPill } from './ReplyPill';
import { BriefingCard } from './rich/BriefingCard';
import { RichBlocks } from './rich/RichBlocks';
import { SummaryCard } from './SummaryCard';
import { SystemNoticeBar } from './SystemNoticeBar';
import { ThinkingContent } from './ThinkingContent';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { TimeoutDiagnosticsPanel } from './TimeoutDiagnosticsPanel';
import { TtsPlayButton } from './TtsPlayButton';

const BREED_STYLES: Record<string, { radius: string; font?: string }> = {
  ragdoll: { radius: 'rounded-2xl rounded-bl-sm' },
  'maine-coon': { radius: 'rounded-2xl rounded-br-sm', font: 'font-mono' },
  siamese: { radius: 'rounded-2xl rounded-tr-sm' },
  'dragon-li': { radius: 'rounded-lg rounded-tl-sm', font: 'font-mono' },
};
const DEFAULT_BREED_STYLE = { radius: 'rounded-2xl' };

/* catSlug helper moved to '@/lib/cat-slug' so other components can share it. */
const SCHEDULER_ACCENT_BADGE_CLASS =
  'inline-flex w-fit items-center gap-1.5 rounded-full border border-conn-amber-ring bg-conn-amber-bg px-2.5 py-1 text-xs font-semibold text-conn-amber-text shadow-sm';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const DELIVERED_AT_GAP_THRESHOLD = 5000;
function formatDualTime(timestamp: number, deliveredAt?: number): string {
  if (!deliveredAt || deliveredAt - timestamp <= DELIVERED_AT_GAP_THRESHOLD) {
    return formatTime(timestamp);
  }
  return `发送 ${formatTime(timestamp)} · 收到 ${formatTime(deliveredAt)}`;
}

function isSchedulerReplyPreview(replyPreview?: ChatMessageType['replyPreview']): boolean {
  return replyPreview?.senderCatId === 'system' && replyPreview.kind === 'scheduler_trigger';
}

function isConnectorSystemNotice(message: ChatMessageType): boolean {
  if (message.type !== 'connector' || !message.source?.meta) return false;
  return (message.source.meta as Record<string, unknown>).presentation === 'system_notice';
}

interface RoundtableSection {
  title: string;
  body: string;
}

interface RoundtableParsedContent {
  meta: string[];
  prelude: string;
  sections: RoundtableSection[];
}

type RoundtableSectionRole = 'claim' | 'reasoning' | 'challenge' | 'vote' | 'risk' | 'next' | 'neutral';
type RoundtableControlKey = 'CHANGE' | 'NEW_CHALLENGE' | 'READY_TO_VOTE' | 'BLOCKER' | 'VOTE';

const ROUNDTABLE_CONTROL_KEYS: readonly RoundtableControlKey[] = [
  'CHANGE',
  'NEW_CHALLENGE',
  'READY_TO_VOTE',
  'BLOCKER',
  'VOTE',
];

export function roundtableSectionRole(title: string): RoundtableSectionRole {
  if (/(立场|结论|讨论结果|多数|共识|采纳|当前判断)/.test(title)) return 'claim';
  if (/(挑战|反对|分歧|阻塞|保留|条件|少数)/.test(title)) return 'challenge';
  if (/(投票|票型|表决)/.test(title)) return 'vote';
  if (/(风险|不确定|证据|数据|事实)/.test(title)) return 'risk';
  if (/(下一步|后续|注意|建议)/.test(title)) return 'next';
  if (/(理由|解释|回应|接受|修订|判断)/.test(title)) return 'reasoning';
  return 'neutral';
}

function roundtableControlKeyFromLabel(label: string): RoundtableControlKey | null {
  const normalized = label.trim().replace(/\s+/g, '').toUpperCase();
  if ((ROUNDTABLE_CONTROL_KEYS as readonly string[]).includes(normalized)) return normalized as RoundtableControlKey;
  if (/^(立场|判断|当前立场|当前判断).*(变化|改变|修订)$/.test(label)) return 'CHANGE';
  if (/^新(的)?挑战$/.test(label)) return 'NEW_CHALLENGE';
  if (/^(准备投票|可进入投票|是否准备投票)$/.test(label)) return 'READY_TO_VOTE';
  if (/^(阻塞|仍有阻塞|仍有阻碍|关键阻塞)$/.test(label)) return 'BLOCKER';
  if (/^(投票|票型|表决)$/.test(label)) return 'VOTE';
  return null;
}

function normalizeRoundtableControlValue(key: RoundtableControlKey, value: string): string {
  const normalized = value.trim().toLowerCase();
  if (key === 'VOTE') return normalized || value.trim();
  if (/^(yes|y|true|1|是|有|已|变化|改变|修订|可|可以|准备好)(?:\b|$)/.test(normalized)) return 'yes';
  if (/^(no|n|false|0|否|无|没有|不|未|无需|不变|保持)(?:\b|$)/.test(normalized)) return 'no';
  if (/(可以|准备好|进入投票|有阻塞|有挑战|改变|修订)/.test(value)) return 'yes';
  if (/(没有|无|不变|保持|不需要|不进入|不能|不可以)/.test(value)) return 'no';
  return value.trim();
}

function normalizeRoundtableControlLine(line: string): string | null {
  const match = /^\s*([^:：]{1,32})\s*[:：]\s*(.+?)\s*$/.exec(line);
  if (!match) return null;
  const key = roundtableControlKeyFromLabel(match[1] ?? '');
  if (!key) return null;
  return `${key}: ${normalizeRoundtableControlValue(key, match[2] ?? '')}`;
}

function roundtableMetaKey(line: string): RoundtableControlKey | null {
  const match = /^\s*([A-Z_]+)\s*:/i.exec(line);
  if (!match) return null;
  const key = match[1]?.toUpperCase();
  return (ROUNDTABLE_CONTROL_KEYS as readonly string[]).includes(key ?? '') ? (key as RoundtableControlKey) : null;
}

function inferRoundtableResponseMeta(text: string, existingMeta: readonly string[]): string[] {
  const existingKeys = new Set(
    existingMeta.map(roundtableMetaKey).filter((key): key is RoundtableControlKey => key != null),
  );
  const looksLikeResponse =
    /(立场修订|立场保持|当前立场是否变化|我接受的论点|我仍然反对|对.+回应|可以进入投票|准备投票|仍未消除|新的挑战)/.test(
      text,
    );
  if (!looksLikeResponse) return [];

  const inferred: string[] = [];
  if (!existingKeys.has('CHANGE')) {
    if (/(立场修订|我修正|修订后的|改变了?我的|调整为|接受.*(?:修订|修正)|部分接受)/.test(text)) {
      inferred.push('CHANGE: yes');
    } else if (/(立场保持|维持.*立场|立场不变|无变化|没有改变|我维持|仍支持|仍坚持)/.test(text)) {
      inferred.push('CHANGE: no');
    }
  }
  if (!existingKeys.has('NEW_CHALLENGE')) {
    if (
      /(^|\n)\s*(?:[-*]\s*)?(?:#{2,4}\s*)?(?:\*\*)?新的?挑战(?:\*\*)?\s*[:：]?|我(?:仍然)?(?:要|会)?挑战|继续挑战|新的实质挑战/.test(
        text,
      )
    ) {
      inferred.push('NEW_CHALLENGE: yes');
    } else if (/(无新的?挑战|没有新的?挑战|不再提出新的?挑战)/.test(text)) {
      inferred.push('NEW_CHALLENGE: no');
    }
  }
  if (!existingKeys.has('READY_TO_VOTE')) {
    if (/(可以进入投票|可进入投票|准备投票|可以投票|足够收束|进入投票)/.test(text)) {
      inferred.push('READY_TO_VOTE: yes');
    } else if (/(不(?:能|宜|建议).*投票|还不能投票|不进入投票|不要.*投票)/.test(text)) {
      inferred.push('READY_TO_VOTE: no');
    }
  }
  if (!existingKeys.has('BLOCKER')) {
    if (/(仍未消除|仍有.*不确定|关键分歧|证据不足|缺少证据|未解决|阻塞|保留分歧|不确定性)/.test(text)) {
      inferred.push('BLOCKER: yes');
    } else if (/(无阻塞|没有阻塞|无关键分歧|可以进入投票|可以投票)/.test(text)) {
      inferred.push('BLOCKER: no');
    }
  }
  return inferred;
}

function parseRoundtableSectionHeading(line: string): { title: string; rest: string } | null {
  const heading = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
  if (heading) return { title: heading[2]?.trim() ?? '', rest: '' };

  const boldLabel = /^\s*(?:[-*]\s*)?\*\*(.{1,48}?)\*\*\s*[:：]\s*(.*?)\s*$/.exec(line);
  if (!boldLabel) return null;
  const title = boldLabel[1]?.trim() ?? '';
  if (!title || /[。！？.!?]$/.test(title)) return null;
  return { title, rest: boldLabel[2]?.trim() ?? '' };
}

function roundtableSectionClasses(role: RoundtableSectionRole): string {
  if (role === 'claim') {
    return 'rounded-md border border-cafe bg-cafe-surface-sunken px-3 py-2 shadow-inner';
  }
  if (role === 'challenge') {
    return 'rounded-r-md border-l-4 border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)]/45 px-3 py-2';
  }
  if (role === 'vote') {
    return 'rounded-r-md border-l-4 border-[var(--semantic-info)] bg-[var(--semantic-info-surface)]/45 px-3 py-2';
  }
  if (role === 'risk') {
    return 'rounded-r-md border-l-4 border-conn-amber-ring bg-conn-amber-bg/45 px-3 py-2';
  }
  return 'rounded-r-md border-l-4 border-cafe bg-cafe-surface-sunken/45 px-3 py-2';
}

function roundtableSectionTitleClasses(role: RoundtableSectionRole): string {
  if (role === 'challenge' || role === 'risk') return 'text-[11px] font-semibold text-conn-amber-text';
  if (role === 'vote') return 'text-[11px] font-semibold text-[var(--semantic-info)]';
  if (role === 'claim') return 'text-[11px] font-semibold text-cafe-secondary';
  return 'text-[11px] font-semibold text-cafe-muted';
}

export function parseRoundtableContent(content: string): RoundtableParsedContent | null {
  const lines = content.trim().split(/\r?\n/);
  const meta: string[] = [];
  const bodyLines: string[] = [];
  for (const line of lines) {
    const normalizedControl = normalizeRoundtableControlLine(line);
    if (normalizedControl) meta.push(normalizedControl);
    else bodyLines.push(line);
  }
  const bodyText = bodyLines.join('\n');
  meta.push(...inferRoundtableResponseMeta(bodyText, meta));

  const sections: RoundtableSection[] = [];
  const prelude: string[] = [];
  let current: RoundtableSection | null = null;
  for (const line of bodyLines) {
    const heading = parseRoundtableSectionHeading(line);
    if (heading) {
      if (current) sections.push({ ...current, body: current.body.trim() });
      current = { title: heading.title, body: heading.rest ? `${heading.rest}\n` : '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
    else prelude.push(line);
  }
  if (current) sections.push({ ...current, body: current.body.trim() });

  const meaningfulSections = sections.filter((section) => section.title && section.body);
  if (meta.length === 0 && meaningfulSections.length < 2) return null;
  return {
    meta,
    prelude: prelude.join('\n').trim(),
    sections: meaningfulSections,
  };
}

export function roundtableMetaLabel(line: string): string {
  const match = /^\s*([A-Z_]+)\s*:\s*(.+?)\s*$/i.exec(line);
  if (!match) return line;
  const key = match[1]?.toUpperCase();
  const value = match[2] ?? '';
  if (key === 'CHANGE') return `立场变化: ${value}`;
  if (key === 'NEW_CHALLENGE') return `新挑战: ${value}`;
  if (key === 'READY_TO_VOTE') return `准备投票: ${value}`;
  if (key === 'BLOCKER') return `仍有阻塞: ${value}`;
  if (key === 'VOTE') return `投票: ${value}`;
  return `${key}: ${value}`;
}

function RoundtableMessageContent({
  content,
  className,
  artifactThreadId,
}: {
  content: string;
  className?: string;
  artifactThreadId?: string;
}) {
  const parsed = parseRoundtableContent(content);
  if (!parsed) {
    return <CollapsibleMarkdown content={content} className={className} artifactThreadId={artifactThreadId} />;
  }

  return (
    <div className={`space-y-2.5 ${className ?? ''}`}>
      {parsed.meta.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {parsed.meta.map((line, index) => (
            <span
              key={`${line}-${index}`}
              className="rounded-md border border-cafe bg-cafe-surface-sunken/60 px-2 py-0.5 text-[11px] font-medium text-cafe-secondary"
            >
              {roundtableMetaLabel(line)}
            </span>
          ))}
        </div>
      )}
      {parsed.prelude && (
        <div className="rounded-r-md border-l-4 border-cafe bg-cafe-surface-sunken/45 px-3 py-2">
          <MarkdownContent content={parsed.prelude} className="!text-xs" disableCommandPrefix artifactThreadId={artifactThreadId} />
        </div>
      )}
      <div className="space-y-2">
        {parsed.sections.map((section, index) => {
          const role = roundtableSectionRole(section.title);
          return (
            <section key={`${section.title}-${index}`} className={roundtableSectionClasses(role)}>
              <div className={`${roundtableSectionTitleClasses(role)} mb-1.5 tracking-normal`}>{section.title}</div>
              <MarkdownContent
                content={section.body}
                className="!text-xs leading-relaxed"
                disableCommandPrefix
                artifactThreadId={artifactThreadId}
              />
            </section>
          );
        })}
      </div>
    </div>
  );
}

interface ChatMessageProps {
  message: ChatMessageType;
  threadId?: string;
  getCatById: (id: string) => CatData | undefined;
  onEditCat?: (catId: string) => void;
  /** F056 follow-up: click co-creator avatar to open editor (consistent with cat avatar behavior). */
  onEditCoCreator?: () => void;
  /** F212 follow-up — UI-layer dedup for adjacent identical CliDiagnostics panels.
   *  When true, this message hides its CliDiagnosticsPanel entirely (an earlier adjacent
   *  message in the same dedup group already rendered the panel with a "×N" badge). The
   *  chat bubble itself, cat signature, and other content still render normally so the
   *  message audit trail stays intact. Computed at the message-list level via
   *  `utils/cli-diagnostics-dedup`. */
  hideDiagnosticsPanel?: boolean;
  /** F212 follow-up — when this is the head of a dedup group, the group's total size
   *  (head + N hidden subsequent duplicates). Passed through to CliDiagnosticsPanel for
   *  the "×N" badge rendering. */
  dedupCount?: number;
}

export function ChatMessage({
  message,
  threadId,
  getCatById,
  onEditCat,
  onEditCoCreator,
  hideDiagnosticsPanel,
  dedupCount,
}: ChatMessageProps) {
  const coCreator = useCoCreatorConfig();
  const { state: ttsState, synthesize: ttsSynthesize, activeMessageId } = useTts();
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const artifactThreadId = threadId ?? currentThreadId;
  const isLoadingThreads = useChatStore((s) => s.isLoadingThreads);
  const threads = useChatStore((s) => s.threads);
  const threadMessages = useChatStore((s) => s.messages);
  const globalBubbleDefaults = useChatStore((s) => s.globalBubbleDefaults);
  const isUser = message.type === 'user' && !message.catId;
  const isSystem = message.type === 'system';
  const isSummary = message.type === 'summary';
  const isConnector = message.type === 'connector';

  const catData = message.catId ? getCatById(message.catId) : undefined;
  const catStyle = catData
    ? (() => {
        const breed = BREED_STYLES[catData.breedId ?? ''] ?? DEFAULT_BREED_STYLE;
        const label = formatCatName(catData);
        const isCallback = message.origin === 'callback';
        /* F056: Route bubble background through CSS vars so the OKLCH Tuner
         * (which writes --color-{slug}-surface) actually controls bubble color.
         * Previously bgColor was catData.color.secondary (raw catalog hex),
         * which bypassed the F056 token system entirely. */
        const slug = catSlug(catData.id);
        /* F056: Compute msg-hue/-chroma for .cat-persona-derived class so the
         * outer message wrapper provides --cat-msg-{bubble,surface,inset,...}
         * tokens used by nested ThinkingContent/CliOutputBlock. Without this,
         * those nested blocks render with --cat-msg-inset undefined → transparent. */
        let msgHue = 297; // fallback
        let msgChroma = 0.1;
        try {
          const oklch = hexToOklch(catData.color.primary);
          if (Number.isFinite(oklch.h) && Number.isFinite(oklch.c)) {
            msgHue = oklch.h;
            msgChroma = oklch.c;
          }
        } catch {
          /* fallback values already set */
        }
        return {
          label,
          radius: breed.radius,
          font: breed.font,
          /* F056 (co-creator 2026-05-28): post_message callback bubbles use the
           * SAME --color-{slug}-surface as normal bubbles. Previously isCallback
           * branched to tintedLight(hex, 0.08) — a hex-derived value that
           * bypassed the F056 token chain, so callback bubbles didn't follow
           * Tuner. Unified now: per-cat slug-keyed token drives both kinds. */
          bgColor: `var(--color-${slug}-surface)`,
          /* F056: cat name text color driven by Tuner's catText H/L/C slider.
           * This goes on the name span; message body text uses --cat-msg-text
           * (the msgText slider) via inline style on the bubble div instead. */
          textColor: catColorVar(catData.id, 'text'),
          /* F056: borderColor also routed through token via color-mix so Tuner
           * gradient propagates to bubble outline as well. Uses --color-{slug}-
           * ring (the existing ring tier already follows --cat-ring-l/cmul). */
          borderColor: isCallback
            ? `color-mix(in srgb, ${catColorVar(catData.id, 'ring')} 12%, transparent)`
            : `color-mix(in srgb, ${catColorVar(catData.id, 'ring')} 30%, transparent)`,
          msgHue,
          msgChroma,
        };
      })()
    : null;
  const currentThread = useChatStore((s) => s.threads.find((t) => t.id === s.currentThreadId));
  const isRoundtableThread = currentThread?.mode === 'roundtable';
  const bubbleRestorePending = isLoadingThreads && !!currentThreadId && !currentThread;
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const hasTextContent = message.content.trim().length > 0;
  const isWhisper = message.visibility === 'whisper';
  const isRevealed = isWhisper && !!message.revealedAt;
  const isSchedulerReply = isSchedulerReplyPreview(message.replyPreview);
  const showSchedulerAccent =
    isSchedulerReply &&
    !threadMessages.some((candidate) => {
      if (candidate.id === message.id) return false;
      if (candidate.replyTo !== message.replyTo) return false;
      if (candidate.catId !== message.catId) return false;
      if (!isSchedulerReplyPreview(candidate.replyPreview)) return false;
      if (candidate.timestamp !== message.timestamp) {
        return candidate.timestamp < message.timestamp;
      }
      return candidate.id < message.id;
    });

  const direction = catData ? parseDirection(message, () => ({ toCat: getMentionToCat(), re: getMentionRe() })) : null;

  const isStreamOrigin = message.origin === 'stream';
  // F194 Phase Z11 follow-up: ordinary post_msg speech is projected as a
  // separate callback bubble, but exact-key callback_final records can still
  // merge into the stream bubble as terminal updates. Projection exposes the
  // origin-split portions on extra.stream so CLI Output keeps the stream
  // working log while the callback terminal text renders as the body.
  const mergedCliStdout = message.extra?.stream?.cliStdout;
  const mergedSpeechContent = message.extra?.stream?.speechContent;
  const renderRoundtableBody = isRoundtableThread && hasTextContent;
  const cliStdoutContent = renderRoundtableBody ? undefined : (mergedCliStdout ?? (isStreamOrigin ? message.content : undefined));
  const cliEvents = toCliEvents(message.toolEvents, cliStdoutContent);
  const hasCliBlock = cliEvents.length > 0;
  const cliStatus = message.isStreaming
    ? ('streaming' as const)
    : message.variant === 'error'
      ? ('failed' as const)
      : ('done' as const);
  if (isSummary && message.summary) {
    return (
      <div data-message-id={message.id}>
        <SummaryCard
          topic={message.summary.topic}
          conclusions={message.summary.conclusions}
          openQuestions={message.summary.openQuestions}
          createdBy={message.summary.createdBy}
          timestamp={message.timestamp}
        />
      </div>
    );
  }

  if (isSystem) {
    // F148 context briefing is internal routing context for cats — suppress from user timeline.
    // Defense-in-depth: stream/socket/API all filter these, but if one leaks through, hide here.
    // Note: F233 duty briefing also uses origin='briefing' but lacks systemKind='context_briefing',
    // so it renders normally via the BriefingCard path below.
    if (message.extra?.systemKind === 'context_briefing') {
      return null;
    }

    // F233 duty briefing + other user-visible briefing cards (origin='briefing' without systemKind marker)
    if (message.origin === 'briefing' && message.extra?.rich?.blocks?.length) {
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full opacity-80">
            <BriefingCard block={message.extra.rich.blocks[0]} messageId={message.id} />
          </div>
        </div>
      );
    }

    if (message.variant === 'evidence' && message.evidence) {
      return <EvidencePanel data={message.evidence} />;
    }

    if (message.variant === 'governance_blocked' && message.extra?.governanceBlocked) {
      const { projectPath, reasonKind, invocationId } = message.extra.governanceBlocked;
      return <GovernanceBlockedCard projectPath={projectPath} reasonKind={reasonKind} invocationId={invocationId} />;
    }

    // F045: variant='thinking' is deprecated — thinking is now embedded in assistant bubbles.

    const isLegacyError = !message.variant && message.content.trim().startsWith('Error:');
    const isError = message.variant === 'error' || isLegacyError;
    const canRenderCliDiagnostics = isError || (message.type === 'system' && Boolean(message.extra?.cliDiagnostics));
    const isTool = message.variant === 'tool';
    const isFollowup = message.variant === 'a2a_followup';
    const isRoundtableSummary = isRoundtableThread && message.content.trimStart().startsWith('# 圆桌会议总结');

    // F212 Phase B routing precedence (砚砚 P1-1 + 云端 codex P2-3, 2026-05-27):
    //   1. Classified CLI error (reasonCode in REASON_PALETTE) → CLI panel
    //   2. Timeout with no recognized classification → timeout panel
    //      (preserves F118 silence/processAlive; covers unknown-reason persisted payloads too)
    //   3. Unclassified CLI error, no timeout → CLI panel unknown-icon fallback
    // The `isKnownReason` membership check (not truthy) is the key defense against
    // persisted/newer/malformed reasonCode strings hijacking the timeout view.
    if (canRenderCliDiagnostics && isKnownReason(message.extra?.cliDiagnostics?.reasonCode)) {
      // F212 follow-up — UI-layer dedup: if this is a subsequent duplicate of an adjacent
      // dedup group, hide the panel (group head already rendered it with a ×N badge). We
      // still render an empty wrapping div with data-message-id so MessageNavigator dots,
      // ReplyPill jumps, and scrollToMessage queries continue to resolve the anchor —
      // dropping the wrapper would silently break navigation/audit trail for the hidden
      // duplicates (codex review PR #1967 P2 catch). h-0 keeps the anchor at zero visual
      // cost; the group head's panel right above carries all the info via ×N badge.
      if (hideDiagnosticsPanel) return <div data-message-id={message.id} aria-hidden="true" className="h-0" />;
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full">
            <CliDiagnosticsPanel
              errorMessage={message.content}
              diagnostics={message.extra.cliDiagnostics}
              dedupCount={dedupCount}
            />
          </div>
        </div>
      );
    }

    // F118 AC-C3: Enhanced timeout diagnostics panel (precedence step 2)
    if (isError && message.extra?.timeoutDiagnostics) {
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full">
            <TimeoutDiagnosticsPanel errorMessage={message.content} diagnostics={message.extra.timeoutDiagnostics} />
          </div>
        </div>
      );
    }

    // F212 Phase B precedence step 3: unclassified cliDiagnostics with no timeout.
    if (canRenderCliDiagnostics && message.extra?.cliDiagnostics) {
      // F212 follow-up — UI-layer dedup (mirrors the classified-path branch above):
      // preserve data-message-id anchor so navigation/scroll targets resolve.
      if (hideDiagnosticsPanel) return <div data-message-id={message.id} aria-hidden="true" className="h-0" />;
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full">
            <CliDiagnosticsPanel
              errorMessage={message.content}
              diagnostics={message.extra.cliDiagnostics}
              dedupCount={dedupCount}
            />
          </div>
        </div>
      );
    }

    if (message.extra?.systemKind === 'upgrade_background' || isRoundtableSummary) {
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full rounded-lg border border-cafe-border bg-cafe-surface px-4 py-3 text-left shadow-sm">
            <MarkdownContent content={message.content} disableCommandPrefix artifactThreadId={artifactThreadId} />
          </div>
        </div>
      );
    }

    const toneClass = isTool
      ? 'text-cafe-muted bg-cafe-surface-elevated/50 font-mono text-xs py-1'
      : isFollowup
        ? 'text-[var(--color-cafe-accent)] bg-[var(--accent-50)] border border-purple-200'
        : isError
          ? 'text-conn-red-text bg-conn-red-bg rounded-full'
          : 'text-[var(--semantic-info)] bg-conn-blue-bg';
    return (
      <div data-message-id={message.id} className={`flex justify-center ${isTool ? 'mb-1' : 'mb-3'}`}>
        <div className={`text-sm px-4 py-2 rounded-lg whitespace-pre-wrap text-left max-w-[85%] ${toneClass}`}>
          {isFollowup && <span className="mr-1">🔗</span>}
          {message.content}
          {isFollowup && (
            <span className="block mt-1 text-xs text-[var(--color-cocreator-primary)]">
              输入 @猫名 跟进 来发起 follow-up
            </span>
          )}
        </div>
      </div>
    );
  }

  if (isConnector && message.source) {
    if (isConnectorSystemNotice(message)) {
      return <SystemNoticeBar message={message} />;
    }
    return <ConnectorBubble message={message} threadId={artifactThreadId} />;
  }

  if (isUser) {
    const coCreatorPrimary = coCreator.color?.primary ?? CO_CREATOR_COLOR.primary;
    /* F056: cocreator slug-keyed (cocreator is in SLUGS, has its own per-cat
     * --color-cocreator-surface in cat-persona-tokens.css that follows the
     * shared --cat-surface-l/cmul gradient — same Tuner control surface as
     * other cats, but cocreator keeps its own hue/chroma). */
    const coCreatorBubbleBg = 'var(--color-cocreator-surface)';
    /* F056: cocreator bubble text uses the same --cat-msg-text as cat bubbles,
     * so the "消息文字" Tuner slider controls ALL message body text uniformly.
     * --color-cocreator-text (from catTxt/catText slider) is reserved for the
     * cocreator name span, not the message body. */
    const coCreatorBubbleText = 'var(--cat-msg-text)';
    /* F056: also wire cocreator hue/chroma to --msg-* so .cat-persona-derived
     * provides --cat-msg-{inset,inset-text} for nested ThinkingContent etc. */
    let coCreatorMsgHue = 40;
    let coCreatorMsgChroma = 0.13;
    try {
      const oklch = hexToOklch(coCreatorPrimary);
      if (Number.isFinite(oklch.h) && Number.isFinite(oklch.c)) {
        coCreatorMsgHue = oklch.h;
        coCreatorMsgChroma = oklch.c;
      }
    } catch {
      /* fallback values already set */
    }
    const userAvatar = (
      <button
        type="button"
        onClick={onEditCoCreator}
        className={`w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ring-2 flex items-center justify-center text-xs font-bold text-[var(--cafe-surface)] ${onEditCoCreator ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
        style={{
          backgroundColor: 'var(--color-cocreator-primary)',
          boxShadow: '0 0 0 2px var(--color-cocreator-surface)',
        }}
        aria-label={`编辑 ${coCreator.name}`}
      >
        {coCreator.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coCreator.avatar}
            alt={coCreator.name}
            width={32}
            height={32}
            className="object-cover w-full h-full"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          'ME'
        )}
      </button>
    );

    const userHeader = (
      <div className="flex justify-end items-center gap-2 mb-1">
        {isWhisper && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-semantic-warning-surface text-semantic-warning'}`}
          >
            {isRevealed ? '已揭秘' : `悄悄话 → ${message.whisperTo?.join(', ') ?? ''}`}
          </span>
        )}
        {message.replyTo && message.replyPreview && !isSchedulerReply && (
          <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
        )}
        <span className="text-xs text-cafe-muted">{formatDualTime(message.timestamp, message.deliveredAt)}</span>
        <CopyIdButton messageId={message.id} />
        <span className="text-xs font-semibold" style={{ color: 'var(--color-cocreator-primary)' }}>
          {coCreator.name}
        </span>
      </div>
    );

    const whisperActive = isWhisper && !isRevealed;

    return (
      <MessageBubble
        messageId={message.id}
        align="right"
        avatar={userAvatar}
        header={userHeader}
        wrapperClassName="group cat-persona-derived"
        wrapperStyle={{ '--msg-hue': coCreatorMsgHue, '--msg-chroma': coCreatorMsgChroma } as CSSProperties}
        bubbleRadius="rounded-2xl rounded-br-sm"
        bubbleClassName={
          whisperActive
            ? 'bg-semantic-warning-surface text-semantic-warning border border-dashed border-semantic-warning'
            : ''
        }
        bubbleStyle={!whisperActive ? { backgroundColor: coCreatorBubbleBg, color: coCreatorBubbleText } : undefined}
      >
        {hasBlocks ? (
          <ContentBlocks blocks={message.contentBlocks!} artifactThreadId={artifactThreadId} />
        ) : (
          <CollapsibleMarkdown content={message.content} artifactThreadId={artifactThreadId} />
        )}
      </MessageBubble>
    );
  }

  // Don't render completely empty non-streaming assistant messages.
  // This can happen when a cat responds with only internal tool use and no text output.
  // Keep messages that have thinking content — they should still show as collapsible bubbles.
  if (
    !message.isStreaming &&
    !hasTextContent &&
    !hasCliBlock &&
    !hasBlocks &&
    !message.extra?.rich?.blocks?.length &&
    !message.extra?.crossPost &&
    !message.thinking
  ) {
    return null;
  }

  /* ── Cat (assistant) header ── */
  const catHeader = catStyle ? (
    <div className="mb-1 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs font-semibold" style={{ color: catStyle.textColor, opacity: 0.8 }}>
          {catStyle.label}
        </span>
        <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
        <CopyIdButton messageId={message.id} />
        {isWhisper && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-semantic-warning-surface text-semantic-warning'}`}
          >
            {isRevealed
              ? '已揭秘'
              : `悄悄话 → ${
                  message.whisperTo
                    ?.map((id) => {
                      const cat = getCatById(id);
                      return cat ? cat.displayName : id;
                    })
                    .join(', ') ?? ''
                }`}
          </span>
        )}
        {!isWhisper && direction && <DirectionPill direction={direction} getCatById={getCatById} />}
        {message.replyTo && message.replyPreview && !isSchedulerReply && (
          <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
        )}
        {hasTextContent && !message.isStreaming && (
          <TtsPlayButton
            messageId={message.id}
            text={message.content}
            catId={message.catId!}
            ttsState={ttsState}
            activeMessageId={activeMessageId}
            onSynthesize={ttsSynthesize}
          />
        )}
      </div>
      {showSchedulerAccent && (
        <div className={SCHEDULER_ACCENT_BADGE_CLASS}>
          <span aria-hidden>⏰</span>
          <span>定时提醒</span>
        </div>
      )}
      {message.extra?.crossPost &&
        (() => {
          const sourceId = message.extra.crossPost?.sourceThreadId;
          const sourceName = threads.find((t) => t.id === sourceId)?.title ?? '未命名对话';
          const shortId = sourceId.replace(/^thread_/, '').slice(0, 8);
          const senderLabel = catStyle?.label;
          return (
            <a
              href={`/thread/${sourceId}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const sourceInvocationId = message.extra?.crossPost?.sourceInvocationId;
                if (sourceInvocationId) {
                  setPendingCrossPostScroll({
                    threadId: sourceId,
                    sourceInvocationId,
                    senderCatId: message.catId,
                  });
                }
                pushThreadRouteWithHistory(sourceId, typeof window !== 'undefined' ? window : undefined);
              }}
              className="inline-flex items-center gap-1.5 border px-3 py-1 rounded-full bg-cafe-surface border-cafe text-cafe hover:bg-cafe-surface-sunken transition-colors cursor-pointer w-fit max-w-full"
              title={sourceId}
              aria-label={`跳转到来源 thread ${sourceId}`}
            >
              <span className="text-micro font-semibold" aria-hidden>
                📮
              </span>
              <span className="min-w-0 truncate">
                {senderLabel && <span className="font-medium">{senderLabel} · </span>}
                {shortId} · {sourceName}
              </span>
            </a>
          );
        })()}
    </div>
  ) : undefined;

  return (
    <MessageBubble
      messageId={message.id}
      avatar={
        catData ? (
          <CatAvatar
            catId={message.catId!}
            size={32}
            status={message.isStreaming ? 'streaming' : undefined}
            onClick={onEditCat && message.catId ? () => onEditCat(message.catId!) : undefined}
          />
        ) : null
      }
      header={catHeader}
      /* F056: always add cat-persona-derived so nested ThinkingContent/CliOutputBlock
       * have valid --cat-msg-{inset,inset-text,...} tokens even when catData is
       * undefined (e.g. stream messages without resolved catId). */
      wrapperClassName="group cat-persona-derived"
      wrapperStyle={
        catStyle ? ({ '--msg-hue': catStyle.msgHue, '--msg-chroma': catStyle.msgChroma } as CSSProperties) : undefined
      }
      bubbleRadius={catStyle ? catStyle.radius : 'rounded-2xl'}
      bubbleClassName={catStyle ? (catStyle.font ?? '') : 'bg-cafe-surface'}
      bubbleStyle={
        catStyle
          ? { backgroundColor: catStyle.bgColor, color: 'var(--cat-msg-text)' }
          : { color: 'var(--cat-msg-text)' }
      }
      footer={!message.isStreaming && message.metadata ? <MetadataBadge metadata={message.metadata} /> : undefined}
    >
      {renderRoundtableBody ? (
        <RoundtableMessageContent
          content={mergedSpeechContent ?? message.content}
          className={catStyle?.font}
          artifactThreadId={artifactThreadId}
        />
      ) : hasCliBlock && isStreamOrigin ? null : !isStreamOrigin && hasBlocks ? (
        <ContentBlocks blocks={message.contentBlocks!} artifactThreadId={artifactThreadId} />
      ) : !isStreamOrigin && hasTextContent ? (
        <CollapsibleMarkdown
          content={mergedSpeechContent ?? message.content}
          className={catStyle?.font}
          artifactThreadId={artifactThreadId}
        />
      ) : message.isStreaming ? (
        <span className="text-xs text-cafe-secondary">Thinking...</span>
      ) : null}
      {message.thinking && (
        <ThinkingContent
          content={message.thinking}
          className={catStyle?.font}
          label="Thinking"
          defaultExpanded={
            bubbleRestorePending
              ? false
              : resolveBubbleExpanded(currentThread?.bubbleThinking, globalBubbleDefaults.thinking)
          }
          expandInExport={false}
          breedColor={catData?.color.primary}
          artifactThreadId={artifactThreadId}
        />
      )}
      {hasCliBlock && (
        <CliOutputBlock
          events={cliEvents}
          status={cliStatus}
          thinkingMode={currentThread?.thinkingMode}
          defaultExpanded={
            bubbleRestorePending
              ? false
              : resolveBubbleExpanded(currentThread?.bubbleCli, globalBubbleDefaults.cliOutput)
          }
          breedColor={catData?.color.primary}
          artifactThreadId={artifactThreadId}
        />
      )}
      {message.extra?.rich?.blocks && message.extra.rich.blocks.length > 0 && (
        <RichBlocks
          blocks={message.extra.rich.blocks}
          catId={message.catId}
          messageId={message.id}
          messageSource={message.source}
        />
      )}
      {message.isStreaming && !isStreamOrigin && (
        <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 rounded-full opacity-50" />
      )}
    </MessageBubble>
  );
}
