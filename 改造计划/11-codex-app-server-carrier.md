# Codex app-server 常驻 carrier 遗留事项

## 状态

暂缓，不进入当前 casual 模式第一阶段。

触发条件：

- Codex/GPT agent 在 casual 或圆桌模式中的 token 成本再次成为主要瓶颈。
- `codex exec resume` 的 prompt cache 命中不足以支撑长期使用。
- 需要把 Codex 从“每轮启动 CLI 进程”升级为“会话期常驻运行时”。

## 背景

当前 Codex 路径使用：

```bash
codex exec --json ...
codex exec resume <sessionId> --json ...
```

这条路径的优点是稳定、实现简单，并且已经能通过 sessionId 复用提高 prompt cache 命中。缺点是它不是 OS 进程常驻，每一轮仍会重新启动 Codex CLI，Codex CLI 自身的运行时说明和工具 schema 仍可能造成较高固定输入成本。

`codex app-server` 提供了更接近常驻运行时的能力，但它不是 Claude Code `stream-json` 那种简单的 stdin 多轮协议，而是完整 JSON-RPC 客户端协议。

## 为什么暂缓

直接切换到 `codex app-server` 的风险较高，因为后端需要实现一个可靠的 app-server client，而不是只包装一个 CLI 命令。

至少需要处理：

- `codex app-server --stdio` 进程生命周期管理。
- JSON-RPC request/response/notification 分发。
- `initialize`、`thread/start`、`thread/resume`、`turn/start`。
- `thread/tokenUsage/updated`、`item/agentMessage/delta`、`item/completed`、`turn/completed` 到现有 `AgentMessage` 的映射。
- 服务端回调请求：
  - `account/chatgptAuthTokens/refresh`
  - `currentTime/read`
  - 命令审批、文件修改审批、权限请求
  - 文件系统和进程相关请求
  - 动态工具调用和用户输入请求
- casual-only 灰度启用；开发协作模式继续回退 `codex exec`。
- app-server 失败、协议变化、认证失败时的自动 fallback。

如果这些没有设计清楚，容易出现“看似常驻，但遇到认证刷新或审批请求就卡住”的半成品。

## 后续设计方向

第一版建议做成显式实验 carrier：

```bash
CAT_CAFE_CODEX_CARRIER=app_server
```

范围建议：

- 只接管 `promptProfile=casual`。
- 无图片、无开发工具链、无 Cat Cafe MCP 注入。
- 同一 `user + thread + cat + promptProfile` 维度复用一个 app-server thread。
- 遇到未支持的 server request 时，终止本轮并 fallback 到 `CodexAgentService` 的 `exec resume`。
- 先只支持文本增量、完成事件和 token usage。

验收指标：

- 同一 casual thread 内 Codex app-server 进程稳定复用。
- Codex thread/sessionId 稳定。
- cacheReadTokens 占比不低于现有 `exec resume` 路径。
- 每轮 inputTokens 或实际账单成本相对现有路径有可见下降。
- 未支持的审批/工具/文件请求不会导致会话卡死。

## 当前替代方案

当前已完成的短期修复：

- casual Codex reasoning effort 封顶到 `medium`。
- casual Codex child env 删除每轮变化的 `CAT_CAFE_INVOCATION_ID` / `CAT_CAFE_CALLBACK_TOKEN`。
- 保留 `codex exec resume`，继续依赖 CLI session + prompt cache。

这不是最终常驻方案，但风险低，适合作为当前阶段的默认路径。
