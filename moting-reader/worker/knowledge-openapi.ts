import { KNOWLEDGE_API_PATH } from "../lib/knowledge-api.ts";

const string = { type: "string" };
const timestamp = { type: "integer", format: "int64", description: "Unix 毫秒" };
const version = { type: "integer", format: "int64", description: "云端单调版本；不是 Unix 毫秒" };
const nextCursor = { type: ["string", "null"], description: "null 表示遍历完成；即使 data 为空，只要有游标仍须继续。下一页保留全部筛选参数。" };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const parameter = (name: string, schema: object, description: string) => ({ name, in: "query", schema, description });
const paging = [{ name: "User-Agent", in: "header", schema: { type: "string", default: "Moting-Grok-Bot/1.0" }, description: "明确的客户端标识；Python urllib 默认标识可能被 Cloudflare 1010 拒绝" },
  parameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 }, "每页最多扫描/返回的记录数"), parameter("cursor", string, "上一页返回的不透明 nextCursor")];
const filters = [parameter("bookId", string, "仅查询这本书"), parameter("q", { type: "string", maxLength: 200 }, "不区分大小写的文字关键词，支持中文"), parameter("updatedSince", timestamp, "仅返回 updatedAt 严格大于此值的已存在记录；不包含删除通知，缓存应定期全量重建")];
const errors = Object.fromEntries([400, 401, 404, 409, 503].map((status) => [status, { description: status === 401 ? "Bearer Token 缺失、无效、到期或已撤销" : "参数错误、资源缺失、对话更新或存储暂不可用", content: { "application/json": { schema: ref("Error") } } }]));
const response = (schema: object) => ({ "200": { description: "已同步的真实数据", content: { "application/json": { schema } } }, ...errors });
const page = (name: string) => ({ type: "object", properties: { data: { type: "array", items: ref(name) }, nextCursor, syncVersion: version, syncedOnly: { const: true } }, required: ["data", "nextCursor", "syncVersion", "syncedOnly"] });

export function knowledgeOpenApi(origin: string): object {
  return {
    openapi: "3.1.0", info: { title: "墨听 AI 数据接口", version: "1.0.0", description: "仅用独立 Bearer Token 读取已同步的书目、划线、想法和 AI 对话。设置 → AI 数据接口创建密钥。只读云端；本地新增内容需要先同步。" },
    servers: [{ url: `${origin}${KNOWLEDGE_API_PATH}` }], security: [{ bearerAuth: [] }],
    paths: {
      "/books": { get: { operationId: "listMotingBooks", summary: "获取书目", parameters: [...paging, ...filters], responses: response(page("Book")) } },
      "/notes": { get: { operationId: "listMotingNotes", summary: "读取划线和想法", description: "跨句划线分段返回，共用 groupId；需要完整摘录时按 bookId、groupId 合并。想法可能在同组重复。", parameters: [...paging, ...filters,
        parameter("thoughtsOnly", { type: "boolean" }, "仅返回带想法的笔记"), parameter("kind", { type: "string", enum: ["highlight", "listening-mark"] }, "可选：只读划线或听书标记")], responses: response(page("Note")) } },
      "/chats": { get: { operationId: "listMotingChats", summary: "列出 AI 对话", description: "返回对话目录，通过 detailPath 获取原始提问、回答和引用；关键词检索书名、对话和引用。", parameters: [...paging, ...filters], responses: response(page("ChatSummary")) } },
      "/chats/{bookId}": { get: { operationId: "readMotingChat", summary: "读取一本书的完整对话", description: "按原顺序分页，回答不截断。阅读分页期间版本变化返回 409 conversation_changed，需重新遍历。", parameters: [{ name: "bookId", in: "path", required: true, schema: string }, ...paging],
        responses: response({ type: "object", properties: { bookId: string, bookTitle: string, updatedAt: timestamp, version, totalTurns: { type: "integer" }, turns: { type: "array", items: ref("Turn") }, nextCursor, syncedOnly: { const: true } }, required: ["bookId", "turns", "totalTurns", "nextCursor"] }) } },
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "moting_ro_…" } }, schemas: {
      Book: { type: "object", properties: { id: string, title: string, author: string, chapterCount: { type: "integer" }, createdAt: { type: ["integer", "null"] }, updatedAt: timestamp, version }, required: ["id", "title", "author"] },
      Note: { type: "object", properties: { id: string, bookId: string, bookTitle: string, chapterId: string, chapterTitle: string, sentenceId: string, kind: { type: "string", enum: ["highlight", "listening-mark"] }, excerpt: string, thought: string, groupId: string, createdAt: { type: ["integer", "null"] }, updatedAt: timestamp, version, start: { type: "integer" }, end: { type: "integer" }, color: string, highlightStyle: string }, required: ["id", "bookId", "excerpt", "thought", "groupId"] },
      ChatSummary: { type: "object", properties: { bookId: string, bookTitle: string, updatedAt: timestamp, version, turnCount: { type: "integer" }, detailPath: string }, required: ["bookId", "detailPath", "turnCount"] },
      Turn: { type: "object", properties: { index: { type: "integer" }, id: string, replyTo: string, role: { type: "string", enum: ["user", "assistant"] }, content: string, quote: string, model: string, reasoning: string, incomplete: { type: "boolean" } }, required: ["index", "role", "content", "incomplete"] },
      Error: { type: "object", properties: { error: { type: "object", properties: { code: string, message: string }, required: ["code", "message"] } }, required: ["error"] },
    } },
  };
}
