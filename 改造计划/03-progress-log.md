# 03. 改造进展日志

## 2026-07-13

### CLI carrier / session 复用边界收窄

完成内容：

- Claude stream-json carrier 不再硬编码只支持 casual，而是按“是否安全复用”决定：
  - casual 继续直接使用常驻 stream-json 进程。
  - development 在没有 per-turn callback MCP 凭证时也可复用 stream-json。
  - development 如果携带 `CAT_CAFE_INVOCATION_ID` / `CAT_CAFE_CALLBACK_TOKEN`，自动回退旧 Claude carrier，避免常驻进程持有首轮 callback token 后串 invocation。
  - 带图片或显式 `spawnCliOverride` 的调用仍回退旧 Claude carrier。
  - 未标注 prompt profile 的直连调用仍保持旧 fallback 行为，避免默认/未知入口被误接管。
- Codex 子进程现在所有 profile 都过滤一次性 callback env；development 的 MCP callback token 仍通过 per-invocation MCP config 注入，不依赖父 Codex 进程 env。

验证：

```bash
corepack pnpm --filter @cat-cafe/api run build
node --test packages/api/test/claude-stream-json-carrier.test.js packages/api/test/claude-carrier-factory.test.js
node --test --test-name-pattern "casual prompt profile uses lightweight Codex CLI launch flags|casual prompt profile upgrades read-only sandbox|casual prompt profile resumes Codex CLI session|injects cat-cafe MCP config|uses env-configured sandbox|unknown Codex cat falls back" packages/api/test/codex-agent-service.test.js
node --test --test-name-pattern "casual mode reuses profile-scoped provider session|casual Codex sessions use a writable sandbox storage namespace" packages/api/test/invoke-single-cat.test.js
node --test packages/api/test/casual-mode-routing.test.js packages/api/test/casual-prompt-profile.test.js
git diff --check
```

结果：

- API build 通过。
- Claude stream-json carrier + carrier factory 测试通过。
- Codex casual 启动参数、sandbox、resume、MCP 注入与默认配置回归测试通过。
- invoke casual provider session 复用与 Codex writable sandbox namespace 测试通过。
- casual routing / casual prompt profile 回归测试通过。
- `git diff --check` 通过。

保留边界：

- 未新增 `roundtable` prompt profile，也未把 casual 的轻量工具策略共享给其他工作模式。
- Claude / Claude bg / Gemini / Kimi / OpenCode / Dare 的轻量 CLI 能力策略仍保持 casual-only。
- Codex effort cap、read-only sandbox 自动提升、禁用 MCP、禁用成员 CLI config、跳过 `.git`/用户配置等策略仍保持 casual-only。
- development 模式仍保留 MCP、`.git` 写权限、成员 CLI config、session-chain、staging、transcript path hints 和质量控制链路。
- Claude stream-json 对 development 的真常驻不强行接管 per-turn callback MCP 场景；否则 MCP server 会持有首轮 callback token，存在串 invocation 风险。
- Codex app-server 常驻 carrier 仍暂缓，继续按 `11-codex-app-server-carrier.md` 的触发条件单独设计。

## 2026-07-11

### 闲聊 prompt profile 精简

完成内容：

- 新增 casual prompt profile，闲聊模式不再复用完整开发协作 L0。
- 闲聊身份只保留最小身份、性格倾向、语言跟随、显式工具边界和统一产物路径规则。
- casual 路由禁用开发协作动态上下文、SOP、质量门禁、MCP 工具文档、teammate roster、A2A handoff、session bootstrap。
- prompt segment diagnostics 可按 casual 模式输出分段 token 诊断。

验证：

```bash
corepack pnpm --filter @cat-cafe/api build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./packages/api/scripts/with-test-home.sh node --test packages/api/test/casual-prompt-profile.test.js packages/api/test/prompt-segment-diagnostics.test.js
```

结果：

- API build 通过。
- casual prompt profile 和 prompt diagnostics 测试通过。

### 闲聊产物统一保存与下载

完成内容：

- 闲聊模式产物写入统一 AgentRoom thread artifact 目录。
- 右侧产物面板可以看到本会话 Markdown 产物。
- 对话中的 artifact 链接支持跳转/下载，不再依赖 agent 自己生成的本地路径。

验证：

- 浏览器实际验证：产物面板可见，Markdown 文件可打开和下载。

结果：

- 功能可用。
- 产物目录不属于项目源码，不纳入 git 管理。

### 模式升级与 session profile 隔离

完成内容：

- provider session 增加 prompt profile 隔离：
  - `development` 保持旧 session key，兼容已有开发会话。
  - `casual` 使用独立 profile key，避免复用旧开发/旧 casual native session。
- non-native casual 不再每轮 prepend 轻量身份；profile 隔离后只按新 session/必要重注入逻辑注入。
- 新增 `POST /api/threads/:id/upgrade`：
  - 当前只允许 `casual -> development`。
  - 要求选择真实项目目录。
  - 创建新开发协作 thread，旧闲聊 thread 保留。
  - 新 thread 写入一条来源闲聊背景摘要，供开发协作 agent 读取。
  - `roundtable` 保留为 API 占位，当前返回 `ROUNDTABLE_NOT_IMPLEMENTED`，避免误走开发链路。
- 前端 casual 会话顶部新增“升级到开发”入口，复用项目选择弹窗，但锁定为开发协作并隐藏大厅选项。

验证：

```bash
corepack pnpm --filter @cat-cafe/api build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./packages/api/scripts/with-test-home.sh node --test packages/api/test/session-chain-store.test.js packages/api/test/threads-endpoint.test.js packages/api/test/casual-prompt-profile.test.js packages/api/test/prompt-segment-diagnostics.test.js
corepack pnpm --filter @cat-cafe/web build
git diff --check
```

结果：

- API build 通过。
- 107 个相关 API 测试通过。
- web build 通过；仍有项目既有 lint warning，但本轮新增 hook warning 已修复。
- `git diff --check` 通过。

遗留事项：

- 圆桌会议控制流尚未实现。
- 闲聊模式的平台侧 memory digest 尚未实现。
- provider 级工具显式禁用仍未完成，目前主要依赖 casual prompt profile 和 A2A depth 限制。

### CLI 底座的闲聊轻量化修正

诊断结论：

- 当前 Codex / Claude / Gemini / Antigravity / OpenCode / Kimi / Dare 等多数 provider 仍是 non-interactive CLI 调用模型。
- 即使传入 `--resume` 或 provider session id，每轮也会启动一个新的 CLI 进程。
- 因此 CLI 自身的运行时说明、权限上下文、工具 schema、用户配置、AGENTS / MCP 初始化等会在每轮重新加载。
- 这部分不等同于 AgentRoom 拼接的 casual prompt；此前 casual prompt 已经瘦身，但 CLI 外壳仍然会带来固定成本。

完成内容：

