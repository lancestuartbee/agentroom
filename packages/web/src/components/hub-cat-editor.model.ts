import {
  builtinAccountFamilyForClient,
  CLI_EFFORT_VALUES,
  type CliEffortValue,
  getCliEffortOptionsForProvider,
  builtinAccountIdForClient as sharedBuiltinAccountIdForClient,
} from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { UNKNOWN_CAT_COLOR } from '@/lib/color-defaults';
import type { BuiltinAccountClient, ProfileItem } from './hub-accounts.types';
import { defaultAcpCommandForClient, defaultAcpStartupArgsForClient } from './hub-cat-editor.acp';
import type { CatStrategyEntry, StrategyType } from './hub-strategy-types';

export type ClientId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'kimi'
  | 'dare'
  | 'opencode'
  | 'antigravity'
  | 'catagent'
  | 'acp';
/** @deprecated Use ClientId instead. */
export type ClientValue = ClientId;
export type SessionChainValue = 'true' | 'false';
export type CapabilityLevelValue = '1' | '2' | '3';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexAuthMode = 'oauth' | 'api_key' | 'auto';

export interface HubCatEditorFormState {
  catId: string;
  name: string;
  displayName: string;
  variantLabel: string;
  nickname: string;
  avatar: string;
  colorPrimary: string;
  colorSecondary: string;
  mentionPatterns: string;
  roleDescription: string;
  personality: string;
  modelFamily: string;
  modelLine: string;
  capabilityLevel: CapabilityLevelValue;
  runtimeClient: string;
  teamStrengths: string;
  caution: string;
  strengths: string;
  /** F032: comma-separated capability/role tags (e.g. coding,designer). */
  roles: string;
  /** F032: comma-separated reusable collaboration behavior IDs. */
  behaviors?: string;
  clientId: ClientId;
  accountRef: string;
  defaultModel: string;
  commandArgs: string;
  cliConfigArgs: string[];
  cliEffort: CliEffortValue | '';
  provider: string;
  acpEnabled: boolean;
  acpTransport: 'stdio' | 'httpstream';
  acpCommand: string;
  acpStartupArgs: string;
  acpMaxLiveProcesses: string;
  acpIdleTtlMinutes: string;
  sessionChain: SessionChainValue;
  maxPromptTokens: string;
  maxContextTokens: string;
  maxMessages: string;
  maxContentLengthPerMsg: string;
  voiceVoice: string;
  voiceLangCode: string;
  voiceSpeed: string;
  voiceRefAudio: string;
  voiceRefText: string;
  voiceInstruct: string;
  voiceTemperature: string;
}

export interface HubCatEditorDraft {
  clientId: ClientId;
  accountRef?: string;
  defaultModel: string;
  commandArgs?: string;
  /** F171: template identity fields for bootcamp-guided cat creation */
  templateName?: string;
  templateNickname?: string;
  templateAvatar?: string;
  templateColorPrimary?: string;
  templateColorSecondary?: string;
  templateRoleDescription?: string;
  templatePersonality?: string;
  templateModelFamily?: string;
  templateModelLine?: string;
  templateCapabilityLevel?: 1 | 2 | 3;
  templateRuntimeClient?: string;
  templateTeamStrengths?: string;
  /** F032: roster roles to seed for a new member created from a template. */
  templateRoles?: string[];
  /** F032: roster behaviors to seed independently from roles. */
  templateBehaviors?: string[];
}

export interface StrategyFormState {
  strategy: StrategyType;
  warnThreshold: string;
  actionThreshold: string;
  maxCompressions: string;
  hybridCapable: boolean;
  sessionChainEnabled: boolean;
}

export interface CodexRuntimeSettings {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  authMode: CodexAuthMode;
}

