---
feature_ids: [F247]
related_features: [F011, F032, F065, F102, F152, F178, F229]
topics: [a2a, sandbox, mode, memory, scheduling, ide]
doc_kind: spec
created: 2026-08-10
---

# F247: A2A 沙盒模式 — 项目级 A2A 开发容器

> **Status**: implemented, pending operator acceptance | **Owner**: Kimi/K3 | **Priority**: P1

## Why

当前系统有闲聊、圆桌会议、开发协作三种会话模式。开发协作适合传统代码工程，但缺少一种面向"长期运行的 A2A 项目"的一等模式。典型场景：股票模拟沙盘需要依托 A2A 系统持续数月运行，每日执行任务并积累领域知识；这种项目的产出不是一次性代码交付，而是一个越跑越懂行的持续运营体。

用户期望：
- 开箱即用，复用现有 Agent 成员的"轻分身"，无需自己配置人物设定。
- 项目级独立记忆存储，默认不带出对话外，但可显式选择把有价值学习成果回流系统。
- 单一会话绑定一个 A2A 项目，支持开发态（修改设定）和运行态（按设定执行）双栏 UX。
- 未来可扩展为完整 A2A IDE。

## What

### Phase A: Schema & Directory Contract

建立 A2A 沙盒的核心抽象和持久化约定。

#### A1. 模式与类型

- `Thread.mode` 新增 `'sandbox'`。
- 新增 `Sandbox` 实体，与 `Thread` 1:1 绑定。
- 新增 `SandboxMemoryV1`、`SandboxSpecV1`、`SandboxScheduleV1`、`SandboxSettingsV1` 类型。
- `Thread` 新增可选字段 `sandboxId?: string`。

#### A2. 目录约定

沙盒持久化锚定在项目目录：

```text
<projectPath>/.a2a-sandbox/
├── state.json              # sandbox 元数据、成员、schedule、settings
├── spec.yaml               # 当前生效 spec
├── spec/                   # 版本化 spec 历史（append-only，按 timestamp 命名）
├── memory/
│   ├── sandbox-memory.json # 项目级滚动记忆
│   └── episodic/           # 每次运行的原始记录
├── runs/                   # 运行产物/日志
└── .gitignore              # 默认忽略 runs/ 和 episodic/
```

#### A3. Spec Schema（v1 最小集）

```yaml
specVersion: '1'
name: '每日主题调研沙盒'
goal: '每天调研一个科技主题，记录关键发现'
schedule:
  cron: '0 9 * * *'
  prompt: '执行今日调研任务'
members:
  - opus
  - kimi
dataSources: []
learningGoal: '积累主题分类体系和信息源质量评估'
```

### Phase B: Backend Routing & Memory Isolation

#### B1. Sandbox Prompt Profile

- 新增 `sandbox` prompt profile。
- Agent 以"轻分身"身份运行：不加载完整家规/SOP/worldview，只保留最小身份、路由能力、质量门禁、记忆工具、当前 spec。

#### B2. Routing

- `AgentRouter.getModeRouteOptions()` 增加 `sandbox` 分支。
- `AgentRouter.resolveTargetsAndIntent()` 增加 `sandbox` 分支。
- Sandbox 内 A2A 路由限制在 `Sandbox.members` 内。

#### B3. Memory Isolation

- 滚动记忆：新增 `SandboxMemoryV1`，挂在 `Sandbox` 上。
- Evidence：复用现有引擎，collection id 为 `sandbox:<id>`，search dimension 新增 `sandbox`。
- KV Memory：key prefix 增加 `sandbox:<id>`。
- `SessionBootstrap` 在 `sandbox` 模式下优先注入 `SandboxMemoryV1`。

#### B4. Run Lifecycle

- 每次运行创建一条运行记录，写入 `runs/<timestamp>.md`。
- 运行结束后调用 `buildSandboxMemory()` 更新 `SandboxMemoryV1`。

### Phase C: Scheduler & Run Loop

