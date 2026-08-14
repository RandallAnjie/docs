# Rdocs

Rdocs 是一个面向中小团队的多人实时协作知识库。项目以 React、Tiptap、Yjs、D1、R2 和 Durable Objects 为核心，目标部署平台是 **RandallFlare**，正式域名为 `docs.bigrandall.io`。

## 当前状态

当前仓库完成了 Phase 0 纵向原型的应用骨架：

- React + Tiptap 富文本工作台与响应式首页。
- Yjs / y-websocket 兼容协议。
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

`docs.bigrandall.io` 暂未切换。实时协作验收发现 RandallFlare 的 DO WebSocket peer broadcast 当前不可用，详见 [RandallFlare blocker](docs/RANDALLFLARE_BLOCKER.md)。在这个核心闭环通过前，不应把预览视为可保存正式资料的生产系统。

## 架构

```text
Browser
  ├─ HTTPS ─────── Rdocs Worker ───── D1 / R2
  └─ WebSocket ─── Rdocs Worker ───── DocumentRoom Durable Object
                                          └─ private SQLite
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

该脚本验证双客户端收敛、DO 持久化、重连恢复和在线撤权。目前会在“双客户端收敛”处失败，这是已记录的平台阻塞，不是一个应被忽略的 flaky test。

## 安全边界

当前为匿名技术预览：页面创建和编辑票据暂时不要求正式登录。请勿写入敏感或生产资料。进入 MVP 前必须接入应用会话、组织/空间权限、Turnstile 和审计日志，并关闭匿名写入。