export const CLIENT_OPTIONS: Array<{ value: ClientId; label: string }> = [
  { value: 'anthropic', label: 'Claude' },
  { value: 'openai', label: 'GPT / Codex CLI' },
  { value: 'google', label: 'Gemini' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'dare', label: 'Dare' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'antigravity', label: 'Gemini / AGY' },
  { value: 'catagent', label: 'CatAgent' },
  { value: 'acp', label: 'ACP Client' },
];

export const CAPABILITY_LEVEL_OPTIONS: Array<{ value: CapabilityLevelValue; label: string }> = [
  { value: '3', label: 'Level 3' },
  { value: '2', label: 'Level 2' },
  { value: '1', label: 'Level 1' },
];

export const SESSION_CHAIN_OPTIONS: Array<{ value: SessionChainValue; label: string }> = [
  { value: 'true', label: 'true' },
  { value: 'false', label: 'false' },
];

export const SESSION_STRATEGY_OPTIONS: Array<{ value: StrategyType; label: string }> = [
  { value: 'handoff', label: 'handoff' },
  { value: 'compress', label: 'compress' },
  { value: 'hybrid', label: 'hybrid' },
];

export const CODEX_SANDBOX_OPTIONS: Array<{ value: CodexSandboxMode; label: string }> = [
  { value: 'read-only', label: 'read-only' },
  { value: 'workspace-write', label: 'workspace-write' },
  { value: 'danger-full-access', label: 'danger-full-access' },
];

export const CODEX_APPROVAL_OPTIONS: Array<{ value: CodexApprovalPolicy; label: string }> = [
  { value: 'untrusted', label: 'untrusted' },
  { value: 'on-failure', label: 'on-failure' },
  { value: 'on-request', label: 'on-request' },
  { value: 'never', label: 'never' },
];

export const CODEX_AUTH_MODE_OPTIONS: Array<{ value: CodexAuthMode; label: string }> = [
  { value: 'oauth', label: 'oauth' },
  { value: 'api_key', label: 'api_key' },
  { value: 'auto', label: 'auto' },
];

export { defaultAcpCommandForClient, defaultAcpStartupArgsForClient };
export {
  ACP_TRANSPORT_OPTIONS,
  type AcpTransportValue,
  acpStartupArgsPlaceholder,
  getAcpWarning,
  isAcpOnlyClient,
  showTransportSelector,
} from './hub-cat-editor.acp';

export const DEFAULT_ANTIGRAVITY_COMMAND_ARGS = '. --remote-debugging-port=9000';

const GOOGLE_OWNED_DOMAINS = ['generativelanguage.googleapis.com', 'googleapis.com'];

function isCliEffortValue(value: string | undefined): value is CliEffortValue {
  return value !== undefined && CLI_EFFORT_VALUES.includes(value as CliEffortValue);
}

function voiceStr(value: string | number | undefined): string {
  return value == null ? '' : String(value);
}

export function getCliEffortOptionsForClient(client: ClientValue): readonly CliEffortValue[] | null {
  return getCliEffortOptionsForProvider(client);
}

