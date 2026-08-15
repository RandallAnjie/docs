# RandallFlare 平台问题：Rdocs 修复清单

更新时间：2026-08-15 UTC

本文只记录 RandallFlare 平台问题，不要求通过修改 Rdocs 来规避。原 WebSocket 与发布链路问题已于 2026-08-14 修复并完成现网复验；Rdocs v0.1 迁移时又发现一项独立的 CLI migration 账本问题（RF-7）。现网验证使用：

- Worker：`rdocs`
- 正式 URL：`https://docs.bigrandall.io`
- 旧自动域名：`https://rdocs-randall.edge.bigrandall.io`（已按产品配置禁用，返回 404 属预期）
- 初始复现 Rdocs commit：`44542e24d752f2f9cafb57743728ce212c68a3e2`
- 最新权限发布 Rdocs commit：`6085569d81b047c00efce29eb5dbc87af6539cb4`
- RandallFlare `main`：`4997d919e4ead4d32d4d5a2e9f75c7d5ab791130`
- 边缘 agent：`2026.08.14.4997d91`（15/15 READY）

## 结论与优先级

| ID   | 优先级    | 状态           | 问题                                                       |
| ---- | --------- | -------------- | ---------------------------------------------------------- |
| RF-1 | P0        | 已修复、已复验 | 集群已转发的请求被禁止执行远端 DO WebSocket handoff        |
| RF-2 | P0        | 已修复、已复验 | Durable Object 的 `bindingName` 与 `className` 被混用      |
| RF-3 | P0 验收项 | 已修复、已复验 | 两个已连接 WebSocket 的 peer send/broadcast 曾不送达       |
| RF-4 | P1        | 已修复、已复验 | Git build 成功不等于边缘版本已激活                         |
| RF-5 | P1        | 已修复、已复验 | `envJson` 已更新，但 Worker 运行时仍读取旧值               |
| RF-6 | P2        | 已修复、已复验 | `rrangler` 对所有参数执行冒号拆分，破坏 URL/JSON/IPv6      |
| RF-7 | P1        | 仍可复现       | `rrangler d1 migrations apply` 写入 migration 名时参数丢失 |
| RF-8 | P1        | 待修复         | 低并发顺序请求间歇返回边缘 502/503                         |
| RF-9 | P1        | 待平台确认     | 自定义域名转发后的 Worker `request.url` 不是公开 Origin    |

修复按 `RF-1 → RF-2 → RF-3 验收 → RF-4/RF-5 → RF-6` 的顺序完成。

## RF-7：D1 migration 账本的参数写入丢失

### 现象

Rdocs 的实际 schema 已包含 `0001`–`0003`，但 `rrangler d1 migrations list rdocs-db` 始终把所有文件显示为未应用。执行 `migrations apply` 后，CLI 重跑已有迁移并在 `0003` 报错：

```text
duplicate column name: actor_id
```

检查 `d1_migrations` 后发现多行记录的 `name` 和 `applied_at` 都是 `NULL`。这意味着 SQL 文件执行成功，但随后用参数记录 migration 名称的请求没有把参数传入数据库。

### 根因范围

`rrangler/commands/index.mjs` 的 migration apply 使用：

```js
sql: "INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)",
params: [file, timestamp]
```

当前 D1 exec API 对这条控制面请求没有正确应用 `params`，SQLite 因 `name` 允许 NULL 而静默插入空账本记录。问题不在 Rdocs Worker 的 D1 binding `.bind()`；应用内参数化查询正常。

### Rdocs 本次安全处理

1. 先导出 31 张表到本地临时备份。
2. 对 `0004`–`0007` 做 schema 前置检查后，用 `d1 execute --file` 精确执行。
3. 验证 `page_grants`、`notifications`、editor schema v2 和 `pragma_foreign_key_check=0`。
4. 用 SQL 字面量重建 Rdocs 自己的 `d1_migrations` 账本；后续迁移继续使用相同的精确执行与账本校验流程。

没有修改 RandallFlare 代码。临时方案只作用于 `rdocs-db`。

### 2026-08-15 复验

执行 `0008_page_acl_roles.sql` 时，CLI 输出：

```text
✔ applied 0008_page_acl_roles.sql
1 migration(s) applied
```

但紧接着执行 `d1 migrations list` 仍把 `0008` 标记为未应用。生产导出确认页面权限表已经成功重建并支持 `none`，同时账本新增了以下空记录：

```sql
INSERT INTO d1_migrations(id, name, applied_at) VALUES (8, NULL, NULL);
```

因此 RF-7 在当前环境仍未修复。Rdocs 已先保存迁移前的 33 表完整导出，然后只在 `rdocs-db` 内把该空记录更新为 `0008_page_acl_roles.sql`；再次执行 migration list 后 `0001`–`0008` 全部显示已应用。迁移前后均有 79 个页面，未发生页面数据丢失。

