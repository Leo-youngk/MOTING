// Cloudflare's generated runtime types expose the default cache, while the
// DOM lib used by the client compiler does not include it.
interface CacheStorage {
  readonly default: Cache;
}
