# Rdocs 架构说明

## 产品边界

Rdocs 的产品定义是团队多人实时协作知识库，不是单份在线编辑器。第一阶段优先证明以下闭环：

1. 两个客户端编辑同一页面并收敛。
2. 更新先持久化，再向其他连接广播。
3. Worker 或 DO 重新初始化后能恢复正文。
4. 客户端重连后通过 state vector 获取缺失更新。
5. 权限撤销后新请求和现有连接都失效。
6. 旧版本通过新 generation 恢复，避免离线旧客户端污染新正文。

评论、全文搜索、附件、通知和完整产品界面必须建立在上述闭环通过之后。

## 数据所有权

| 组件          | 权威数据                                  | 不负责         |
| ------------- | ----------------------------------------- | -------------- |
| Rdocs Worker  | 路由、票据、Origin 和 frame 校验          | 长期保存正文   |
| DocumentRoom  | 单页面 generation 的 Y.Doc、增量和快照    | 跨空间查询     |
| D1            | 用户、组织、空间、页面树、ACL、版本元数据 | 高频按键更新   |
| R2            | 附件、导出和冷快照                        | 权限真相       |
| Queue（后续） | 搜索、通知和导出异步事件                  | 实时编辑主链路 |

页面正文与 `pages` 元数据严格分离。DO 名称使用：

```text
document:{pageId}:generation:{generation}
```

## 页面树

页面树是 D1 中 `pages.parent_id` 和 `sort_key` 的投影，不进入 Y.Doc，也不依赖 Durable Object：

```text
GET  /api/pages             → 当前 Phase 0 空间的页面元数据
POST /api/pages             → 创建根页面，或通过 parentId 创建子页面
GET  /api/pages/{pageId}    → 读取单页元数据
PATCH /api/pages/{pageId}   → 自动保存页面标题
```

列表按 `sort_key`、`id` 稳定排序，当前技术预览最多返回 500 个页面。创建子页面前，Worker 会验证父页面存在且属于当前组织与空间。前端会防御性处理孤儿节点、自引用和循环父链，保证异常元数据不会让页面从导航中消失。

## 设备密钥与应用会话

Rdocs 不使用 GitHub OAuth，也不实现密码登录。正式登录采用 WebAuthn discoverable credential：浏览器和系统认证器在设备上生成并保管私钥，Rdocs 只在 D1 保存 credential ID、公钥、签名计数器和备份属性，不接触生物识别数据。

首次设备登记使用管理员持有的高熵登记码完成 bootstrap；登记码只作为 RandallFlare secret 保存，不进入仓库或数据库。它只控制未登录用户的新账号登记，不参与已有设备密钥的登录，因此 bootstrap 完成后可以删除。登记挑战和登录挑战有效期均为 5 分钟，并在成功验证后一次性消费。注册要求 resident key 和 user verification，登录采用无用户名的设备密钥发现流程。

验证成功后，Worker 生成随机应用会话令牌。D1 `sessions` 表只保存 SHA-256 哈希，浏览器通过 `__Host-rdocs_session` Cookie 持有原令牌；Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Lax` 和 `Path=/`。写请求必须同时满足请求 URL 与 `Origin` 精确等于 `https://docs.bigrandall.io`，会话过期时前端静默重新读取状态并回到设备密钥登录页。

生产配置只有显式 `AUTH_MODE=phase0` 才允许匿名技术预览；变量缺失或拼写错误会 fail closed 到设备密钥模式。正式激活流程见 [设备密钥启用手册](PASSKEY_SETUP.md)。

## 协作协议

浏览器先请求：

```text
POST /api/pages/{pageId}/collab-ticket
```

Worker 对页面状态和 ACL version 做当前读取，返回 5 分钟有效的 HMAC ticket。客户端优先连接：

```text
GET /collab/{pageId}?ticket=...
Upgrade: websocket
```

二进制消息兼容 y-websocket：外层类型 `0` 为 sync、`1` 为 awareness；sync 内层支持 step 1、step 2 和 update。应用限制单 frame 最大 256 KiB。

为兼容 RandallFlare 当前的浏览器 WebSocket 和 DO peer broadcast 问题，客户端同时启动应用层 HTTP 同步：

```text
POST /api/pages/{pageId}/collaboration-sync
Authorization: Bearer <collab-ticket>
Content-Type: application/octet-stream
```