发布完整权限系统时，`0009_complete_permissions.sql` 再次复现相同行为：CLI 报告 migration 已应用，schema 和数据变更也已生效，但生产导出显示第 9 行仍为 `(9, NULL, NULL)`。Rdocs 在迁移前保存了完整 33 表备份，只把 `rdocs-db.d1_migrations` 第 9 行修复为实际文件名；随后 `migrations list` 显示 `0001`–`0009` 全部已应用，Owner、真实设备密钥和页面均保留，系统账号组织成员关系已删除，`pragma_foreign_key_check` 为 0。

同日执行数据库内核迁移 `0010_databases.sql` 时，即使 RandallFlare 已反馈修复，问题仍第三次复现：CLI 报告成功、生产导出从 33 张表增加到 39 张表，但账本新增 `(10, NULL, NULL)`，`migrations list` 继续显示 `0010` 未应用。Rdocs 已在执行前完整导出 33 张表到 `/tmp/rdocs-db-backup-e8P3J3/before-0010.sql`，确认新表和外键正常后，仅把第 10 行更新为 `0010_databases.sql`；随后迁移列表 `0001`–`0010` 全部为已应用。没有修改 RandallFlare 平台代码。

执行 `0011_database_relations_and_sequences.sql` 时第四次复现：CLI 报告成功，但第 11 条账本记录仍为 `(11, NULL, NULL)`。执行前的 39 表完整备份保存在 `/tmp/rdocs-db-backup-OLC8Co/before-0011.sql`（132,615 bytes）。复验确认 `database_counters` 已创建、现有行无空序号、外键违规为 0 后，只把第 11 条 Rdocs 账本记录修复为实际文件名；`migrations list` 随后显示 `0001`–`0011` 全部已应用。没有修改 RandallFlare 平台代码或配置。

