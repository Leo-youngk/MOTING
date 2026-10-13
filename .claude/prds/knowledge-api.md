---
name: knowledge-api
description: 让 Grok bot 用独立 Bearer Token 只读访问已同步的划线、想法和 AI 对话
status: completed
created: 2026-10-13T04:53:41Z
---

# PRD: 墨听 AI 数据接口

## 目标与验收

用户已确认 HTTP API（Bearer Token）接入。设置提供「AI 数据接口」入口，登录既有同步账号后创建、复制和撤销独立只读密钥；密钥原文只在创建时返回，不进入持久化前端设置、日志或仓库。服务端仅存 SHA-256 哈希。

Bot 能分页读取书名与作者、划线摘录及附属想法、每本书的 AI 提问、回答和引用。查询支持书籍、关键词和修改时间；跨句划线保留 groupId。返回内容由字段白名单投影，不暴露同步设置、AI 服务凭据、正文和插图。删除的书籍及笔记不可读。

只读接口不接受写入，也不接受同步 Cookie 作为 Bot 授权；Bot 密钥不能调用同步或密钥管理。匿名、错误、到期、撤销密钥均拒绝。分页覆盖重复时间戳和过滤空页，长对话读现有 R2 引用并校验哈希，资源失败明确返回错误。

## 约束与范围

继续使用现有 Cloudflare Workers、D1、R2、IndexedDB 和同步账号，兼容主、旧两个域名。API 只读云端已同步数据；本地尚未上传的内容需立即同步。公开机器可读 OpenAPI 和接入文档。

不新增模型调用、Grok 账号配置、团队管理、MCP 或写入 API。用户已授权验证后提交与部署。需验证类型、受影响 lint、全套现有单测、本地真 SQL/D1/R2 及移动设置操作；生产仅进行只读资料验证与短期测试密钥生命周期，不能写测试书籍/笔记/对话。

## 技术调研与采用理由

- 现有依赖已检查：Workers/D1/R2 原生能力满足本次需求，无需新增 API 框架或数据库。
- [Karakeep 官方 API](https://docs.karakeep.app/api/karakeep-api/) 提供设置生成 Bearer Token、cursor/limit 分页的成熟接入方式；已实际阅读文档、[许可证](https://github.com/karakeep-app/karakeep/blob/main/LICENSE)、仓库及 [Docker 示例](https://github.com/karakeep-app/karakeep/blob/main/docker/docker-compose.yml)。仓库持续维护，AGPL-3.0，完整部署需 Web/Chrome/Meilisearch；本项目参考协议设计，自行实现最小只读适配，不引入其源码和运行栈。
- [Cloudflare D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/) 确认参数绑定方法；所有可变输入使用绑定参数，表名来自固定允许列表。
- 当前生产分支已合并的大记录同步（协议 5）使用不可变 R2 引用；数据接口必须读取并验证引用，不直接把 D1 data 当 JSON。

## 实施顺序

1. 独立密钥表、会话鉴权管理及只读查询路由。
2. 设置入口、一次性密钥展示、同步提示、接入说明及 OpenAPI。
3. 授权、字段范围、删除过滤、分页和 R2 回归；验证后提交、迁移、双域部署。

## 完成证据

2026-10-13：PR #30 已合并到当前生产分支，代码构建 `73877ce` 已在主、旧两个入口上线。339 项单测（13 项新 API 回归）、类型检查、受影响 ESLint、23 项隔离 D1/R2 与移动界面验收通过。两入口分别完整读取 38 本现存书目、418 条笔记、19 个对话/18,613 条轮次；校验密钥已撤销，两入口均拒绝后续读取。迁移只增加密钥表与索引，未写生产测试内容。

上线时发现 Python urllib 默认客户端标识被 Cloudflare 1010 拒绝，接入说明与 OpenAPI 已添加明确 User-Agent。约 7 MB 长对话逐页重新解析曾触发 Workers 1102；按 R2 上传版本复用已校验内容、每次检查对象存在与版本、限制 12 MB 缓存后，同一失败分页连续 8 次通过，全部对话遍历通过。

接入文档：`moting-reader/docs/AI_DATA_API.md`。完整证据：`moting-reader/docs/knowledge-api-2026-10-13/validation.json`。用户在设置创建专用密钥后即可配置 Bot；尚未同步的本地新内容须先完成同步。
