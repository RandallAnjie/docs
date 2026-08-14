# RandallFlare blocker：Durable Object 多 WebSocket 广播

记录时间：2026-08-14 UTC

影响：阻塞 Rdocs Phase 0 和 `docs.bigrandall.io` 正式切换

## 结论

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

Rdocs 不会通过先广播后持久化、轮询 D1 或修改 RandallFlare 平台代码来掩盖此问题。