请求携带客户端 state vector、尚未被服务端确认的 Yjs update 和 awareness update；响应返回缺失的服务端 update、服务端 state vector 和当前 awareness。正文输入约 25 ms 后上传，页面可见时约每 350 ms 拉取远端变化，隐藏时降为约 1500 ms。一次瞬时失败不会把界面切回“重新连接中”，票据过期会在后台静默续签；超过 10 秒未续心跳的 HTTP awareness 会被清理，避免幽灵协作者和残留光标。

更新的目标顺序是：

```text
validate → deduplicate → persist SQLite → apply Y.Doc → broadcast
```

只有完成 SQLite 写入的更新才允许进入 Y.Doc、WebSocket broadcast 和 HTTP 响应。HTTP 与 WebSocket 复用同一个 DocumentRoom、Y.Doc 和 SQLite 更新序列；D1 只负责 ACL 元数据，不承载高频正文轮询。Worker 对协作授权最多缓存 2 秒以降低轮询读取压力，权限变更会主动清除当前 isolate 缓存并通知 DocumentRoom。

## 持久化与恢复

每个 DocumentRoom 私有 SQLite 包含：

- `room_meta`：页面、generation、seq 和 schema version。
- `updates`：按 seq 追加的 Yjs update。
- `snapshots`：完整 state update 与 state vector。

对象初始化时加载最新快照，再按 seq 应用其后的增量。每 100 条更新或累计 512 KiB 生成快照；最后一个连接离开时也生成快照。

## 用户版本与 generation 恢复

手动版本不是 D1 元数据的空壳。创建版本时，Worker 要求当前浏览器先完成一次 HTTP/Yjs flush，然后让当前 DocumentRoom 生成完整 Yjs state update，校验 SHA-256 后写入 R2 不可变对象，最后登记 D1 `revisions`。R2 key 包含组织、页面和 revision ID；D1 保存 generation、collab seq、对象引用和内容哈希。

恢复版本采用新 generation，不能把旧 update 直接覆盖到当前 Y.Doc：

```text
flush 当前客户端
→ 保存恢复前 Revision
→ 读取并校验目标 R2 快照
→ 初始化尚未使用的新 generation DocumentRoom
→ 条件更新 pages.current_generation
→ 关闭旧 generation WebSocket
→ 旧 HTTP ticket 收到 document_rebased
→ 所有客户端重新取票并连接新 generation
```

新 generation 在 D1 切换前完成初始化；页面更新使用旧 generation 作为 compare-and-swap 条件，防止两个恢复操作同时生效。旧 generation 后续即使收到迟到 update，也不再是页面权威，且不能污染新 generation。

恢复 API 强制使用 UUID `Idempotency-Key`。D1 `revision_restore_operations` 保存源/目标 generation、恢复前版本和 `pending → prepared → completed` 状态；外部快照初始化完成后才进入 `prepared`，页面 generation 切换成功后才进入 `completed`。客户端在 5xx 或连接中断后用同一键重试，只会继续或回放原操作，不会重复生成“恢复前版本”或再次推进 generation。旧 generation 的关闭由响应后的生命周期任务执行，不把连接清理延迟叠加到用户请求上。

RandallFlare 的 `state.storage.sql` 是异步接口，因此所有查询和写入都必须显式 `await`。代码仍保持 Cloudflare 可接受的调用形状，但部署目标以 RandallFlare 行为为准。

## 当前 RandallFlare 适配

- WebSocket 二进制 message 实际可能是 `Blob`；Rdocs 同时接受 `Blob`、`ArrayBuffer` 和 typed array。
- DO binding name 与 class name 都使用 `DocumentRoom`，规避远端 dispatch 对两种名称解析不一致的问题。
- RandallFlare 当前没有真正的 WebSocket hibernation eviction，因此应用不依赖休眠期间仅内存保存正文。
- hibernation-style 与普通 `server.accept()` 两条路径都已实测 peer broadcast 不送达；这是当前平台阻塞。
- Rdocs 已提供 Worker→DocumentRoom HTTP 二进制同步作为兼容路径；WebSocket 仍保留并在平台修复后自然成为更低延迟的主路径。

这些适配都位于 Rdocs 仓库内，没有修改 RandallFlare 平台实现。