紧接着执行滚动发布保护迁移 `0012_database_sequence_rollout_guards.sql` 时第五次复现，第 12 条账本仍为 `(12, NULL, NULL)`。执行前 40 表备份位于 `/tmp/rdocs-db-backup-LoRCKz/before-0012.sql`（141,335 bytes）。复验确认两个兼容触发器均存在、无空序号、外键违规为 0 后，只修复第 12 条 Rdocs 账本记录；迁移列表 `0001`–`0012` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行公开数据库表单迁移 `0013_public_database_forms.sql` 时第六次复现：业务 schema 和系统提交身份均已创建，但第 13 条账本仍为 `(13, NULL, NULL)`。执行前完整备份位于 `/tmp/rdocs-db-backup-URwida/before-0013.sql`（141,591 bytes）。复验确认 `database_form_links`、`database_form_submissions` 和 `usr_rdocs_forms` 均存在，系统身份的组织成员关系为 0 且外键无违规后，只修复第 13 条 Rdocs 账本记录；迁移列表 `0001`–`0013` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行数据库模板迁移 `0014_database_templates.sql` 时第七次复现：模板表及“每个数据库最多一个默认模板”的唯一索引均已创建，但第 14 条账本仍为 `(14, NULL, NULL)`。执行前 42 表完整备份位于 `/tmp/rdocs-db-backup-yRtCv1/before-0014.sql`（142,768 bytes）。复验确认目标表、索引存在且外键无违规后，只修复第 14 条 Rdocs 账本记录；迁移列表 `0001`–`0014` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行自动化迁移 `0015_database_automations.sql` 时第八次复现：CLI 报告成功，两张目标表已创建，生产表数由 43 增至 45，但第 15 条账本仍为 `(15, NULL, NULL)`。执行前完整备份位于 `/tmp/rdocs-db-backup-bdw4gk/before-0015.sql`（143,552 bytes）。复验目标表定义和外键后，只把第 15 条 Rdocs 账本记录修复为实际文件名；迁移列表 `0001`–`0015` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行页面外观与锁定迁移 `0016_page_appearance_and_lock.sql` 时第九次复现：6 个页面字段和封面索引均已创建，现有页面全部回填安全默认值，但第 16 条账本仍为 `(16, NULL, NULL)`。执行前 45 表完整备份位于 `/tmp/rdocs-db-backup-lScGOg/before-0016.sql`（145,279 bytes）。复验页面 schema 后，只修复第 16 条 Rdocs 账本记录；迁移列表 `0001`–`0016` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行编辑器 schema v3 迁移 `0017_editor_core_blocks.sql` 时第十次复现：84 个现有页面全部更新为 `editor_schema_version = 3`，表数仍为 45，但第 17 条账本仍为 `(17, NULL, NULL)`。执行前完整备份位于 `/tmp/rdocs-db-backup-AOVyng/before-0017.sql`（155,921 bytes）。复验导出中所有页面版本和业务数据后，只修复第 17 条 Rdocs 账本记录；迁移列表 `0001`–`0017` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行块操作与分栏迁移 `0018_editor_block_controls_and_columns.sql` 时第十一次复现：84 个现有页面全部更新为 `editor_schema_version = 4`，表数仍为 45，但第 18 条账本仍为 `(18, NULL, NULL)`。执行前完整备份位于 `/tmp/rdocs-db-backup-lxHMGw/before-0018.sql`（156,045 bytes）。复验全部页面版本后，只修复第 18 条 Rdocs 账本记录；迁移列表 `0001`–`0018` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行私有文件与媒体块迁移 `0019_editor_attachment_and_media_blocks.sql` 时第十二次复现：84 个现有页面全部更新为 `editor_schema_version = 5`，表数仍为 45，外键违规为 0，但第 19 条账本仍为 `(19, NULL, NULL)`。执行前完整备份位于 `/tmp/rdocs-db-backup-PfTTor/before-0019.sql`（156,987 bytes）。复验所有页面版本和数据完整性后，只修复第 19 条 Rdocs 账本记录；迁移列表 `0001`–`0019` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行动态面包屑与页面按钮迁移 `0020_editor_page_button_and_breadcrumb.sql` 时第十三次复现：84 个现有页面全部更新为 `editor_schema_version = 6`，表数仍为 45，外键违规为 0，但第 20 条账本仍为 `(20, NULL, NULL)`。执行前完整备份位于 `/tmp/rdocs-db-backup-2j6X8A/before-0020.sql`（159,957 bytes）。复验所有页面版本和数据完整性后，只修复第 20 条 Rdocs 账本记录；迁移列表 `0001`–`0020` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行跨页同步块迁移 `0021_cross_page_synced_blocks.sql` 时第十四次复现：迁移本体成功，生产库从 45 张表增加到 47 张表，84 个现有页面全部更新为 `editor_schema_version = 7`，新同步资源表初始为空且外键违规为 0，但第 21 条账本仍为 `(21, NULL, NULL)`。执行前完整备份位于 `/tmp/rdocs-db-backup-v9he1U/before-0021.sql`（160,096 bytes，SHA-256 `915d50e536e2f1c8e2369c8bb3373872d568d090505b9ad1ea5ff3a4fd1a8b63`）。只修复第 21 条 Rdocs 账本记录后，迁移列表 `0001`–`0021` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行同步块生命周期迁移 `0022_synced_block_lifecycle.sql` 时第十五次复现：`lifecycle_state` 列与索引成功创建，生产库仍为 47 张表、84 个页面保持 `editor_schema_version = 7`、同步资源为空且外键违规为 0，但第 22 条账本仍写成 `(22, NULL, NULL)`。执行前完整备份位于 `/tmp/rdocs-db-backup-9wncYy/before-0022.sql`（161,276 bytes，SHA-256 `6490897e8e1eb7cf32fe13fa0914fbf39cb2ee14e07276d2fdd9bf9259deba49`）。只修复第 22 条 Rdocs 账本记录后，迁移列表 `0001`–`0022` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

执行页面发现与反向链接迁移 `0023_page_discovery_and_links.sql` 时第十六次复现：`page_links` 表和目标索引成功创建，生产库由 47 张表增加到 48 张表，84 个页面全部更新为 `editor_schema_version = 8`，链接投影初始为空且外键违规为 0，但第 23 条账本仍写成 `(23, NULL, NULL)`。执行前完整备份位于 `/tmp/rdocs-db-backup-Ch8Ro8/before-0023.sql`（162,252 bytes，SHA-256 `4501939fed260b2fb2418309a382b91db391749414023c92b8e1d066cd2e5a8a`）。只修复第 23 条 Rdocs 账本记录后，迁移列表 `0001`–`0023` 全部显示已应用。没有修改 RandallFlare 平台代码或配置。

### 建议修复与验收

- 修复 D1 exec API 的参数传递，或让 CLI 在写账本前验证 `changes=1` 且回读的 `name` 与文件名一致。
- `d1_migrations.name` 应为 `TEXT NOT NULL UNIQUE`，避免参数丢失静默成功。
- 增加测试：迁移 SQL 成功后账本记录非 NULL；二次 apply 必须输出 `already up to date`，不能重跑 `ALTER TABLE`。
- 用包含单引号、Unicode 和长文件名的 migration 名验证参数编码。

## RF-9：自定义域名转发后的 Worker URL 与公开 Origin 不一致

### 现象

Rdocs Git build `a5f6dd5` 激活后，从正式地址请求设备密钥登记接口：

```text
POST https://docs.bigrandall.io/api/auth/passkey/registration/options
Origin: https://docs.bigrandall.io
→ 403 请求来源不允许
```

