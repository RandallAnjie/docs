# RandallFlare 登录

更新时间：2026-11-25 UTC

Rdocs 只用 RandallFlare 账户登录。登录、会话和成员校验都由 RandallFlare 边缘网关完成，Rdocs 不保存密码、设备密钥或自己的会话 Cookie。

## 工作方式

1. 平台上的 `rdocs` 应用保持 **public** 访问模式，这样分享链接（`/share/…`）、Sites（`/site/…`）和公开表单（`/form/…`）仍然可以匿名访问。
2. 访客打开内部页面时，前端发现 `/api/auth/session` 返回 `anonymous`，会整页跳转到网关的 `/__rf_access/login?rd=<原路径>`。
3. 网关把访客送到 RandallFlare 登录；成功后在 `docs.bigrandall.io` 上写入 `__Host-rf_user` Cookie，再回到原路径。
4. 之后每个同源请求都带着网关验证过的 `RF-User-Id`、`RF-User-Email`、`RF-User-Name`、`RF-User-Username`、`RF-User-Owner`、`RF-User-Member` 请求头。网关会先删掉客户端自己带来的同名请求头；跨站的写请求和 WebSocket 不会带身份。
5. Worker（`apps/worker/src/auth.ts`）只信任这些请求头：按 `RF-User-Id` 找到或创建 Rdocs 用户（`users.external_id`），首次登录会自动创建个人工作区；如果已有同邮箱、尚未关联的用户（例如 SCIM 预建），会直接关联。
6. 退出登录访问 `/__rf_access/logout?rd=/`，它只清除 Rdocs 的登录 Cookie，不会退出 RandallFlare 本身。

## 谁能进入

由 `RF_ACCESS_POLICY` 决定（`rrangler.json` 的 `vars`）：

| 值                | 允许进入                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| `members`（默认） | 应用所有者，以及 RandallFlare 控制台 rdocs 应用访问页 **成员** 名单里的人 |
| `accounts`        | 任何 RandallFlare 账户（邮箱验证码访客仍需在成员名单内）                  |

不在名单内的账户会看到“暂无访问权限”，API 返回 `403 access_denied`。修改成员名单后，被移除的人在下一次请求时失去访问。

管理成员名单：

```bash
# 查看
rrangler api GET compute/cmssrecre04bo1jfmal7hygn4/access
# 设置（users 是 RandallFlare 用户名，emails/domains 可选）
rrangler api PUT compute/cmssrecre04bo1jfmal7hygn4/access --data '{"users":["alice"],"emails":[],"domains":[]}'
```

组织内的角色（所有者、管理员、成员）仍由 Rdocs 自己的组织邀请管理：被邀请人需要先在成员名单里，再用 RandallFlare 账户打开邀请链接。

## 安全边界

- 业务 API 的写请求还必须带精确的 `Origin: https://docs.bigrandall.io`（`APP_ORIGIN`）。
- 旧的设备密钥、WebAuthn 挑战和 `sessions` 表已由迁移 `0034_randallflare_sign_in.sql` 删除；`/api/auth/passkey/*` 一律 404。
- 原先未校验签名的 SAML ACS 入口已移除，SCIM 只负责同步成员资料与停用状态，不能登录。
- 在 Rdocs 中被停用（`users.status = 'disabled'`）的用户即使在 RandallFlare 成员名单里也无法进入。
