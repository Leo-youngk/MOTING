# 多服务商 AI 配置

在「设置 → AI 助手」添加服务商。每条配置独立保存名称、API 地址、Key、主模型和同服务商备用模型；点击名称编辑，点击「使用」切换当前服务商。支持重复添加同一家服务商，分别使用不同账号或地址。

内置 Google Gemini、DeepSeek、通义千问（北京）、硅基流动、OpenRouter、OpenAI 和自定义地址。均使用 OpenAI 兼容的 `/models` 和 `/chat/completions` 接口；原生 Anthropic Messages 接口不在本次范围内。地址可以编辑，阿里云其他地域和业务空间专属域名需要填对应地址及 Key。

模型列表按当前编辑的服务商读取，切换或离开配置时取消旧请求。列表不可用时可以手填模型，不会自动使用列表里第一个模型。

## 备用

- 没选跨服务商备用：沿用同接口备用模型。
- 选择跨服务商备用：主服务商两次 → 备用服务商两次 → 主服务商最后一次；沿用现有重试间隔和预算检查。
- 只对连接失败、408、429 和可重试的 5xx 切换。400、401、403、404 等配置错误直接报告；已进入回答流后不切换。
- 切换时同时替换地址、Key、模型和思考参数。同名模型可以来自不同服务商，回答下方会注明备用服务商和模型。
- 每次请求仅携带当前配置及选中的备用连接，不上传整个服务商列表。

## 迁移与同步

旧的单组配置自动成为「原有配置」，保留原地址、Key 和主备模型。新增配置保存在现有设置记录内，无需数据库迁移。`aiBaseUrl`、`aiApiKey`、`aiModel`、`aiFallbackModel` 继续反映当前配置，供既有调用使用。

开启同步后，所有服务商配置及 Key 沿用现有设置同步规则存入 D1。转发日志只记录模型、状态及主备标记。

## 验证

- `npm run typecheck`
- `npm run lint`
- `npm test`：含构建产物校验、迁移/切换/删除、同名模型跨服务商重试、真实 Worker 请求路由和 Key 隔离测试。上游均用测试响应，不调用收费模型。
- `node tests/ai-providers-browser.mjs`：手机视口下添加、编辑、切换、刷新恢复、旧配置迁移和删除。需本地服务与 Playwright；可设置 `TEST_BASE_URL`、`PLAYWRIGHT_MODULE`、`BROWSER_BIN`。

接口依据：[Gemini](https://ai.google.dev/gemini-api/docs/openai)、[DeepSeek](https://api-docs.deepseek.com/)、[阿里云](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[硅基流动](https://docs.siliconflow.cn/api-reference/chat-completions/chat-completions)、[OpenRouter](https://openrouter.ai/docs/quickstart)。
