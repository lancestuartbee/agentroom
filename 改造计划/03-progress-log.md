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
