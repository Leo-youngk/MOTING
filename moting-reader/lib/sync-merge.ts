// 云端同步的纯合并逻辑:记录级 LWW、push 收集后的分批。只依赖类型(编译期擦除),
// 因此能被 node --experimental-strip-types 直接跑,不经 IndexedDB。
export interface SyncRecord {
  key: string;
  data?: unknown;
  updatedAt: number;
  deletedAt?: number;
}

export interface PushItem {
  key: string;
  data: string;
  updatedAt: number;
  deletedAt?: number;
  bookId?: string;
}

export interface PushPayload {
  books?: PushItem[];
  notes?: PushItem[];
  positions?: PushItem[];
  sessions?: PushItem[];
  settings?: PushItem[];
  chats?: PushItem[];
  patches?: PushItem[];
  listening?: PushItem[];
}

// 服务端单次限 500 条、32 MB;这里更保守,条数和字节两道闸。
const PUSH_BATCH_ITEMS = 400;
const PUSH_BATCH_BYTES = 6 * 1024 * 1024;

/** 书的 LWW 时间取 meta.updatedAt 与 syncReadyAt 的较大者,让 ready 标记能被推上去。 */
export function bookPushTime(meta: { updatedAt: number; syncReadyAt?: number }): number {
  return Math.max(meta.updatedAt, meta.syncReadyAt ?? 0);
}

/**
 * 推上云端的书籍 meta:去掉封面。封面是整张图的 data URL,动辄几百 KB 到几 MB,
 * 会顶破 D1 单行 2 MB 上限;它随正文走 R2(插图通道的 COVER_IMAGE_ID)。
 * 接收端合并时 meta 里没有这个键,本地已有的封面原样保留。
 */
export function toSyncBookMeta<B extends { coverDataUrl?: string }>(meta: B): Omit<B, "coverDataUrl"> {
  const { coverDataUrl: _cover, ...rest } = meta;
  return rest;
}

/** 资料补丁里的 original.coverDataUrl 就是这本书导入时的封面,对端书里已经有一份,不重复上传。 */
export function toSyncPatch<P extends { original: { coverDataUrl?: string } | null }>(patch: P): P {
  if (!patch.original?.coverDataUrl) return patch;
  const { coverDataUrl: _cover, ...original } = patch.original;
  return { ...patch, original };
}

/** 封面在 R2 插图通道里的固定编号;真实插图编号由解析器生成,不会撞上下划线开头的名字。 */
export const COVER_IMAGE_ID = "_cover";

export function countPayload(payload: PushPayload): number {
  return Object.values(payload).reduce((sum, list) => sum + (list?.length ?? 0), 0);
}

/** 按条数和体积分批,首轮全量上传也不会撞上服务端的请求上限。 */
export function splitPayload(
  payload: PushPayload,
  limit = PUSH_BATCH_ITEMS,
  byteLimit = PUSH_BATCH_BYTES
): PushPayload[] {
  const batches: PushPayload[] = [];
  let current: PushPayload = {};
  let count = 0;
  let bytes = 0;
  for (const [name, list] of Object.entries(payload) as Array<[keyof PushPayload, PushItem[] | undefined]>) {
    if (!list) continue;
    for (const item of list) {
      const size = item.data.length + item.key.length + 64;
      if (count && (count >= limit || bytes + size > byteLimit)) {
        batches.push(current);
        current = {};
        count = 0;
        bytes = 0;
      }
      (current[name] ??= []).push(item);
      count += 1;
      bytes += size;
    }
  }
  if (count) batches.push(current);
  return batches;
}

export type MergeAction<T> = { op: "keep" } | { op: "write"; value: T } | { op: "delete" };

/** 书:远端新则盖本地 meta,但本地存在时保留正文与两套位置(位置由 positions 表管)。 */
export function mergeBookMeta<B extends { updatedAt: number; syncReadyAt?: number }>(
  local: B | undefined,
  remote: SyncRecord
): MergeAction<B> {
  if (remote.deletedAt) return local ? { op: "delete" } : { op: "keep" };
  if (!remote.data || typeof remote.data !== "object") return { op: "keep" };
  const remoteMeta = remote.data as B;
  if (!local) return remoteMeta.syncReadyAt ? { op: "write", value: remoteMeta } : { op: "keep" };
  if (remote.updatedAt <= bookPushTime(local)) return { op: "keep" };
  // 位置字段不跟 meta 走:远端 meta 里的 readingPosition/listeningPosition 是对端的旧值。
  const clone = { ...(remote.data as Record<string, unknown>) };
  delete clone.readingPosition;
  delete clone.listeningPosition;
  return { op: "write", value: clone as B };
}

/** 划线:比较 updatedAt;墓碑只删本地存在的。 */
export function mergeNote<N extends { createdAt: number; updatedAt?: number }>(
  local: N | undefined,
  remote: SyncRecord
): MergeAction<N> {
  if (remote.deletedAt) return local ? { op: "delete" } : { op: "keep" };
  if (!remote.data || typeof remote.data !== "object") return { op: "keep" };
  const remoteNote = remote.data as N;
  const localUpdatedAt = local ? local.updatedAt ?? local.createdAt : 0;
  if (local && (remoteNote.updatedAt ?? remoteNote.createdAt) <= localUpdatedAt) return { op: "keep" };
  return { op: "write", value: remoteNote };
}

/** 位置:纯 LWW,谁后保存听谁的。 */
export function mergePosition<R extends { savedAt: number }>(
  localSavedAt: number | undefined,
  remote: SyncRecord
): MergeAction<R> {
  if (!remote.data || typeof remote.data !== "object") return { op: "keep" };
  const record = remote.data as R;
  if (localSavedAt !== undefined && record.savedAt <= localSavedAt) return { op: "keep" };
  return { op: "write", value: record };
}

/**
 * 听书进度:按位置自己的 updatedAt 比新旧,远端更新才返回它。
 * 它不跟书籍 meta 走——meta 的 LWW 看的是整本书最后被谁改过,会把刚听过的进度用对端的旧值盖掉。
 */
export function newerListening<P extends { updatedAt: number }>(
  local: P | undefined,
  remote: P | undefined
): P | null {
  if (!remote || typeof remote !== "object" || !Number.isFinite(remote.updatedAt)) return null;
  if (local && remote.updatedAt <= local.updatedAt) return null;
  return remote;
}

/**
 * 限并发地逐个处理。插图一本书几十张,串行时每张都要付一次两跳往返;
 * 任何一个失败就不再领新任务,把第一个错误抛出去。
 */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await task(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}