- casual 模式不再读取和恢复 provider CLI session，避免旧隐藏会话携带开发态上下文。
- Codex casual 调用新增轻量启动参数：
  - `--ignore-user-config`
  - `--ignore-rules`
  - `--ephemeral`
  - `--skip-git-repo-check`
- Codex casual 不再注入 Cat Cafe MCP config，不再添加 `.git` 写权限目录。
- Codex casual 忽略成员编辑器里的 `cliConfigArgs`，避免用户侧 profile / MCP 配置把重负载重新带回。
- Claude Code casual 不再 `--resume`、不再注入 Cat Cafe MCP、不再启用 `--chrome`，也不再应用成员 `cliConfigArgs`。
- Claude bg carrier casual 不再 `--resume`，不再注入 Cat Cafe MCP。
- Gemini casual 在 `gemini-cli` 与默认 `antigravity-cli` 路径下不再 resume provider session，也不再应用成员 `cliConfigArgs`。
- OpenCode casual 不再传 `--session`，也不再应用成员 `cliConfigArgs`。
- Kimi casual 不再传 `--session`，不再生成/注入 MCP config，也不再应用成员 `cliConfigArgs`。
- Dare casual 不再传 `--session-id`，也不再应用成员 `cliConfigArgs`。

结果：

- 保持 CLI 底座，不切换到 direct API。
- 短期目标是让每轮 CLI cold start 尽量轻，尤其避免闲聊加载开发协作 MCP。
- 长期仍需要评估常驻 CLI carrier / daemon，才能从根上减少“每轮重启 CLI”的启动成本；这更适合放到开发协作模式改造阶段。

### CLI 常驻化方向确认

补充判断：

- 闲聊模式仍需要保留必要的人设和模型差异，不能为了省 token 把 agent 个性完全削掉。
- 如果 Prompt Capture 显示 AgentRoom 自身注入量只是几百到少量 token，而 provider metadata 仍显示万级 input tokens，则主要问题应归因于 CLI 外壳自身的系统说明、工具 schema、权限上下文和每轮冷启动。
- 普通 CLI provider 当前走 `spawnCli`，每轮 invoke 都启动一个新子进程；`--resume` 只能恢复 provider/model 会话，不能复用本地 CLI 进程，也不能避免 CLI runtime 每轮重新加载。
- 代码中已有 ACP provider 使用 `AcpProcessPool` + session 复用模型，可作为后续 CLI 常驻 carrier 的设计参考。

下一步方向：

- 用 Prompt Capture 对比 AgentRoom effective prompt / native system prompt 与 provider metadata 的实际 input tokens。
- 若确认 AgentRoom 注入占比很小，则停止继续削弱闲聊人设，转向 CLI 端复用：
  - 一个 thread + cat + profile 维度持有常驻 CLI carrier。
  - 优先复用支持 server/ACP/bg/daemon 的 provider。
  - 无法常驻的 provider 继续走裁剪后的 cold-start CLI。
  - 记录每轮 input/cache 命中率，观察 prompt cache 是否随着稳定 prefix 和 session 复用提升。

### 闲聊 CLI carrier/session 复用第一版

完成内容：

- casual 模式重新启用 provider session 复用，但 session key 带 `promptProfile=casual`，不会复用或污染开发协作 session。
- casual 仍不启用开发协作的 session-chain/bootstrap/seal 机制，避免把重型开发控制流带回闲聊。
- 各 CLI provider 在 casual 模式下不再丢弃 `sessionId` / `cliSessionId`，允许同一 thread + cat + profile 继续 resume：
  - Codex
  - Claude Code
  - Claude bg carrier
  - Gemini CLI / Antigravity CLI
  - OpenCode
  - Kimi
  - Dare
- Codex casual 去掉 `--ephemeral`，否则 CLI session 无法持久化并在后续轮次 resume。
- casual 仍保留轻量裁剪：不注入 Cat Cafe MCP，不恢复成员编辑器里的额外 CLI config args，不添加 `.git` 写权限。

验证：

```bash
corepack pnpm --filter @cat-cafe/api build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./packages/api/scripts/with-test-home.sh node --test --test-name-pattern 'casual prompt profile uses lightweight Codex CLI launch flags|casual prompt profile resumes Codex CLI session|casual mode reuses profile-scoped provider session|casual prompt profile|casual mode routing|promptProfile isolates|prompt segment diagnostics' packages/api/test/codex-agent-service.test.js packages/api/test/invoke-single-cat.test.js packages/api/test/casual-prompt-profile.test.js packages/api/test/casual-mode-routing.test.js packages/api/test/prompt-segment-diagnostics.test.js packages/api/test/session-chain-store.test.js packages/api/test/redis-session-chain-store.test.js
git diff --check
```

结果：

- API build 通过。
- 16 个相关定向测试通过。
- `git diff --check` 通过。

下一步观察：

- 同一 casual thread 内连续发言时，OpenAI/GPT agent 的 `sessionId` 是否稳定复用。
- `inputTokens` 是否下降，或至少 `cacheReadTokens` / input 占比是否提升。
- Gemini/Antigravity 是否因为 `--conversation` resume 出现历史重放；如出现，再单独做 trajectory/final answer 去重或 provider-specific carrier。

### 闲聊 CLI carrier 后台实测记录

测试线程：

- `thread_mrgsjj2ma1a2n03o`
- mode: `casual`
- Redis profile: `opensource`
- Redis port: `6398`

实测观察：

- carrier 改动前，GPT/Codex agent 每轮 `sessionId` 都变化：
  - `019f52c6-7ee1-77a0-b19a-082fd4a97177`
  - `019f52cd-ab89-7931-9f87-aae3e5282c04`
  - `019f52ce-d165-7323-8e60-55471bcdeb5f`
  - `019f52cf-4cc7-77b2-b0ff-221421a7d028`
- carrier 改动后，GPT/Codex agent 在同一线程内稳定复用：
  - `019f52de-6658-74f1-80a0-de693bf145c7`
- carrier 改动后，Gemini/Antigravity agent 在同一线程内稳定复用：
  - `ab5ff6e4-c998-466f-ae6e-986e8e31b427`
- 当前 Redis provider session key 与最新消息中的 `sessionId` 一致：
  - `cat-cafe:sessions:default-user:cat-k7noygiu:thread_mrgsjj2ma1a2n03o::prompt-profile:casual`
  - `cat-cafe:sessions:default-user:cat-gvepveae:thread_mrgsjj2ma1a2n03o::prompt-profile:casual`
- 当前测试线程没有写入 `cat-cafe:session-chain:*thread_mrgsjj2ma1a2n03o*`，说明 casual 没有误启用开发模式 session-chain。

GPT/Codex usage 变化：

| 阶段 | inputTokens | cacheReadTokens | cache 占比 |
| --- | ---: | ---: | ---: |
| carrier 前 | 12502 | 9600 | 76.8% |
| carrier 前 | 12714 | 9600 | 75.5% |
| carrier 前 | 12798 | 9600 | 75.0% |
| carrier 前 | 12479 | 9600 | 76.9% |
| carrier 后 | 12974 | 10112 | 77.9% |
| carrier 后 | 14156 | 12672 | 89.5% |

