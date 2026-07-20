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

### 最终版设计（第一阶段已验收）

闲聊模式第一阶段的定位已经收敛为：

```text
轻量、多模型观点、可指定成员、可保存 Markdown 产物、默认不进入开发协作链路。
```

它不是开发协作模式的“弱版本”，而是一条相对独立的控制流，只复用底层消息、线程、provider 调用、产物登记和前端面板等基础设施。

#### 会话创建

闲聊模式创建时不绑定项目目录。

创建入口显示的是参与 Agent 选择，而不是项目路径选择：

- 用户可以选择一位或多位 Agent 加入会话。
- 选择结果写入 `Thread.preferredCats`，作为该闲聊会话的成员边界。
- 如果没有显式选择成员，系统可以回退到已有参与者/默认可路由 Agent，但 UI 不应显示开发协作项目选择。

#### 路由与 audience

闲聊会话使用 `Thread.mode = casual` 和 `Thread.audience`。

最终路由语义：

- 无 @：使用当前 audience。
- 初始 audience 默认为 `all`，含义是当前闲聊会话成员全员回复。
- `@某个成员`：只让该成员回复，并把后续无 @ 对话保持在该成员上。
- `@多个成员`：只让这些成员回复，并把后续无 @ 对话保持在这些成员上。
- `@all` / `@全体`：恢复为当前闲聊会话成员全员回复，之后无 @ 继续全员。

前端 `@` 候选必须按闲聊成员边界裁剪：

- 只展示 `preferredCats` 中的个体成员。
- 若 `preferredCats` 缺失，才退回 thread participants。
- 只保留 `@all` 作为群体入口。
- 不展示开发协作遗留的 `@thread`、品种全体或未加入会话的 Agent。

后端也必须执行同样边界：

- 用户手打未加入成员的 mention，不应绕过 casual membership。
- 越界 mention 应退回当前 casual audience，而不是唤醒未加入会话的 Agent。

#### Prompt / Context

闲聊模式使用独立 `casual` prompt profile，不再复用完整开发协作 L0。

保留：

- 最小身份：是谁、来自哪个模型/提供方、日常背景/关注点、说话倾向。
- 当前模式边界：这是闲聊，不是开发协作、代码审查、任务执行或圆桌审议。
- 风格边界：自然、克制、清楚；不反复强调工作职责；避免过度拟人化。
- 工具边界：无明确要求时不调用工具、不读写文件、不运行命令、不发起 A2A/任务/交接。
- 产物边界：如需保存 Markdown 报告或对话产物，只写入共享 reports 目录，并在回复中给出 Markdown 链接。

剔除：

- 完整 SOP。
- review gate / merge gate。
- 开发质量门禁。
- teammate roster。
- MCP 工具说明。
- A2A handoff 协议。
- 项目治理和开发工作流触发点。

上下文预算使用 casual 专属预算：

```text
maxPromptTokens: 3200
maxContextTokens: 900
maxMessages: 8
maxContentLengthPerMsg: 1200
```

#### 工具与写入权限

闲聊模式不是只读模式。

默认行为：

- 不主动调用工具。
- 不主动写文件。
- 不主动搜索。

当用户明确要求时：

- 可以搜索当前信息。
- 可以读取用户指定文件。
- 可以保存/导出 Markdown 报告。
- 可以使用完成该动作必需的最小工具。

GPT/Codex 闲聊可写策略：

- 新建 casual Codex CLI session 时，如果全局 sandbox 是 `read-only`，自动提升为 `workspace-write`。
- 不采用“检测到写意图后重启 CLI”的策略，避免破坏 session 复用和 prompt cache。
- Codex casual provider session 使用版本化存储 key：`threadId::provider-session:codex-casual-writable-v1`，避免恢复历史 read-only casual session。

#### Provider Session

闲聊模式复用 provider session，但不启用开发协作的 session-chain/bootstrap/seal 控制流。

原则：

- `development` 和 `casual` 不跨 profile 复用 native/provider session。
- 同一 `user + thread + cat + casual profile` 内尽量复用 provider session。
- 复用目标是降低每轮 CLI cold start 和提高 prompt cache 命中。
- 不把开发协作 MCP、用户成员编辑器里的额外 CLI args、完整工具配置带入 casual。

已验证的短期优化：

- Claude casual stream-json carrier 可在同一 thread + cat 内复用进程，并过滤每轮变化的 callback env。
- Codex casual effort 以 `medium` 为上限，并过滤每轮变化的 callback env。
- Codex app-server 常驻 carrier 暂缓，记录在 `11-codex-app-server-carrier.md`。

#### 产物保存和下载

闲聊模式不绑定项目目录，但每个 thread 有统一产物目录：

```text
~/Documents/AgentRoom/profiles/<profile-key>/threads/<threadId>/reports/
```

实际实现采用 CLI 友好的方式：