Rdocs 会话接口同时确认配置的 WebAuthn Origin 正是 `https://docs.bigrandall.io`。原校验要求浏览器 `Origin` 和 Worker 内的 `new URL(request.url).origin` 都等于正式域名；正式请求仍失败，说明自定义域名转发后的 Worker URL 没有保留同一公开 Origin（或等价的公开 URL 信息未进入 Request URL）。协作 Origin 校验此前之所以可用，是因为它额外允许显式配置的 `APP_ORIGIN`。

### Rdocs 安全处理

Rdocs 改为精确校验浏览器不可由跨站脚本伪造的 `Origin` 头；缺失或不等于 `https://docs.bigrandall.io` 仍返回 403。会话 Cookie 继续使用 `HttpOnly; Secure; SameSite=Lax`，WebAuthn 注册和认证响应仍由库对预期 RP ID 与 Origin 做密码学验证。因此该兼容处理没有信任任意转发头，也没有放宽到其他域名。

### 建议平台确认

- Worker 的 `request.url` 应保留浏览器访问的 scheme、host 和 path，内部 upstream 地址不应暴露为应用 URL。
- 若必须内部重写，应提供不可伪造且由平台规范化的原始 URL 元数据，并覆盖自定义域名、自动域名关闭和多层转发测试。
- 用一个回显 `request.url`、`Host`、`Forwarded` 元数据的最小 Worker 验证 `docs.bigrandall.io`，不要在生产 Rdocs 增加永久诊断端点。

## RF-8：低并发顺序 API 仍会间歇返回 502/503

### 现象

在新版本部署完成、D1 外键检查通过后，`npm run smoke:product` 以单客户端顺序调用产品 API。已观测的运行中：

1. 第一次在 `POST /api/pages/{id}/share-links` 返回 502。
2. 第二次完整通过租户、页面、搜索、权限、评论、附件、分享、Markdown、用户组、邀请、审计和回收站。
3. 第三次在 `POST /api/pages/{id}/export/markdown` 返回 502。
4. 最终发布复验在 `POST /api/pages/{id}/comments` 返回 502，错误体为 `upstream peer unreachable`，`x-request-id` 为 `d7f393ea7591d4346a01cf23acceba06`。

单独重试相同类型的创建分享请求可以返回 201。失败端点不固定，请求不是并发洪泛；smoke 每一步都等待上一响应。最终一次平台错误明确返回 `upstream peer unreachable`，与此前没有 Rdocs 业务错误字段的 502 一致，因此应沿 front door 到 compute peer 的路由、健康状态和连接复用链路排查。

2026-08-15 在 Git build `6ba379f` 成功激活、15 秒稳定等待之后，使用错误登记码对设备密钥 options 接口执行 20 次顺序请求（每次都等待上一次完成）。19 次按预期返回 Rdocs JSON 403；第 9 次由平台返回：

```text
HTTP/2 502
x-request-id: cb618fb0f99a4c4a300abdbef9c3d56d
upstream peer unreachable
```

该请求在校验错误登记码后不会创建 challenge 或修改业务数据，因此这次复现排除了并发写入、重复提交和 Rdocs 数据副作用。RF-8 在当前 RandallFlare 版本仍可稳定以低并发顺序请求复现。

完整权限系统 commit `6085569d` 的 Git build 成功激活后，正式域名验收同时请求健康、会话、组织和旧页面树入口。其中 `GET /api/organizations` 没有到达 Rdocs 的预期 401，而由平台返回：

```text
HTTP/2 503
retry-after: 1
x-rf-edge-failover: 1
x-request-id: 1b4f9e8603cd609723800a362ded5a7d
edge node is at capacity; retry shortly
```

紧接着对同一只读端点做 10 次严格顺序请求，10/10 均按预期返回 Rdocs JSON 401，耗时 0.27–0.90 秒。这次复现不涉及 D1 写入、DO 或 R2，也没有并发洪泛，说明 RF-8 还包括 front door / edge capacity 与 failover 路径，不只发生在复杂写端点。

Rdocs 没有自动重放创建分享、评论、邀请等非幂等写请求，因为响应丢失后盲目重试可能制造重复数据。产品 smoke 已增加 20 秒单请求超时，并在失败信息中输出 `x-request-id` 和最多 500 字节的原始错误体，供后续关联平台日志。

### 建议排查与验收

- 用 `x-request-id` 串联 front door、compute、D1 executor、DO 和 R2 日志；平台生成的 502 也必须返回可关联 ID。
- 检查 PR #146 的 D1 executor 有界等待是否覆盖同一请求内的多次顺序 D1 调用，以及 DO→D1/R2 的内部调用。
- 连续运行 `npm run smoke:product` 100 次，要求 100/100 通过且无 502/503/504。
- 端点级压力测试至少覆盖分享创建、版本/导出快照、评论批量写和 ACL bump。