结论：

- 第一版 CLI carrier 已解决“同一闲聊线程每轮更换 provider session”的问题。
- GPT/Codex 侧 cache 命中占比提升明显，但 `inputTokens` 仍在 1.3w-1.4w 左右，说明 CLI runtime 固定上下文仍然较重。
- Gemini/Antigravity 没有暴露 usage token 字段，只能通过 `sessionId` 稳定性确认 carrier 生效。
- 闲聊模式下工具默认不主动使用，但当用户请求天气这类需要实时信息的任务时，Gemini/Antigravity 仍可触发 `search_web`；本次天气测试出现 1 次 web search 工具调用。
- 下一步不建议继续大幅削弱必要人设；更有价值的方向是评估真正的常驻 CLI process/daemon carrier，或针对 Codex/Claude/Gemini 分 provider 做持久进程能力探测。

### Claude Code CLI stream-json 常驻 carrier 第一版

完成内容：

- 新增 `ClaudeStreamJsonCarrierService`，使用 Claude Code CLI 的 streaming input 模式：
  - `claude -p --input-format stream-json --output-format stream-json`
  - 同一 `user + thread + cat + promptProfile` 维度持有一个本地 Claude CLI 进程。
  - 每轮用户消息通过 stdin 写入一行 stream-json，不再每轮重启本地 Claude CLI。
- 新 carrier 通过 `CAT_CAFE_CLAUDE_CARRIER=stream_json` 显式启用；默认仍是旧的 `print_sdk`。
- 初版只接管 casual 闲聊路径：
  - 非 casual / 开发协作模式自动回退到 `ClaudeAgentService`。
  - 带图片/附件的调用自动回退旧 carrier，避免常驻进程启动参数无法动态追加 `--add-dir`。
  - casual 继续不注入 Cat Cafe MCP，不启用 `--chrome`，不应用成员 `cliConfigArgs`。
- 稳定 casual 身份通过 `--system-prompt-file` 在进程启动时注入。
- 如果进程已存在，后续同线程同猫闲聊只写新的 stream-json 用户消息；如果 native system prompt / cwd / env / model 等稳定启动签名变化，则关闭旧进程并重启。
- carrier 进程按 thread 隔离，避免不同闲聊线程串上下文。
- 空闲进程默认 30 分钟后关闭，可用 `CAT_CAFE_CLAUDE_STREAM_IDLE_MS` 调整。
- 降级链新增 `stream_json`：
  - `bg_daemon -> interactive_pty -> stream_json -> print_sdk -> api_key`

验证：

```bash
corepack pnpm --filter @cat-cafe/api build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./packages/api/scripts/with-test-home.sh node --test packages/api/test/claude-stream-json-carrier.test.js packages/api/test/claude-carrier-factory.test.js
git diff --check
```

结果：

- API build 通过。
- 33 个 Claude carrier 相关定向测试通过。
- `git diff --check` 通过。

待真实验证：

- 用 `CAT_CAFE_CLAUDE_CARRIER=stream_json` 启动后，在同一个 casual thread 内连续调用 Claude agent。
- 观察后台日志中同一 thread 是否只出现一次 `Claude stream-json CLI process started`。
- 观察 Claude usage 的 `inputTokens` / `cacheReadTokens` 是否相比 `--resume` 每轮冷启动进一步改善。
- 如果 Claude Code CLI 的 stream-json 模式在订阅账号下出现协议或权限限制，再回退到 `print_sdk` 并记录失败样本。

### Claude casual stream-json effort 下调

真实验证观察：

- 测试线程：`thread_mrhvah57celc6pa5`
- Claude session：`41de0f1a-93f2-4c84-a98a-330c388c8db8`
- carrier：`CAT_CAFE_CLAUDE_CARRIER=stream_json`
- 现象：
  - 新增 carrier 生效，Claude Code CLI 使用 `--input-format stream-json --output-format stream-json`。
  - 第二轮命中 prompt cache：`cacheReadTokens=16807`，第一轮创建的缓存被完整读中。
  - 但启动参数仍继承猫配置的 `--effort max`，两轮 hidden thinking/output 成本偏高。

调整：

- `ClaudeStreamJsonCarrierService` 的 casual 路径不再直接继承 Claude 猫配置的高 effort。
- casual stream-json effort 以 `medium` 为上限：
  - 如果成员显式配置为 `low`，保留 `low`。
  - 如果配置为 `medium/high/max/xhigh`，闲聊路径使用 `medium`。
- 开发协作模式和旧 `ClaudeAgentService` 路径不受影响。

验证：

- `claude-stream-json-carrier.test.js` 增加 `--effort medium` 断言，防止 casual 后续退回 `max`。

### Claude casual stream-json 进程复用签名修复

真实验证观察：

- `--effort medium` 生效后，Claude sessionId 继续稳定为 `41de0f1a-93f2-4c84-a98a-330c388c8db8`。
- medium 首轮因启动参数变化重新创建 cache：`cacheCreationTokens=23208`。
- medium 第二轮成功读回 cache：`cacheReadTokens=23208`，命中率约 `96.7%`。
- 但 OS 进程 PID 仍从 `4426` 变为 `4569`，说明常驻进程复用没有真正稳定。

原因：

- `ClaudeStreamJsonCarrierService` 的进程启动签名包含完整 `envDigest`。
- `envDigest` 来自 `callbackEnv`，而 `CAT_CAFE_INVOCATION_ID` / `CAT_CAFE_CALLBACK_TOKEN` 每轮都会变化。
- 因此同一 `thread + cat + casual` 会话被误判为启动签名变化，carrier 主动关闭旧进程并重启。

调整：

- casual stream-json carrier 在构造 Claude 子进程环境前过滤一次性 callback 凭证：
  - `CAT_CAFE_INVOCATION_ID`
  - `CAT_CAFE_CALLBACK_TOKEN`
- 这些字段不再进入子进程环境，也不再影响启动签名。
- 保留账号/模型/模式相关环境变量，避免影响 subscription/api_key 选择。
- 加强 `claude-stream-json-carrier.test.js`：两轮 casual 调用带不同 invocation/token，仍必须只 spawn 一个 Claude 进程。

真实验证结果：

- 修复后同一 casual 线程内 Claude Code CLI PID 稳定为 `5018`。
- Claude sessionId 继续稳定为 `41de0f1a-93f2-4c84-a98a-330c388c8db8`。
- 最近三轮 cache 命中率保持高位：
  - `input=24268` / `cacheRead=23989` / `cacheCreation=277`，命中约 `98.9%`
  - `input=24967` / `cacheRead=24266` / `cacheCreation=699`，命中约 `97.2%`
  - `input=25768` / `cacheRead=24965` / `cacheCreation=801`，命中约 `96.9%`
- 结论：Claude Code casual carrier 已解决“同一线程频繁重启 CLI 导致 cache 不稳定”的主要问题。后续成本波动主要来自输出长度、上下文增长和 Claude Code 自身运行时注入。

