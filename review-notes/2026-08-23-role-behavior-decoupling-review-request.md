# Review Request: 协作角色与行为协议完全解耦

Review-Target-ID: role-behavior-decoupling
Branch: role-behavior-decoupling
Implementation commit: `6daf96d4`

## What

把 development-mode 工作流从“成员身份隐式决定行为”改为两个独立、显式维度：

- `roster[catId].roles` 只选择团队路由偏好；dev-role 按既定优先级选一条，designer 等非 dev-role 可独立叠加。
- `roster[catId].behaviors` 只选择可复用协作纪律；当前规范行为为 `engineering-discipline` 与 `opencode-runtime-boundary`。
- runtime `SystemPromptBuilder` 与 native L0 compiler 使用同一投影规则，不再从 breed、catId、displayName、model 或 capability 推导行为。
- Runtime CRUD、模板 API、Hub 编辑器和 first-run wizard 全链路携带 `behaviors`，并保持 `roles` / `behaviors` 独立 PATCH 语义。
- 旧 flat overlay 与旧 `breeds:` overlay 在 loader 边界迁移到 `roles:` / `behaviors:`，发出告警；canonical 配置优先。
- 修复 `SystemPromptBuilder` 测试中 16 条长期硬编码 displayName/breed 漂移，使该套件恢复全绿并真正锁定当前 registry 契约。

Operator 批准的首批显式绑定：

- `codex.behaviors = ["engineering-discipline"]`
- `opencode.behaviors = ["opencode-runtime-boundary"]`

## Why

有代码能力不应等同于某个固定成员身份，协作纪律也不应由 breed/model 偶然继承。终态是：身份负责“是谁”，角色负责“在团队里怎么路由”，行为负责“执行时遵守什么协议”；新增成员只要选择结构化 roles/behaviors，就能获得一致的 runtime/native 行为。

## Original Requirements（必填）

> “新创建的成员有相关的代码能力，但是让它们在协作模式里执行开发任务时，它们似乎不会按照协作模式开发者的原则来开发，比如不会在写完后传球给 reviewer。”
> “这个可以看看是不是编码技能和某个成员高度绑定而没有进行行为抽象的原因。”
> “可以，我建议就做这个，这个也是我觉得比较重要的。”
> “批准。”

- 来源：thread `thread_msvx7vnhafhl3qw8`，opener `0001786891916601-000132-7575a103` 与 2026-08-23 continuation
- **请对照上面的摘录判断：新成员的协作行为是否已经从具体成员身份中真正解耦，而不只是把 fallback 换了名字。**

## Tradeoff

- 选择显式 `behaviors`，不从 capability/model/breed 自动猜测。代价是成员创建端多一个结构化字段；收益是行为来源可解释、可编辑、runtime/native 可保持一致。
- 保留旧 overlay 的入口迁移，避免本地配置静默失效；但未知 legacy key 只能保留为同名 behavior 并告警，不能可靠猜测其语义。
- `behaviors` 在共享/运行态 schema 中保持 optional，兼容旧 catalog；编译期将缺省值解释为空数组，而不是恢复任何身份 fallback。
- 没有新建 behavior catalog/registry 服务；当前两个 canonical ID 直接来自模板真相源，避免为两条协议引入并行 Store/Router/Binding。

## Architecture Ownership（必填）

Architecture cell: identity-session / identity-agent
Map delta: none
Why: 本次扩展既有 roster → prompt projection 和现有模板 loader；未改变 owner、边界、extension point 或 canonical anchor，也未新建平行架构组件。

请 reviewer 检查：

- diff 是否与 `Map delta: none` 一致
- 是否意外保留了 breed/cat/display/model/capability → behavior 的隐式 fallback
- 是否新建了并行 `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding`

## Open Questions

### 技术 OQ（给 reviewer）

