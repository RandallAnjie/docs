# Rdocs 设备密钥启用手册

更新时间：2026-08-15 UTC

Rdocs 使用 WebAuthn 设备密钥，不走 GitHub OAuth，不保存密码，也不会获得设备的私钥或生物识别数据。正式 RP ID 固定为 `docs.bigrandall.io`，Origin 固定为 `https://docs.bigrandall.io`。

## 当前发布策略

代码和数据库迁移可以先发布，但 `rrangler.json` 必须继续保持：

```json
"AUTH_MODE": "phase0"
```

这样现网不会在首把真实设备密钥登记前被锁住。只有显式 `phase0` 会启用匿名模式；变量缺失、拼错或任何其他值都会 fail closed 到 `passkey`。

## 首次启用

所有命令只操作 Rdocs Worker 或 Rdocs 自有数据库，不修改 RandallFlare 平台代码。

1. 构建并确认设备密钥、邀请登记和页面 ACL migrations 已应用：

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

4. 保持 `AUTH_MODE=phase0`，打开 `https://docs.bigrandall.io/setup/passkey`，输入显示名称、邮箱和登记码，然后完成系统设备验证。首位管理员会自动接管现有 `org_phase0` 组织和文档；此阶段即使登记失败也不会锁住现网。

5. 页面显示“首位管理员已经就绪”后，再把 Rdocs 的 `AUTH_MODE` 改为 `passkey`。登记响应已经写入安全会话 Cookie，刷新应直接进入组织工作台；随后验证退出、重新登录、组织切换、页面四档权限和非正式域名拒绝登记。把仓库中的 `AUTH_MODE` 固定为 `passkey`，避免后续 Git build 又切回技术预览。切换后等待旧协作票据最长 5 分钟的有效期结束，再把环境视为完全关闭匿名访问。

6. 不再需要给未登录用户创建新账号时，删除 bootstrap 登记码以关闭入口；已有设备密钥登录不依赖这个 secret：

   ```bash
   node /develop/bigrandall.io/rrangler/bin/rrangler.mjs secret delete PASSKEY_ENROLLMENT_SECRET --worker rdocs
   ```

## 回退

如果首次登记无法完成，只把 Rdocs 的 `AUTH_MODE` 恢复为 `phase0`；不要删除用户、credential 或 migration。回退不会破坏文档数据，之后可以修正 Rdocs 配置再重新启用。

## 已实现与后续安全工作

- 首次登记码只用于首位管理员 bootstrap，不是普通用户注册入口。新成员只能通过仍有效且邮箱匹配的组织邀请登记；已登录用户也可以为自己的账号增加设备密钥。
- 用户应至少登记两把可恢复的设备密钥，并提供已登录状态下的设备密钥管理与撤销页。
- 认证挑战和过期会话需要定期清理；会话撤销、设备增删和异常验证需要进入审计日志。
