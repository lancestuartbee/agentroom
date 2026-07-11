# 01. 会话模式设计：闲聊 / 圆桌会议 / 开发协作

## 背景

当前系统的主要问题之一是：所有场景都容易进入偏重的开发协作链路。

这会导致非代码任务也加载过多身份约束、质量约束、MCP 工具、记忆工具、路由规则和 A2A 协作协议，尤其会让 Claude Code CLI 在简单问答中产生过高 token 消耗和工具调用成本。

因此第一阶段不直接重构开发协作主链路，而是新增更清晰的会话模式：

- 闲聊模式。
- 圆桌会议模式。
- 开发协作模式。

其中：

- 闲聊和圆桌会议走新的轻量核心。
- 开发协作先保留现有逻辑，作为稳定旧通道。

## 总原则

### 1. 会话模式显式选择

创建会话时由用户选择模式：

```text
闲聊
圆桌会议
开发协作
```

模式不应完全依赖自动识别。系统可以做建议和局部升级，但不能隐式把低成本会话升级成高成本开发链路。

### 2. 新旧执行通道分离

第一阶段采用双通道：

```text
新通道：闲聊模式 / 圆桌会议模式
旧通道：开发协作模式
```

开发协作模式暂时保留现有 AgentRouter、Queue、route-serial、route-parallel、MCP callback 和质量门禁机制。

闲聊和圆桌会议作为新核心的第一批落地模式，用来验证：

- 低 token 成本。
- 低工具暴露。
- 显式路由。
- 多模型观点。
- 受控审议。

### 3. 质量约束不删除，只按模式启用

闲聊和圆桌会议默认不注入完整 SOP、review gate、merge gate。

开发协作继续保留现有质量约束。后续再通过 shadow/advisory/enforce 的灰度方式重构开发协作模式。

## 模式一：闲聊模式

### 当前实现状态（第一阶段）

已完成：

- `Thread.mode` / `Thread.audience` 已进入内存存储、Redis 存储和 `/api/threads` 创建/更新接口。
- `AgentRouter` 在 `mode=casual` 时启用独立路由规则：
  - 无 @：按当前 `Thread.audience` 路由。
  - `@agent` / 多个 `@agent`：切换为 selected audience。
  - `@all` / `@全体`：切换回 all audience。
- 闲聊模式下多 Agent 默认强制走 `ideate` 并行回复，避免误入串行 A2A 链路。
- 闲聊模式执行时注入短 `Casual mode` prompt，并设置 `maxA2ADepth=0`。
- 新建对话 modal 已开放 `开发协作 / 闲聊` 两个模式；默认仍为开发协作，避免改变旧行为。
- 闲聊模式已改为独立轻量 prompt profile：不再加载完整开发 L0、SOP、质量门禁、teammate roster、MCP 工具说明。
- provider session 已按 prompt profile 隔离：`development` 继续沿用旧 key，`casual` 使用独立 session/profile key，避免跨模式复用 native session。
- 闲聊会话已支持手动升级为新的开发协作会话：旧闲聊保留，新会话绑定项目目录，并写入一条来源闲聊的背景摘要。

未完成：

- provider 级工具禁用还未做；当前先通过 mode prompt + A2A depth 限制降低误触发。
- 平台侧 memory digest 还未接入。
- 前端尚未显示当前 audience 状态。
- 圆桌会议模式尚未开放到 UI。

### 目标

闲聊模式用于非代码、非执行类任务。

它的核心能力是：

- 来自多个模型 Agent 的独立观点。
- 可选的轻量记忆召回。
- 极低工具和 prompt 成本。

### 默认行为

闲聊模式下，用户不 @ 任何 Agent 时，当前会话参与者都回复。

```text
用户：你怎么看这个产品方向？
Claude：...
Codex：...
Gemini：...
```

这里的“全员”指当前会话参与者，不一定是系统内所有已配置 Agent。

### 指定对话对象

用户明确 @ 某个 Agent 时，仅该 Agent 回复。

```text
用户：@Claude 你怎么看？
Claude：...
```

