/**
 * F247: A2A 沙盒模式类型定义
 *
 * A2A 沙盒是一种项目级 A2A 开发容器：
 * - 与单个 Thread 1:1 绑定
 * - 持久化锚定在项目目录 (<projectPath>/.a2a-sandbox/)
 * - 支持开发态（修改 spec）和运行态（按 spec 执行）
 * - 拥有项目级隔离记忆，默认不污染系统全局记忆
 */

import type { CatId } from './ids.js';

/**
 * 沙盒规格（spec）—— 开发态可编辑，运行态只读执行。
 * 这是开发态与运行态之间的唯一接口。
 */
export interface SandboxSpecV1 {
  /** Spec 协议版本 */
  specVersion: '1';
  /** 沙盒显示名称 */
  name: string;
  /** 项目目标描述 */
  goal: string;
  /** 学习/积累目标 */
  learningGoal?: string;
  /** 调度配置 */
  schedule?: SandboxScheduleV1;
  /** 参与 Agent 列表（v1 固定） */
  members: CatId[];
  /** 数据源声明（v1 可空，未来扩展） */
  dataSources?: SandboxDataSourceV1[];
  /** 扩展字段 */
  extensions?: Record<string, unknown>;
}

export interface SandboxScheduleV1 {
  /** Cron 表达式，如 '0 9 * * *' */
  cron: string;
  /** 每次运行时自动发送给 Agent 的 prompt */
  prompt: string;
  /** 时区，默认使用系统本地时区 */
  timezone?: string;
}

export interface SandboxDataSourceV1 {
  /** 数据源类型 */
  type: string;
  /** 数据源名称 */
  name: string;
  /** 类型特定配置 */
  config?: Record<string, unknown>;
}

/**
 * 沙盒设置
 */
export interface SandboxSettingsV1 {
  /** 是否允许把有价值学习成果回流到系统级记忆 */
  allowBackflow: boolean;
  /** 是否在创建时自动开始 schedule */
  autoStartSchedule: boolean;
  /** 最大保留的运行记录数量，0 表示无限制 */
  maxRunLogs: number;
}

/**
 * 沙盒级滚动记忆
 *
 * 与 ThreadMemoryV1 不同：它按沙盒隔离，跨多次运行持续积累。
 */
export interface SandboxMemoryV1 {
  v: 1;
  /** 项目级滚动摘要 */
  summary: string;
  /** 已合并的运行次数 */
  runsIncorporated: number;
  /** 最近一次运行时间 */
  lastRunAt?: number;
  /** 学习条目 */
  learnedItems?: SandboxLearnedItemV1[];
  /**
   * 已折叠进本记忆的运行 ID 集合。
   *
   * 幂等判据用**集合成员**而不是 `lastRunAt` 时间戳游标：时间戳会在三种情况下
   * 永久丢数据——同一时间戳的迟到报告、系统时钟回拨、并发折叠互相覆盖。
   * 对一个要跑几个月的项目，"静默丢掉几天的学习"是不可接受的失败。
   */
  processedRunIds?: string[];
  /** 未解决的开放问题 */
  openQuestions?: string[];
  /** 关键决策 */
  decisions?: string[];
  /** Unix 时间戳 */
  updatedAt: number;
}

export interface SandboxLearnedItemV1 {
  /** 条目唯一 id */
  id: string;
  /** 学习内容 */
  content: string;
  /**
   * 来源运行 ID。
   *
   * 旧版从 `id.slice(0, lastIndexOf('-'))` 反解，但 stable id 不保证含 `-` 或该 `-`
   * 分隔 runId，所以 provenance 必须显式存储。旧数据无此字段时 fold 会回退到 id 反解。
   */
  sourceRunId: string;
  /** 来源运行时间 */
  sourceRunAt: number;
  /** 是否已提升为系统级知识 */
  promoted: boolean;
  /** 提升时间 */
  promotedAt?: number;
  /**
   * 已 promoted 条目与其来源报告不再一致时的记录（F247 Phase E 前置）。
   *
   * promoted 条目是冻结的——内容已导出到沙盒外，静默改写本地副本会让两边不一致。
   * 但"只打日志"支撑不了 operator 侧的 UX：进程重启后分歧就消失了。所以分歧连同
   * **来源指纹**（报告现在说什么）一起持久化在条目上，由 operator 决定是否撤回已发布的副本。
   */
  divergence?: SandboxLearningDivergenceV1;
}

