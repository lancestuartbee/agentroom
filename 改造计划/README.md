# 多 Agent 协作平台改造计划

## 当前分支

本轮改造在分支 `professional-collab-platform-refactor` 上进行。

## 总目标

将当前系统从风格化较强、隐式规则较多的多 Agent 协作产品，收敛为一个可靠、专业、可解释、可验证的多前沿大模型开发团队平台。

核心保留能力：

- 平等多 Agent 协作。
- 高质量产出和门禁。
- 跨模型 review。
- 可追踪、可恢复、可审计的执行链路。

核心改进方向：

- 降低普通调用的上下文和工具成本。
- 让路由决策显式、可解释、可测试。
- 将身份约束、质量约束、工具权限、记忆召回分层控制。
- 将用户界面从风格化聊天产品收敛为专业开发团队工作台。

## 大方向

### 1. 路由系统

范围：

- 目标 Agent 选择。
- single / serial / parallel / review-pair / gate 等执行模式。
- A2A 交接规则。
- 显式 routing preview。
- 用户确认、跳数限制、ping-pong 防护。
- route decision trace。

目标：

- 用户能理解为什么某些 Agent 会参与。
- 系统能解释路由结果。
- 路由规则可以单元测试。
- 减少隐式、散落在多个模块里的规则。

### 2. 记忆系统

范围：

- thread memory。
- session chain。
- evidence search。
- graph resolve。
- recent scan。
- 长期项目知识。
- 记忆写入、召回、裁剪策略。

目标：

- 记忆召回按任务类型启用，而不是每次全量介入。
- 记忆引用可解释、可审计。
- 区分短期会话上下文、项目长期知识和证据型资料。

### 3. 前端 UI 系统

范围：

- Electron 桌面壳。
- Next/React 前端。
- macOS 风格信息架构。
- Projects / Threads 导航。
- Agents / Queue / Gates / Evidence 面板。
- token、profile、routing 状态展示。

目标：

- 从风格化聊天流，转向专业开发团队工作台。
- 保留现有 Electron + Web 架构作为第一阶段基础。
- 优先重做信息架构和关键状态展示，不先重写成原生 SwiftUI。

### 4. 身份约束与质量约束系统

范围：

- Agent 身份。
- 能力边界。
- 协作规则。
- SOP。
- 设计门、测试门、review gate、merge gate。
- verdict 和阻断规则。

目标：

- 身份约束和质量约束分离。
- 普通问答不注入完整门禁规则。
- review / gate 阶段仍保持严格。
- 去除用户可见和 prompt 层中过强的风格化表达。

### 5. 项目管理、会话管理系统

范围：

- Project / Thread / Session / Workspace 的边界。
- CLI resume。
- active slot。
- session chain。
- 跨线程切换。
- 项目路径治理。

目标：

- 明确项目、线程、运行时会话的职责。
- 保持长任务可靠恢复。
- 降低会话状态对普通交互的复杂度暴露。

### 6. 调用运行时与队列系统

范围：

- InvocationQueue。
- QueueProcessor。
- InvocationRecord。
- 并发、排队、取消、失败恢复。
- 自动续跑。
- A2A 入队。
- stale invocation 清理。

目标：

- 保留可靠性机制。
- 降低业务规则和运行时控制的耦合。
- 让执行状态、失败原因和恢复路径更容易审计。

### 7. Prompt / Context / Tool Budget 系统

范围：

- InvocationProfile。
- prompt section 开关。
- context 裁剪。
- toolset 暴露策略。
- token 预算。
- 注入审计。

目标：

- 解决普通请求上下文过重、工具过多、token 成本过高的问题。
- 按任务类型决定注入内容和工具集合。
- 记录每次调用注入了什么、为什么注入、估算 token 多少。

初步 profile：

- `quick_answer`：极简上下文，极少工具。
- `dev_task`：项目上下文和必要工具。
- `review_gate`：完整审查规则、测试要求、证据要求。
- `merge_gate`：最严格门禁。
- `a2a_handoff`：只注入交接信息，不重复全量系统规则。

### 8. 工具、MCP 与权限边界系统

范围：

- MCP toolset。
- callback token。
- agent-key。
- 只读工具和写入工具。
- 人类审批。
- workspace 访问边界。
- provider 侧工具可见性。

目标：

- 工具按 profile 和权限边界暴露。
- 普通问答不让模型看到过多工具。
- 高风险动作需要清晰审批和审计。

### 9. 观测、审计、成本与评估系统

范围：