- 调用 Agent 时，将 workingDirectory 设为当前 thread 的 `reports` 目录。
- Agent 可以直接在该目录写 Markdown 文件。
- 本轮结束后，平台扫描并登记该目录下新增/更新的 Markdown 产物。
- 产物进入右侧 workspace/artifacts 面板。
- 对话中的本地绝对路径、file URI、artifact-store content 链接和部分历史链接都会被转换为下载入口。
- 下载使用后端 `Content-Disposition` 原始文件名，支持中文文件名，不再强制重命名。

安全边界：

- 只允许同一 thread 的 `reports` 目录内产物走下载。
- 后端用 `realpath` 处理 macOS `AgentRoom` / `agentroom` 大小写或显示名差异。
- 不允许任意本地路径下载。

#### 模式升级

第一阶段只支持闲聊升级到开发协作：

- 不在原 thread 原地切换。
- 创建新的开发协作 thread。
- 要求选择项目目录。
- 新 thread 写入来源闲聊背景摘要。
- 旧闲聊 thread 和其中产物继续保留。

闲聊升级到圆桌会议保留为产品方向，但圆桌控制流未实现前不开放可执行路径。

#### 已知遗留

- 平台侧 memory digest 尚未实现；当前闲聊主要依赖短上下文和 provider session。
- provider 级工具物理隐藏还未彻底完成；第一阶段主要靠 prompt profile、MCP 裁剪、A2A depth 和 CLI 启动参数收缩。
- 前端当前 audience 状态还没有作为清晰状态条展示。
- Agent 自己写 Markdown 链接文字时可能包含“打开/下载”等动作词；当前判断为模型表达问题，不影响下载逻辑，暂不收紧 prompt。

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
tools: none by default; minimal tools only on explicit user request
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

它要解决的问题不是“让所有 Agent 都各说一句”，而是：

```text
让多个前沿模型围绕同一议题独立判断、暴露分歧、互相回应、有限修正，并在不能说服所有人时保留少数意见。
```

设计底线：

- 不走开发协作的自由 A2A。
- 不让 Agent 随意 @ 其他 Agent 触发无限链路。
- 不默认开放开发工具、写文件工具或项目目录。
- 不强制伪共识。
- 不把多数意见包装成“所有 Agent 已同意”。
- 不为了结束流程抹掉少数意见。
- 不在状态存储里复制完整会议内容；消息流本身是会议内容的 SoT。

### 产品入口

创建会话时选择：

```text
圆桌会议
```

第一版要求用户明确选择参与 Agent：

- `preferredCats` 作为固定圆桌成员。
- 创建后成员默认不随路由变化。
- 后续可以再设计“邀请新成员加入圆桌”，但不进入 v1。

圆桌会议可以不绑定项目目录。

若用户讨论的是开发任务，应先保持圆桌的讨论性质；只有当用户明确要落地执行时，再升级到开发协作 thread。

### 议题状态机

圆桌会议不是“每条用户消息都固定跑完整流程”，而是维护当前议题状态。

会话顶部应展示当前议题进度：

```text
独立立场 -> 互评循环 1/5 -> ... -> 共识投票 -> 会议总结
```

用户发新消息时，平台先判断这句话是在：

- 开启新议题。
- 追问当前议题中的某个观点。
- 要求继续推进当前议题。
- 要求重新投票或重新总结。

第一版状态只保存流程索引和路由决策字段，不保存完整会议内容：

```ts
interface RoundtableIssueStateV1 {
  issueId: string;
  threadId: string;
  topic: string;
  status: 'open' | 'voting' | 'summarized' | 'closed';
  stage:
    | 'independent_stance'
    | 'critique_loop'
    | 'consensus_vote'
    | 'final_summary';
  critiqueRound: number;
  maxCritiqueRounds: 5;
  participants: string[];
  lastPhaseMessageId?: string;
  finalSummaryMessageId?: string;
  updatedAt: number;
}
```

不存：

- 每只猫完整立场内容。
- 每条挑战内容。
- 每轮回复正文。
- 完整投票理由。

这些内容作为普通会话消息保存。需要继续推进时，后端从最近圆桌消息中读取上下文。

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

圆桌会议采用 4 个阶段，其中第二阶段是最多 5 轮的受控互评循环。

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

#### 2. 互评循环阶段

互评循环不是自由聊天，而是按轮次批处理。

每一轮：

1. 平台把上一阶段观点、上一轮挑战、上一轮回应和当前分歧整理成上下文。
2. 每只猫按自己收到的挑战回复。
3. 每只猫必须明确自己是否修订立场。
4. 每只猫可以继续提出新的实质挑战，指向固定参会人。
5. 平台收集新挑战，作为下一轮输入。

单轮输出建议：

```text
收到的挑战
对挑战的回应：接受并修订 / 部分接受 / 拒绝 / 需要证据 / NO_CHANGE
当前立场是否变化
新的挑战：@catId + challenge
```

最大轮数：

```text
maxCritiqueRounds = 5
```

提前结束条件：