export interface SandboxLearningDivergenceV1 {
  /** `rewritten` = 报告改了这条内容；`retracted` = 报告还在，但这条被删掉了。 */
  kind: 'rewritten' | 'retracted';
  /** 报告现在说什么。retracted 时不存在——正是"它不再说了"。 */
  reportContent?: string;
  /**
   * 观察到分歧时那份报告的 `triggeredAt`。
   *
   * 刻意用运行时间而不是墙上时钟：折叠是纯函数，同样的报告折叠多少次都必须得到
   * 同样的记忆，否则幂等性就没了。
   */
  observedAt: number;
}

/**
 * 单次运行记录（也持久化到 runs/<timestamp>.md）
 */
export interface SandboxRunRecordV1 {
  v: 1;
  runId: string;
  /** 触发方式 */
  trigger: 'scheduled' | 'manual';
  /** 触发时间 */
  triggeredAt: number;
  /** 对应 spec 版本 */
  specVersion: string;
  /** 运行结果摘要 */
  summary: string;
  /**
   * 本次运行沉淀下来的 durable 结论。
   *
   * 与 `summary` 的区别是这次设计的要害：summary 是"今天发生了什么"（会过期），
   * learned 是"从此以后都成立的判断"（要积累）。两者混在一起，几个月后记忆就退化
   * 成一堆读不动的日志——只有 learned 会进入 `SandboxMemoryV1.learnedItems`。
   *
   * 旧格式是纯字符串数组，id 由 fold 按 `runId-index` 推导。新报告应在每条结论前
   * 带稳定 id，解析后进入 `learnedWithIds`；fold 优先用显式 id，无显式 id 时回退
   * 到 legacy 推导。
   */
  learned?: string[];
  /**
   * 带稳定 id 的 durable 结论。当成员改写报告时保留 id，fold 就能区分
   * "内容改写 / 条目删除 / 顺序重排"，而不会因数组下标漂移产生假 divergence。
   */
  learnedWithIds?: Array<{ id: string; content: string }>;
  /** 运行产物路径（相对沙盒目录） */
  artifacts?: string[];
}

/**
 * 沙盒实体
 *
 * 与 Thread 1:1 绑定。持久化以目录为真相源，此类型主要用于运行时和 API 传输。
 */
export interface Sandbox {
  /** 沙盒唯一 id，格式 sandbox:<uuid> */
  id: string;
  /** 显示名称 */
  title: string;
  /** 绑定目录 */
  projectPath: string;
  /** 1:1 绑定的 Thread id */
  threadId: string;
  /** 创建者 */
  createdBy: string;
  /** 参与成员（v1 固定） */
  members: CatId[];
  /** 当前生效 spec */
  spec: SandboxSpecV1;
  /** 设置 */
  settings: SandboxSettingsV1;
  /** 沙盒状态 */
  status: 'active' | 'paused' | 'archived';
  createdAt: number;
  updatedAt: number;
}

/**
 * 沙盒状态文件（state.json）的序列化格式
 */
export interface SandboxStateFileV1 {
  v: 1;
  sandboxId: string;
  title: string;
  threadId: string;
  members: CatId[];
  settings: SandboxSettingsV1;
  status: Sandbox['status'];
  currentSpecRef: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 创建沙盒请求（API / UI）
 */
export interface CreateSandboxInput {
  title: string;
  projectPath: string;
  members: CatId[];
  spec: SandboxSpecV1;
  settings?: Partial<SandboxSettingsV1>;
}

/**
 * 更新沙盒 spec（开发态）
 */
export interface UpdateSandboxSpecInput {
  spec: Partial<SandboxSpecV1>;
}

/**
 * 更新沙盒设置
 */
export interface UpdateSandboxSettingsInput {
  settings: Partial<SandboxSettingsV1>;
}

/**
 * 更新沙盒状态
 */
export interface UpdateSandboxStatusInput {
  status: Sandbox['status'];
}
