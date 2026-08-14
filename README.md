# Rdocs

Rdocs 是一个面向中小团队的多人实时协作知识库。项目以 React、Tiptap、Yjs、D1、R2 和 Durable Objects 为核心，目标部署平台是 **RandallFlare**，正式域名为 `docs.bigrandall.io`。

## 当前状态

当前仓库完成了 Phase 0 纵向原型的应用骨架：

- React + Tiptap 富文本工作台与响应式首页。
- 基于 D1 元数据的工作区页面树、根页面/子页面创建和页面切换。
- Yjs / y-websocket 兼容协议。
- 浏览器 WebSocket 与应用层 HTTP/Yjs 双通道协作同步。
- 短期 HMAC 协作票据、同源校验和 256 KiB frame 上限。
- 每篇页面、每个 generation 一个 Durable Object。
- DO SQLite 增量持久化、重启恢复和阈值快照。
- D1 第一版领域模型和版本化迁移。
- R2 附件 binding 预留。
- 权限版本检查和已打开连接的撤权关闭路径。
- RandallFlare 部署配置、单文件 Worker 构建和 CI。

应用已部署到 RandallFlare 的临时地址：

<https://rdocs-randall.edge.bigrandall.io>

![Rdocs Phase 0 首页](docs/preview.png)

`docs.bigrandall.io` 暂未切换。Rdocs 已通过 HTTP/Yjs 兼容通道提供无感自动保存、多人正文同步、在线状态和协作者光标；RandallFlare 原生 WebSocket 链路仍待平台修复，详见 [RandallFlare 平台问题清单](docs/RANDALLFLARE_PLATFORM_ISSUES.md)。当前仍是匿名技术预览，不应保存敏感或正式资料。

## 架构

```text
Browser
  ├─ HTTPS API ────────── Rdocs Worker ───── D1 / R2
  ├─ HTTP/Yjs fallback ── Rdocs Worker ───── DocumentRoom Durable Object
  └─ WebSocket ────────── Rdocs Worker ────────┘       └─ private SQLite
```

前端构建为单个内联 HTML，再与 API、WebSocket 路由和 DO class 一起打包为一个 ESM Worker，适配 RandallFlare 的 Git build `output file` 部署方式。

仓库结构：

```text
apps/web/          React + Tiptap 编辑器
apps/worker/       HTTP API、协作协议与 DocumentRoom
packages/shared/   前后端共享类型和约束
migrations/        D1 版本化迁移
tests/             线上纵向 smoke test
docs/              架构决策和平台兼容记录
```

## 本地开发

要求 Node.js 20 或更高版本。

```bash
npm install
npm run typecheck
npm test
npm run build
```

前端开发服务器：

```bash
npm run dev -w @rdocs/web
```

完整 Worker 本地运行依赖 RandallFlare 的 `rrangler dev` 与 `workerd`。生产配置位于 [`rrangler.json`](rrangler.json)。

## 部署到 RandallFlare

本项目只通过 `rrangler` 使用 RandallFlare 已有能力，不应修改 RandallFlare 平台代码。

```bash
npm run build
node /develop/bigrandall.io/rrangler/bin/rrangler.mjs deploy --no-publish
npm run migrate:randallflare
node /develop/bigrandall.io/rrangler/bin/rrangler.mjs secret put COLLAB_TICKET_SECRET --worker rdocs
node /develop/bigrandall.io/rrangler/bin/rrangler.mjs secret put PHASE0_ADMIN_SECRET --worker rdocs
node /develop/bigrandall.io/rrangler/bin/rrangler.mjs deploy
```

配置会创建或同步以下 Rdocs 专属资源：

- Worker：`rdocs`
- D1：`rdocs-db`，binding `DB`
- R2：`rdocs-attachments`，binding `ATTACHMENTS`
- Durable Object：binding 与 class 均为 `DocumentRoom`

生产构建命令为 `npm ci && npm run build`，输出文件为 `dist/worker.js`。

## 验证

常规校验：

```bash
npm run format:check
npm run typecheck
npm test
npm run build
```

线上协作闭环：

```bash
RDOCS_SMOKE_ADMIN_SECRET='<secret>' \
RDOCS_SMOKE_URL='https://rdocs-randall.edge.bigrandall.io' \
RDOCS_SMOKE_ORIGIN='https://docs.bigrandall.io' \
npm run smoke:collab
```

该脚本验证 RandallFlare 原生 WebSocket 链路的双客户端收敛、DO 持久化、重连恢复和在线撤权。该原生链路当前仍受已记录的平台问题影响；浏览器产品界面同时使用 HTTP/Yjs 兼容通道维持自动保存和多人同步。

## 安全边界

当前为匿名技术预览：页面创建和编辑票据暂时不要求正式登录。请勿写入敏感或生产资料。进入 MVP 前必须接入应用会话、组织/空间权限、Turnstile 和审计日志，并关闭匿名写入。