验证：

```bash
corepack pnpm --filter @cat-cafe/api build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./packages/api/scripts/with-test-home.sh node --test packages/api/test/claude-stream-json-carrier.test.js packages/api/test/claude-carrier-factory.test.js
git diff --check
```

### Codex casual CLI 轻量化修复

背景：

- Codex 当前路径仍是 `codex exec` / `codex exec resume`，不是常驻 OS 进程。
- casual 模式已经跳过 Cat Cafe MCP，并使用 `--ignore-user-config --ignore-rules`，同一线程通过 sessionId resume 来提高 prompt cache 命中。
- 进一步检查 `codex app-server` 后确认它是完整 JSON-RPC 客户端协议，会暴露审批、文件、进程、认证刷新等 server request 面；不适合在本轮直接替换 casual carrier，需要单独设计协议适配和安全策略。

调整：

- `CodexAgentService` 的 casual 路径不再继承 OpenAI provider 默认 `xhigh` reasoning effort。
- casual Codex effort 以 `medium` 为上限：
  - 显式配置为 `low` 时保留 `low`。
  - 其他 `medium/high/max/xhigh` 均降为 `medium`。
- 开发协作模式不受影响，仍保留既有 effort 配置和 MCP 注入逻辑。
- casual 子进程环境中过滤一次性 callback 凭证：
  - `CAT_CAFE_INVOCATION_ID`
  - `CAT_CAFE_CALLBACK_TOKEN`
- 这些字段不再进入 Codex child env，减少每轮动态噪音和凭证暴露面。
- Antigravity / agy 暂不改动；当前没有发现类似 Claude stream-json 或 Codex app-server 的低风险常驻协议。

验证：

```bash
corepack pnpm --filter @cat-cafe/api build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./packages/api/scripts/with-test-home.sh node --import ./packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/codex-agent-service.test.js packages/api/test/casual-prompt-profile.test.js
git diff --check
```

结果：

- API build 通过。
- Codex provider + casual prompt 定向测试共 52 个通过。
- `git diff --check` 通过。

遗留事项：

- Codex 真常驻 carrier 暂缓，详见 `11-codex-app-server-carrier.md`。
- 触发条件是后续 Codex/GPT agent 的 token/cache 成本再次成为主要瓶颈。
- 当前先保留 `codex exec resume` 路径，不在本阶段引入 app-server JSON-RPC client。

## 2026-07-12

### 闲聊 @ 候选与参与者边界修复

问题：

- 闲聊会话输入 `@` 时仍显示开发协作遗留的 `@thread`。
- 只选择 sonnet 加入新闲聊会话时，输入框仍显示 opus、fable 以及布偶猫全家族候选。
- 后端也存在真实逻辑残留：用户手打未加入 agent 的显式 mention 时，casual 路由仍可能越过会话成员边界。

调整：

- 前端 `ChatInput` 在 casual thread 下按 `preferredCats` 裁剪 mention 候选；无 `preferredCats` 时退回 `participants`。
- casual mention 候选只保留本会话成员个体和 `@all`。
- casual 模式隐藏 `@thread` 和品种全体候选；开发协作模式保持原逻辑不变。
- 后端 `AgentRouter` 在 casual 模式下对显式 mention 也应用 `preferredCats` 边界；越界 mention 不再路由到未加入会话的 agent，而是退回当前 casual audience。

验证：

```bash
corepack pnpm --filter @cat-cafe/api run build
node --test packages/api/test/casual-mode-routing.test.js
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/chat-input-options-labels.test.ts src/components/__tests__/chat-input-mention-filter.test.ts
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
```

结果：

- API build 通过。
- casual routing 定向测试 6 个通过。
- web mention 相关测试 18 个通过。
- web TypeScript 检查通过。

补充修复：

- 真实验证发现后端路由已按 casual 边界收敛，但 UI 仍可能显示全量候选。
- 原因是 `ChatInput` 在当前 thread 元数据尚未进入前端 store 时，会退回到“未知模式”，从而临时使用开发模式全量 mention 候选。
- 现在 `ChatInput` 在缺少 thread 元数据时不再显示全量候选，并会主动请求 `/api/threads/:id` 补拉当前 thread 元数据。
- 新建 thread 成功后，前端立即把后端返回的新 thread 合并进 store，再跳转，避免创建后输入框先于 thread list 刷新。
- 已用 `REDIS_PORT=6398 REDIS_URL=redis://127.0.0.1:6398 bash ./scripts/start-dev.sh --profile=opensource` 重启本地验证服务。

补充验证：

```bash
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/chat-input-mention-guard.test.ts src/components/__tests__/chat-input-options-labels.test.ts src/components/__tests__/chat-input-mention-filter.test.ts
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
git diff --check
```

结果：

- ChatInput mention 相关测试 23 个通过。
- web TypeScript 检查通过。
- `git diff --check` 通过。

再次排查：

- `testv3` 新 thread 后端数据确认正确：
  - `mode: casual`
  - `preferredCats: ["sonnet"]`
- UI 仍显示全量候选时，进一步定位到另一条输入框路径：`viewMode === "split"` 时，页面渲染的是 `SplitPaneView` 的共享输入框。
- split-pane 的共享输入框按 `splitPaneTargetId` 决定发送目标；旧逻辑只在 panes 为空时把 URL 当前 thread 写入 split target。若已有 panes，切到/创建新 thread 后共享输入框仍可能沿用旧 target，于是 `@` 候选显示旧 thread 或 default/development 的全量列表。
- 已调整 `ChatContainer`：split 模式下 URL thread 变化时，将当前 thread 加入 split panes 并设为 `splitPaneTargetId`；如果 panes 已满，则替换当前选中的 pane。这样共享输入框也会绑定当前会话。

验证：

```bash
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/chat-input-mention-guard.test.ts src/components/__tests__/chat-input-options-labels.test.ts src/components/__tests__/chat-input-mention-filter.test.ts
git diff --check
```

结果：

- web TypeScript 检查通过。
- ChatInput mention 相关测试 23 个通过。
- `git diff --check` 通过。

第三次排查：

- 用户继续验证后仍看到图形化 `@` 候选全量显示。
- 后端再次确认最新 `testv4` thread 数据正确：
  - `mode: casual`
  - `preferredCats: ["sonnet"]`
- 进一步收紧 `ChatInput` 的 thread 元数据判定：不能只要 store 里存在同 ID thread 就认为可用，因为侧边栏会先加载 IndexedDB 离线快照，旧快照可能缺少 `mode/preferredCats/audience`。
- `ChatInput` 现在会优先使用 `/api/threads/:id` 拉到的完整详情，并把详情覆盖合并回 store。
- 如果当前 thread 的 mention 路由元数据不完整，则 `@` 菜单不展示全局候选，避免在 API 详情返回前暴露开发模式候选。
- 补充回归测试：store 先有缺少 `mode/preferredCats` 的旧 thread 快照，API 返回 casual + `preferredCats` 后，候选必须收窄到本会话成员和 `@all`。
- 为排除 Next dev/HMR 残留，已停止旧服务并用同一 Redis 6398 持久化环境重启；启动脚本清理了 `.next` 缓存。