## 2026-08-14 修复与现网复验

平台修复集中在以下 RandallFlare 变更：

- PR #145：修复 handoff、DO identity、Git/env 原子激活和 `rrangler` 参数解析，并补齐 desired/observed 状态。
- PR #146：D1 executor 饱和时改为在操作 deadline 内有界等待，避免不同数据库并发把第 9 个请求直接打成 502。
- PR #147：保留 workerd 所有权下的 101 Response，避免包装 Server-Timing 时重建 101 导致 `RangeError`。
- PR #148：分配 workerd 端口时同时检查真实 listener，避免端口位图滞后触发 `EADDRINUSE`。
- PR #149：原生 DO actor 同时支持模块显式导出和旧式 `register(className, Class)`；bindingName 与 className 可不同。

自动滚动发布严格保持每地区至少一台可用节点。最终结果为 15/15 READY 节点运行
`2026.08.14.4997d91`；最近运行日志未再出现 101 Response、DO class resolution 或
`EADDRINUSE` 错误。

现网验收结果：

1. Rdocs 原始 `smoke:collab` 在正式域名通过 two-client convergence、DO persistence、reconnect restore 和 live revocation（4403）。
2. 固定 owner + 9 个 cross-node 客户端全部收敛；100 客户端房间全部连接后，广播在约 353 ms 内送达全部客户端。
3. 连接静默 61 秒后仍可双向发送，cross-node 广播约 301 ms。
4. 使用真实 `bindingName=GAME_ROOMS`、`className=GameRoom` 且只调用旧式 `register()` 的 `xiangqi` Worker：20/20 次 DO 读取为 200，WebSocket 收到初始状态及后续消息。
5. Rdocs Git build `b8d5a4a` 生成 v82 后自动激活为 v83；10/10 承载节点 observed v83/OK，`publishedAt` 同步更新，无需额外 env 写入触发。
6. 控制面 `RELEASE_SHA=659b8a6...` 与公开运行时 `/api/health` 完全一致。该变量是显式 env 值，不会被后续 Git commit 隐式改写。
7. RandallFlare 单元测试 95/95、edge-agent 全量 Go 测试、真实 workerd 生成配置启动测试、Rdocs typecheck/14 项测试/生产构建全部通过。

---

## RF-1：集群转发后的 DO WebSocket handoff 被主动拒绝

### 用户侧现象

Chromium 原生 WebSocket：

```text
close code: 1006
reason: ""
```

同一个 URL、ticket 和 Origin 使用 Node `ws` 时，第一条连接可以完成 Yjs sync，第二条连接收到：

```text
durable object ownership changed during handoff
```

这段文本来自 RandallFlare router，不来自 Rdocs。

### 现网复现

在 `/root/docs` 执行：

```bash
RDOCS_SMOKE_DEBUG=1 npm run smoke:collab
```

2026-08-14 当前输出的关键部分：

```text
smoke-alice received sync message 0 1
smoke-alice received sync message 1 2
smoke-bob unexpected response body durable object ownership changed during handoff
```

真实 Chromium 中直接建立 `/collab/{pageId}?ticket=...` 的两次独立测试均为 `1006`；此前的 ticket HTTP 请求均为 200，因此不是 Rdocs 的 ticket、Origin 或 Yjs 校验失败。

### 实际请求路径

```text
Browser
  → Front Door
  → compute 节点（带有效集群签名，clusterMeta.Forwarded = true）
  → Rdocs Worker
  → env.<DO>.get(...).fetch(WebSocket upgrade)
  → DO owner 不在当前 compute
  → workerd shim 注册 one-time handoff，返回内部 421
  → compute router 看到 clusterMeta.Forwarded=true
  → 主动把 421 改成 409：ownership changed during handoff
  → 浏览器只看到握手失败 / 1006
```

### 根因代码

1. `/develop/bigrandall.io/edge-agent/internal/workerd/manager.go:4789`

   远端 DO WebSocket 无法穿过普通 Fetcher，因此 shim 注册 handoff 并返回内部 `421 + X-Edge-DO-Handoff`。这个设计方向是正确的。

2. `/develop/bigrandall.io/edge-agent/internal/router/router.go:1308`

   当前逻辑：

   ```go
   if token == "" || clusterMeta.Forwarded {
       message := "durable object ownership changed during handoff\n"
       // 转成 409
   }
   ```

   `clusterMeta.Forwarded` 只表示公开请求已经经过 `Front Door → compute`，不表示 DO ownership 在请求期间发生变化。正常三段路径本来就是：

   ```text
   Front Door → compute → DO owner
   ```

   这里把正常拓扑错误地当成 ownership race。