- invocation trace。
- route decision trace。
- prompt 注入审计。
- 工具调用记录。
- token 成本。
- 失败原因。
- review 记录。
- 回放测试。

目标：

- 每项改造都能验证是否真的变好。
- 能比较改造前后的 token、工具调用次数、路由行为和产出质量。
- 支持后续真实 CLI 手动测试与自动化测试结合。

## 优先级

### 第一优先级

- Prompt / Context / Tool Budget 系统。
- 路由系统。

原因：

- 这是上下文爆炸、工具调用过多、隐式派活和用户学习成本高的根因层。
- 先改这里，可以在不破坏核心协作能力的前提下降低成本和复杂度。

### 第二优先级

- 身份约束与质量约束系统。
- 调用运行时与队列系统。

原因：

- 质量门禁需要保留，但要从普通问答链路中拆出来。
- 运行时可靠性很重要，不适合第一轮大改，只做必要解耦和审计。

### 第三优先级

- 前端 UI 系统。
- 项目管理、会话管理系统。

原因：

- UI 重构要基于新的 routing/profile 状态。
- 会话模型改动风险较高，需要在前两项稳定后推进。

### 第四优先级

- 记忆系统。
- 观测、审计、成本与评估系统深化。

原因：

- 记忆系统重要，但不应先于 profile 和路由重构。
- 第一阶段会先做基础审计，后续再深化评估体系。

## 一周目标

一周内不追求完成全部 9 项改造，而是优先完成第一优先级的可验证 v1。

交付目标：

- 普通问答明显轻量化。
- 复杂任务仍可升级为严格协作和门禁。
- 路由决策显式、可解释、可测试。
- 工具暴露按任务类型收缩。
- prompt 注入可审计。
- 不破坏现有多 Agent 协作和门禁主链路。

非目标：

- 不做全量内部命名迁移。
- 不完整重写记忆系统。
- 不完整重写 UI。
- 不大规模重写 queue/runtime/session。
- 不一次性清理所有历史风格化代码。

## 一周建议节奏

### Day 1：基线与设计

- 记录当前简单问答的 prompt 注入、工具暴露、token、工具调用次数。
- 固定会话模式设计：闲聊 / 圆桌会议 / 开发协作。
- 写 `InvocationProfile v1` 设计。
- 写 `RoutingPolicy v1` 设计。
- 明确哪些约束只在 gate/review 时开启。

### Day 2-3：Prompt / Context / Tool Budget

- 实现 `InvocationProfile`。
- 按 profile 控制 prompt section。
- 按 profile 控制 MCP/toolset 暴露。
- 加注入审计。
- 单测覆盖 profile 选择、section 开关、工具策略。

### Day 3-4：路由系统 v1

- 把路由决策显式化。
- 增加 route decision trace。
- 减少隐式 A2A 触发。
- 定义 routing preview 的后端数据结构。
- 单测覆盖 mention、默认路由、parallel、serial、A2A 限制。

### Day 4-5：身份约束 / 质量约束拆分的必要兼容

- 把 Agent 身份和 SOP/质量门禁拆成不同 prompt section。
- 普通聊天默认轻量。
- review/gate 模式启用完整质量约束。
- 测试重点是不能让 review/merge gate 降质。

### Day 5-6：前端最小展示

- 不做完整 UI 重写。
- 增加或预留 routing preview、active agents、profile、token 审计入口。
- 去掉最明显的用户可见风格化文案。

### Day 6-7：集成测试与真实 CLI 验证

- 跑现有 check/test。
- 增加 mock provider 集成测试。
- 手动测试 Claude / Codex / Gemini 的真实行为。
- 对比改造前后简单问答和 review gate 的表现。

## 验证原则

每一项改动按以下流程推进：

1. 先写小设计说明，明确保留、删除、降级什么。
2. 小范围实现。
3. 单元测试覆盖纯逻辑。
4. 集成测试覆盖 API 到 mock agent 的执行链。
5. 前端改动用组件测试或 Playwright 验证关键状态。
6. 真实 CLI 手动测试重点关注 token、工具调用次数、上下文长度、质量门禁是否仍有效。

## 后续文档规划

后续讨论和实现文档放在本目录下：

- `01-session-modes.md`
- `02-artifact-store.md`
- `02-invocation-profile.md`
- `03-routing-policy.md`
- `04-prompt-context-budget.md`
- `05-quality-gates.md`
- `06-ui-workbench.md`
- `07-memory-system.md`
- `08-runtime-queue.md`
- `09-tool-permissions.md`
- `10-observability-evaluation.md`
- `11-codex-app-server-carrier.md`