之后用户继续不 @ 时，默认继续与上次明确指定的 Agent 对话。

```text
用户：那你展开讲讲
Claude：...
```

直到用户显式 `@all`，系统恢复为全员回复。

```text
用户：@all 其他人怎么看？
Claude：...
Codex：...
Gemini：...
```

之后用户不 @ 时，默认继续全员回复。

### Audience 状态

闲聊模式需要引入会话级 audience 状态：

```ts
type ThreadAudience =
  | { mode: 'all' }
  | { mode: 'selected'; agentIds: string[] };
```

路由规则：

- 无 @：使用当前 `Thread.audience`。
- `@agent`：设置 `Thread.audience = selected([agent])`。
- `@agentA @agentB`：设置 `Thread.audience = selected([agentA, agentB])`。
- `@all`：设置 `Thread.audience = all`。

前端必须显示当前 audience，例如：

```text
当前对话对象：全员
当前对话对象：Claude
当前对话对象：Claude, Codex
```

### 工具和记忆策略

闲聊模式默认：

```text
tools: none
A2A: off
SOP/gate: off
identity: minimal
memory: platform-prefetch only
```

记忆不建议由每个 Agent 自己调用 MCP memory tool。

更好的方式是：

1. 平台侧根据用户问题和 thread 做轻量记忆检索。
2. 平台生成简短 memory digest。
3. 将 digest 注入给参与回复的 Agent。

这样可以避免每个 Agent 都加载工具 schema、再分别调用记忆工具。

### InvocationProfile

闲聊模式对应 profile：

```text
casual_chat
```

基础策略：

```text
prompt sections:
  - minimal_identity
  - user_message
  - short_recent_context
  - optional_memory_digest

excluded sections:
  - full_sop
  - quality_gate
  - project_governance
  - a2a_protocol
  - full_tool_instructions
  - development_workflow

tool policy:
  - no provider-visible tools by default
  - optional platform-side memory prefetch
```

## 模式二：圆桌会议模式

### 目标

圆桌会议模式用于正式讨论、观点碰撞和决策收束。

它的核心能力是：

- 多模型独立判断。
- 显式分歧。
- 结构化反驳。
- 有限轮修正。
- 共识检测。
- 允许保留少数意见，不强制一致。

### 与普通 A2A 的区别

圆桌会议不是自由 A2A。

它不是：

```text
Agent 想 @ 谁就 @ 谁，系统自动触发下一轮。
```

而是：

```text
系统创建一个受控审议流程，固定参与者、固定阶段、固定最大轮数。
```

因此它应被视为一个独立的 deliberation protocol，而不是开发协作中的自由 handoff。

### 审议流程

圆桌会议建议采用 6 个阶段。

#### 1. 独立立场阶段

每个 Agent 先独立回答，不看其他 Agent 的答案。

目的：

- 保留模型差异。
- 避免先发观点锚定后发 Agent。
- 得到真实的初始分歧。

每个 Agent 输出：

```text
stance
key reasons
confidence
main risks
```

#### 2. 公开观点阶段

平台把所有初始观点整理到公共黑板。

公共黑板不做最终裁判，只结构化保存：

```text
options
claims
reasons
risks
uncertainties
initial disagreements
```

#### 3. 交叉质询阶段

每个 Agent 读取公共黑板，并明确回应其他 Agent 的观点。

必须回答：

```text
我同意哪些点？
我不同意哪些点？
对方哪些论据不充分？
什么证据会改变我的判断？
```

#### 4. 修正阶段

每个 Agent 可以修改自己的立场，也可以坚持原观点。

必须说明：

```text
是否改变立场？
改变了什么？
接受了谁的哪些论点？
仍然不同意什么？
为什么？
```

#### 5. 共识检测阶段

平台生成候选综合结论，然后要求每个 Agent 显式表态：

```text
accept
accept_with_conditions
reject
```

每个 Agent 必须给出理由。

重点：

- 不能把多数同意伪装成全员共识。
- 不能为了结束流程强制 Agent 接受。
- 不接受的少数意见必须保留。