- 创建沙盒时可配置 `schedule.cron`。
- 调度触发时，在绑定的 Thread 内以系统身份发起一条运行消息。
- 支持手动触发运行（用户在运行态点击"立即执行"）。
- 支持暂停/恢复 schedule。

### Phase D: Frontend Dual-Pane UX（v1）

- 创建会话 modal 增加"A2A 沙盒"选项。
- `Thread.mode === 'sandbox'` 时，聊天区域渲染左右双栏：
  - 左栏：开发态。可对话式修改 spec、成员、schedule、学习目标。
  - 右栏：运行态。展示运行历史、当前状态、手动触发按钮、最新运行结果。
- 会话顶部显示沙盒状态、schedule 状态、回流开关状态。
- v1 双栏为最小实现：左右分屏，不追求复杂看板。

### Phase E: Backflow & Promotion

- 创建沙盒时提供 `allowBackflow` 开关（默认关闭）。
- 当 `allowBackflow=true` 时，用户可在开发态显式把某条 `learnedItem` 标记为"promote"。
- Promote 动作把该学习成果写入系统级 evidence（或 skill 候选池），并记录 provenance。

## Acceptance Criteria

### Phase A（Schema & Directory Contract）
- [x] AC-A1: `packages/shared/src/types/modes.ts` 增加 `'sandbox'`，类型系统不破坏现有三种模式。
- [x] AC-A2: 新增 `packages/shared/src/types/sandbox.ts`，包含 `Sandbox`、`SandboxMemoryV1`、`SandboxSpecV1`、`SandboxScheduleV1`、`SandboxSettingsV1`。
- [x] AC-A3: `Thread` 类型增加 `sandboxId?: string`，不影响现有 thread 行为。
- [x] AC-A4: 目录约定文档化，`<projectPath>/.a2a-sandbox/` 结构明确。

### Phase B（Backend Routing & Memory Isolation）
- [x] AC-B1: `AgentRouter` 在 `mode === 'sandbox'` 时走 sandbox 分支，不进入 development 旧通道。
- [x] AC-B2: Sandbox 内 A2A 路由限制在 `Sandbox.members` 内，越界 mention 退回当前成员；`PATCH /api/threads/:id` 拒绝改写 sandbox thread 的 `preferredCats`/`audience`。
- [x] AC-B3: `SessionBootstrap` 在 sandbox 模式下注入 `SandboxMemoryV1`；KV memory 对 sandbox thread 隐式加 `sandbox:<id>:` 前缀隔离。
- [x] AC-B4: Sandbox 内 evidence search 默认只搜索 `sandbox:<id>` collection，不污染全局/项目记忆。实现沿用现有 evidence 表，以 `anchor` 前缀 `sandbox:<id>:` 做逻辑隔离，未为每个沙盒注册独立 LibraryCatalog collection（KD-4）。
- [x] AC-B5: Sandbox 内 Agent 不加载完整 SOP/家规，但保留路由和质量门禁。

### Phase C（Scheduler & Run Loop）
- [x] AC-C1: 支持创建沙盒时配置 cron schedule。`spec.schedule` 是唯一真相源，cron 任务只是它的投影；创建/改 spec/暂停都走 `syncSandboxSchedule()` 收敛，避免改 cron 后两个调度并存。时区透传到 trigger（真实盯盘没有时区等于没有时间）。
- [x] AC-C2: schedule 触发时自动在绑定 Thread 内发起运行消息。`sandbox-run` 模板在 fire 时读**当前** spec + 已积累记忆构造运行指令，因此左栏改完下一次运行立即生效。开启 `deferWhileThreadBusy`，避免 cron 打断正在进行的 spec 编辑。
- [x] AC-C3: 支持手动触发运行和暂停/恢复 schedule。`POST /api/sandboxes/:id/run`（无 cron 也可手动跑，便于新 spec 冒烟）；暂停通过 status 收敛，paused 沙盒不再触发。
- [x] AC-C4: 每次运行生成运行记录并更新 `SandboxMemoryV1`。
  - [x] 运行记录闭环：调度器是 fire-and-forget（`trigger()` 在派发时就 resolve，没有完成回调），因此闭环走文件系统——猫把运行报告写进 `.a2a-sandbox/runs/`，store 读回。目录既是大脑也是完成通道，不需要新增完成 hook 或 MCP 工具。
  - [x] 记忆折叠：每次 fire 前先把新报告折进记忆，因此**本次运行就能读到上次学到的东西**。放在运行链路里（而非单独的蒸馏任务）使闭环自愈——无论报告是定时跑、手动跑还是成员迟到写的，下一次运行都会捡起来。