- 所有猫都没有新挑战。
- 所有猫都没有修订立场。
- 所有猫都接受同一个结论草案。
- 剩余分歧已经明确标记为“无法在当前材料下解决”。

达到 5 轮后，即使仍未互相说服，也进入投票，不继续嵌套。

#### 3. 共识投票阶段

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

#### 4. 最终输出阶段

最终输出区分：

```text
已达成共识
当前最优结论
未解决分歧
少数意见
需要进一步验证的证据
建议下一步
```

最终总结必须给用户一个决策视图：

```text
多数观点是什么
哪些部分已经达成共识
哪些分歧仍然存在
少数观点是谁坚持的
少数观点的核心理由
哪些证据会改变各方判断
用户下一步可以追问哪里
```

### 追问与继续推进

用户在议题总结后或互评过程中可能追问某只猫的某个观点。

路由规则：

- 无 @ 或明确说“大家讨论 / 形成共识 / 继续圆桌”：按当前议题状态推进。
- `@某只猫`：被点名猫先回答。
- `@多只猫`：被点名猫按轻量并行回答。
- 其他固定参会猫默认拥有有限插话权：只有存在实质补充、反驳、事实纠错或风险提示时才发言；否则输出 `NO_COMMENT`，前端不展示。
- 用户明确说“只让 X 回答”时，严格单猫回答，不允许旁听猫插话。
- 点名追问不改变圆桌固定参会名单，不自动进入投票，也不伪造共识。
- 用户追问后如果要求“基于这个继续收束 / 重新投票 / 重新总结”，平台继续使用当前议题状态，而不是丢弃上一轮成果。

### 消息 Rich Block

每只猫的立场、挑战、回应和投票理由作为普通会话消息保存，并可用 rich block 展示。

状态机只保存进度索引；具体内容在消息气泡里表达：

```ts
interface RoundtableRichBlockV1 {
  kind: 'roundtable';
  issueId: string;
  phase:
    | 'independent_stance'
    | 'critique_loop'
    | 'consensus_vote'
    | 'final_summary'
    | 'followup';
  critiqueRound?: number;
  title?: string;
  sections: Array<{
    title: string;
    body: string;
  }>;
}
```

第一版可以先要求 Agent 按 Markdown 小标题输出；如果 rich block pipeline 改动过大，再把结构化渲染延后到下一刀。

### Prompt Profile

圆桌会议对应 profile：

```text
roundtable_deliberation
```

保留：

- 最小身份和模型视角差异。
- 当前阶段说明。
- 议题。
- 最近阶段消息摘要。
- 明确输出格式。
- 必须回应分歧、证据和不确定性。

剔除：

- 完整开发 SOP。
- merge/review gate。
- 文件编辑和命令执行工具。
- 自由 A2A handoff。
- 项目工作流和任务执行协议。

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

### UI v1

第一版前端不需要复杂视觉设计，但需要让用户看懂进度：

- 会话顶部显示 `Mode: 圆桌会议`。
- 显示固定参与 Agent。
- 显示当前议题。
- 显示当前阶段和互评轮次。
- 消息流中每个阶段有清晰分隔。
- 每只猫的消息气泡中结构化展示立场、挑战、回应、投票。

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

### 验收标准

第一版圆桌会议至少要通过：

- 创建 roundtable thread 后不会走 development 旧通道。
- 不 @ 时不会按 casual audience 直接全员普通回复，而是进入 roundtable controller。
- 每个 Agent 在第一阶段独立产出立场。
- 互评循环最多 5 轮，且按批次推进，不触发自由 A2A。
- 互评循环中 Agent 能看到收到的挑战，并能修订或坚持立场。
- 共识投票允许 `reject`。
- 最终总结不会把 `reject` 说成全员同意。
- 用户点名追问时，被点名猫优先回答，其他固定参会猫只有有限插话权。
- 开发协作模式不受影响。

### 暂不做

- 原地从开发协作降级到圆桌。
- 圆桌内自由 A2A。
- 文件修改、命令执行、merge gate。
- 复杂图形化 board 编辑器。
- 自动长期记忆写入。

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
tools: none by default; explicit search/read/write can use minimal required tools
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
5. 闲聊模式 prompt/tool policy：minimal prompt + default-no-tools + explicit-request minimal tools。
6. 平台侧记忆 prefetch 的接口占位，第一版可先关闭或只做最小 digest。
7. 圆桌会议 `DeliberationBoard` 最小结构。
8. 圆桌会议阶段流转。
9. 前端创建会话模式选择。
10. 前端显示 mode/audience/profile/tools。
11. 补测试和真实 CLI 验证。

## 当前结论

三模式方案作为第一阶段改造主线：

```text
闲聊：轻量、多模型观点、记忆优先、默认不主动用工具。
圆桌会议：受控多模型审议、分歧回应、共识检测。
开发协作：保留现有强协作与质量门禁，后续灰度重构。
```

这条路径能优先解决 Claude Code 在非开发场景下损耗过大的问题，同时不破坏已有开发协作能力。
