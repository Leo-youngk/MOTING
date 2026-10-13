---
name: knowledge-api
description: 让 Grok bot 用独立 Bearer Token 只读访问已同步的划线、想法和 AI 对话
status: active
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