1. legacy `breeds:` migration 的两条已知映射是否边界清晰；未知 key “保留同名 behavior + warning”是否可能掩盖配置错误。
2. runtime/native 是否在三点完全一致：dev-role 只取最高优先级、非 dev-role 可叠加、behavior 按 roster 声明顺序去重。
3. API 的独立 PATCH 语义是否覆盖 partial update，是否仍有 create/edit 入口遗漏 `behaviors`。
4. `SystemPromptBuilder` 测试去硬编码后的 helper 是否仍可能把 registry 变化吞掉，而不是暴露契约漂移。

### 价值 OQ（给 operator，如有）

无。首批 behavior 绑定已由 operator 明确批准，其余选择均可单提交回滚。

## Next Action

请 reviewer 对 `origin/main...role-behavior-decoupling` 做全量 review，重点验证：

1. 能力 / 角色 / 行为是否确实三者解耦，没有隐藏身份推导。
2. runtime、native L0、API、Hub、first-run 的端到端契约是否一致。
3. 旧 overlay migration 是否 fail-visible 且不会覆盖 canonical 配置。
4. 同 role + behavior、不同身份得到相同 workflow 投影的回归证据是否充分。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/role-behavior-decoupling/opus`
- Start Command: `pnpm review:start`
- Ports: `web=3201`, `api=3202`

注意：主工作区当前有另一份并行、未提交的同域改动，且与本分支内容不同。请只从远端 `role-behavior-decoupling` 创建 detached review sandbox，不要在主工作区 review。

## 自检证据

### Spec 合规

- 原始问题的根因从 breed-bound prompt overlay 转为显式 `roles` / `behaviors` 投影。
- 公共 development 协议仍对全员注入；角色路由与可复用纪律分别选择。
- 批准的 codex/opencode behavior 绑定已落 `cat-template.json`。
- runtime/native/API/Web/first-run 均有实现与回归测试。
- 方案与门禁记录：`feature-specs/2026-08-23-role-behavior-decoupling.md`。

### 测试结果

- `pnpm --filter api build` → 通过
- 相关 API 正确 harness：225 tests，221 pass / 4 skip / 0 fail
- Web：Hub editor + first-run wizard，64/64
- `pnpm --filter @cat-cafe/web exec tsc --noEmit` → 通过
- `pnpm biome check --diagnostic-level=error <24 changed TS/JS files>` → 通过
- `pnpm lint` → 通过（仅仓库既有 warning）
- `pnpm -r --if-present run build` → 通过
- `node scripts/verify-template-extraction.mjs` → 通过
- `node --test scripts/prompt-injection-review-guards.test.mjs` → 14/14
- `node scripts/check-manifest-drift.mjs` → 通过
- `git diff --check origin/main...HEAD` → 通过
- 根目录媒体/设计工件扫描（工作树 + branch diff）→ 空
- 浏览器实测：隔离 worktree Web 在 `3015` 启动，Hub preview callback 允许，`GET /` 返回 200；相关组件测试 64/64。当前工具面没有截图捕获 API。

仓库级基线说明：

- 完整 `pnpm test` 在本隔离 checkout 中 exit 1，失败属于本功能之外的既有/环境项（旧中文 handle/displayName fixture、callback feat-index metadata、缺失 ignored `.claude/settings.json` / launchd scripts、环境无 tmux 等）；本功能涉及的四个 API 套件与两个 Web 套件均 0 failure。
- 完整 `pnpm check` 命中 35 个既有/上游 Biome 错误（含 F247/memory 与全量 JSON 格式）；本分支改动的 24 个 TS/JS 文件 scoped Biome 为 0 error。未用大范围格式化混入无关 diff。

### Dogfood

对实际 runtime `buildStaticIdentity` 与 native `compileL0` 做同配置对照：

- codex：development 两路均有 engineering behavior；casual 均无。
- opus：development 两路均无 engineering behavior。
- opencode：development 两路均有 runtime boundary；casual 均无。

### 相关文档

- Plan / contract: `feature-specs/2026-08-23-role-behavior-decoupling.md`
- Feature context: `docs/features/F032-agent-plugin-architecture.md`
- Prompt truth source: `assets/prompt-templates/workflow-triggers.yaml`

[sol/gpt-5.6-sol🐾]
