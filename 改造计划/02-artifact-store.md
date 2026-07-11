# 02. 统一产物保存路径与 Markdown 导出

## 背景

闲聊模式不绑定项目目录，但用户仍然会让多个 Agent 做调研、总结和报告。

这类产物不能由各 Agent 自行写到不同工作目录。平台必须提供统一的公共产物目录，并把保存、下载、打开路径这些动作收束到 AgentRoom 侧。

## 目标

第一版只做 Markdown：

- 保存到本对话。
- 下载 Markdown 副本。
- 在 Finder 中显示保存路径。
- 让保存后的 Markdown 出现在现有“产物”面板里。

PDF、HTML、Docx 等格式后续通过插件或导出器扩展，不进入第一版。

## 统一目录

默认根目录：

```text
~/Documents/AgentRoom/
```

profile 目录用于隔离开发验证和正式使用：

```text
~/Documents/AgentRoom/profiles/<profile-key>/
```

其中 `<profile-key>` 的优先级：

1. `CAT_CAFE_ARTIFACT_PROFILE`
2. `REDIS_STORAGE_KEY`
3. 非默认 Redis 端口：`<REDIS_PROFILE>-<REDIS_PORT>`
4. `default`

例如当前 6398 隔离验证：

```text
~/Documents/AgentRoom/profiles/opensource-6398/
```

正式默认环境：

```text
~/Documents/AgentRoom/profiles/default/
```

## 本对话保存路径

本对话 Markdown 产物保存到：

```text
~/Documents/AgentRoom/profiles/<profile-key>/threads/<threadId>/reports/
```

示例：

```text
~/Documents/AgentRoom/profiles/opensource-6398/threads/thread_xxx/reports/2026-07-11-153012-research-report.md
```

每个产物同时写入 metadata：

```text
~/Documents/AgentRoom/profiles/<profile-key>/threads/<threadId>/.metadata/<artifactId>.json
```

metadata 记录：

- `artifactId`
- `threadId`
- `userId`
- `title`
- `filename`
- `relativePath`
- `mimeType`
- `sha256`
- `createdAt`
- `source`

## 平台约束

Agent 不能直接决定最终文件落点。

正确流程是：

1. Agent 产出 Markdown 内容。
2. 平台 Artifact Store 写入统一目录。
3. 平台登记 artifact metadata。
4. UI 展示保存路径、下载入口和 Finder 打开入口。

即使某个 Agent 产生了外部路径，平台也应复制或重新写入统一 Artifact Store，再对用户展示统一目录下的文件。

## 第一版接口

### 保存 Markdown 到本对话

```http
POST /api/threads/:threadId/artifacts/markdown
```

body：

```json
{
  "source": "thread-export",
  "title": "可选标题",
  "content": "可选 Markdown 内容"
}
```

如果不传 `content`，后端会把当前对话导出为 Markdown 并保存。

### 读取内容

```http
GET /api/artifact-store/threads/:threadId/:artifactId/content
```

### 下载副本

```http
GET /api/artifact-store/threads/:threadId/:artifactId/download
```

### 打开路径

```http
POST /api/artifact-store/threads/:threadId/:artifactId/reveal
```

macOS 下用 Finder 显示文件。

## 第一版不做

- 不实现 PDF/HTML 导出。
- 不把报告库接入全文检索索引。
- 不开放 Agent 任意路径写文件。
- 不把产物默认写入代码仓库目录。