#### 6. 最终输出阶段

最终输出区分：

```text
已达成共识
当前最优结论
未解决分歧
少数意见
需要进一步验证的证据
建议下一步
```

### DeliberationBoard

圆桌会议需要一个会话内公共黑板：

```ts
interface DeliberationBoard {
  id: string;
  threadId: string;
  topic: string;
  participants: string[];
  phase:
    | 'initial_stance'
    | 'public_board'
    | 'cross_examination'
    | 'revision'
    | 'consensus_check'
    | 'final';
  claims: DeliberationClaim[];
  options: DeliberationOption[];
  objections: DeliberationObjection[];
  concessions: DeliberationConcession[];
  votes: DeliberationVote[];
  unresolvedDisagreements: string[];
  finalConclusion?: string;
}
```

第一阶段可以先存为 thread extra metadata 或普通 message extra，后续再决定是否需要独立 store。

### 工具和记忆策略

圆桌会议默认：

```text
tools: none or memory_readonly
development tools: off
A2A: controlled deliberation only
SOP/gate: off by default
memory: platform-prefetch + optional evidence digest
```

如果讨论明确需要证据，后续可以加入 `evidence_needed` 子阶段，但默认不让每个 Agent 自由调用完整工具集。

### InvocationProfile

圆桌会议对应 profile：

```text
roundtable_deliberation
```

基础策略：

```text
prompt sections:
  - minimal_identity
  - deliberation_phase_instruction
  - topic
  - board_digest
  - optional_memory_or_evidence_digest

excluded sections:
  - full_development_sop
  - merge_gate
  - file_editing_tools
  - freeform_a2a_handoff

tool policy:
  - no write tools
  - no project mutation
  - optional platform-side memory/evidence prefetch
```

## 模式三：开发协作模式

### 目标

开发协作模式用于代码实现、调试、review、安全分析、测试、merge gate 等任务。

第一阶段目标不是重写它，而是保留现有机制，避免破坏已经存在的多 Agent 开发协作能力。

### 第一阶段行为

开发协作模式继续走旧通道：

```text
AgentRouter
InvocationQueue
QueueProcessor
route-serial
route-parallel
MCP callback
质量门禁
现有 session/resume 机制
```

也就是说：

```text
Thread.mode = development
```

时，默认不启用新通道的 casual/roundtable 执行逻辑。

### 后续灰度改造

开发协作模式后续按以下顺序灰度：

#### 1. Shadow mode

旧系统照常执行。

新核心同时生成一份建议决策：

```text
如果由新核心处理，本次 profile 是什么？
会选择哪些 Agent？
会开放哪些工具？
会注入哪些 prompt section？
```

结果只写审计，不影响行为。

#### 2. Advisory mode

前端展示新核心 routing/profile preview，但旧系统仍执行旧逻辑。

#### 3. Low-risk enforce

只让新核心接管低风险开发问答：

```text
quick_code_qna
无文件修改
无命令执行
无 review/gate
无 A2A
```

#### 4. Prompt/tool policy 接管

路由仍可暂用旧逻辑，但 prompt section 和 toolset 按 InvocationProfile 控制。

#### 5. 复杂开发协作接管

逐步接管：

```text
implementation
debugging
review_gate
merge_gate
a2a_handoff
```

#### 6. 清理旧规则

只有当新核心覆盖足够测试和真实 CLI 验证后，才删除旧的隐式规则。

## 数据模型建议

### Thread.mode

新增会话模式字段：

```ts
type ThreadMode = 'casual' | 'roundtable' | 'development';
```

旧 thread 默认：

```text
development
```

避免旧数据行为改变。

### Thread.audience

闲聊模式需要 audience：

```ts
type ThreadAudience =
  | { mode: 'all' }
  | { mode: 'selected'; agentIds: string[] };
```

默认：

```text
all
```

### InvocationProfile

初步 profile：

```ts
type InvocationProfile =
  | 'casual_chat'
  | 'roundtable_deliberation'
  | 'dev_task'
  | 'review_gate'
  | 'merge_gate';
```