> **Phase C 已通过 review（luna，2026-08-16）**，`a3e795a1..295a75ac`。

**durable vs ephemeral（这条是月级记忆的成败关键）**：运行报告分两段——`## Summary` 是"今天发生了什么"（会过期），`## Learned` 是"从此以后都成立的判断"（要积累）。只有后者进入 `learnedItems`。两者混在一起，几个月后记忆就退化成读不动的日志。

**记忆是报告的投影**：报告由成员写、随时可能被追加或改写，而"文件写完了"在系统这边**不可知**——任何完成协议要么依赖成员配合（可能忘），要么是把启发式当保证（只会把竞态推迟）。所以摘要和学习条目**每次都从当前可见报告重新推导**，向报告当前内容收敛；半截内容会在报告写完后被自动纠正。

两个刻意的非投影例外（都是因为"丢掉积累"比"陈旧"更糟）：
- **报告被归档/删除时，学习条目不删**——报告会被清理，而学习是攒下来的资产。
- **已 promoted 的条目冻结**——内容已导出到沙盒外，静默改写本地副本会让两边不一致；分歧通过 `divergedPromotedIds` 上报而不是直接应用。

**边界策略：限制注入，不限制存储**。滚动摘要有上限（否则会撑爆 prompt 预算，被 SessionBootstrap 整段丢弃）；durable 学习条目在磁盘上永不丢弃。封顶发生在注入 prompt 时，且 prompt 会**明说还有多少条没展开**，而不是静默截断。

> ⚠️ 契约警告：`renderSandboxRunReport()`（我们让成员写的格式）与 `InMemorySandboxStore.listRunFiles()`（系统解析的格式）共用 `- Trigger:` / `- Triggered At:` / `- Spec Version:` / `## Summary` / `## Learned` 标记，且**有两个写入者**（成员按模板写、`persistRun()` 调同一渲染器）。任一侧漂移，**每次运行都会被静默丢弃**——不报错、不打日志，只是沙盒突然不再学习。该契约由 `test/sandbox-run-prompt.test.js` 的 round-trip 测试对**两个写入者**分别钉死。

> ✅ **Phase E 前置阻塞已解除（2026-08-16）**。原问题：分歧检测只覆盖"内容被改写"，不覆盖"条目被删除"——投影循环只走报告**现在说的**内容，所以成员改写报告删掉一条时，旧 `runId-index` 永久留在记忆里且不告警。
>
> **删除语义（已定）——"不见了"有两种意思，绝不能混为一谈：**
> - **报告还在，但这条没了 = 撤回。** 成员判断它错了。学习条目会注入**每一次**后续运行的 prompt，所以留着一条作者自己已收回的判断，比丢了更糟——沙盒会持续基于一个被撤回的结论推理。→ **删除**。
> - **整份报告不见了 = 归档，不是撤回。** 几个月的项目会清理报告，而学习是攒下来的资产；在这里删等于把例行清理变成失忆。→ **保留**（原有规则不变）。
> - **已 promoted 条目两种情况都不删。** 内容已导出到沙盒外，静默丢掉本地副本会和已发布的副本不一致——和"promoted 的改写只上报不应用"是同一条理由。→ **上报分歧，由 operator 决定是否撤回已发布副本。**
>
> **分歧持久化**：写在条目自己身上（`SandboxLearnedItemV1.divergence`），带**来源指纹**（`reportContent` = 报告现在说什么；retracted 时不存在，因为"它不再说了"就是指纹本身）。`observedAt` 取那份报告的 `triggeredAt` 而**不是墙上时钟**——折叠是纯函数，同一份报告折叠多少次都必须得到同样的记忆。
>
> 两条配套性质：分歧**自愈**（报告改回来就清除标记，半截报告写完属于此类），且**幂等**（同一个分歧每次折叠都继续上报给调度器，但只有第一次观察算 `changed`——否则沙盒余生每次运行都要重写一遍记忆，`changed` 就不再有意义）。