验证：

```bash
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/chat-input-mention-guard.test.ts src/components/__tests__/chat-input-options-labels.test.ts src/components/__tests__/chat-input-mention-filter.test.ts
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
node --test packages/api/test/casual-mode-routing.test.js
git diff --check
```

结果：

- ChatInput mention 相关测试 24 个通过。
- web TypeScript 检查通过。
- casual routing 定向测试 6 个通过。
- `git diff --check` 通过。
- 服务已重新启动在 frontend `3003`、API `3004`、Redis `6398`。

第四次排查：

- 用户截图确认双方讨论的是同一个图形化 `@` 候选框。
- 截图中没有出现临时调试行，且候选仍是旧的开发模式全量候选，说明当前浏览器窗口加载的不是最新前端 bundle。
- 进一步检查发现 `packages/web/public/sw.js` 存在旧 production/PWA 构建残留，且该文件不受 git 管理；其中 precache 仍指向旧 build id。
- 结论：业务代码和后端 thread 数据已经收敛，但浏览器/PWA 窗口仍可能被旧 Service Worker 控制，继续展示缓存中的旧 UI。

修复：

- 新增 `DevServiceWorkerCleanup`，仅在本地 development 且未显式启用 `ENABLE_PWA_IN_DEV=1` 时运行，自动注销旧 Service Worker 并清理 Cache Storage。
- `start-dev.sh` 在开发模式启动时生成 dev-only `public/sw.js` reset 文件，让已经注册过旧 PWA 的窗口在刷新后也能拿到注销脚本。
- `/sw.js` 增加 `Cache-Control: no-store`，减少 Service Worker 脚本自身被缓存导致的假旧包问题。
- 当前工作目录中的 ignored `packages/web/public/sw.js` 已替换为 reset 文件，便于本轮验证。
- 为定位旧 bundle 曾短暂加入 `@` 菜单调试行；定位完成后已移除，不会出现在正式测试界面。
- 用户验证后出现一次 Next hydration mismatch overlay；原因判断为 reset Service Worker 在 activate 阶段主动 `clients.navigate()`，可能打断 Next hydration。
- 已移除 reset Service Worker 的主动页面导航逻辑；现在仅清理缓存并注销自身，实际刷新由前端 dev cleanup 组件在 React 加载后处理。
- 用户重新打开窗口后 hydration mismatch 仍稳定出现，说明不只是 SW 主动导航的一次性竞态。
- 进一步定位到三个 SSR/CSR 首帧不一致风险：
  - `app/(chat)/layout.tsx` 在 render 阶段直接读取 `window.location.pathname`，服务端和客户端首帧可能给 `ChatContainer` 不同 threadId。
  - `useIsDesktop()` 在客户端首帧直接读取 `matchMedia`，桌面端会和服务端默认移动端结构不同。
  - `ChatContainer` 在 render 阶段读取 `window.location.search`，带 query 时可能导致导出/研究模式首帧结构不一致。
- 已调整为 hydration-safe：
  - `ChatLayout` 首帧只使用 `usePathname()`，浏览器地址栏纠偏移到 `useLayoutEffect` 后。
  - `useIsDesktop()` 首帧固定为 `false`，mount 后再读 `matchMedia` 更新。
  - `ChatContainer` 的 query-driven mode 首帧固定关闭，mount 后同步 `export/research` 状态。

验证：

```bash
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/chat-input-mention-guard.test.ts src/components/__tests__/chat-input-options-labels.test.ts src/components/__tests__/chat-input-mention-filter.test.ts
corepack pnpm --filter @cat-cafe/web exec eslint src/components/DevServiceWorkerCleanup.tsx src/app/layout.tsx src/components/ChatInput.tsx src/components/ChatInputMenus.tsx
git diff --check
```

结果：

- web TypeScript 检查通过。
- ChatInput mention 相关测试 24 个通过。
- 新增 dev Service Worker 清理组件和 ChatInput 相关文件 lint 通过。
- `git diff --check` 通过。
- 移除 reset SW 主动导航后，重新执行 web TypeScript、mention 测试、cleanup 组件 lint、`git diff --check`，均通过。
- 修复 hydration 首帧风险后，重新执行：
  - `corepack pnpm --filter @cat-cafe/web exec tsc --noEmit`
  - `corepack pnpm --filter @cat-cafe/web exec vitest run 'src/app/(chat)/__tests__/thread-route-marker.test.tsx' src/components/__tests__/chat-input-mention-guard.test.ts src/components/__tests__/chat-input-options-labels.test.ts src/components/__tests__/chat-input-mention-filter.test.ts src/components/__tests__/AppShell-presentation-kd1.test.tsx`
  - `corepack pnpm --filter @cat-cafe/web exec eslint 'src/app/(chat)/layout.tsx' 'src/app/(chat)/layout-thread-id.ts' src/hooks/useIsDesktop.ts src/components/ChatContainer.tsx`
  - `git diff --check`
- 结果均通过，定向测试 33 个通过。

第五次排查：

- 用户在闲聊模式中实际生成报告后，点击产物下载按钮返回 500：
  - `ERR_INVALID_CHAR`
  - `Invalid character in header content ["content-disposition"]`
- 定位为 artifact store 下载接口直接把中文文件名写入 `Content-Disposition` header；Node/Fastify 不允许 header 中出现原始非 ASCII 字符。
- 同时确认 casual prompt 裁剪后只要求“保存后给绝对路径”，没有明确要求使用 Markdown 链接；因此 agent 可能只说“已保存”或给不可识别路径，前端不会生成下载按钮。
- Codex/GPT 反馈只读沙箱不是同一个原因；当前 `.env` 未设置 `CAT_CODEX_SANDBOX_MODE`，后端默认仍是 `danger-full-access`。更可能是该 casual thread 的 Codex CLI 旧 session 在创建时已经锁定了只读 sandbox，而 `codex exec resume` 不会重新接受 `--sandbox`。

修复：

- artifact store 下载 header 改为 RFC 5987 格式：
  - ASCII fallback: `filename="..."`
  - UTF-8 filename: `filename*=UTF-8''...`
- casual prompt 保持轻量，只新增一条产物规则：实际保存成功后，用 Markdown 链接给出绝对路径，例如 `[下载报告](绝对路径)`。
- Codex casual 模式增加写产物逃生口：
  - 如果本轮 prompt 明显是保存/导出/下载/生成 Markdown 报告等写产物请求；
  - 且当前 cat 是 openai/Codex；
  - 且已存在旧 provider session；
  - 则本轮跳过旧 session resume，启动新的 Codex CLI session，让新 session 带当前 sandbox 和当前共享 reports 目录。
  - 不删除 Redis 或 Codex 历史 session；新 session 成功后按正常 `session_init` 覆盖当前会话映射。

