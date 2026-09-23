// Cloudflare's generated runtime types expose the default cache, while the
// DOM lib used by the client compiler does not include it.
interface CacheStorage {
  readonly default: Cache;
}

// Worker 密钥是用 `wrangler secret put` 设的，不出现在 wrangler.jsonc 里，
// 所以 wrangler 生成的 Env 类型不认识它，只能在这里补声明。
// SYNC_UPSTREAM 只出现在旧域名部署的 vars 里，同样补在这里。
interface Env {
  WEREAD_API_KEY?: string;
  SYNC_USERNAME?: string;
  SYNC_PASSWORD?: string;
  SYNC_UPSTREAM?: string;
}