### Phase D（Frontend Dual-Pane UX v1）
- [x] AC-D1: 创建会话 modal 可选择"A2A 沙盒"，并**真的创建出 Sandbox 实体**。选项此前只是把 thread 标成 `mode=sandbox`，前端从不调用 `POST /api/sandboxes`——运行态面板读一个不存在的 id，右栏永远空白。

> **沙盒线程只和它的沙盒一起诞生**（AC-D1 契约）。`Thread.mode === 'sandbox'` 不是一个标签，而是"`thread.sandboxId` 指向一个真实 Sandbox"的断言：运行面板读它、开发态写路径靠它推 authorization、调度器往它投递。因此：
> - 前端沙盒创建走 `POST /api/sandboxes`（唯一同时创建两者的入口），成员列表**一份**同时写进 `members` 和 `spec.members`（KD-5 要求二者一致，客户端从同一个数组构造，让不一致在前端不可表达）。
> - `POST /api/threads` 与 `PATCH /api/threads/:id` **拒绝** `mode: 'sandbox'`（400 `SANDBOX_THREAD_REQUIRES_SANDBOX`），因为它们收不到 goal / members，放行只会凭空发明数据。已绑定 sandbox 的 thread 例外——那条路径是修复，不是诞生。
> - 沙盒**必须有 projectPath**：记忆、spec 历史、运行报告都在 `<projectPath>/.a2a-sandbox/`。此前它被归到"轻量模式"（casual/roundtable）而强制落在大厅，等于让沙盒没有大脑所在地。
>
> ⚠️ 旧数据：在此之前从「A2A沙盒」选项建出来的会话是孤儿（`mode=sandbox` 但无 `sandboxId`），无法补建（缺 goal/members）。删掉重建。
- [x] AC-D2: 沙盒会话顶部显示 mode、schedule 状态、回流开关 —— `SandboxSpecBar` 常驻开发态顶部（名称 / 状态 / 目标 / cron+时区 / 回流 / 成员，长文案折叠），并承载**暂停 / 恢复**。运行面板此前拒绝运行已暂停沙盒却没有任何恢复入口，那是个死路。
- [x] AC-D3: 沙盒会话渲染左右双栏，左栏可编辑 spec，右栏展示运行态。左栏 = 开发态对话（改 spec 走 AC-D4 的对话式路径），**spec 现在在左栏可见**——此前操作者是在对着一个自己看不见的东西说话；右栏 = `SandboxRunPane`（进入沙盒会话自动打开）。
- [x] AC-D4: 开发态对话修改 spec 后，目录中 `spec.yaml` 和 `spec/` 历史同步更新。成员通过 `cat_cafe_sandbox_update_spec` 走 `PATCH /api/callback/sandbox/spec`；**不接受 sandboxId**（由 invocation 的 threadId 推导），且要求调用者 ∈ `sandbox.members`（"由 thread 推导"是 scope，不是 authorization）。

> **成员在 v1 固定，不可对话式修改**（KD-5）。成员同时存在于 `Sandbox.members`（授权依据）和 `spec.members`（调度器选 runner 的依据）；允许编辑会让两者分叉，出现"被唤醒的成员无权改 spec"的运行态。因此**创建时拒绝两者不一致，所有 spec mutation path 一律拒绝 members 编辑**。此前 Phase D 文本写过"可对话式修改成员"，以本条为准。

> **Phase D 已通过 review（luna，2026-08-16）**，`f32591c9..0f3450ef`。

#### 前端沙盒面板的身份契约（Phase D review 反复撞出来的同一个形状）

两个面板都从"当前 thread"推出 sandboxId 再发请求，而 thread 是会切的。review 在四个不同位置撞到同一个错误：**显示的对象和写入的对象不是同一个**。修完后的契约是三层，缺任何一层都会复发：