验证：

```bash
corepack pnpm --filter @cat-cafe/api run build
node --test packages/api/test/artifact-store.test.js packages/api/test/casual-prompt-profile.test.js packages/api/test/invoke-single-cat.test.js
git diff --check
```

结果：

- API 编译通过。
- artifact store、casual prompt、invoke-single-cat 定向测试通过：124 个测试通过。
- `git diff --check` 通过。

第六次排查：

- 用户验证后确认中文文件名下载 500 已修复。
- 但 Gemini 在闲聊模式中只输出裸绝对路径：
  - `/Users/aidox/Documents/AgentRoom/profiles/default-6398/threads/thread_mrhzx4ueucwdg861/reports/烁烁_test.md`
  - 前端没有渲染下载入口。
- 定位：`MarkdownContent` 的裸路径识别复用了通用源码文件路径正则 `FILE_PATH_RE`，该正则只允许英文/数字/下划线/点/`@`/`-` 等 ASCII 路径段；中文文件名 `烁烁_test.md` 无法命中。

修复：

- 为 AgentRoom reports 产物路径增加专用裸路径正则，优先于通用源码路径规则。
- 支持中文文件名和普通 Markdown 报告扩展名 `.md/.markdown`。
- 保留现有通用源码路径规则，避免普通路径识别行为被放宽。
- 新增回归测试，直接覆盖用户贴出的裸路径 + 中文文件名场景。

验证：

```bash
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/markdown-content-workspace-links.test.ts
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
git diff --check
```

结果：

- `MarkdownContent` workspace/link 测试 22 个通过。
- web TypeScript 检查通过。
- `git diff --check` 通过。

第七次排查：

- 用户刷新后仍未看到下载入口。
- 进一步定位发现第六次只修了 `MarkdownContent` 自身；真实聊天气泡链路中：
  - `ChatContainer` 有正确 threadId；
  - 但没有传给 `ChatMessage`；
  - `ChatMessage` 内部的 `ContentBlocks` / `CollapsibleMarkdown` 没有显式 artifact thread；
  - 因此最终仍依赖全局 `currentThreadId`，在历史消息、切换会话或局部渲染时可能为空或不一致。

修复：

- `ChatContainer` 向 `ChatMessage` 显式传入当前消息列表的 `threadId`。
- `ChatMessage` 将该 threadId 传给：
  - `ContentBlocks`
  - `CollapsibleMarkdown`
  - `ConnectorBubble`
- `ContentBlocks`、`CollapsibleMarkdown`、`ConnectorBubble` 都向内部 `MarkdownContent` 透传 `artifactThreadId`。
- 新增真实链路回归测试：全局 `currentThreadId` 故意设为错误值，`ChatMessage(threadId=真实线程)` 仍必须把中文文件名裸 AgentRoom reports 路径渲染成下载入口。

验证：

```bash
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/chat-message-artifact-links.test.tsx src/components/__tests__/markdown-content-workspace-links.test.ts
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
corepack pnpm --filter @cat-cafe/web exec eslint src/components/ChatMessage.tsx src/components/ChatContainer.tsx src/components/CollapsibleMarkdown.tsx src/components/ContentBlocks.tsx src/components/ConnectorBubble.tsx src/components/MarkdownContent.tsx src/components/__tests__/chat-message-artifact-links.test.tsx src/components/__tests__/markdown-content-workspace-links.test.ts
git diff --check
```

结果：

- 定向测试 23 个通过。
- web TypeScript 检查通过。
- 相关文件 eslint 通过。
- `git diff --check` 通过。

第八次排查：

- 用户指出 GPT/Codex 闲聊模式不应默认只读，也不应在检测到“写文件/生成报告”意图时重开 CLI session。
- 这个判断成立：闲聊模式的目标是轻量控制流，不是只读控制流；如果写入时才重开 CLI，会降低 provider session 复用和 prompt cache 命中稳定性，重新抬高 token 成本。

修复：

- 移除 `invokeSingleCat` 中“casual + Codex + 写入意图 => 强制 fresh provider session”的启发式逻辑。
- `CodexAgentService` 在新建 casual Codex CLI session 时，如果全局 `CAT_CODEX_SANDBOX_MODE=read-only`，自动提升为 `workspace-write`。
- 非 casual / 开发协作模式继续严格遵循 `CAT_CODEX_SANDBOX_MODE`，不改变原有权限策略。
- 保留 provider session 复用：写报告、保存 Markdown 等操作不再触发每次重开 CLI。
- 注意：Codex CLI resume 不能修改已存在 session 的 sandbox；旧的 read-only casual session 可能需要一次性换新 session，之后同一 casual 会话内应继续复用可写 session。

验证：

```bash
node --test --test-name-pattern "casual prompt profile upgrades read-only sandbox|casual prompt profile resumes Codex CLI session|uses env-configured sandbox|falls back to defaults" packages/api/test/codex-agent-service.test.js
node --test --test-name-pattern "casual mode reuses profile-scoped provider session|casual mode stores profile-scoped provider session" packages/api/test/invoke-single-cat.test.js
node --test packages/api/test/casual-prompt-profile.test.js
corepack pnpm --filter @cat-cafe/api run build
git diff --check
```

结果：

- Codex casual 可写 sandbox 定向测试通过。
- Codex casual session resume / provider session 复用测试通过。
- casual prompt profile 回归测试通过。
- API 编译通过。
- `git diff --check` 通过。

第九次排查：

- 用户验证发现：对话中已经显示为链接样式，但点击不能下载，也没有出现内联“下载”标记，点击后跳到 404。
- 重新检查后确认第七次修复覆盖了普通消息正文链路：
  - `ChatMessage -> CollapsibleMarkdown -> MarkdownContent`
  - `ContentBlocks/ConnectorBubble -> MarkdownContent`
- 但遗漏了另一条真实渲染链路：
  - `ChatMessage -> CliOutputBlock -> MarkdownContent`
  - `ChatMessage -> ThinkingContent -> MarkdownContent`
- CLI/stdout 或 thinking 面板里的 Markdown 链接没有拿到当前 `artifactThreadId`，所以 `/Users/.../Documents/AgentRoom/.../reports/*.md` 只会作为普通链接渲染，点击后进入前端/浏览器 404。
- 同时发现 URL 编码后的中文文件名可能被二次编码，导致下载接口按 `%E7...` 字面路径查找文件并返回 404。

修复：

- `CliOutputBlock` 增加 `artifactThreadId` 参数，并传给内部 `MarkdownContent`。
- `ThinkingContent` 增加 `artifactThreadId` 参数，并传给内部 `MarkdownContent`。
- `ChatMessage` 将当前消息所在 thread 的 `artifactThreadId` 继续透传给 CLI stdout 和 thinking 面板。
- `MarkdownContent` 在构造 `download-path` 前先对本地路径做 `decodeURI`，避免 URL 编码中文/空格文件名被二次编码。
- 下载失败时不再 fallback 打开同一个 artifact API 链接，避免用户被带到 404 页面；改为停留在当前页并提示下载失败。

