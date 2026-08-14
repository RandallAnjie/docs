# Rdocs 设备密钥启用手册

更新时间：2026-08-14 UTC

Rdocs 使用 WebAuthn 设备密钥，不走 GitHub OAuth，不保存密码，也不会获得设备的私钥或生物识别数据。正式 RP ID 固定为 `docs.bigrandall.io`，Origin 固定为 `https://docs.bigrandall.io`。

## 当前发布策略

代码和数据库迁移可以先发布，但 `rrangler.json` 必须继续保持：

```json
"AUTH_MODE": "phase0"
```

这样现网不会在首把真实设备密钥登记前被锁住。只有显式 `phase0` 会启用匿名模式；变量缺失、拼错或任何其他值都会 fail closed 到 `passkey`。

## 首次启用

所有命令只操作 Rdocs Worker 或 Rdocs 自有数据库，不修改 RandallFlare 平台代码。

1. 构建并应用 `migrations/0003_passkey_authentication.sql`：

   ```bash
   npm run build
   npm run migrate:randallflare
   ```

2. 生成至少 32 字符的高熵登记码，并通过交互式输入保存为 Rdocs secret。不要把值写进 shell history、仓库、截图或聊天记录：

   ```bash
   node /develop/bigrandall.io/rrangler/bin/rrangler.mjs secret put PASSKEY_ENROLLMENT_SECRET --worker rdocs
   ```

3. 确认非秘密配置为：

   ```text
   PASSKEY_RP_ID=docs.bigrandall.io
   PASSKEY_ORIGIN=https://docs.bigrandall.io
   ```

4. 在一个可控的短窗口把 Rdocs 的 `AUTH_MODE` 改为 `passkey`，打开 `https://docs.bigrandall.io`，选择“首次使用？登记这台设备”，输入显示名称、邮箱和登记码，然后完成系统设备验证。

5. 登记完成后立即验证：刷新仍保持登录、退出后需要设备密钥、重新登录成功、非正式域名无法发起登记。随后把仓库中的 `AUTH_MODE` 固定为 `passkey`，避免后续 Git build 又切回技术预览。切换后等待旧协作票据最长 5 分钟的有效期结束，再把环境视为完全关闭匿名访问。

6. 不再需要给未登录用户创建新账号时，删除 bootstrap 登记码以关闭入口；已有设备密钥登录不依赖这个 secret：

   ```bash
   node /develop/bigrandall.io/rrangler/bin/rrangler.mjs secret delete PASSKEY_ENROLLMENT_SECRET --worker rdocs
   ```

## 回退

如果首次登记无法完成，只把 Rdocs 的 `AUTH_MODE` 恢复为 `phase0`；不要删除用户、credential 或 migration。回退不会破坏文档数据，之后可以修正 Rdocs 配置再重新启用。

## 后续安全工作

- 首次登记码是 MVP bootstrap，不是普通用户注册入口。组织邀请完成后，新成员登记必须由有效邀请或已登录管理员授权。
- 用户应至少登记两把可恢复的设备密钥，并提供已登录状态下的设备密钥管理与撤销页。
- 认证挑战和过期会话需要定期清理；会话撤销、设备增删和异常验证需要进入审计日志。