export function splitMentionPatterns(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function normalizeMentionPattern(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

export function deriveModelMentionPattern(model: string): string {
  const modelId = model.trim().split('/').filter(Boolean).at(-1)?.trim();
  if (!modelId) return '';
  const alias = modelId
    .replace(/^[@.]+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return alias ? normalizeMentionPattern(alias) : '';
}

function lastModelSegment(model: string): string {
  return model.trim().split('/').filter(Boolean).at(-1)?.trim() ?? '';
}

function normalizedModel(model: string): string {
  return lastModelSegment(model).toLowerCase();
}

export interface ModelProfileDraft {
  clientId: ClientId;
  defaultModel: string;
  runtimeClient?: string;
}

export function deriveModelFamily(clientId: ClientId, model: string): string {
  const normalized = normalizedModel(model);
  if (clientId === 'anthropic' || normalized.startsWith('claude-')) return 'claude';
  if (clientId === 'openai' || /^(gpt-|o[134]-|chatgpt)/.test(normalized)) return 'gpt';
  if (clientId === 'google' || clientId === 'antigravity' || normalized.startsWith('gemini-')) return 'gemini';
  if (clientId === 'kimi' || normalized.includes('kimi') || normalized.includes('moonshot')) return 'kimi';
  if (clientId === 'opencode') return 'opencode';
  if (clientId === 'dare') return 'dare';
  if (clientId === 'catagent') return 'catagent';
  return clientId;
}

export function deriveModelLine(clientId: ClientId, model: string): string {
  const normalized = normalizedModel(model);
  if (normalized.includes('opus')) return 'Opus';
  if (normalized.includes('sonnet')) return 'Sonnet';
  if (normalized.includes('fable')) return 'Fable';
  if (/gpt-5(?:[.-]|\b)/.test(normalized) || normalized.startsWith('chatgpt-5')) return '5.x';
  if (normalized.includes('flash')) return 'Flash';
  if (normalized.includes('pro')) return 'Pro';
  if (normalized === 'k3') return 'K3';
  if (normalized.includes('kimi')) return normalized.includes('coding') ? 'Code' : 'Kimi';
  if (clientId === 'antigravity') return 'AGY';
  if (clientId === 'opencode') return 'Provider model';
  if (clientId === 'dare') return 'Agent runtime';
  if (clientId === 'acp') return 'ACP';
  return lastModelSegment(model) || deriveModelFamily(clientId, model);
}

export function deriveCapabilityLevel(clientId: ClientId, model: string): CapabilityLevelValue {
  const normalized = normalizedModel(model);
  if (
    normalized.includes('opus') ||
    normalized.includes('fable') ||
    /gpt-5(?:[.-]|\b)/.test(normalized) ||
    normalized.includes('gemini-3.1-pro')
  ) {
    return '3';
  }
  if (
    normalized.includes('sonnet') ||
    normalized.includes('gemini') ||
    normalized.includes('kimi') ||
    clientId === 'opencode' ||
    clientId === 'dare' ||
    clientId === 'catagent'
  ) {
    return '2';
  }
  return '1';
}

export function deriveRuntimeClient(profile: ModelProfileDraft): string {
  const runtime = profile.runtimeClient?.trim();
  if (runtime) return runtime;
  switch (profile.clientId) {
    case 'anthropic':
      return 'Claude CLI';
    case 'openai':
      return 'Codex CLI';
    case 'google':
      return 'Gemini CLI';
    case 'antigravity':
      return 'AGY';
    case 'kimi':
      return 'Kimi CLI';
    case 'opencode':
      return 'OpenCode';
    case 'dare':
      return 'Dare';
    case 'acp':
      return 'ACP';
    default:
      return profile.clientId;
  }
}

export function deriveModelProfile(
  profile: ModelProfileDraft,
): Pick<HubCatEditorFormState, 'modelFamily' | 'modelLine' | 'capabilityLevel' | 'runtimeClient'> {
  return {
    modelFamily: deriveModelFamily(profile.clientId, profile.defaultModel),
    modelLine: deriveModelLine(profile.clientId, profile.defaultModel),
    capabilityLevel: deriveCapabilityLevel(profile.clientId, profile.defaultModel),
    runtimeClient: deriveRuntimeClient(profile),
  };
}

export function resolveModelSuffix(form: Partial<HubCatEditorFormState> & ModelProfileDraft): string {
  return (
    (form.variantLabel ?? '').trim() ||
    (form.modelLine ?? '').trim() ||
    deriveModelLine(form.clientId, form.defaultModel).trim() ||
    (form.nickname ?? '').trim()
  );
}

export function applyDerivedModelProfile(
  previous: HubCatEditorFormState,
  next: HubCatEditorFormState,
  options: { force?: boolean } = {},
): HubCatEditorFormState {
  const previousDerived = deriveModelProfile(previous);
  const nextDerived = deriveModelProfile(next);
  const previousVariantLabel = previous.variantLabel.trim();
  const shouldUpdateSuffix =
    options.force || !previousVariantLabel || previousVariantLabel === previousDerived.modelLine;
  const nextVariantLabel = shouldUpdateSuffix ? nextDerived.modelLine : next.variantLabel;
  const previousSuffix = resolveModelSuffix({ ...previous, modelLine: previousDerived.modelLine });
  const nextSuffix = resolveModelSuffix({ ...next, variantLabel: nextVariantLabel, modelLine: nextDerived.modelLine });
  const keepOrDerive = (current: string, prevDerived: string, nextValue: string) => {
    if (options.force) return nextValue;
    const trimmed = current.trim();
    if (!trimmed || trimmed === prevDerived) return nextValue;
    return current;
  };
  const nextNickname =
    options.force || !previous.nickname.trim() || previous.nickname.trim() === previousSuffix
      ? nextSuffix
      : next.nickname;
  return {
    ...next,
    variantLabel: nextVariantLabel,
    modelFamily: keepOrDerive(previous.modelFamily, previousDerived.modelFamily, nextDerived.modelFamily),
    modelLine: keepOrDerive(previous.modelLine, previousDerived.modelLine, nextDerived.modelLine),
    capabilityLevel: keepOrDerive(
      previous.capabilityLevel,
      previousDerived.capabilityLevel,
      nextDerived.capabilityLevel,
    ) as CapabilityLevelValue,
    runtimeClient: keepOrDerive(previous.runtimeClient, previousDerived.runtimeClient, nextDerived.runtimeClient),
    nickname: nextNickname,
  };
}

export function withDefaultModelMentionPattern(form: HubCatEditorFormState): HubCatEditorFormState {
  const modelAlias = deriveModelMentionPattern(form.defaultModel);
  if (!modelAlias) return form;
  const aliases = splitMentionPatterns(form.mentionPatterns).map(normalizeMentionPattern).filter(Boolean);
  if (aliases.length > 0) return form;
  return { ...form, mentionPatterns: joinTags([modelAlias]) };
}

export function canonicalMentionPattern(catId: string): string {
  return normalizeMentionPattern(catId);
}

export function joinTags(tags: string[]): string {
  return tags.join(', ');
}

export function splitCommandArgs(raw: string): string[] {
  const input = raw.trim();
  if (!input) return [];
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length === 0) return;
    args.push(current);
    current = '';
  };

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }
    current += char;
  }
  if (escaping) current += '\\';
  pushCurrent();
  return args;
}

