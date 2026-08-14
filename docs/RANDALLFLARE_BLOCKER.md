# RandallFlare blockers：Rdocs 实时协作与发布链路

记录时间：2026-08-14 UTC

影响：阻塞 RandallFlare 原生 WebSocket 实时链路；Rdocs 已通过应用层 HTTP 同步缓解正文、自动保存和 presence 的用户影响，正式域名切换前仍应修复平台问题

## 结论一：Durable Object 多 WebSocket 广播

RandallFlare 当前可以建立 Durable Object WebSocket、维护两条连接并把 Yjs update 写入 DO SQLite，但不能可靠地把 update 发送给同一 DO 中的另一条已建立连接。

同时，第二条 WebSocket upgrade 会间歇性返回 HTTP 500。出现过的具体响应包括：

```text
DO binding "DocumentRoom" not configured
Internal Server Error
```

将 binding name 与 class name 都改为 `DocumentRoom` 后，名称错误减少，但间歇性 500 和 peer send 不送达仍存在。

## 已验证事实

在同一个随机 page/generation 的 DO 实例中：

- 客户端 A 成功完成 Yjs sync step 1/2。
- 客户端 B 成功完成 Yjs sync step 1/2（部分运行在 upgrade 阶段 500）。
- DO 同时报告 2 条连接。
- A 发送 71-byte Yjs update。
- DO 成功处理 update，SQLite `currentSeq` 从 2 增到 3。
- 对 B 的 `socket.send()` 没有产生客户端 message event。
- 把 broadcast 放到 SQLite `await` 之前仍不送达，因此不是异步落盘造成的时序问题。
- `state.acceptWebSocket()` 与普通 `server.accept()` 两种实现均复现。

## 复现

部署当前 Rdocs 后运行：

```bash
RDOCS_SMOKE_DEBUG=1 \
RDOCS_SMOKE_ADMIN_SECRET='<PHASE0_ADMIN_SECRET>' \
npm run smoke:collab
```

预期：输出 `ok: true`，并列出 convergence、persistence、reconnect、revocation 四项检查。

实际：通常在 `second client did not converge` 处超时；部分运行中第二条连接在 upgrade 阶段返回 500。

## 需要的平台能力

在不修改 Rdocs 的“先持久化、后广播”正确性约束下，RandallFlare 需要保证：

1. 同一 DO 实例的多条 WebSocket 能稳定建立。
2. DO 保存的 server-side WebSocket 可以在后续 message handler 中向 peer 发送二进制 frame。
3. owner-local 与 cross-node path 使用一致的 DO binding/class 解析。
4. binary handler 的实际输入类型与兼容文档一致，或明确记录 `Blob` 差异。

Rdocs 不会通过先广播后持久化、轮询 D1 或修改 RandallFlare 平台代码来掩盖此问题。当前兼容方案由 Worker 将带 ticket 的二进制同步请求转发给同一个 DocumentRoom，仍然先写 DO SQLite 再应用和响应。

## 结论二：真实浏览器 WebSocket 握手被边缘取消

在 `rdocs-randall.edge.bigrandall.io` 上，Chromium 会反复触发：

```text
Network.webSocketFrameError: WebSocket opening handshake was canceled
close code: 1006
```

失败发生在 Worker/DO 日志之前。相同 URL、票据与 Origin 通过 Node `ws` 和
`y-websocket` Provider 可以达到 `status=connected`、`sync=true`，说明 Worker 业务校验和
Yjs 协议路径本身可工作；浏览器传输路径仍需 RandallFlare 排查。

该问题原本会让 UI 持续显示“重新连接中”，并阻塞协作者光标、presence 和正文云端自动保存的
真实浏览器端到端验收。Rdocs 现在同时运行应用层 HTTP/Yjs 同步：输入约 25 ms 后上传、前台约
350 ms 拉取远端 update 和 awareness，成功后由该通道维持“已同步”状态。此方案缓解用户影响，
但不代表 RandallFlare 的 WebSocket 缺陷已经修复。

## 结论三：Git build 成功后未自动切换边缘版本

Git push 会产生 `SUCCESS` build，worker version 中也包含新文件，但边缘仍可能提供旧 HTML，
且 `publishedAt` 不更新。通过更新 Rdocs 自己的环境变量后，新版本才会在边缘生效。

RandallFlare 需要保证 Git 模式下成功构建会自动 publish，或提供明确的“构建后发布”开关与状态。

## 结论四：rrangler 无法直接设置包含 URL 的环境变量

`rrangler` 的命令标准化会对每个参数执行 `split(":")`，导致以下合法命令无法解析：

```text
rrangler worker env set rdocs APP_ORIGIN=https://docs.bigrandall.io
```

当前只能绕过 CLI 参数解析层，直接调用已有的环境变量 API。RandallFlare 需要把冒号兼容处理限制在
命令名 token，而不是拆分环境变量值、JSON 或 URL。