验证：

```bash
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/markdown-content-workspace-links.test.ts src/components/__tests__/chat-message-artifact-links.test.tsx
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
corepack pnpm --filter @cat-cafe/web exec eslint src/components/MarkdownContent.tsx src/components/ChatMessage.tsx src/components/ThinkingContent.tsx src/components/cli-output/CliOutputBlock.tsx src/components/__tests__/markdown-content-workspace-links.test.ts src/components/__tests__/chat-message-artifact-links.test.tsx
git diff --check
```

结果：

- MarkdownContent / ChatMessage artifact 链接定向测试 25 个通过。
- web TypeScript 检查通过。
- 相关文件 eslint 通过。
- `git diff --check` 通过。

补充修复：

- 用户继续验证仍跳转到 Next 404。
- 回看昨天的解决方案后确认：昨天修的是 `MarkdownContent` 组件内转换；如果某条链路最终仍输出普通 `<a href="/Users/.../Documents/AgentRoom/.../reports/*.md">`，浏览器会把它当作前端路由跳转，进入 404。
- 为避免继续逐个追漏，新增页面级点击兜底 `ArtifactDownloadLinkInterceptor`：
  - 根布局全局挂载；
  - 捕获所有普通 `<a>` 点击；
  - 如果 href 是 AgentRoom reports 目录下的 Markdown 产物路径，直接转成 artifact-store `download-path` 请求；
  - 支持 `/Users/...`、浏览器归一化后的 `http://localhost:3003/Users/...`、`file:///Users/...`；
  - 优先从路径中的 `/threads/:threadId/reports/` 解析真实 threadId，避免误用当前全局 thread。

补充验证：

```bash
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/artifact-download-link-interceptor.test.ts src/components/__tests__/markdown-content-workspace-links.test.ts src/components/__tests__/chat-message-artifact-links.test.tsx
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
corepack pnpm --filter @cat-cafe/web exec eslint src/components/ArtifactDownloadLinkInterceptor.tsx src/app/layout.tsx src/components/MarkdownContent.tsx src/components/ChatMessage.tsx src/components/ThinkingContent.tsx src/components/cli-output/CliOutputBlock.tsx src/components/__tests__/artifact-download-link-interceptor.test.ts src/components/__tests__/markdown-content-workspace-links.test.ts src/components/__tests__/chat-message-artifact-links.test.tsx
git diff --check
```

结果：

- artifact 点击兜底、MarkdownContent、ChatMessage artifact 链接定向测试 29 个通过。
- web TypeScript 检查通过。
- 相关文件 eslint 通过。
- `git diff --check` 通过。

再次补充：

- 用户继续验证后，点击已被前端捕获，但弹出“下载失败”。
- 本地文件检查确认目标文件存在，例如：
  - `/Users/aidox/Documents/AgentRoom/profiles/default-6398/threads/thread_mrhzx4ueucwdg861/reports/烁烁_test.md`
- 根因转移到后端校验：`download-path` 原本只允许当前服务 profile 下的 reports 目录；当历史消息或切换环境后的消息里带着 `default-6398` 绝对路径，而当前服务 profile 解析为其他值时，后端会判定“outside this thread reports directory”并返回失败。

修复：

- `download-path` 仍保持相对路径只能落在当前 profile 的当前 thread reports 目录。
- 对 agent 明确给出的绝对路径，增加安全兼容：
  - 必须位于统一 artifact root 下；
  - 必须匹配 `profiles/<profile>/threads/<同一个threadId>/reports/...`；
  - threadId 必须和请求路径中的 `:threadId` 一致；
  - 其他 thread 的 reports 路径仍然拒绝。
- 这样兼容历史/跨 profile 绝对路径，同时不放开任意本地文件读取。

补充验证：

```bash
corepack pnpm --filter @cat-cafe/api run build
node --test packages/api/test/artifact-store.test.js
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/artifact-download-link-interceptor.test.ts src/components/__tests__/markdown-content-workspace-links.test.ts src/components/__tests__/chat-message-artifact-links.test.tsx
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
corepack pnpm --filter @cat-cafe/web exec eslint src/components/ArtifactDownloadLinkInterceptor.tsx src/app/layout.tsx src/components/MarkdownContent.tsx src/components/ChatMessage.tsx src/components/ThinkingContent.tsx src/components/cli-output/CliOutputBlock.tsx src/components/__tests__/artifact-download-link-interceptor.test.ts src/components/__tests__/markdown-content-workspace-links.test.ts src/components/__tests__/chat-message-artifact-links.test.tsx
git diff --check
```

结果：

- API build 通过。
- artifact-store 后端测试 3 个通过，覆盖同 thread 跨 profile 可下载、不同 thread 仍 403。
- 前端 artifact 链接测试 29 个通过。
- web TypeScript 检查通过。
- 相关文件 eslint 通过。
- `git diff --check` 通过。

最终确认：

- 用户继续验证仍失败后，通过运行服务日志看到真实请求：
  - `GET /api/artifact-store/threads/thread_mri2lc7sv6lbnrzw/download-path?path=/Users/aidox/Documents/agentroom/profiles/default-6398/threads/thread_mri2lc7sv6lbnrzw/reports/test.md`
  - 后端返回 `403`。
- 进一步检查 inode 发现：
  - `/Users/aidox/Documents/agentroom`
  - `/Users/aidox/Documents/AgentRoom`
  - 实际是同一个文件系统位置。
- 根因是 macOS 路径大小写/显示名差异：后端旧校验用字符串比较 artifact root，`AgentRoom` 与 `agentroom` 被误判为不同目录。

最终修复：

- `download-path` 改为基于 `realpath` 的真实路径比较。
- 仍然保留 thread reports 安全边界：真实路径必须落在 artifact root 下，并且必须匹配同一个 `threads/<threadId>/reports`。
- 增加后端 alias-root 回归测试：artifact root 经别名路径配置，请求用真实路径，也必须允许下载。
- 已重启本地 dev 服务：
  - Frontend: `http://localhost:3003`
  - API: `http://localhost:3004`
  - Redis: `6398`
- 用真实失败 URL 直接请求后确认返回 `200 OK`，并带 `Content-Disposition: attachment`。

最终验证：

```bash
corepack pnpm --filter @cat-cafe/api run build
node --test packages/api/test/artifact-store.test.js
curl -i -H 'x-cat-cafe-user: default-user' 'http://127.0.0.1:3004/api/artifact-store/threads/thread_mri2lc7sv6lbnrzw/download-path?path=%2FUsers%2Faidox%2FDocuments%2Fagentroom%2Fprofiles%2Fdefault-6398%2Fthreads%2Fthread_mri2lc7sv6lbnrzw%2Freports%2Ftest.md'
git diff --check
```

结果：

- API build 通过。
- artifact-store 后端测试通过。
- 真实失败 URL 返回 `200 OK`。
- `git diff --check` 通过。

