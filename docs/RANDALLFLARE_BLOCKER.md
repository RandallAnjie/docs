# RandallFlare 历史阻塞归档

更新时间：2026-08-14 UTC

此前影响 Rdocs 的 WebSocket handoff、Durable Object binding/class 解析、peer broadcast、Git build 激活、环境变量刷新和通用 `rrangler` 参数解析问题已经由 RandallFlare 修复，并在 `https://docs.bigrandall.io` 完成现网复验。

详细根因、修复版本和验收证据保留在 [RandallFlare 平台问题修复清单](RANDALLFLARE_PLATFORM_ISSUES.md)。新发现的 RF-7 会让 D1 migration 账本写入空值，但已有可验证的精确迁移方案；RF-8 是低并发顺序产品 smoke 中不同写端点间歇出现的 `502 upstream peer unreachable`，重跑可通过但仍需平台按 request ID 排查。

Rdocs 当前唯一与平台配置有关、但不阻塞功能使用的差异是：浏览器直传 R2 需要为 Rdocs 提供 bucket-scoped S3 凭据或等价短期签名接口。现阶段附件使用 Worker 鉴权后流式上传，单文件上限 25 MB。该差异不通过修改 RandallFlare 代码解决。
