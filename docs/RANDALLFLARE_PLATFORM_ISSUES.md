# RandallFlare 平台问题：Rdocs 修复清单

更新时间：2026-08-14 UTC

本文只记录 RandallFlare 平台问题，不要求通过修改 Rdocs 来规避。现网验证使用：

- Worker：`rdocs`
- URL：`https://rdocs-randall.edge.bigrandall.io`
- Rdocs commit：`44542e24d752f2f9cafb57743728ce212c68a3e2`
- RandallFlare `main`：已包含 `248d492 Optimize Durable Object routing`

## 结论与优先级

| ID   | 优先级    | 状态                           | 问题                                                  |
| ---- | --------- | ------------------------------ | ----------------------------------------------------- |
| RF-1 | P0        | 现网稳定复现、根因明确         | 集群已转发的请求被禁止执行远端 DO WebSocket handoff   |
| RF-2 | P0        | 源码确认、Rdocs 已被迫规避     | Durable Object 的 `bindingName` 与 `className` 被混用 |
| RF-3 | P0 验收项 | 历史复现，当前被 RF-1 挡住     | 两个已连接 WebSocket 的 peer send/broadcast 曾不送达  |
| RF-4 | P1        | 多次现网复现、根因待补充观测   | Git build 成功不等于边缘版本已激活                    |
| RF-5 | P1        | 现网复现、控制面与运行时不一致 | `envJson` 已更新，但 Worker 运行时仍读取旧值          |
| RF-6 | P2        | 源码确认、稳定复现             | `rrangler` 对所有参数执行冒号拆分，破坏 URL/JSON/IPv6 |

建议按 `RF-1 → RF-2 → RF-3 验收 → RF-4/RF-5 → RF-6` 的顺序处理。

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

## 不属于平台 bug，但仍需完成的 Rdocs 配置

`docs.bigrandall.io` 当前未绑定到 `rdocs` Worker；控制面只显示自动域名：

```text
rdocs-randall.edge.bigrandall.io
```

这是尚未执行的应用域名配置，不应与上述平台故障混为一谈。建议在 RF-1～RF-5 修复并通过验收后再切正式域名。

## 最终全链路验收

平台修复后，在 `/root/docs` 运行：

```bash
npm run typecheck
npm test
npm run build
RDOCS_SMOKE_DEBUG=1 \
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
