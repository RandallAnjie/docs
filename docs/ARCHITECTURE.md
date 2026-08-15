# Rdocs 架构说明

## 产品边界

Rdocs 的产品定义是团队多人实时协作知识库，不是单份在线编辑器。第一阶段优先证明以下闭环：

1. 两个客户端编辑同一页面并收敛。
2. 更新先持久化，再向其他连接广播。
3. Worker 或 DO 重新初始化后能恢复正文。
4. 客户端重连后通过 state vector 获取缺失更新。
5. 权限撤销后新请求和现有连接都失效。
6. 旧版本通过新 generation 恢复，避免离线旧客户端污染新正文。

上述闭环已经通过。评论、全文搜索、附件、通知、多租户和完整权限界面均建立在同一套页面与协作数据边界之上。

## 数据所有权

| 组件              | 权威数据                                  | 不负责         |
| ----------------- | ----------------------------------------- | -------------- |
| Rdocs Worker      | 路由、票据、Origin 和 frame 校验          | 长期保存正文   |
| DocumentRoom      | 单页面 generation 的 Y.Doc、增量和快照    | 跨空间查询     |
| D1                | 用户、组织、空间、页面树、ACL、版本元数据 | 高频按键更新   |
| R2                | 附件、导出和冷快照                        | 权限真相       |
| Queue（可选扩展） | 超大导出、缩略图和批量清理异步事件        | 实时编辑主链路 |

页面正文与 `pages` 元数据严格分离。DO 名称使用：

```text
document:{pageId}:generation:{generation}
```

## 页面树

页面树是 D1 中 `pages.parent_id` 和 `sort_key` 的投影，不进入 Y.Doc，也不依赖 Durable Object：

```text
GET  /api/spaces/{spaceId}/pages → 当前用户可见的空间页面树
POST /api/pages                 → 创建根页面，或通过 parentId 创建子页面
GET  /api/pages/{pageId}        → 读取单页元数据
PATCH /api/pages/{pageId}       → 自动保存页面标题
POST /api/pages/{pageId}/move   → 移动和同级排序
DELETE /api/pages/{pageId}      → 子树软删除
```

列表按 `sort_key`、`id` 稳定排序，当前技术预览最多返回 500 个页面。创建子页面前，Worker 会验证父页面存在且属于当前组织与空间。前端会防御性处理孤儿节点、自引用和循环父链，保证异常元数据不会让页面从导航中消失。

## 同步块级联删除与恢复

跨页同步块的正文由独立 DocumentRoom 保存，引用页面只保存资源 ID。删除原始同步块及全部副本时，Worker 先重新校验每个引用页面的编辑权限、锁定和协作状态，再以 8 路有界并发把引用节点替换为 `deletedSyncedBlock` 占位；所有占位共享随机删除操作 ID。`synced_block_references` 在 30 天撤销期内继续保留受影响页面清单，资源本身软删除并拒绝签发协作票据。

恢复使用同一操作 ID，只替换匹配的占位节点，不恢复整页快照，因此删除之后的其他正文编辑会保留。删除与恢复都使用资源生命周期租约、ACL version 提升、连接关闭和完成条件比较；中途失败会等待所有在途页面任务结束、释放租约并保留可重试占位。只要删除操作 ID 尚未清除，DocumentRoom 还会在 WebSocket 与 HTTP 离线更新入口执行删除围栏，把旧客户端重新写入的活动引用转换为同一操作的占位；恢复租约期间会暂停围栏，恢复完成后原子清除操作 ID。恢复前再次要求操作者能编辑并解锁全部相关页面，任一页面撤权都会阻止整体恢复。

## 页面通知与收件箱

页面通知偏好保存在 D1 的 `page_notification_subscriptions`，每个正式成员可为有权查看的页面选择 `all_updates`、`all_comments` 或 `replies_mentions`。参与评论会自动创建最低噪声的 `replies_mentions` 订阅，但不会覆盖成员已经明确选择的更高通知级别。

