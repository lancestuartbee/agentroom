/**
 * F247: A2A 沙盒存储接口
 */

import type {
  CreateSandboxInput,
  Sandbox,
  SandboxLearnedItemV1,
  SandboxLearningPromotionClaimV1,
  SandboxLearningPromotionProvenanceV1,
  SandboxMemoryV1,
  SandboxRunRecordV1,
  SandboxStateFileV1,
  UpdateSandboxSettingsInput,
  UpdateSandboxSpecInput,
  UpdateSandboxStatusInput,
} from '@cat-cafe/shared';

export interface ISandboxStore {
  /** 创建沙盒 */
  create(input: CreateSandboxInput, createdBy: string): Promise<Sandbox>;

  /** 绑定沙盒到 Thread（创建 thread 后调用） */
  bindThread(sandboxId: string, threadId: string): Promise<void>;

  /** 通过 id 获取沙盒 */
  get(sandboxId: string): Promise<Sandbox | null>;

  /** 通过 thread id 获取沙盒 */
  getByThreadId(threadId: string): Promise<Sandbox | null>;

  /** 通过 projectPath 列出沙盒 */
  listByProject(projectPath: string): Promise<Sandbox[]>;

  /** 更新 spec（开发态） */
  updateSpec(sandboxId: string, input: UpdateSandboxSpecInput): Promise<Sandbox | null>;

  /** 更新设置 */
  updateSettings(sandboxId: string, input: UpdateSandboxSettingsInput): Promise<Sandbox | null>;

  /** 更新状态 */
  updateStatus(sandboxId: string, input: UpdateSandboxStatusInput): Promise<Sandbox | null>;

  /** 读取沙盒滚动记忆 */
  getMemory(sandboxId: string): Promise<SandboxMemoryV1 | null>;

  /** 更新沙盒滚动记忆 */
  updateMemory(sandboxId: string, memory: SandboxMemoryV1): Promise<void>;

  /**
   * 声明一条 learned item 正在被提升。
   *
   * 声明写入 memory 后，fold 在看到 `promotionClaim` 时不得删除或改写该条目。
   * 返回带声明的条目；找不到 item 或已有冲突声明时返回 null。
   */
  claimPromotion(
    sandboxId: string,
    itemId: string,
    claim: SandboxLearningPromotionClaimV1,
  ): Promise<SandboxLearnedItemV1 | null>;

  /**
   * 完成提升：把 item 标为 promoted，并写入 provenance / evidenceAnchor，同时移除声明。
   *
   * 返回更新后的条目；找不到 item、声明不匹配或 fingerprint 不一致时返回 null。
   */
  completePromotion(
    sandboxId: string,
    itemId: string,
    provenance: SandboxLearningPromotionProvenanceV1,
    evidenceAnchor: string,
    fingerprint: { sourceRunId: string; content: string },
    attemptId: string,
  ): Promise<SandboxLearnedItemV1 | null>;

  /**
   * 释放未完成的提升声明（例如 evidence upsert 失败后清理）。
   *
   * 返回移除声明后的条目；找不到 item 时返回 null。
   */
  releasePromotionClaim(sandboxId: string, itemId: string): Promise<SandboxLearnedItemV1 | null>;

  /** 读取最近一次运行记录 */
  getLastRun(sandboxId: string): Promise<SandboxRunRecordV1 | null>;

  /** 添加运行记录 */
  addRun(sandboxId: string, run: SandboxRunRecordV1): Promise<void>;

  /** 列出运行记录 */
  /** Omit `limit` to get every report. The fold MUST omit it — an unread report can
   * never be folded, so a tail window would permanently strand the oldest ones. */
  listRuns(sandboxId: string, limit?: number): Promise<SandboxRunRecordV1[]>;

  /** 读取沙盒状态文件（用于目录持久化） */
  readStateFile(projectPath: string): Promise<SandboxStateFileV1 | null>;

  /** 写入沙盒状态文件 */
  writeStateFile(projectPath: string, state: SandboxStateFileV1): Promise<void>;

  /** 删除沙盒 */
  delete(sandboxId: string): Promise<boolean>;
}
