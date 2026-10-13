# AI 数据接口：接入 Grok bot

在墨听「设置 → AI 数据接口」登录云端同步，点「立即同步」，然后创建名为 `Grok bot` 的只读密钥。复制密钥到 Bot 的安全凭据配置；完整密钥只显示这一次。密钥默认有效期 1 年，也可选 30/90 天；在同一页面撤销后立即失效。

主站基础地址：`https://moting-reader.if5v.workers.dev/api/knowledge/v1`。旧入口 `https://moting-reader.yk2958374240.workers.dev/api/knowledge/v1` 使用同一数据源和密钥。

鉴权请求头：`Authorization: Bearer <你的专用密钥>`。密钥不要写入 URL、源代码、聊天提示词或日志；使用 Bot 的环境变量/凭据存储。

建议请求头加 `User-Agent: Moting-Grok-Bot/1.0`。本次线上验证发现 Python urllib 的默认标识收到 Cloudflare 403 / 1010，使用明确的客户端标识可正常访问。该错误属于 [Cloudflare 浏览器完整性检查](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)；下方示例已带客户端标识。

公开 [OpenAPI 3.1 文档](https://moting-reader.if5v.workers.dev/api/knowledge/v1/openapi.json) 可用于生成 HTTP 工具。接口全为 GET。

| 路径 | 内容 |
| --- | --- |
| `/` | 接口版本、构建和授权范围 |
| `/books` | 书籍 ID、书名、作者、章节数量和修改时间 |
| `/notes` | 划线摘录、想法、书名、章节、颜色、位置和分组 ID；含听书标记 |
| `/notes?thoughtsOnly=true` | 仅带想法的笔记 |
| `/notes?kind=highlight` | 仅划线 |
| `/chats` | AI 对话目录，包含书名、轮次数和 `detailPath` |
| `/chats/{bookId}` | 原顺序提问与回答，包括原文引用、已保存的思考、模型标识和回答是否未完成 |

## 查询与分页

三个列表支持 `bookId`、`q`（最多 200 字）、`updatedSince`（Unix 毫秒，严格大于）、`limit`（1–100，默认 50）和 `cursor`。`q` 为文字包含检索，不区分大小写；支持中文，`%`、`_` 按字面匹配。对话目录的关键词检索包括保存的对话和引用，随后通过详情读取上下文。

列表返回 `{ data, nextCursor, syncVersion, syncedOnly: true }`。每页最多扫描 `limit` 条候选记录和约 8 MB；过滤后可能是空页。**只要 `nextCursor` 不是 null 就继续请求**，保留原筛选参数。遍历期间固定云端上界；之后的新修改在下一轮遍历可见。`syncVersion`/记录 `version` 是云端单调版本，不是毫秒时间。

对话详情返回 `{ bookId, bookTitle, updatedAt, version, totalTurns, turns, nextCursor, syncedOnly: true }`，支持 `limit` 和 `cursor`。每页最多 100 条轮次，保留全文，不截断回答。对话在遍历期间更新时返回 `409 conversation_changed`，重新从第一页读取。`turns[].index` 是原对话顺序；`incomplete: true` 表示这条回答保存时未完成。

一次跨句划线可能有多个分段。完整摘录按 `bookId`、`groupId` 聚合；各段含 `sentenceId` 与可选的 `start`/`end`。同组的 `thought` 可能重复，合并时去重。书目查询返回章节数量，笔记自身带章节名。

`updatedSince` 仅筛选现存记录，不是含删除事件的同步协议。若 Bot 持久缓存资料，需定期全量重建以移除已删除的笔记/书籍；询问时即时读取可直接获得当前内容。

## Python 接入示例

使用标准库，无额外依赖。先在 Bot 的安全运行环境设置 `MOTING_READ_TOKEN`。该变量是本接口密钥，独立于 Grok 模型调用凭据。

```python
import json
import os
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE = "https://moting-reader.if5v.workers.dev/api/knowledge/v1"

def read(path, **params):
    query = urlencode({k: v for k, v in params.items() if v is not None})
    request = Request(
        BASE + path + ("?" + query if query else ""),
        headers={
            "Authorization": "Bearer " + os.environ["MOTING_READ_TOKEN"],
            "User-Agent": "Moting-Grok-Bot/1.0",
            "Accept": "application/json",
        },
    )
    with urlopen(request, timeout=30) as response:
        return json.load(response)

def list_all(path, **filters):
    cursor = None
    while True:
        page = read(path, limit=50, cursor=cursor, **filters)
        yield from page["data"]
        cursor = page["nextCursor"]
        if cursor is None:
            return

notes = list(list_all("/notes"))
thoughts = list(list_all("/notes", thoughtsOnly="true"))
conversations = list(list_all("/chats"))

# 根据 conversations 中的 bookId，分页读取完整对话。
# 收到 409 conversation_changed 时重新读取该对话。
```

建议给 Bot 的工具描述：墨听资料为用户阅读数据，按相关书籍/关键词读取；对话目录需要再读详情；遍历至 `nextCursor=null`；明确区分原文、用户想法、AI 回答；保留书名、章节与笔记 ID 便于追溯。

## 数据和权限边界

- API 读取 D1 已同步记录；大对话、笔记和书目通过现有 R2 不可变引用读取并校验哈希。R2 缺失/校验失败返回 503，不伪造或截断内容。
- 大对话在 Worker 内按 R2 对象版本复用已校验内容，缓存原始数据预算最多 12 MB；每次检查对象仍存在且版本一致，版本变化重新下载并验证 SHA-256。授权、删除和对话分页版本仍逐次检查。
- 本机离线新内容在恢复联网并同步成功后才可供 Bot 读取。示例书不参与云端同步。
- 密钥只授予 `knowledge:read`，不允许写笔记、删书、发送 AI 请求或操作同步。同步 Cookie 不能替代 Bearer Token；Bearer Token 也不能管理密钥或调用同步。
- 返回字段由白名单生成，不包含同步设置、AI API Key、电子书全文、插图、封面和内部错误详情。删除的书籍和笔记不返回。
- 服务端仅存密钥 SHA-256、前缀、名称、有效期和最近使用时间；最多 10 个有效密钥。前端不持久化密钥原文。读取响应 `Cache-Control: no-store`，不放入 PWA 缓存。
- `401 unauthorized`：密钥缺失、无效、到期或已撤销。`400 invalid_request`：参数/游标错误。`404 not_found`：资源不存在。`409 conversation_changed`：分页中对话有更新。`503`：存储或记录暂不可用。

## 维护

增量迁移 `worker/migrations/0002_knowledge_api.sql` 新建密钥表与查询索引，不改动现有内容。密钥管理位于 `/api/sync/access-keys` 和 `/api/sync/access-keys/{id}/revoke`，受现有 HttpOnly 同步会话与同源检查保护。

主、旧两个 Worker 均需部署；旧入口代理新增 `/api/knowledge/v1/*`，透传 Bearer Token。研发验证使用 `tests/knowledge-api.test.ts` 的真 SQLite SQL 回归和隔离本地 D1/R2 HTTP 验收。验证与部署证据记录在 `docs/knowledge-api-2026-10-13/validation.json`。