3. `/develop/bigrandall.io/edge-agent/internal/router/cluster.go:774`

   `maxClusterHops=1` 用于阻止普通 Worker 请求在 compute 节点间继续转发。DO handoff 走的是一次性 token + fleet-authenticated `/__edge_fleet_do__/` 路径，不应被当成第二次普通 cluster routing。

4. `/develop/bigrandall.io/edge-agent/internal/doproxy/doproxy.go:492`

   `HandleWebSocketHandoff` 已经具备 worker-scoped、one-time、20 秒过期 token，并直接调用 `forwardCrossNode`。安全边界已经足够，不需要用 `clusterMeta.Forwarded` 一刀切拒绝。

### 建议修复

- 对有效、未过期且 worker 匹配的一次性 handoff token，允许在 `clusterMeta.Forwarded=true` 时进入 `HandleWebSocketHandoff`。
- 普通 cluster routing 的 `maxClusterHops=1` 保持不变；DO fleet path 继续由 fleet secret / mTLS、placement epoch 和 one-time token 单独鉴权。
- 不要用 `clusterMeta.Forwarded` 推断 ownership 变化。真正的 ownership race 应由 placement epoch、owner 返回的 409 或重新 locate 判断。
- handoff 失败时增加结构化日志：`request_id`、source compute、DO owner、worker、binding、instance、placement epoch、token lookup result；不要记录 token 本身。

### 缺失测试

当前只有：

- `doproxy_test.go`：验证 token 是 worker-scoped 且只能使用一次。
- `do_wrapper_test.go`：静态检查 shim 源码包含 handoff 字符串。

缺少 router 集成测试，因此 `clusterMeta.Forwarded` 拒绝正常 handoff 没被发现。至少补：

1. 带有效集群签名的 WebSocket 请求到达 compute。
2. mock Worker upstream 返回 `421 + X-Edge-DO-Handoff`。
3. router 必须调用 `HandleWebSocketHandoff`，而不是返回 409。
4. 最终返回 101，并验证双向 binary frame。
5. 三节点 E2E：`Front Door A → compute B → DO owner C`。

### 验收标准

- Chromium 连续 50 次建立连接，无 `1006` 和间歇性 409/500。
- 同一 DO 同时建立至少 10 条连接，连接全部落到唯一 owner/实例。
- Node `npm run smoke:collab` 通过 convergence、persistence、reconnect 和 revocation。

---

## RF-2：Durable Object 的 bindingName 与 className 被混用

### 现象

Cloudflare 允许：

```text
bindingName = COLLAB_ROOM
className   = DocumentRoom
```

RandallFlare 当前远端 dispatch 路径在两者不相同时可能返回：

```text
DO binding "DocumentRoom" not configured
```

Rdocs 目前被迫把两者都配置成 `DocumentRoom` 才能降低失败率。这不是正确的兼容要求。

### 根因代码

1. `/develop/bigrandall.io/edge-agent/internal/workerd/manager.go:2620`

   wrapper 给 `namespace()` 传入的是：

   ```text
   env.<BINDING>_CLASS
   ```

   即 className。

2. `/develop/bigrandall.io/edge-agent/internal/workerd/manager.go:4906`

   `namespace(svc, className, workerId, env)` 又把 className 保存成 Stub 的 `_binding`，后续 placement、handoff 和 invoke URL 都使用它。

3. `/develop/bigrandall.io/edge-agent/internal/workerd/manager.go:4982`

   远端 owner 执行 `dispatchDO()` 时解析 URL 中的 `binding`，然后执行：

   ```js
   const svc = env[binding];
   ```

   如果 URL 中是 `DocumentRoom`，实际 env binding 是 `COLLAB_ROOM`，`svc` 就是 `undefined`，随后触发 `DO binding "DocumentRoom" not configured`。

### 建议修复

- placement identity、locate key、handoff path、invoke path 和 `env[...]` 查找全部使用 `bindingName`。
- `className` 只用于从用户 module 中选择并注册导出的 class。
- 生成 wrapper 时，`__rfNamespace` 的第二个参数直接传配置中的 `b.Name`，不要传 `env[b.Name + "_CLASS"]`。
- 注册表以 bindingName 为主要 key；className alias 可以保留用于兼容，但不能用于 storage/placement identity。

### 迁移风险

当前错误实现已经把 className 写进部分 `EdgeDoInstance.bindingName`。直接切换会为 bindingName 创建新实例，导致旧 SQLite 状态留在旧 identity 下。

修复时需要：

- 为 `bindingName != className` 的现有实例提供一次迁移或 alias；或
- 在控制面按 worker 的 DO binding 配置把旧 `(workerId, className, instanceName)` 重命名为 `(workerId, bindingName, instanceName)`；
- 检测冲突：新旧 identity 同时存在时禁止自动覆盖并要求人工选择权威实例。

### 验收标准

使用刻意不同的配置：

