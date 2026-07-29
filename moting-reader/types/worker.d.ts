// workerd 在 lib.dom 之外还多出这几个成员，仓库里没装 @cloudflare/workers-types，就地补声明。
interface WebSocket {
  accept(): void;
}

interface CacheStorage {
  readonly default: Cache;
}
