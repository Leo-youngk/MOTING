// Cloudflare's generated runtime types expose the default cache, while the
// DOM lib used by the client compiler does not include it.
interface CacheStorage {
  readonly default: Cache;
}

// SYNC_UPSTREAM 只出现在旧域名部署的 vars 里，不在主部署生成的 Env 中。
interface Env {
  SYNC_UPSTREAM?: string;
}