1. **身份来源**：`threadId` 由 `ChatContainer` 以 prop 传入，不读全局 `currentThreadId`。ChatContainer 是用 effect 把 thread 同步进 store 的，所以切换后有一个 render/effect 窗口全局仍指着上一个 thread——在那个窗口里「立即运行」会把 POST 发给操作者已经离开的沙盒。**请求地址在发出前就错了，任何响应侧守卫都救不回来。**
2. **响应身份**（`useSandboxResource`）：generation 计数器丢弃被取代的在途响应；数据和它被取回时的 sandboxId 存在一起，id 不匹配就不交出去。切换瞬间数据置空——显示一拍空白是诚实的，显示上一个沙盒不是。
3. **调用方状态**（`isCurrent(id)` + 切换重置）：mutation 自己写的状态（trigger note / error / busy）hook 看不见，必须在**每一个 await 之后**由调用方检查。且守卫必须配套重置：`busy` 是为 A 设的，清它的 `finally` 被守卫正确跳过后就再没人清，B 的按钮会永久 disabled——**身份守卫没有配套重置，不会让标志变安全，只会让它变永久。**

> ⚠️ **已知覆盖缺口（luna 放行时记录，2026-08-16）**：`useSandboxResource.apply()` 的"切换后旧 mutation reply 不污染 B"**没有直接的 hook 回归测试**。当前安全性来自两个实现细节——调用方在 `apply` 前查 `isCurrent`，且 hook 的 sandboxId-tag getter 不会把旧数据当作 B 交出去。**新增任何 `apply` 调用方都必须沿用 `isCurrent` 守卫**，并应补上这条直测。

### Phase E（Backflow & Promotion）
- [x] AC-E1: 创建沙盒时可设置 `allowBackflow` 开关。
- [x] AC-E2: 当 `allowBackflow=true` 时，用户可在开发态把 learned item 手动提升为系统级 evidence。
  - 提升动作使用 durable **claim state machine**：`claimPromotion` → `upsertEvidence` → `completePromotion`，失败时 `releasePromotionClaim`。
  - `claimPromotion` 在写 claim 前按 `sourceRunId + content` 的 **fingerprint** 做线性化校验；同 stable id 在 claim 前被 fold 改写/撤回时直接 conflict，不会外泄旧 evidence。
  - 同内容的并发请求命中已有 active claim 时，只得到 `Promotion already in progress`，**不共享 attemptId**，也绝不 release 不属于自己的 claim。
  - Stale claim 用新 attemptId 显式 takeover，避免崩溃后遗留不可恢复的 pending 状态。
  - Claim 完成后 fold 仍按已定删除语义工作：已 promoted 的条目冻结，后续改写/撤回记录为 `divergence` 上报，不静默应用。
- [x] AC-E3: 回流操作记录完整 provenance，包括来源 sandbox / run / original content / promotedAt，不发布沙盒绝对目录为 `sourcePath`。

> **Phase E 已通过 review（terra，2026-08-22）**，`94f8692c..3d845ce3`。
>
> ⚠️ **已知 P3（本轮记录）**：`PROMOTION_CLAIM_STALE_MS` 当前为 30 秒租约启发式，用于区分崩溃遗留 claim 与仍在执行的活 claim。若 evidence write queue 极端积压超过该阈值，第二请求可能误判并 takeover 一个仍在推进的活 claim。后续应改为显式 heartbeat 或独立恢复器，而不是继续调大该常数。

## Tips Contribution（F244）

- [ ] Added/updated 1-2 tips in `packages/web/src/lib/capability-tips.seed.json`
- [ ] Existing tip sourceRef still covers this user-visible change
- [ ] If exempt, uncomment/add `tips_exempt: {reason}` in YAML frontmatter

Reviewer usefulness check: tip teaches a concrete action, timing, or traceable house rule; title-only tips must be rejected.

## Dependencies