通知投递和展示都重新计算当前页面 ACL。成员在投递后被撤权时，旧通知不会继续出现在列表或未读数字中；不同组织的未读数互不混合。页面内容变更使用 generation 和协作序列组成稳定事件键，D1 唯一索引避免 Durable Object 重试产生重复通知。

正文同步不等待关注者扇出：DocumentRoom 完成 `persist → apply → broadcast` 后，只同步登记节流后的审计事件，再通过生命周期后台任务进行通知 ACL 复核和批量写入。权限复核采用有界并发，通知写入按批次执行，因此关注者数量不会进入正文持久化与广播的关键延迟路径。

## 设备密钥与应用会话

Rdocs 不使用 GitHub OAuth，也不实现密码登录。正式登录采用 WebAuthn discoverable credential：浏览器和系统认证器在设备上生成并保管私钥，Rdocs 只在 D1 保存 credential ID、公钥、签名计数器和备份属性，不接触生物识别数据。

首次设备登记使用管理员持有的高熵登记码完成 bootstrap；登记码只作为 RandallFlare secret 保存，不进入仓库或数据库。它只控制未登录用户的新账号登记，不参与已有设备密钥的登录，因此 bootstrap 完成后可以删除。登记挑战和登录挑战有效期均为 5 分钟，并在成功验证后一次性消费。注册要求 resident key 和 user verification，登录采用无用户名的设备密钥发现流程。

验证成功后，Worker 生成随机应用会话令牌。D1 `sessions` 表只保存 SHA-256 哈希，浏览器通过 `__Host-rdocs_session` Cookie 持有原令牌；Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Lax` 和 `Path=/`。写请求必须同时满足请求 URL 与 `Origin` 精确等于 `https://docs.bigrandall.io`，会话过期时前端静默重新读取状态并回到设备密钥登录页。

生产只运行设备密钥模式；旧的 `AUTH_MODE=phase0` 值也不能重新启用匿名业务 API。首位管理员登记已经完成，bootstrap secret 已删除；当前恢复流程见 [设备密钥启用手册](PASSKEY_SETUP.md)。

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

客户端同时启动应用层 HTTP 同步作为弱网、代理和票据续签期间的恢复通道：

```text
POST /api/pages/{pageId}/collaboration-sync
Authorization: Bearer <collab-ticket>
Content-Type: application/octet-stream
```

请求携带客户端 state vector、尚未被服务端确认的 Yjs update 和 awareness update；响应返回缺失的服务端 update、服务端 state vector 和当前 awareness。原生 WebSocket 是低延迟主通道。正文输入约 25 ms 后也会进入 HTTP 合批，页面可见时约每 350 ms 校验远端变化，隐藏时降为约 1500 ms。一次瞬时失败不会把界面切回“重新连接中”，票据过期会在后台静默续签；超过 10 秒未续心跳的 HTTP awareness 会被清理，避免幽灵协作者和残留光标。

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

## 当前 RandallFlare 状态与适配

- WebSocket 二进制 message 实际可能是 `Blob`；Rdocs 同时接受 `Blob`、`ArrayBuffer` 和 typed array。
- RandallFlare 已修复跨节点 WebSocket handoff、DO binding/class 解析和 peer broadcast，并在正式域名通过双客户端、100 客户端、静默 61 秒后广播等平台复验。
- Rdocs 仍不把未落盘正文只保存在内存中；即使运行时逐出对象，也从 DO SQLite snapshot + updates 恢复。
- Worker→DocumentRoom HTTP 二进制同步继续作为恢复通道；它与 WebSocket 复用同一个 Y.Doc 和更新序列，不形成第二份正文真相。
- 浏览器直传 R2 需要项目级 S3 签名配置。当前附件经 Worker 鉴权后写入同一私有 R2 bucket，单文件上限 25 MB。

这些适配都位于 Rdocs 仓库内，没有修改 RandallFlare 平台实现。