第一阶段重点实现：

```text
casual_chat
roundtable_deliberation
```

开发相关 profile 先作为后续扩展点。

## 路由原则

### 闲聊模式

```text
mode: casual
route: audience-based
A2A: off
tools: none
memory: platform-prefetch
```

### 圆桌会议模式

```text
mode: roundtable
route: fixed participants
A2A: controlled deliberation protocol
tools: none or memory/evidence readonly
memory: platform-prefetch
```

### 开发协作模式

```text
mode: development
route: existing behavior
A2A: existing behavior
tools: existing behavior
quality gates: existing behavior
```

## 前端行为

### 创建会话

创建会话时选择：

```text
闲聊
圆桌会议
开发协作
```

UI 应简短解释成本和行为差异。

### 会话顶部状态

会话顶部显示：

```text
Mode: 闲聊 / 圆桌会议 / 开发协作
Audience: 全员 / Claude / Claude, Codex
Profile: casual_chat / roundtable_deliberation / development legacy
Tools: none / memory readonly / full development
```

### 模式切换

第一阶段不做任意原地切换，而是把“升级”为一等动作：

```text
闲聊 -> 开发协作：创建新的开发协作会话，带闲聊背景摘要，要求选择项目目录
闲聊 -> 圆桌会议：保留目标模式和 API 占位，圆桌控制流实现前不真正创建可执行圆桌会话
开发协作 -> 闲聊：第一阶段不支持
```

设计原因：

- 不跨模式复用 provider/native session，避免旧系统提示词、工具状态或开发上下文残留。
- 闲聊产物仍保留在闲聊会话目录；开发会话绑定项目目录后再产生开发产物。
- 如果用户只是想闲聊过去项目经验，应在闲聊会话中通过记忆库/历史检索引用项目经验，而不是把开发会话降级为闲聊。
- 对用户而言 UI 可以表现为“从当前想法升级”，但底层是新的 thread 和新的 prompt/session profile。

## 测试策略

### 单元测试

覆盖：

- `Thread.mode` 默认值。
- 闲聊 audience 状态机。
- `@agent` / `@all` 解析。
- 闲聊路由目标。
- 圆桌会议阶段流转。
- 圆桌会议共识检测。
- 开发协作模式仍走旧通道。

### 集成测试

覆盖：

- 创建闲聊 thread 后普通消息触发所有参与者。
- 闲聊 thread 中 @ 单 Agent 后只触发该 Agent。
- @all 后恢复全员。
- 圆桌会议创建 board 并完成至少一轮阶段流转。
- development thread 行为与当前主链路保持兼容。

### 真实 CLI 测试

重点验证：

- 闲聊模式下 Claude Code 不再加载完整开发工具和 SOP。
- 闲聊模式下工具调用次数显著下降。
- 圆桌会议中 Agent 能明确回应分歧。
- 圆桌会议最终输出不会强制伪共识。
- 开发协作模式未被新模式破坏。

## 第一阶段实现顺序

建议开发顺序：

1. 新增 `Thread.mode` 和默认值。
2. 新增 `Thread.audience`。
3. 创建新核心入口，先处理 `casual` 和 `roundtable`。
4. 闲聊模式路由：audience-based routing。
5. 闲聊模式 prompt/tool policy：minimal prompt + no tools。
6. 平台侧记忆 prefetch 的接口占位，第一版可先关闭或只做最小 digest。
7. 圆桌会议 `DeliberationBoard` 最小结构。
8. 圆桌会议阶段流转。
9. 前端创建会话模式选择。
10. 前端显示 mode/audience/profile/tools。
11. 补测试和真实 CLI 验证。

## 当前结论

三模式方案作为第一阶段改造主线：

```text
闲聊：轻量、多模型观点、记忆优先、无工具。
圆桌会议：受控多模型审议、分歧回应、共识检测。
开发协作：保留现有强协作与质量门禁，后续灰度重构。
```

这条路径能优先解决 Claude Code 在非开发场景下损耗过大的问题，同时不破坏已有开发协作能力。