- **Evolved from**: F011（模式系统）、F065（Thread Memory）、F102（Evidence 索引引擎）
- **Blocked by**: 无
- **Related**: F032（Agent 插件架构）、F152（经验回流）、F178（持久 Agent 跨 invocation）、F229（Concierge Thread）

## Risk

| 风险 | 缓解 |
|------|------|
| 数月运行导致沙盒记忆膨胀，context 爆炸 | 分层记忆：episodic 保留原始记录，semantic 定期蒸馏；目录级持久化避免对话压缩丢失 |
| 沙盒学习成果意外污染全局记忆 | 默认隔离，`allowBackflow` 显式开关；回流需用户手动 promote |
| 与 development 模式路由/工具链混淆 | 显式 `mode === 'sandbox'` 分支；prompt profile 独立；质量门禁保留但 SOP 剥离 |
| 双栏前端复杂度 | v1 最小实现：左右分屏，不追求复杂看板；先验证交互闭环 |
| schedule 长期运行的可观测性 | 每次运行生成记录；顶部显示下次运行时间；支持手动触发和暂停 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | v1 是否支持非 cron 的 schedule（如 interval、外部 webhook）？ | ⬜ 未定，v1 只做 cron |
| OQ-2 | 沙盒是否允许绑定非代码目录（如纯数据目录）？ | ⬜ 未定，v1 复用 projectPath 校验 |
| OQ-3 | learned item 的 promote 目标：全局 evidence 还是 skill 候选池？ | ✅ 已定为全局 evidence（derived/observed），`allowBackflow=true` 时手动 promote 写入系统级 evidence |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 模式命名为"A2A 沙盒"，枚举值 `sandbox` | co-creator 拍板，表达隔离、实验、可长期运行 | 2026-08-10 |
| KD-2 | Sandbox 与 Thread 1:1 绑定 | 目录是大脑，单一会话是 IDE 窗口；符合用户直觉 | 2026-08-10 |
| KD-3 | 持久化锚定在项目目录 | 便于迁移、版本化、独立备份；与开发协作的 projectPath 习惯一致 | 2026-08-10 |
| KD-4 | 记忆采用逻辑隔离（sandbox-scoped collection），非每个沙盒独立 sqlite | 复用现有引擎，降低实现复杂度；数据边界足够满足 v1 | 2026-08-10 |
| KD-5 | v1 成员固定，复用现有 Agent 轻分身 | 开箱即用，不要求用户配置人物设定 | 2026-08-10 |
| KD-6 | 回流采用创建时总开关 + 手动 promote | 默认隔离保护系统记忆；有价值成果可显式回流 | 2026-08-10 |
| KD-7 | 双栏 v1 为最小实现：左开发、右运行 | 先验证闭环，复杂看板留 v2 | 2026-08-10 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-08-10 | 立项，明确模式命名、核心抽象、目录约定 |
| 2026-08-10 | Phase A: schema & directory contract |
| 2026-08-23 | Phase B: backend routing & memory isolation 实现完成并通过 review（routing fail-closed + lexical/entity/raw semantic/hybrid evidence scope） |
| 2026-08-16 | Phase C: scheduler & run loop 实现完成并通过 review（luna） |
| 2026-08-16 | Phase D: frontend dual-pane UX v1 实现完成并通过 review（luna） |
| 2026-08-22 | Phase E: backflow & promotion 实现完成并通过 review（terra） |

## Review Gate

- Phase A: 跨猫 review（建议 @opus），重点审查类型定义和目录约定是否与其他模式冲突。
- Phase B: 跨族 review（建议 @claude 族或 @gpt 族），重点审查记忆隔离和路由边界。
- Phase D: 需要前端 review，建议 @sonnet 或熟悉 web 包的猫。

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F247-a2a-sandbox-mode.md` | 本 spec |
| **Mode Design** | `改造计划/01-session-modes.md` | 现有三种模式设计 |
| **Memory Architecture** | `docs/decisions/020-f102-memory-system-architecture.md` | F102 记忆系统架构 |
| **Schema Draft** | `packages/shared/src/types/sandbox.ts` | 类型定义草案 |