```text
bindingName = ROOM
className   = DocumentRoom
```

验证 owner-local、cross-node fetch、WebSocket、RPC、alarm 和 SQLite 恢复全部成功；日志和数据库 identity 始终使用 `ROOM`。

---

## RF-3：多 WebSocket peer send/broadcast 必须重新验收

### 历史现象

在 RF-1 出现前的运行中，曾观察到：

- 同一 DO 报告两条连接。
- A 的 update 已被 handler 处理并写入 DO SQLite。
- `currentSeq` 正常递增。
- DO 对 B 调用 `socket.send(binaryFrame)`，B 没有收到 message event。
- `state.acceptWebSocket()` 与普通 `server.accept()` 都复现。
- 把 send 移到 SQLite await 之前仍不送达，因此不是持久化时序问题。

### 当前判断

RF-1 让第二条连接经常在握手阶段失败，因此当前无法把 peer send 单独判定为已修复或仍有独立根因。修好 RF-1 后必须重新做完整验收，不能以“101 成功”代替 broadcast 验收。

需要重点确认：

- 同一个 `(workerId, bindingName, instanceName)` 在 owner 节点只有一个内存实例。
- 多个 101 reverse-proxy tunnel 的 server-side WebSocket 在 fetch handler 返回后仍然可写。
- 后续 `message` handler 中对另一条 socket 的 binary `send()` 可以穿过各自 tunnel。
- close/error 能从 proxy 传播回 owner，避免 sockets 集合永久残留。
- owner-local 与 cross-node handoff 建立的 socket 可以互相广播。

### 验收标准

- 2、10、100 客户端房间分别做双向广播，消息无丢失、无乱序、无幽灵连接。
- 混合拓扑：一个 owner-local 客户端 + 多个 cross-node 客户端。
- binary 类型覆盖 `ArrayBuffer`、typed array 和运行时实际提供的 `Blob`。
- handler 返回后等待 60 秒再由任意客户端发送，peer 仍能收到。

---

## RF-4：Git build SUCCESS 不保证边缘版本已激活

### 现象

- Git push 后 `worker builds rdocs` 显示 `SUCCESS`。
- 控制面的 Worker files 和 `gitLastBuiltCommit` 已是新 commit。
- 边缘仍可能继续提供旧 HTML/Worker。
- `publishedAt` 不更新。
- 再修改一次 Rdocs 自己的环境变量、触发额外 version bump 后，新代码才出现在边缘。

本次观察：

```text
gitLastBuiltCommit = 44542e24d752f2f9cafb57743728ce212c68a3e2
worker status       = PUBLISHED
worker version      = 64
publishedAt         = 2026-08-14T09:43:31.325Z  # 没随本次发布变化
```

### 可疑代码/语义缺口

`/develop/bigrandall.io/src/lib/edge/workers-builder.ts:480` 在生产构建成功后更新：

- `files`
- `entryFile`
- `version += 1`
- `gitLastBuiltCommit`

但没有更新 `publishedAt`，也没有等待任何 edge agent 确认该 version 已加载，就把 build 标成 `SUCCESS`。

`/develop/bigrandall.io/src/app/edge/agent/poll/route.ts:1113` 仅在 agent 的 known version 与 desired version 不同时下发代码。当前缺少用户可见的 desired/observed version 和每节点 ack，无法区分：

```text
artifact 构建成功
control plane desired version 已更新
edge agent 已下载
workerd runtime 已替换
公开流量已切换
```

### 建议修复

- 明确定义 build 与 deploy/publish 为两个状态机阶段。
- 生产 Git build 成功后执行明确的 publish/activate 操作，原子更新 desired version 和 `publishedAt`。
- agent 成功加载 runtime 后回报 observed version；控制面至少展示 desired/observed，不要只显示 `SUCCESS`。
- 如果语义规定 Git `main` build 自动发布，构建完成后必须自动触发，不应依赖一次无关 env 写入。
- 对 gradual rollout 场景明确：Git build 是更新 target、stable，还是只创建候选版本；不能静默停在旧 stable。

### 验收标准

1. push 一个包含唯一 marker 的 main commit。
2. build `SUCCESS` 后不做任何额外 mutation。
3. 所有健康节点在约定 SLO 内返回新 marker/version。
4. `publishedAt` 更新；控制面显示 desired 与 observed version。
5. 节点离线后恢复，也会追到 desired version。

---

## RF-5：envJson 控制面已更新，但运行时仍是旧值

### 现象

执行 Rdocs 自己的部署变量更新后：

```text
rrangler worker env set rdocs RELEASE_SHA=44542e24d752f2f9cafb57743728ce212c68a3e2
```

控制面 `worker get rdocs` 显示：

```json
{
  "envJson": {
    "RELEASE_SHA": "44542e24d752f2f9cafb57743728ce212c68a3e2"
  }
}
```

