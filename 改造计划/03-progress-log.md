# 03. 改造进展日志

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