export function splitStrengthTags(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function isBuiltinClient(client: ClientId): client is BuiltinAccountClient {
  return (
    client === 'anthropic' ||
    client === 'openai' ||
    client === 'google' ||
    client === 'kimi' ||
    client === 'dare' ||
    client === 'opencode' ||
    client === 'acp'
  );
}

function legacyProfileClient(profile: ProfileItem): BuiltinAccountClient | undefined {
  if (profile.clientId) return profile.clientId;
  if (profile.oauthLikeClient === 'dare' || profile.oauthLikeClient === 'opencode') return profile.oauthLikeClient;
  const normalizedId = `${profile.id} ${profile.provider ?? ''} ${profile.displayName} ${profile.name}`.toLowerCase();
  if (normalizedId.includes('claude')) return 'anthropic';
  if (normalizedId.includes('codex')) return 'openai';
  if (normalizedId.includes('gemini')) return 'google';
  if (normalizedId.includes('kimi') || normalizedId.includes('moonshot')) return 'kimi';
  if (normalizedId.includes('dare')) return 'dare';
  if (normalizedId.includes('opencode')) return 'opencode';
  if (normalizedId.includes('acp')) return 'acp';
  return undefined;
}

function parseHostname(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isOfficialGoogleHostname(hostname: string): boolean {
  return GOOGLE_OWNED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function isAllowedGoogleGatewayProfile(profile: ProfileItem): boolean {
  if (profile.authType !== 'api_key') return false;
  const hostname = parseHostname(profile.baseUrl);
  return hostname !== null && !isOfficialGoogleHostname(hostname);
}

function resolveBuiltinClientFamily(client: ClientId): BuiltinAccountClient | null {
  if (typeof builtinAccountFamilyForClient === 'function') {
    const family = builtinAccountFamilyForClient(client);
    if (family) return family;
  }
  if (isBuiltinClient(client)) return client;
  if (client === 'catagent') return 'anthropic';
  return null;
}
export function builtinAccountIdForClient(client: ClientId): string | null {
  return sharedBuiltinAccountIdForClient(client);
}

export function filterAccounts(client: ClientId, profiles: ProfileItem[]): ProfileItem[] {
  // F161: Generic ACP is a transport, not tied to any provider family.
  // Any account (oauth or api_key, any client family) can supply credentials to the ACP carrier.
  if (client === 'acp') return profiles;
  const effective = resolveBuiltinClientFamily(client);
  if (!effective || !isBuiltinClient(effective)) return [];
  const builtinProfiles = profiles.filter(
    (profile) => profile.authType !== 'api_key' && legacyProfileClient(profile) === effective,
  );
  if (effective === 'google') {
    const gatewayProfiles = profiles.filter(isAllowedGoogleGatewayProfile);
    return [...builtinProfiles, ...gatewayProfiles.filter((profile) => !builtinProfiles.includes(profile))];
  }
  if (effective === 'kimi') {
    const kimiApiProfiles = profiles.filter(
      (profile) => profile.authType === 'api_key' && legacyProfileClient(profile) === 'kimi',
    );
    return [...builtinProfiles, ...kimiApiProfiles.filter((profile) => !builtinProfiles.includes(profile))];
  }
  const apiKeyProfiles = profiles.filter((profile) => profile.authType === 'api_key');
  return [...builtinProfiles, ...apiKeyProfiles.filter((profile) => !builtinProfiles.includes(profile))];
}

export const filterProfiles = filterAccounts;
export function autoSlug(name: string, currentId?: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
  if (/^[a-z]/.test(slug)) return slug;
  if (currentId && /^cat-[a-z0-9]+$/.test(currentId)) return currentId;
  const rand = Math.random().toString(36).substring(2, 10);
  return `cat-${rand}`;
}

/**
 * Make an auto-derived catId unique against ids taken by other members (`reserved`, lowercased).
 * catId is internal/not user-editable, so on collision we transparently append a numeric suffix
 * instead of surfacing a conflict — mirrors the mentionPattern alias auto-suffix.
 */
export function uniqueCatId(base: string, reserved: ReadonlySet<string>): string {
  const trimmed = base.trim();
  if (!trimmed || !reserved.has(trimmed.toLowerCase())) return trimmed;
  for (let i = 2; i <= 999; i++) {
    const candidate = `${trimmed}-${i}`;
    if (!reserved.has(candidate.toLowerCase())) return candidate;
  }
  // Pathological (999 numeric suffixes all taken): draw random suffixes, re-checking each so
  // uniqueness still holds. The 36^6 space vs a finite reserved set makes this terminate at once.
  let candidate: string;
  do {
    candidate = `${trimmed}-${Math.random().toString(36).slice(2, 8)}`;
  } while (reserved.has(candidate.toLowerCase()));
  return candidate;
}

export function initialState(cat?: CatData | null, draft?: HubCatEditorDraft | null): HubCatEditorFormState {
  const createDraft = !cat ? draft : null;
  const persistedCliEffort = cat?.cli?.effort;
  const voiceConfig = cat?.voiceConfig;
  const acpConfig = cat?.acp;
  const nameForCreate = createDraft?.templateName ?? '';
  const catId = cat?.id ?? (nameForCreate ? autoSlug(nameForCreate) : '');
  const mentionPatterns = cat?.mentionPatterns ?? [];
  const clientId = (cat?.clientId as ClientId | undefined) ?? createDraft?.clientId ?? 'anthropic';
  const defaultModel = cat?.defaultModel ?? createDraft?.defaultModel ?? '';
  const derivedModelProfile = deriveModelProfile({
    clientId,
    defaultModel,
    runtimeClient: cat?.runtimeClient,
  });
  const variantLabel =
    cat?.variantLabel ?? cat?.nickname ?? createDraft?.templateNickname ?? derivedModelProfile.modelLine;
  const nickname = cat?.nickname ?? variantLabel;
  return {
    catId,
    name: cat?.name ?? cat?.displayName ?? createDraft?.templateName ?? '',
    displayName: cat?.displayName ?? cat?.name ?? createDraft?.templateName ?? '',
    variantLabel,
    nickname,
    avatar: cat?.avatar ?? createDraft?.templateAvatar ?? '',
    colorPrimary: cat?.color.primary ?? createDraft?.templateColorPrimary ?? UNKNOWN_CAT_COLOR.primary,
    colorSecondary: cat?.color.secondary ?? createDraft?.templateColorSecondary ?? UNKNOWN_CAT_COLOR.secondary,
    mentionPatterns: joinTags(mentionPatterns),
    roleDescription: cat?.roleDescription ?? createDraft?.templateRoleDescription ?? '',
    personality: cat?.personality ?? createDraft?.templatePersonality ?? '',
    modelFamily: cat?.modelFamily ?? createDraft?.templateModelFamily ?? derivedModelProfile.modelFamily,
    modelLine: cat?.modelLine ?? createDraft?.templateModelLine ?? derivedModelProfile.modelLine,
    capabilityLevel: String(
      cat?.capabilityLevel ?? createDraft?.templateCapabilityLevel ?? derivedModelProfile.capabilityLevel,
    ) as CapabilityLevelValue,
    runtimeClient: cat?.runtimeClient ?? createDraft?.templateRuntimeClient ?? derivedModelProfile.runtimeClient,
    teamStrengths: cat?.teamStrengths ?? createDraft?.templateTeamStrengths ?? '',
    caution: cat?.caution ?? '',
    strengths: cat?.strengths?.join(', ') ?? '',
    roles: cat?.roster?.roles?.join(', ') ?? createDraft?.templateRoles?.join(', ') ?? '',
    behaviors: cat?.roster?.behaviors?.join(', ') ?? createDraft?.templateBehaviors?.join(', ') ?? '',
    clientId,
    accountRef: cat?.accountRef ?? createDraft?.accountRef ?? '',
    defaultModel,
    commandArgs: cat?.commandArgs?.join(' ') ?? createDraft?.commandArgs ?? '',
    cliConfigArgs: [...(cat?.cliConfigArgs ?? [])],
    cliEffort: isCliEffortValue(persistedCliEffort) ? persistedCliEffort : '',
    provider: cat?.provider ?? '',
    acpEnabled:
      Boolean(acpConfig) || (cat?.clientId as ClientId | undefined) === 'acp' || createDraft?.clientId === 'acp',
    acpTransport: (acpConfig?.transport as 'stdio' | 'httpstream' | undefined) ?? 'stdio',
    acpCommand:
      acpConfig?.command ??
      defaultAcpCommandForClient((cat?.clientId as ClientId | undefined) ?? createDraft?.clientId ?? 'anthropic'),
    acpStartupArgs:
      acpConfig?.startupArgs?.join(' ') ??
      defaultAcpStartupArgsForClient(
        (cat?.clientId as ClientId | undefined) ?? createDraft?.clientId ?? 'anthropic',
        (acpConfig?.transport as 'stdio' | 'httpstream' | undefined) ?? 'stdio',
      ),
    acpMaxLiveProcesses: acpConfig?.pool?.maxLiveProcesses !== undefined ? String(acpConfig.pool.maxLiveProcesses) : '',
    acpIdleTtlMinutes:
      acpConfig?.pool?.idleTtlMs !== undefined ? String(Math.round(acpConfig.pool.idleTtlMs / 60_000)) : '',
    sessionChain: String(cat?.sessionChain ?? true) as SessionChainValue,
    maxPromptTokens: cat?.contextBudget ? String(cat.contextBudget.maxPromptTokens) : '',
    maxContextTokens: cat?.contextBudget ? String(cat.contextBudget.maxContextTokens) : '',
    maxMessages: cat?.contextBudget ? String(cat.contextBudget.maxMessages) : '',
    maxContentLengthPerMsg: cat?.contextBudget ? String(cat.contextBudget.maxContentLengthPerMsg) : '',
    voiceVoice: voiceStr(voiceConfig?.voice),
    voiceLangCode: voiceStr(voiceConfig?.langCode),
    voiceSpeed: voiceStr(voiceConfig?.speed),
    voiceRefAudio: voiceStr(voiceConfig?.refAudio),
    voiceRefText: voiceStr(voiceConfig?.refText),
    voiceInstruct: voiceStr(voiceConfig?.instruct),
    voiceTemperature: voiceStr(voiceConfig?.temperature),
  };
}

export function toStrategyForm(entry: CatStrategyEntry): StrategyFormState {
  return {
    strategy: entry.effective.strategy,
    warnThreshold: String(entry.effective.thresholds.warn),
    actionThreshold: String(entry.effective.thresholds.action),
    maxCompressions: String(entry.effective.hybrid?.maxCompressions ?? 2),
    hybridCapable: entry.hybridCapable,
    sessionChainEnabled: entry.sessionChainEnabled,
  };
}

export function buildStrategyPayload(strategy: StrategyFormState) {
  const warn = Number.parseFloat(strategy.warnThreshold);
  const action = Number.parseFloat(strategy.actionThreshold);
  if (!Number.isFinite(warn) || !Number.isFinite(action)) {
    throw new Error('Session 阈值必须是数字');
  }
  if (warn >= action) {
    throw new Error('Warn Threshold 必须小于 Action Threshold');
  }

  const payload: Record<string, unknown> = {
    strategy: strategy.strategy,
    thresholds: { warn, action },
  };
  if (strategy.strategy === 'hybrid') {
    const maxCompressions = Number.parseInt(strategy.maxCompressions, 10);
    if (!Number.isFinite(maxCompressions) || maxCompressions <= 0) {
      throw new Error('Max Compressions 必须是正整数');
    }
    payload.hybrid = { maxCompressions };
  }
  return payload;
}

export function toCodexRuntimeSettings(config?: {
  cli?: {
    codexSandboxMode?: CodexSandboxMode;
    codexApprovalPolicy?: CodexApprovalPolicy;
  };
  codexExecution?: {
    authMode?: CodexAuthMode;
  };
}): CodexRuntimeSettings {
  return {
    sandboxMode: config?.cli?.codexSandboxMode ?? 'workspace-write',
    approvalPolicy: config?.cli?.codexApprovalPolicy ?? 'on-request',
    authMode: config?.codexExecution?.authMode ?? 'oauth',
  };
}

export function buildCodexConfigPatches(
  settings: CodexRuntimeSettings,
  baseline: CodexRuntimeSettings,
): Array<{ key: string; value: string }> {
  const patches: Array<{ key: string; value: string }> = [];
  if (settings.sandboxMode !== baseline.sandboxMode) {
    patches.push({ key: 'cli.codexSandboxMode', value: settings.sandboxMode });
  }
  if (settings.approvalPolicy !== baseline.approvalPolicy) {
    patches.push({ key: 'cli.codexApprovalPolicy', value: settings.approvalPolicy });
  }
  if (settings.authMode !== baseline.authMode) {
    patches.push({ key: 'codex.execution.authMode', value: settings.authMode });
  }
  return patches;
}

export {
  buildCatPatchPayload,
  buildCatPayload,
  buildContextBudget,
  hintModelFormatForClient,
  validateModelFormatForClient,
} from './hub-cat-editor.payload';