但公开 Worker 的 `/api/health` 返回：

```json
{
  "release": "local"
}
```

同一个运行时可以读到早期写入的 `ENVIRONMENT=production`，说明不是 Rdocs 完全没有 env binding，而是控制面新值没有进入当前 runtime。

### 可疑路径

- `/develop/bigrandall.io/src/app/api/edge/v1/workers/[id]/env/route.ts:113`：env mutation 只更新 `EdgeWorker.envJson` 并 bump version。
- `/develop/bigrandall.io/src/app/edge/agent/poll/route.ts:1116`：有 active rollout 时，canonical version 可能固定为 `rollout.stableVersion`。
- `/develop/bigrandall.io/src/app/edge/agent/poll/route.ts:1181`：stable rollout 从 `EdgeWorkerVersion.envJson` 读取快照，而不是当前 `EdgeWorker.envJson`。

这会产生必须明确的产品语义问题：env 是“随版本固定的快照”，还是“跨版本的当前 overlay”。当前 API 文档写的是“bump version，next agent poll picks the new env up”，但 rollout/snapshot 路径可能让这条承诺失效。

### 建议修复

- 先明确 env 版本模型：
  - 若 env 随版本固定：env mutation 必须创建新 version snapshot，并更新当前 stable/target 指针。
  - 若 env 是全局 overlay：agent 下发任意 stable/canary 代码时都应合并当前 Worker env，并把 env revision 独立纳入 known-state 比较。
- agent 应回报实际 runtime env revision/hash；不要仅用 code version 推断 env 已加载。
- runtime 替换成功后再 ack；确保旧 isolate 不继续无限服务。

### 验收标准

- 设置 `ENV_PROBE=<uuid>`，不做其他写操作。
- 下一轮 poll 后，owner-local 与 cluster-forwarded 请求都返回同一个新值。
- 删除变量后两个路径都看不到旧值。
- stable rollout、canary rollout、无 rollout 三种模式分别通过。

---

## RF-6：rrangler 对所有参数执行 `split(":")`

### 根因代码

`/develop/bigrandall.io/rrangler/bin/rrangler.mjs:99`：

```js
function normalize(tokens) {
  return tokens.flatMap((t) => t.split(':'));
}
```

该函数本意是兼容：

```text
kv:namespace → kv namespace
```

但它作用于所有 argv token，因此会破坏：

- URL：`https://docs.bigrandall.io`
- JSON：`{"API":"https://example.com"}`
- IPv6：`[2001:db8::1]:443`
- 任何包含冒号的 secret、DSN、时间或路径

例如：

```bash
rrangler worker env set rdocs APP_ORIGIN=https://docs.bigrandall.io
```

会把一个合法的 `KEY=VALUE` 拆成多个 positional token。

### 建议修复

- 只对命令路径位置做兼容展开，不要修改已经进入参数区的 token。
- 更稳妥的实现：先尝试用 argv 前 1～3 个 token 匹配命令表；仅对第一个命令 token 中的已知 `:` alias 展开。
- `--flag=value` 的 value、positional value 和 `KEY=VALUE` 必须逐字保留。

### 验收标准

增加 CLI 测试覆盖：

```text
worker env set w URL=https://example.com/a:b
worker git set w --build-env '{"API":"https://example.com"}'
worker env set w DSN=postgres://u:p@[2001:db8::1]:5432/db
kv:namespace list
```

前三条的 value 必须字节级不变，最后一条仍兼容旧 alias。

---

## 不属于平台 bug 的 Rdocs 域名配置

`docs.bigrandall.io` 已于平台修复后绑定到 `rdocs` Worker，并成为正式验收域名。
旧自动域名 `rdocs-randall.edge.bigrandall.io` 已禁用；它返回 404 是明确的产品配置，
不是 Worker 丢失或边缘部署失败。烟测和监控必须使用正式域名。

## 最终全链路验收

已在 `/root/docs` 运行：

```bash
npm run typecheck
npm test
npm run build
RDOCS_SMOKE_DEBUG=1 \
RDOCS_SMOKE_URL='https://docs.bigrandall.io' \
RDOCS_SMOKE_ORIGIN='https://docs.bigrandall.io' \
RDOCS_SMOKE_ADMIN_SECRET='<Rdocs admin secret>' \
npm run smoke:collab
```

然后使用两个独立 Chromium profile 打开同一页面，确认：

1. 两端原生 WebSocket 均为 open，不再依赖 HTTP fallback 才显示已同步。
2. 正文双向收敛。
3. 协作者光标和圆形身份气泡双向可见。
4. 新客户端从 DO SQLite 恢复正文。
5. 权限撤销立即关闭现有 socket，旧 ticket 不能重连。
6. Git main build 自动激活，运行时 commit/env 与控制面一致。
