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

## 协作协议

浏览器先请求：

```text
POST /api/pages/{pageId}/collab-ticket
```

Worker 对页面状态和 ACL version 做当前读取，返回 5 分钟有效的 HMAC ticket。客户端随后连接：

```text
GET /collab/{pageId}?ticket=...
Upgrade: websocket
```

二进制消息兼容 y-websocket：外层类型 `0` 为 sync、`1` 为 awareness；sync 内层支持 step 1、step 2 和 update。应用限制单 frame 最大 256 KiB。

更新的目标顺序是：

```text
validate → deduplicate → persist SQLite → apply Y.Doc → broadcast
```

只有完成 SQLite 写入的更新才允许广播。当前 RandallFlare peer broadcast 阻塞使这一流程尚未通过验收。

## 持久化与恢复

每个 DocumentRoom 私有 SQLite 包含：

- `room_meta`：页面、generation、seq 和 schema version。
- `updates`：按 seq 追加的 Yjs update。
- `snapshots`：完整 state update 与 state vector。

对象初始化时加载最新快照，再按 seq 应用其后的增量。每 100 条更新或累计 512 KiB 生成快照；最后一个连接离开时也生成快照。

RandallFlare 的 `state.storage.sql` 是异步接口，因此所有查询和写入都必须显式 `await`。代码仍保持 Cloudflare 可接受的调用形状，但部署目标以 RandallFlare 行为为准。

## 当前 RandallFlare 适配

- WebSocket 二进制 message 实际可能是 `Blob`；Rdocs 同时接受 `Blob`、`ArrayBuffer` 和 typed array。
- DO binding name 与 class name 都使用 `DocumentRoom`，规避远端 dispatch 对两种名称解析不一致的问题。
- RandallFlare 当前没有真正的 WebSocket hibernation eviction，因此应用不依赖休眠期间仅内存保存正文。
- hibernation-style 与普通 `server.accept()` 两条路径都已实测 peer broadcast 不送达；这是当前平台阻塞。

这些适配都位于 Rdocs 仓库内，没有修改 RandallFlare 平台实现。