经验教训：

- 这次走弯路的主要原因是最初把现象归因为“前端 Markdown 链接没有被接管”，而没有第一时间拿到真实点击后的网络请求、HTTP 状态码和后端日志。
- 正确排查顺序应是：
  - 先确认用户点击的真实 `href`；
  - 再看浏览器 Network 或后端日志中的真实 API URL；
  - 再确认状态码是 `404/403/401/500` 哪一种；
  - 最后才决定是前端渲染、前端点击拦截、后端路径校验、文件缺失还是身份问题。
- 前两轮修复虽然分别解决了真实问题：
  - 普通消息/CLI/stdout 链路没有完整传 `artifactThreadId`；
  - 某些普通 `<a href="/Users/...">` 没有页面级兜底；
  但它们没有解释“已接管后仍下载失败”的后端 `403`，所以只能算局部修复，不是最终根因。
- 本次最终根因是 macOS 文件系统大小写/显示名差异：
  - `/Users/aidox/Documents/agentroom`
  - `/Users/aidox/Documents/AgentRoom`
  在文件系统上是同一个 inode，但字符串安全校验会把它们当作两个不同目录。
- 涉及本地路径安全边界时，不能只做字符串前缀/relative 判断；对已存在路径应优先用 `realpath` 做规范化，再执行“是否在允许根目录内”的校验。
- 前端错误提示也需要改进：仅提示“下载失败”不够，应在开发模式或 toast 详情里暴露 HTTP 状态码和简短后端错误，这样能减少来回试错。

## 2026-07-12 闲聊 GPT 可写沙箱与下载文件名修复

背景：

- 用户新建闲聊对话后，GPT/Codex 又反馈只能读，说明之前的修复没有覆盖整个闲聊模式生命周期。
- 产物区下载正常，但对话框内点击下载会把文件保存为 `agentroom-report.md`，不符合“保留原始文件名”的设计。

根因：

- Codex CLI 的 `resume` 子命令不会重新接受 `--sandbox`。之前只修了“新建 Codex CLI 时把 casual 的 read-only 升为 workspace-write”，但旧的 casual provider sessionId 如果已经以 read-only 创建，后续恢复仍会继承旧沙箱。
- 对话框链接下载走前端全局拦截器：前端用 `fetch` 拿文件 blob 后再触发下载。因为前端和 API 是不同端口，浏览器默认不允许 JS 读取 `Content-Disposition`，所以文件名读取失败后落到了固定兜底名。

修复：

- 对 Codex/openai 的闲聊 provider session 增加版本化存储命名：
  - `threadId::provider-session:codex-casual-writable-v1`
  - 只影响 `promptProfile=casual` 且 provider 为 `openai` 的 sessionManager get/store/delete。
  - 不删除 Redis 旧数据，但新的闲聊 Codex 不再恢复旧 read-only session。
- 同步把静态身份注入/压缩检测使用的 session identity key 切到同一个存储 threadId，避免新旧 session 运行状态混用。
- API CORS 增加 `exposedHeaders: ['Content-Disposition']`，允许前端下载拦截器读取后端文件名。
- 前端下载拦截器移除 `agentroom-report.md` 固定兜底：
  - 优先使用 `Content-Disposition`；
  - 对 `download-path` URL 从真实 path 推导原始文件名；
  - 最后才兜底为通用 `artifact.md`。

验证：

```bash
corepack pnpm --filter @cat-cafe/api run build
node --test packages/api/test/invoke-single-cat.test.js --test-name-pattern "casual .*session"
node --test packages/api/test/artifact-store.test.js
corepack pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/artifact-download-link-interceptor.test.ts src/components/__tests__/markdown-content-workspace-links.test.ts src/components/__tests__/chat-message-artifact-links.test.tsx
corepack pnpm --filter @cat-cafe/web exec tsc --noEmit
corepack pnpm --filter @cat-cafe/web exec eslint src/components/ArtifactDownloadLinkInterceptor.tsx src/components/MarkdownContent.tsx src/components/__tests__/artifact-download-link-interceptor.test.ts
git diff --check
```

结果：

- API build 通过。
- `invoke-single-cat` 文件实际跑完 118 个测试，全通过；新增覆盖 Codex casual session 使用可写命名空间。
- artifact-store 后端测试 3 个通过。
- 前端下载/Markdown 链接测试 30 个通过。
- web TypeScript 检查通过。
- 相关文件 eslint 通过。
- `git diff --check` 通过。
- 当前 dev API 真实请求通过，响应包含：
  - `access-control-expose-headers: Content-Disposition`
  - `content-disposition: attachment; filename="test.md"; filename*=UTF-8''test.md`

经验：

- 处理 CLI 沙箱问题不能只看新建命令参数，还必须检查 `resume` 是否继承了旧 session 的创建时参数。
- 不应通过删除 Redis 来“修”旧 session；更合适的是引入版本化 session storage key，让旧数据自然退场。
- 浏览器下载文件名如果经过 `fetch -> blob -> a[download]`，必须确认前端能读取 `Content-Disposition`；否则后端 header 正确也不会影响前端保存名。

## 2026-07-13 Claude callback 凭证与主进程 env 分离

背景：

- 协作/开发模式每轮都会生成新的 `CAT_CAFE_INVOCATION_ID` / `CAT_CAFE_CALLBACK_TOKEN`。
- 这些 volatile 值如果进入 provider 主进程 env 或影响 CLI/MCP 初始化签名，可能降低 Claude prompt cache 前缀稳定性；但 native MCP callback 工具仍必须拿到本轮凭证。

修复：

- `ClaudeAgentService` 普通 `print/resume` 路径：
  - 主 Claude CLI env 中 strip `CAT_CAFE_INVOCATION_ID` / `CAT_CAFE_CALLBACK_TOKEN`。
  - `--mcp-config` 的 `mcpServers.cat-cafe.env` 单独注入本轮 callback env，保留 native MCP callback 能力。
  - Windows 分支不再缓存 MCP config 文件；改为每轮写临时 config，并在 invocation 结束清理，避免复用旧 token。
- 同步更新测试：
  - Claude 单测断言主进程 env 不含 volatile 凭证，MCP config 仍含本轮 API URL / invocation ID / callback token。
  - wiring 测试不再从 provider child env 读取 callback token，改从 invocation registry 读取。

验证：

```bash
corepack pnpm --filter @cat-cafe/api run build
node --test --test-name-pattern "falls back to default MCP path" packages/api/test/claude-agent-service.test.js
node --test --test-name-pattern "development MCP config still receives callback env" packages/api/test/codex-agent-service.test.js
node --test --test-name-pattern "stream-json carrier falls back for development turns" packages/api/test/claude-stream-json-carrier.test.js
git diff --check
```

结果：

- API build 通过。
- 新增/相关定向测试通过。
- `git diff --check` 通过。
- 说明：这不是新增 provider cache 层，而是减少每轮变化值对 Claude 主进程环境和潜在 cache 前缀稳定性的干扰。
