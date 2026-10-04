import type { PushFailure } from "./sync-record";
import { normalizeVoiceURI } from "./edge-voices";
import type { BookMetadataPatch } from "./book-metadata-types";
import { outlineOf } from "./content";
import { mergeChatTurns } from "./sync-merge";
import { acknowledgeProgress, progressId, type ProgressKind, type ProgressReceipt, type ProgressRecord, type QueuedProgress } from "./sync-progress";
import type {
  Book,
  BookAiChat,
  BookImage,
  BookMeta,
  BookNote,
  BookPosition,
  Chapter,
  ReaderSettings,
  ReadingSession,
  ReadingStats,
} from "./types";
import { DEFAULT_SETTINGS, DEFAULT_STATS } from "./types";

const DB_NAME = "moting-reader";
/** 6：增加与位置同事务保存的进度待上传队列。 */
const DB_VERSION = 6;
const BOOK_STORE = "books";
/** 书的正文，一本书一条，主键 bookId。书目在 books 表里，打开这本书时才读这里。 */
const CONTENT_STORE = "contents";
const NOTE_STORE = "notes";
const SETTINGS_STORE = "settings";
const IMAGE_STORE = "images";
const CHAT_STORE = "chats";
const SESSION_STORE = "sessions";
const PROGRESS_STORE = "sync-progress";
const READING_POSITION_PREFIX = "reading-position:";
/** 线上补全的书籍资料。跟阅读位置一样单独存，不写回体积巨大的 Book 记录。 */
const BOOK_METADATA_PREFIX = "book-metadata:";
// 云端同步的本地状态,都放在 settings store 里。
const SYNC_STATE_KEY = "sync:state";
const SETTINGS_MTIME_KEY = "reader-mtime";

let dbPromise: Promise<IDBDatabase> | null = null;

interface StoredReadingPosition {
  position: BookPosition;
  lastOpenedAt: number;
  savedAt: number;
}

interface StoredContent {
  bookId: string;
  chapters: Chapter[];
}

/** 已删除书/划线的墓碑。push 被服务端接受后清理。 */
export interface SyncTombstones {
  books: Record<string, number>;
  notes: Record<string, number>;
}

/**
 * 云端同步的本地状态。两个水位分属两台时钟,绝不能混用:
 * - pushedAt:普通记录的本机时间水位；阅读/听书位置由独立队列逐条确认。
 * - pullCursor:服务端号段(server_at)。下次 pull 从这里接着拉。
 */
export interface SyncState {
  /** 同步协议的数据版本。客户端新增同步类别时加一,旧版本的设备会整体补传一次。 */
  schema: number;
  pushedAt: number;
  pullCursor: number;
  progressCursor?: number;
  lastProgressAt?: number;
  tombstones: SyncTombstones;
  pendingContent: string[];
  pendingDownloads?: BookMeta[];
  blockedContent?: Array<{ bookId: string; reason: string }>;
  pendingImages: Array<{ bookId: string; imageId: string }>;
  pendingPush: Partial<Record<SyncPushKind, string[]>>;
  pushFailures?: PushFailure[];
  lastCompleteAt?: number;
}

export type SyncPushKind =
  | "books"
  | "notes"
  | "positions"
  | "sessions"
  | "settings"
  | "chats"
  | "patches"
  | "listening";

const DEFAULT_SYNC_STATE: SyncState = {
  schema: 0,
  pushedAt: 0,
  pullCursor: 0,
  tombstones: { books: {}, notes: {} },
  pendingContent: [],
  pendingImages: [],
  pendingPush: {},
};

/** 应用云端变更时传 tombstone:false——那是别人删的,不该再以本机名义推回去。 */
export interface SyncWriteOptions {
  tombstone?: boolean;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("浏览器本地存储操作失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("浏览器本地存储写入失败"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("浏览器本地存储写入被中止"));
  });
}

/** 旧库升级（把正文从书目里搬出去）的进行状态。只在老用户第一次打开新版时出现一次。 */
const upgradeListeners = new Set<(upgrading: boolean) => void>();

export function onStorageUpgrade(listener: (upgrading: boolean) => void): () => void {
  upgradeListeners.add(listener);
  return () => {
    upgradeListeners.delete(listener);
  };
}

function notifyUpgrade(upgrading: boolean): void {
  upgradeListeners.forEach((listener) => listener(upgrading));
}

/**
 * v4 → v5：书目记录里的 chapters 搬进 contents 表，书目留一份目录。
 *
 * 就在升级事务里逐本做：游标一次只拿一本，内存峰值是一本书；
 * 中途任何一步失败整个事务回滚，库停在 v4 原样，下次打开再来。
 */
function moveContentsOutOfBooks(transaction: IDBTransaction): void {
  const contents = transaction.objectStore(CONTENT_STORE);
  const request = transaction.objectStore(BOOK_STORE).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const record = cursor.value as Partial<Book> & { id: string };
    if (Array.isArray(record.chapters)) {
      const { chapters, ...meta } = record;
      contents.put({ bookId: record.id, chapters } satisfies StoredContent);
      cursor.update({ ...meta, chapterOutline: outlineOf(chapters) });
    }
    cursor.continue();
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("当前浏览器不支持本地书库"));
  }
  if (dbPromise) return dbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let upgrading = false;
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONTENT_STORE)) {
        db.createObjectStore(CONTENT_STORE, { keyPath: "bookId" });
      }
      if (event.oldVersion > 0 && event.oldVersion < 5 && request.transaction) {
        upgrading = true;
        notifyUpgrade(true);
        moveContentsOutOfBooks(request.transaction);
      }
      if (!db.objectStoreNames.contains(BOOK_STORE)) {
        db.createObjectStore(BOOK_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(NOTE_STORE)) {
        const notes = db.createObjectStore(NOTE_STORE, { keyPath: "id" });
        notes.createIndex("bookId", "bookId", { unique: false });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE);
      }
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        const images = db.createObjectStore(IMAGE_STORE, { keyPath: "id" });
        images.createIndex("bookId", "bookId", { unique: false });
      }
      if (!db.objectStoreNames.contains(CHAT_STORE)) {
        // 一本书一条常驻对话，bookId 本身就是主键，不用像 notes 那样另建索引。
        db.createObjectStore(CHAT_STORE, { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        const sessions = db.createObjectStore(SESSION_STORE, { keyPath: "id" });
        sessions.createIndex("bookId", "bookId", { unique: false });
      }
      if (!db.objectStoreNames.contains(PROGRESS_STORE)) {
        db.createObjectStore(PROGRESS_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (upgrading) notifyUpgrade(false);
      // 别的页面要升级数据库时让出连接，否则它会一直卡在 blocked。
      db.onversionchange = () => {
        db.close();
        if (dbPromise === promise) dbPromise = null;
      };
      db.onclose = () => {
        if (dbPromise === promise) dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      if (upgrading) notifyUpgrade(false);
      if (dbPromise === promise) dbPromise = null;
      reject(request.error ?? new Error("无法打开浏览器本地书库"));
    };
    request.onblocked = () => {
      if (dbPromise === promise) dbPromise = null;
      reject(new Error("请关闭其他正在使用墨听的页面后重试"));
    };
  });
  dbPromise = promise;

  return dbPromise;
}

function readingPositionKey(bookId: string): string {
  return `${READING_POSITION_PREFIX}${bookId}`;
}

function bookMetadataKey(bookId: string): string {
  return `${BOOK_METADATA_PREFIX}${bookId}`;
}

/** settings 表里某一类前缀的全部键。只读这一段，不把整张表连同别的大记录一起捞出来。 */
function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}

async function readPrefixed(
  store: IDBObjectStore,
  prefix: string
): Promise<Array<[string, unknown]>> {
  const range = prefixRange(prefix);
  const [values, keys] = await Promise.all([
    requestToPromise(store.getAll(range) as IDBRequest<unknown[]>),
    requestToPromise(store.getAllKeys(range)),
  ]);
  return keys.map((key, index) => [String(key).slice(prefix.length), values[index]]);
}

function validPosition(value: unknown): value is StoredReadingPosition {
  const record = value as Partial<StoredReadingPosition> | undefined;
  return Boolean(
    record?.position &&
      typeof record.savedAt === "number" &&
      Number.isFinite(record.savedAt) &&
      typeof record.lastOpenedAt === "number" &&
      Number.isFinite(record.lastOpenedAt)
  );
}

export type ReadingPositionEntry = StoredReadingPosition & { bookId: string };

function notifyProgressPending(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("moting:progress-pending"));
}

function rememberReadingBackup(bookId: string, data: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(`moting:pos:${bookId}`, JSON.stringify(JSON.parse(data).position)); }
  catch { /* IndexedDB 已保存，localStorage 不可用时仍可恢复。 */ }
}

export async function recoverReadingBackups(books: BookMeta[]): Promise<void> {
  if (typeof window === "undefined") return;
  const entries: ReadingPositionEntry[] = [];
  for (const book of books) {
    try {
      const raw = window.localStorage.getItem(`moting:pos:${book.id}`);
      if (!raw) continue;
      const position = JSON.parse(raw) as BookPosition;
      if (typeof position.sentenceId !== "string" || !Number.isFinite(position.updatedAt) ||
          position.updatedAt <= (book.readingPosition?.updatedAt ?? 0)) continue;
      entries.push({ bookId: book.id, position, savedAt: position.updatedAt, lastOpenedAt: position.updatedAt });
    } catch { /* 单条损坏的兜底不影响书库。 */ }
  }
  await saveReadingPositions(entries, { bootstrap: true });
}

function queueProgress(
  transaction: IDBTransaction,
  kind: ProgressKind,
  key: string,
  data: string,
  updatedAt: number,
  bootstrap = false
): void {
  const store = transaction.objectStore(PROGRESS_STORE);
  const id = progressId(kind, key);
  const request = store.get(id);
  request.onsuccess = () => {
    const current = request.result as QueuedProgress | undefined;
    store.put({
      id, kind, key, data, updatedAt,
      seq: (current?.seq ?? 0) + 1,
      mutationId: crypto.randomUUID(),
      serverRev: current?.serverRev ?? 0,
      baseServerRev: current?.pending ? current.baseServerRev : current?.serverRev ?? 0,
      pending: true,
      bootstrap,
      conflict: current?.conflict,
    } satisfies QueuedProgress);
  };
}

/** 旧库对账：未进入队列的旧位置保留原时间，修复历史 pushedAt 漏洞。 */
export async function getProgressQueue(): Promise<QueuedProgress[]> {
  const [metas, positions] = await Promise.all([getBookMetas(), getAllReadingPositions()]);
  const liveBooks = new Set(metas.map((book) => book.id));
  const localOnly = new Set(metas.filter((book) => book.format === "demo").map((book) => book.id));
  const candidates: Array<{ kind: ProgressKind; key: string; data: string; updatedAt: number }> = [];
  const positionById = new Map(positions.map((entry) => [entry.bookId, entry]));
  for (const meta of metas) {
    if (localOnly.has(meta.id)) continue;
    if (meta.listeningPosition) candidates.push({ kind: "listening", key: meta.id,
      data: JSON.stringify(meta.listeningPosition), updatedAt: meta.listeningPosition.updatedAt });
    const stored = positionById.get(meta.id);
    if (meta.readingPosition && (!stored || meta.readingPosition.updatedAt > Math.max(stored.savedAt, stored.position.updatedAt))) {
      positionById.set(meta.id, { bookId: meta.id, position: meta.readingPosition,
        savedAt: meta.readingPosition.updatedAt, lastOpenedAt: meta.lastOpenedAt });
    }
  }
  for (const { bookId, ...value } of positionById.values()) {
    if (!liveBooks.has(bookId) || localOnly.has(bookId)) continue;
    candidates.push({ kind: "positions", key: bookId, data: JSON.stringify(value), updatedAt: value.savedAt });
  }
  const db = await openDatabase();
  const transaction = db.transaction([PROGRESS_STORE, SETTINGS_STORE, BOOK_STORE], "readwrite");
  const store = transaction.objectStore(PROGRESS_STORE);
  for (const candidate of candidates) {
    const request = store.get(progressId(candidate.kind, candidate.key));
    request.onsuccess = () => {
      const current = request.result as QueuedProgress | undefined;
      // 旧库尚无确认队列的记录只迁移一次，保留原修改时间。
      if (!current) {
        const book = transaction.objectStore(BOOK_STORE).get(candidate.key);
        book.onsuccess = () => {
          if (!book.result) return;
          writeProgressValue(transaction, candidate.kind, candidate.key, candidate.data);
          queueProgress(transaction, candidate.kind, candidate.key, candidate.data, candidate.updatedAt, true);
        };
      }
    };
  }
  await transactionDone(transaction);
  const read = db.transaction(PROGRESS_STORE, "readonly");
  return requestToPromise(read.objectStore(PROGRESS_STORE).getAll() as IDBRequest<QueuedProgress[]>);
}

function writeProgressValue(transaction: IDBTransaction, kind: ProgressKind, key: string, data: string): void {
  const value = JSON.parse(data);
  if (kind === "positions") {
    transaction.objectStore(SETTINGS_STORE).put(value, readingPositionKey(key));
    const books = transaction.objectStore(BOOK_STORE);
    const request = books.get(key);
    request.onsuccess = () => {
      const book = request.result as BookMeta | undefined;
      if (book?.readingPosition) {
        const { readingPosition: _legacyPosition, ...meta } = book;
        books.put(meta);
      }
    };
  } else {
    const books = transaction.objectStore(BOOK_STORE);
    const request = books.get(key);
    request.onsuccess = () => {
      const book = request.result as BookMeta | undefined;
      if (book) books.put({ ...book, listeningPosition: value });
    };
  }
}

/** 确认与位置落库同事务。上传期间产生的新 mutation 不会被旧响应清除。 */
export async function applyProgressReceipt(receipt: ProgressReceipt): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction([PROGRESS_STORE, SETTINGS_STORE, BOOK_STORE], "readwrite");
  const store = transaction.objectStore(PROGRESS_STORE);
  let changed = false;
  let backup: string | undefined;
  const request = store.get(progressId(receipt.kind, receipt.key));
  request.onsuccess = () => {
    const current = request.result as QueuedProgress | undefined;
    if (!current || !receipt.record) return;
    const next = acknowledgeProgress(current, receipt);
    if (next === current) return;
    store.put(next);
    if (!next.pending && next.data !== current.data) {
      writeProgressValue(transaction, next.kind, next.key, next.data);
      if (next.kind === "positions") backup = next.data;
      changed = true;
    }
  };
  await transactionDone(transaction);
  if (backup) rememberReadingBackup(receipt.key, backup);
  return changed;
}

/** 单条异常不阻塞其他位置和拉取；下一次真实本地操作会替换这个条目。 */
export async function rejectProgress(kind: ProgressKind, key: string, mutationId: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(PROGRESS_STORE, "readwrite");
  const store = transaction.objectStore(PROGRESS_STORE);
  const request = store.get(progressId(kind, key));
  request.onsuccess = () => {
    const current = request.result as QueuedProgress | undefined;
    if (current?.mutationId === mutationId) store.put({ ...current, rejection: "进度内容异常，请打开这本书重新定位" });
  };
  await transactionDone(transaction);
}

/** 服务端版本大于本机已知版本才应用；并发本地候选保留在 conflict 中。 */
export async function applySyncedProgress(kind: ProgressKind, record: ProgressRecord): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction([PROGRESS_STORE, SETTINGS_STORE, BOOK_STORE], "readwrite");
  const store = transaction.objectStore(PROGRESS_STORE);
  let changed = false;
  let backup: string | undefined;
  const request = store.get(progressId(kind, record.key));
  request.onsuccess = () => {
    const current = request.result as QueuedProgress | undefined;
    if (current && record.serverAt <= current.serverRev) return;
    const data = JSON.stringify(record.data);
    const next: QueuedProgress = current ? acknowledgeProgress(current, {
      // 拉取处理的是当前本地候选，上传回执才带被确认的那次 mutation。
      kind, key: record.key, record, mutationId: current.mutationId,
      status: current.pending && record.mutationId !== current.mutationId ? "conflict" : "accepted",
    }) : {
      id: progressId(kind, record.key), kind, key: record.key, data, updatedAt: record.updatedAt,
      seq: 0, mutationId: record.mutationId ?? "", serverRev: record.serverAt,
      baseServerRev: record.serverAt, pending: false, bootstrap: false,
    };
    store.put(next);
    if (!next.pending) {
      writeProgressValue(transaction, kind, record.key, next.data);
      if (kind === "positions") backup = next.data;
      changed = !current || current.data !== next.data;
    }
  };
  await transactionDone(transaction);
  if (backup) rememberReadingBackup(record.key, backup);
  return changed;
}

/** 显式选择本机候选才生成新修改；选择云端只清除保留的候选。 */
export async function resolveProgressConflict(id: string, useLocal: boolean): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([PROGRESS_STORE, SETTINGS_STORE, BOOK_STORE], "readwrite");
  const store = transaction.objectStore(PROGRESS_STORE);
  const request = store.get(id);
  request.onsuccess = () => {
    const current = request.result as QueuedProgress | undefined;
    if (!current?.conflict) return;
    const { conflict, ...clean } = current;
    if (useLocal) {
      const data = JSON.parse(conflict.data);
      const now = Math.max(Date.now(), current.updatedAt + 1);
      if (current.kind === "positions") {
        data.savedAt = now;
        data.lastOpenedAt = now;
        data.position.updatedAt = now;
      } else data.updatedAt = now;
      const serialized = JSON.stringify(data);
      writeProgressValue(transaction, current.kind, current.key, serialized);
      store.put({ ...clean, data: serialized, updatedAt: now, seq: current.seq + 1,
        mutationId: crypto.randomUUID(), baseServerRev: current.serverRev, pending: true, bootstrap: false });
    } else store.put(clean);
  };
  await transactionDone(transaction);
  if (useLocal) notifyProgressPending();
}

/** 新本地听书事件立即保存；不再等待旧定时器，也不修改书目同步时间。 */
export async function saveLocalListeningPosition(bookId: string, position: BookPosition): Promise<BookMeta | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, PROGRESS_STORE], "readwrite");
  const store = transaction.objectStore(BOOK_STORE);
  let saved: BookMeta | undefined;
  const request = store.get(bookId);
  request.onsuccess = () => {
    const current = request.result as BookMeta | undefined;
    if (!current) return;
    const next = { ...position, updatedAt: Math.max(position.updatedAt, (current.listeningPosition?.updatedAt ?? 0) + 1) };
    saved = { ...current, listeningPosition: next };
    store.put(saved);
    if (current.format !== "demo") queueProgress(transaction, "listening", bookId, JSON.stringify(next), next.updatedAt);
  };
  await transactionDone(transaction);
  if (saved) notifyProgressPending();
  return saved;
}

/** 书库要显示的书目：叠上阅读位置和线上补全的资料，不含正文。 */
export async function getAllBooks(): Promise<BookMeta[]> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, SETTINGS_STORE], "readonly");
  const settings = transaction.objectStore(SETTINGS_STORE);
  const [metas, positions, patches] = await Promise.all([
    requestToPromise(transaction.objectStore(BOOK_STORE).getAll() as IDBRequest<BookMeta[]>),
    readPrefixed(settings, READING_POSITION_PREFIX),
    readPrefixed(settings, BOOK_METADATA_PREFIX),
  ]);
  const positionById = new Map(
    positions.filter((entry): entry is [string, StoredReadingPosition] => validPosition(entry[1]))
  );
  const patchById = new Map(
    patches.filter((entry): entry is [string, BookMetadataPatch] => Boolean(entry[1] && typeof entry[1] === "object"))
  );
  return metas
    .map((meta) => {
      const record = positionById.get(meta.id);
      // 阅读进度有自己的保存时钟。书目 updatedAt 还会因资料、听书状态等变化而更新，
      // 不能拿它和 reading-position 的 savedAt 比，否则无关的书目写入会让旧位置复活。
      const storedPositionAt = record
        ? Math.max(record.savedAt, record.position.updatedAt ?? 0)
        : 0;
      const legacyPositionAt = meta.readingPosition?.updatedAt ?? 0;
      const merged = record && storedPositionAt >= legacyPositionAt
        ? {
            ...meta,
            readingPosition: record.position,
            lastOpenedAt: Math.max(meta.lastOpenedAt, record.lastOpenedAt),
          }
        : meta;
      return applyBookMetadata(merged, patchById.get(meta.id));
    })
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/**
 * 线上补全的书名/作者/封面只在读出来的这一刻盖上去，书目记录本身保持导入时的原样。
 * 删掉补丁记录，书就恢复原貌——这也是「还原成导入时的资料」能成立的前提。
 */
function applyBookMetadata(
  book: BookMeta,
  patch: BookMetadataPatch | undefined
): BookMeta {
  const applied = patch?.applied;
  if (!applied) return book;
  return {
    ...book,
    title: applied.title ?? book.title,
    author: applied.author ?? book.author,
    coverDataUrl: applied.coverDataUrl ?? book.coverDataUrl,
  };
}

export async function getAllBookMetadata(): Promise<BookMetadataPatch[]> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const patches = await readPrefixed(transaction.objectStore(SETTINGS_STORE), BOOK_METADATA_PREFIX);
  return patches
    .map(([, value]) => value)
    .filter((value): value is BookMetadataPatch => Boolean(value && typeof value === "object"));
}

export async function saveBookMetadata(patch: BookMetadataPatch): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  const key = bookMetadataKey(patch.bookId);
  const request = store.get(key);
  request.onsuccess = () => {
    const current = request.result as BookMetadataPatch | undefined;
    // A local action is a new version even when the caller reused an old patch's fetchedAt.
    // This makes manual select/revert operations sync reliably and wins against an older pull.
    const saved = {
      ...patch,
      fetchedAt: Math.max(patch.fetchedAt, (current?.fetchedAt ?? 0) + 1),
    };
    store.put(saved, key);
  };
  await transactionDone(transaction);
}

/** Sync patches use their own fetchedAt LWW clock, checked atomically against concurrent edits. */
export async function saveBookMetadataIfNewer(patch: BookMetadataPatch): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  let changed = false;
  const request = store.get(bookMetadataKey(patch.bookId));
  request.onsuccess = () => {
    const current = request.result as BookMetadataPatch | undefined;
    if (current && current.fetchedAt >= patch.fetchedAt) return;
    store.put(patch, bookMetadataKey(patch.bookId));
    changed = true;
  };
  await transactionDone(transaction);
  return changed;
}

export async function removeBookMetadata(bookId: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  transaction.objectStore(SETTINGS_STORE).delete(bookMetadataKey(bookId));
  await transactionDone(transaction);
}

/** 书目和正文分两张表写；目录每次都从正文重算，两边不会对不上。 */
function putBook(transaction: IDBTransaction, book: Book): void {
  const { chapters, ...meta } = book;
  transaction.objectStore(BOOK_STORE).put({ ...meta, chapterOutline: outlineOf(chapters) });
  transaction.objectStore(CONTENT_STORE).put({ bookId: book.id, chapters } satisfies StoredContent);
}

/** 写整本书（书目 + 正文）。只有导入、同步下载、生成示例书这类「正文本身变了」的场合用。 */
export async function saveBook(book: Book): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, CONTENT_STORE], "readwrite");
  putBook(transaction, book);
  await transactionDone(transaction);
}

/** 整条覆盖书目。同步合并远端书目时用：那边给的是完整一条。 */
export async function saveBookMeta(meta: BookMeta): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readwrite");
  const { chapters: _chapters, ...clean } = meta as BookMeta & { chapters?: unknown };
  transaction.objectStore(BOOK_STORE).put(clean);
  await transactionDone(transaction);
}

/** 同步书目按远端时间戳在事务内比较，不能把读取后刚改过的本地元数据覆盖掉。 */
export async function saveBookMetaIfNewer(meta: BookMeta): Promise<BookMeta | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readwrite");
  const store = transaction.objectStore(BOOK_STORE);
  let saved: BookMeta | undefined;
  const request = store.get(meta.id);
  request.onsuccess = () => {
    const current = request.result as BookMeta | undefined;
    if (!current) return;
    const currentAt = Math.max(current.updatedAt, current.syncReadyAt ?? 0);
    const incomingAt = Math.max(meta.updatedAt, meta.syncReadyAt ?? 0);
    if (incomingAt <= currentAt) return;
    saved = {
      ...current,
      ...meta,
      chapterOutline: current.chapterOutline,
      readingPosition: current.readingPosition,
      listeningPosition: current.listeningPosition,
    };
    store.put(saved);
  };
  await transactionDone(transaction);
  return saved;
}

/**
 * 改书目里的几个字段，在同一个事务里读出库里那条再合并写回。
 *
 * 不拿内存里的书整条写回：内存里那份叠过线上补全的书名封面，
 * 写回去就等于把补丁焊死进了原始记录，「还原成导入时的资料」从此失效。
 */
export async function updateBookMeta(
  bookId: string,
  changes: Partial<Omit<BookMeta, "id">>
): Promise<BookMeta | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, PROGRESS_STORE], "readwrite");
  const store = transaction.objectStore(BOOK_STORE);
  let updated: BookMeta | undefined;
  const request = store.get(bookId);
  request.onsuccess = () => {
    const current = request.result as BookMeta | undefined;
    if (!current) return;
    const safe = { ...changes };
    if (safe.listeningPosition && safe.listeningPosition.updatedAt <= (current.listeningPosition?.updatedAt ?? 0)) {
      delete safe.listeningPosition;
    }
    updated = { ...current, ...safe, id: current.id,
      updatedAt: Math.max(current.updatedAt, safe.updatedAt ?? current.updatedAt) };
    store.put(updated);
    if (safe.listeningPosition && current.format !== "demo") {
      queueProgress(transaction, "listening", bookId, JSON.stringify(safe.listeningPosition), safe.listeningPosition.updatedAt);
    }
  };
  await transactionDone(transaction);
  return updated;
}

/** 听书进度在书目记录里，但只比较它自己的时间戳并在事务内合并其他元数据。 */
export async function updateListeningIfNewer(
  bookId: string,
  position: BookPosition
): Promise<BookMeta | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readwrite");
  const store = transaction.objectStore(BOOK_STORE);
  let updated: BookMeta | undefined;
  const request = store.get(bookId);
  request.onsuccess = () => {
    const current = request.result as BookMeta | undefined;
    if (!current || position.updatedAt <= (current.listeningPosition?.updatedAt ?? 0)) return;
    updated = { ...current, listeningPosition: position };
    store.put(updated);
  };
  await transactionDone(transaction);
  return updated;
}

export async function getBookMeta(bookId: string): Promise<BookMeta | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readonly");
  return requestToPromise(
    transaction.objectStore(BOOK_STORE).get(bookId) as IDBRequest<BookMeta | undefined>
  );
}

/** 一本书的正文。打开阅读器、播放器、单书笔记时才读。 */
export async function getBookContent(bookId: string): Promise<Chapter[] | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(CONTENT_STORE, "readonly");
  const record = await requestToPromise(
    transaction.objectStore(CONTENT_STORE).get(bookId) as IDBRequest<StoredContent | undefined>
  );
  return record?.chapters;
}

/** 库里原样的整本书（不叠补丁）。同步上传正文时用，内存里同时只有这一本。 */
export async function getBook(bookId: string): Promise<Book | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, CONTENT_STORE], "readonly");
  const [meta, content] = await Promise.all([
    requestToPromise(transaction.objectStore(BOOK_STORE).get(bookId) as IDBRequest<BookMeta | undefined>),
    requestToPromise(transaction.objectStore(CONTENT_STORE).get(bookId) as IDBRequest<StoredContent | undefined>),
  ]);
  return meta && content ? { ...meta, chapters: content.chapters } : undefined;
}

function deleteByBookId(store: IDBObjectStore, bookId: string): void {
  const request = store.index("bookId").openCursor(IDBKeyRange.only(bookId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
}

/** 库里原样的全部书目（不叠补丁、不叠阅读位置），同步用。 */
export async function getBookMetas(): Promise<BookMeta[]> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readonly");
  const metas = await requestToPromise(
    transaction.objectStore(BOOK_STORE).getAll() as IDBRequest<BookMeta[]>
  );
  return metas.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/** 全部阅读/听书位置,同步用。 */
export async function getAllReadingPositions(): Promise<
  Array<{ bookId: string; position: BookPosition; lastOpenedAt: number; savedAt: number }>
> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const positions = await readPrefixed(transaction.objectStore(SETTINGS_STORE), READING_POSITION_PREFIX);
  return positions
    .filter((entry): entry is [string, StoredReadingPosition] => validPosition(entry[1]))
    .map(([bookId, record]) => ({
      bookId,
      position: record.position,
      lastOpenedAt: record.lastOpenedAt,
      savedAt: record.savedAt,
    }));
}

export async function getSyncState(): Promise<SyncState> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const state = await requestToPromise(transaction.objectStore(SETTINGS_STORE).get(SYNC_STATE_KEY));
  if (!state || typeof state !== "object") return { ...DEFAULT_SYNC_STATE, tombstones: { books: {}, notes: {} } };
  const stored = state as Partial<SyncState>;
  return {
    schema: typeof stored.schema === "number" ? stored.schema : 0,
    pushedAt: typeof stored.pushedAt === "number" ? stored.pushedAt : 0,
    pullCursor: typeof stored.pullCursor === "number" ? stored.pullCursor : 0,
    progressCursor: typeof stored.progressCursor === "number" ? stored.progressCursor : 0,
    lastProgressAt: typeof stored.lastProgressAt === "number" ? stored.lastProgressAt : 0,
    tombstones: {
      books: stored.tombstones?.books ?? {},
      notes: stored.tombstones?.notes ?? {},
    },
    pendingContent: Array.isArray(stored.pendingContent) ? stored.pendingContent : [],
    pendingDownloads: Array.isArray(stored.pendingDownloads) ? stored.pendingDownloads : [],
    blockedContent: Array.isArray(stored.blockedContent) ? stored.blockedContent : [],
    pendingImages: Array.isArray(stored.pendingImages)
      ? stored.pendingImages.filter((entry): entry is { bookId: string; imageId: string } =>
          Boolean(entry && typeof entry.bookId === "string" && typeof entry.imageId === "string")
        )
      : [],
    pushFailures: Array.isArray(stored.pushFailures) ? stored.pushFailures : [],
    lastCompleteAt: typeof stored.lastCompleteAt === "number" ? stored.lastCompleteAt : 0,
    pendingPush: Object.fromEntries(
      (["books", "notes", "positions", "sessions", "settings", "chats", "patches", "listening"] as const)
        .flatMap((kind) => {
          const keys = stored.pendingPush?.[kind];
          return Array.isArray(keys)
            ? [[kind, keys.filter((key): key is string => typeof key === "string")]]
            : [];
        })
    ),
  };
}

export async function saveSyncState(state: SyncState): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  transaction.objectStore(SETTINGS_STORE).put(state, SYNC_STATE_KEY);
  await transactionDone(transaction);
}

/** 同步结束时原子清理已确认的墓碑，并保留同步途中新增或再次删除的条目。 */
export async function commitSyncState(
  next: SyncState,
  baseline: SyncState,
  rejected: { books?: string[]; notes?: string[] } = {}
): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  const request = store.get(SYNC_STATE_KEY);
  request.onsuccess = () => {
    const current = (request.result as SyncState | undefined) ?? DEFAULT_SYNC_STATE;
    const keep = (kind: "books" | "notes") => {
      const rejectedIds = new Set(rejected[kind] ?? []);
      return Object.fromEntries(
        Object.entries(current.tombstones?.[kind] ?? {}).filter(
          ([id, at]) => baseline.tombstones[kind][id] !== at || rejectedIds.has(id)
        )
      );
    };
    store.put(
      {
        ...next,
        lastCompleteAt: Math.max(current.lastCompleteAt ?? 0, next.lastCompleteAt ?? 0),
        pullCursor: Math.max(current.pullCursor, next.pullCursor),
        lastProgressAt: Math.max(current.lastProgressAt ?? 0, next.lastProgressAt ?? 0),
        progressCursor: Math.max(current.progressCursor ?? 0, next.progressCursor ?? 0),
        tombstones: { books: keep("books"), notes: keep("notes") },
      } satisfies SyncState,
      SYNC_STATE_KEY
    );
  };
  await transactionDone(transaction);
}

export async function commitProgressCursor(cursor: number): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  const request = store.get(SYNC_STATE_KEY);
  request.onsuccess = () => {
    const current = (request.result as SyncState | undefined) ?? DEFAULT_SYNC_STATE;
    store.put({ ...current, progressCursor: Math.max(current.progressCursor ?? 0, cursor), lastProgressAt: Date.now() }, SYNC_STATE_KEY);
  };
  await transactionDone(transaction);
}

/** settings 本身的修改时间,LWW 用;没有它就分不清「没改」和「改了」。 */
/**
 * settings 的修改时间。存过设置但没有 mtime 的(同步上线前保存的)记为 1:
 * 它要能被推上去,但任何一台设备上真正改过的设置都比它新。
 * 从没存过设置(全是默认值)的设备记 0,不推,等着拉别人的。
 */
export async function getSettingsMtime(): Promise<number> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const store = transaction.objectStore(SETTINGS_STORE);
  const [mtime, settings] = await Promise.all([
    requestToPromise(store.get(SETTINGS_MTIME_KEY)),
    requestToPromise(store.get("reader")),
  ]);
  if (typeof mtime === "number") return mtime;
  return settings ? 1 : 0;
}

/**
 * 在 readwrite 事务内增删墓碑;get→put 链在同事务里自动延续。
 * 重新写回的记录(比如撤销删除)要摘掉自己的墓碑,否则下次同步会把它再删一遍。
 */
function editTombstones(
  store: IDBObjectStore,
  kind: "books" | "notes",
  added: Record<string, number>,
  cleared: string[] = []
): void {
  if (!Object.keys(added).length && !cleared.length) return;
  const request = store.get(SYNC_STATE_KEY);
  request.onsuccess = () => {
    const state = (request.result as SyncState | undefined) ?? DEFAULT_SYNC_STATE;
    const list = { ...state.tombstones[kind] };
    for (const id of cleared) delete list[id];
    for (const [id, at] of Object.entries(added)) list[id] = Math.max(at, (list[id] ?? 0) + 1);
    const tombstones: SyncTombstones = { ...state.tombstones, [kind]: list };
    store.put({ ...state, tombstones }, SYNC_STATE_KEY);
  };
}

/** Book deletion cascades to notes; update both tombstone groups from one state read. */
function editBookDeletionTombstones(
  store: IDBObjectStore,
  bookId: string | null,
  bookDeletedAt: number,
  noteDeletes: Record<string, number>
): void {
  const request = store.get(SYNC_STATE_KEY);
  request.onsuccess = () => {
    const state = (request.result as SyncState | undefined) ?? DEFAULT_SYNC_STATE;
    const books = { ...state.tombstones.books };
    const notes = { ...state.tombstones.notes };
    if (bookId) books[bookId] = Math.max(bookDeletedAt, (books[bookId] ?? 0) + 1);
    for (const [id, at] of Object.entries(noteDeletes)) {
      notes[id] = Math.max(at, (notes[id] ?? 0) + 1);
    }
    store.put({ ...state, tombstones: { books, notes } }, SYNC_STATE_KEY);
  };
}

function deleteBookNotes(
  store: IDBObjectStore,
  settings: IDBObjectStore,
  bookId: string,
  deletedAt: number,
  bookTombstone: boolean
): void {
  const deleted: Record<string, number> = {};
  const request = store.index("bookId").openCursor(IDBKeyRange.only(bookId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      const note = cursor.value as BookNote;
      deleted[note.id] = Math.max(deletedAt, (note.updatedAt ?? note.createdAt) + 1);
      cursor.delete();
      cursor.continue();
      return;
    }
    editBookDeletionTombstones(settings, bookTombstone ? bookId : null, deletedAt, deleted);
  };
}

/** 阅读记录不跟着删：书没了，那段时间也确实读过。 */
async function removeBookData(
  bookId: string,
  tombstone: boolean,
  deletedAt?: number
): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(
    [BOOK_STORE, CONTENT_STORE, NOTE_STORE, IMAGE_STORE, CHAT_STORE, SETTINGS_STORE, PROGRESS_STORE],
    "readwrite"
  );
  const books = transaction.objectStore(BOOK_STORE);
  const remove = (current: BookMeta | undefined) => {
    if (deletedAt !== undefined && current && deletedAt <= Math.max(current.updatedAt, current.syncReadyAt ?? 0)) return;
    books.delete(bookId);
    transaction.objectStore(CONTENT_STORE).delete(bookId);
    const deletedAtForChildren = Math.max(
      deletedAt ?? Date.now(),
      (current?.updatedAt ?? 0) + 1,
      (current?.syncReadyAt ?? 0) + 1
    );
    deleteBookNotes(
      transaction.objectStore(NOTE_STORE),
      transaction.objectStore(SETTINGS_STORE),
      bookId,
      deletedAtForChildren,
      tombstone
    );
    deleteByBookId(transaction.objectStore(IMAGE_STORE), bookId);
    transaction.objectStore(CHAT_STORE).delete(bookId);
    const settings = transaction.objectStore(SETTINGS_STORE);
    settings.delete(readingPositionKey(bookId));
    transaction.objectStore(PROGRESS_STORE).delete(progressId("positions", bookId));
    transaction.objectStore(PROGRESS_STORE).delete(progressId("listening", bookId));
    // 补丁必须跟着删：留着的话重新导入同一本书、复用到同一个 id 时会串到旧资料上。
    settings.delete(bookMetadataKey(bookId));
    removed = Boolean(current);
  };
  let removed = false;
  const request = books.get(bookId);
  request.onsuccess = () => remove(request.result as BookMeta | undefined);
  await transactionDone(transaction);
  return removed;
}

export async function removeBook(bookId: string, { tombstone = true }: SyncWriteOptions = {}): Promise<void> {
  await removeBookData(bookId, tombstone);
}

/** 收到云端删书时在同一事务比较版本，较新的本地书籍不会被迟到墓碑清掉。 */
export async function removeBookIfOlder(bookId: string, deletedAt: number): Promise<boolean> {
  return removeBookData(bookId, false, deletedAt);
}

/** 只保存阅读位置，不复制整本正文；正文仍由 saveBook 负责持久化。 */
export async function saveReadingPositions(
  entries: ReadingPositionEntry[],
  { local = false, bootstrap = false }: { local?: boolean; bootstrap?: boolean } = {}
): Promise<ReadingPositionEntry[]> {
  if (!entries.length) return [];
  const db = await openDatabase();
  const transaction = db.transaction([SETTINGS_STORE, PROGRESS_STORE, BOOK_STORE], "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  const saved: ReadingPositionEntry[] = [];
  // 一个批次里先按 savedAt 去重，免得同一本书的迟到旧条目覆盖较新的条目。
  const latest = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const previous = latest.get(entry.bookId);
    if (local || !previous || entry.savedAt > previous.savedAt) latest.set(entry.bookId, entry);
  }
  for (const entry of latest.values()) {
    const key = readingPositionKey(entry.bookId);
    const request = store.get(key);
    request.onsuccess = () => {
      const previous = request.result;
      if (!local && validPosition(previous) && previous.savedAt >= entry.savedAt) return;
      const book = transaction.objectStore(BOOK_STORE).get(entry.bookId);
      book.onsuccess = () => {
        if (!book.result) return;
        const savedAt = local && validPosition(previous) ? Math.max(entry.savedAt, previous.savedAt + 1) : entry.savedAt;
        const value: StoredReadingPosition = {
          position: { ...entry.position, updatedAt: savedAt },
          lastOpenedAt: entry.lastOpenedAt,
          savedAt,
        };
        store.put(value, key);
        const { readingPosition: _legacyPosition, ...meta } = book.result as BookMeta;
        if ((book.result as BookMeta).readingPosition) transaction.objectStore(BOOK_STORE).put(meta);
        saved.push({ bookId: entry.bookId, ...value });
        if ((book.result as BookMeta).format !== "demo") {
          queueProgress(transaction, "positions", entry.bookId, JSON.stringify(value), savedAt, bootstrap);
        }
      };
    };
  }
  await transactionDone(transaction);
  for (const entry of saved) rememberReadingBackup(entry.bookId, JSON.stringify(entry));
  if (saved.length) notifyProgressPending();
  return saved;
}

/** 图片可先于正文重试落库；一张失败的插图不应阻塞整本书的同步。 */
/** 下载完成时重新检查书籍与封面，避免覆盖用户刚换的封面或复活已删除的书。 */
export async function saveRecoveredCover(bookId: string, coverDataUrl: string): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readwrite");
  const store = transaction.objectStore(BOOK_STORE);
  let saved = false;
  const request = store.get(bookId);
  request.onsuccess = () => {
    const current = request.result as BookMeta | undefined;
    if (!current || current.coverDataUrl) return;
    store.put({ ...current, coverDataUrl });
    saved = true;
  };
  await transactionDone(transaction);
  return saved;
}

export async function saveRecoveredImage(image: BookImage): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, IMAGE_STORE], "readwrite");
  let saved = false;
  const request = transaction.objectStore(BOOK_STORE).get(image.bookId);
  request.onsuccess = () => {
    if (!request.result) return;
    transaction.objectStore(IMAGE_STORE).put(image);
    saved = true;
  };
  await transactionDone(transaction);
  return saved;
}

export async function saveBookImages(images: BookImage[]): Promise<void> {
  if (!images.length) return;
  const db = await openDatabase();
  const transaction = db.transaction(IMAGE_STORE, "readwrite");
  const store = transaction.objectStore(IMAGE_STORE);
  for (const image of images) store.put(image);
  await transactionDone(transaction);
}

/** 书目、正文与插图放在同一个事务，存储失败时不留下半本书。 */
export async function saveImportedBook(book: Book, images: BookImage[]): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, CONTENT_STORE, IMAGE_STORE], "readwrite");
  putBook(transaction, book);
  for (const image of images) transaction.objectStore(IMAGE_STORE).put(image);
  await transactionDone(transaction);
}

/** Sync download must not replace a book imported or edited while the network request was running. */
export async function saveImportedBookIfMissing(book: Book, images: BookImage[]): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, CONTENT_STORE, IMAGE_STORE, SETTINGS_STORE, PROGRESS_STORE], "readwrite");
  const books = transaction.objectStore(BOOK_STORE);
  const settings = transaction.objectStore(SETTINGS_STORE);
  let saved = false;
  let bookRead = false;
  let stateRead = false;
  let current: BookMeta | undefined;
  let tombstoneAt = 0;
  const commitIfCurrent = () => {
    if (!bookRead || !stateRead || current || tombstoneAt >= Math.max(book.updatedAt, book.syncReadyAt ?? 0)) return;
    putBook(transaction, book);
    const listening = transaction.objectStore(PROGRESS_STORE).get(progressId("listening", book.id));
    listening.onsuccess = () => {
      const progress = listening.result as QueuedProgress | undefined;
      if (progress) writeProgressValue(transaction, "listening", book.id, progress.data);
    };
    for (const image of images) transaction.objectStore(IMAGE_STORE).put(image);
    saved = true;
  };
  const bookRequest = books.get(book.id);
  bookRequest.onsuccess = () => {
    current = bookRequest.result as BookMeta | undefined;
    bookRead = true;
    commitIfCurrent();
  };
  const stateRequest = settings.get(SYNC_STATE_KEY);
  stateRequest.onsuccess = () => {
    const state = stateRequest.result as SyncState | undefined;
    tombstoneAt = state?.tombstones?.books?.[book.id] ?? 0;
    stateRead = true;
    commitIfCurrent();
  };
  await transactionDone(transaction);
  return saved;
}

export async function getBookImage(
  imageId: string
): Promise<BookImage | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(IMAGE_STORE, "readonly");
  return requestToPromise(
    transaction.objectStore(IMAGE_STORE).get(imageId) as IDBRequest<
      BookImage | undefined
    >
  );
}

export async function getAllNotes(): Promise<BookNote[]> {
  const db = await openDatabase();
  const transaction = db.transaction(NOTE_STORE, "readonly");
  const notes = await requestToPromise(
    transaction.objectStore(NOTE_STORE).getAll() as IDBRequest<BookNote[]>
  );
  return notes
    .map((note) =>
      // 早期版本把整句标记存成 kind: "bookmark"，现在统一当成整句划线。
      (note.kind as string) === "bookmark"
        ? { ...note, kind: "highlight" as const }
        : note
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveNote(note: BookNote): Promise<void> {
  await writeNotes([note]);
}

/** 一次划线跨多句时，正文标记、改色和删除必须整组提交或整组回滚。 */
export async function writeNotes(
  notes: BookNote[],
  removedIds: string[] = [],
  { tombstone = true }: SyncWriteOptions = {}
): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([NOTE_STORE, SETTINGS_STORE], "readwrite");
  const done = transactionDone(transaction);
  try {
    const store = transaction.objectStore(NOTE_STORE);
    for (const note of notes) {
      // 旧记录没有 updatedAt 时补上;同步 LWW 靠它区分「没改」和「改了」。
      store.put({ ...note, updatedAt: note.updatedAt ?? note.createdAt });
    }
    for (const id of removedIds) store.delete(id);
    if (tombstone) {
      const removedAt = Date.now();
      editTombstones(
        transaction.objectStore(SETTINGS_STORE),
        "notes",
        Object.fromEntries(removedIds.map((id) => [id, removedAt])),
        notes.map((note) => note.id)
      );
    }
  } catch (error) {
    transaction.abort();
    await done.catch(() => undefined);
    throw error;
  }
  await done;
}

/** 把云端划线按本地当前版本与未推送删除墓碑原子合并，不复活更晚删除的划线。 */
export async function applySyncedNotes(
  writes: BookNote[],
  deletes: Array<{ id: string; deletedAt: number }>
): Promise<boolean> {
  if (!writes.length && !deletes.length) return false;
  const db = await openDatabase();
  const transaction = db.transaction([NOTE_STORE, SETTINGS_STORE], "readwrite");
  const noteStore = transaction.objectStore(NOTE_STORE);
  const settingsStore = transaction.objectStore(SETTINGS_STORE);
  let changed = false;
  const stateRequest = settingsStore.get(SYNC_STATE_KEY);
  stateRequest.onsuccess = () => {
    const state = (stateRequest.result as SyncState | undefined) ?? DEFAULT_SYNC_STATE;
    const cleared = new Set<string>();
    let remaining = writes.length + deletes.length;
    const finishRead = () => {
      remaining -= 1;
      if (remaining === 0 && cleared.size) {
        editTombstones(settingsStore, "notes", {}, [...cleared]);
      }
    };
    for (const note of writes) {
      const request = noteStore.get(note.id);
      request.onsuccess = () => {
        const current = request.result as BookNote | undefined;
        const incomingAt = note.updatedAt ?? note.createdAt;
        const currentAt = current ? current.updatedAt ?? current.createdAt : 0;
        const deletedAt = state.tombstones?.notes?.[note.id] ?? 0;
        if (incomingAt > Math.max(currentAt, deletedAt)) {
          noteStore.put({ ...note, updatedAt: incomingAt });
          if (deletedAt) cleared.add(note.id);
          changed = true;
        }
        finishRead();
      };
    }
    for (const deletion of deletes) {
      const request = noteStore.get(deletion.id);
      request.onsuccess = () => {
        const current = request.result as BookNote | undefined;
        if (current && deletion.deletedAt > (current.updatedAt ?? current.createdAt)) {
          noteStore.delete(deletion.id);
          changed = true;
        }
        finishRead();
      };
    }
  };
  await transactionDone(transaction);
  return changed;
}

export async function removeNote(noteId: string): Promise<void> {
  await writeNotes([], [noteId]);
}

export async function getAllChats(): Promise<BookAiChat[]> {
  const db = await openDatabase();
  const transaction = db.transaction(CHAT_STORE, "readonly");
  return requestToPromise(
    transaction.objectStore(CHAT_STORE).getAll() as IDBRequest<BookAiChat[]>
  );
}

export async function saveChat(chat: BookAiChat): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(CHAT_STORE, "readwrite");
  const store = transaction.objectStore(CHAT_STORE);
  const request = store.get(chat.bookId);
  request.onsuccess = () => {
    const current = request.result as BookAiChat | undefined;
    if (!current) {
      store.put(chat);
      return;
    }
    store.put({
      bookId: chat.bookId,
      turns: mergeChatTurns(current.turns ?? [], chat.turns ?? []),
      updatedAt: Math.max(current.updatedAt, chat.updatedAt),
    } satisfies BookAiChat);
  };
  await transactionDone(transaction);
}

export async function getAllSessions(): Promise<ReadingSession[]> {
  const db = await openDatabase();
  const transaction = db.transaction(SESSION_STORE, "readonly");
  const sessions = await requestToPromise(
    transaction.objectStore(SESSION_STORE).getAll() as IDBRequest<
      ReadingSession[]
    >
  );
  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}

export async function saveSession(session: ReadingSession): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SESSION_STORE, "readwrite");
  transaction.objectStore(SESSION_STORE).put(session);
  await transactionDone(transaction);
}

/**
 * 同步拉回来的阅读记录：本地没有、或远端那条更晚结束才写。返回真正写了几条。
 *
 * 本机刚推上去的记录，下一次拉取会原样回来一遍。以前不分青红皂白整批写、
 * 再通知界面「有变化」，于是每轮同步都要把整个书库重读一遍。
 */
export async function saveSessionsIfNewer(sessions: ReadingSession[]): Promise<number> {
  if (!sessions.length) return 0;
  const db = await openDatabase();
  const transaction = db.transaction(SESSION_STORE, "readwrite");
  const store = transaction.objectStore(SESSION_STORE);
  let written = 0;
  for (const session of sessions) {
    const request = store.get(session.id);
    request.onsuccess = () => {
      const local = request.result as ReadingSession | undefined;
      if (local && local.endedAt >= session.endedAt) return;
      store.put(session);
      written += 1;
    };
  }
  await transactionDone(transaction);
  return written;
}

export async function getSettings(): Promise<ReaderSettings> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const settings = await requestToPromise(
    transaction.objectStore(SETTINGS_STORE).get("reader")
  );
  const merged = { ...DEFAULT_SETTINGS, ...(settings ?? {}) } as ReaderSettings;
  // 旧版三主题（paper/white/night）迁移到对齐 Apple Books 的六主题。
  const legacyTheme: Partial<Record<string, ReaderSettings["theme"]>> = {
    paper: "calm",
    white: "original",
    night: "quiet",
  };
  const mapped = legacyTheme[merged.theme as string];
  if (mapped) merged.theme = mapped;
  // 选过已经下架的音色（或者系统语音）的，回到默认音色。
  merged.voiceURI = normalizeVoiceURI(merged.voiceURI);
  return merged;
}

export async function saveSettings(
  settings: ReaderSettings,
  mtime = Date.now()
): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  store.put(settings, "reader");
  // mtime 跟 settings 同事务落盘,同步时才能可靠地按「谁后改」合并。
  // 同步拉回来的新设置用它自己的远程时间,避免本地时间把 LWW 摚乱。
  store.put(mtime, SETTINGS_MTIME_KEY);
  await transactionDone(transaction);
}

/** 同步设置和修改时间必须在同一事务内比较，避免较旧云端回包覆盖刚保存的本地设置。 */
export async function saveSettingsIfNewer(
  settings: ReaderSettings,
  mtime: number
): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  let changed = false;
  const request = store.get(SETTINGS_MTIME_KEY);
  request.onsuccess = () => {
    const current = typeof request.result === "number" ? request.result : 0;
    if (mtime <= current) return;
    store.put(settings, "reader");
    store.put(mtime, SETTINGS_MTIME_KEY);
    changed = true;
  };
  await transactionDone(transaction);
  return changed;
}

/** 早期版本存下的每日阅读时长基数;没有就是 null(新设备,或从没用过早期版本)。 */
export async function getLegacyStats(): Promise<ReadingStats | null> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const stats = await requestToPromise(transaction.objectStore(SETTINGS_STORE).get("stats"));
  if (!stats || typeof stats !== "object") return null;
  const days = (stats as Partial<ReadingStats>).days;
  return days && typeof days === "object" && Object.keys(days).length ? { days } : null;
}

/**
 * 把别的设备的历史基数并进来:同一天取较大值。按天取大是幂等的,
 * 重复拉取、两台设备互相合并都不会把时长越加越多。返回本地是否有变化。
 */
export async function mergeLegacyStats(remote: ReadingStats): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  let changed = false;
  // get→put 用回调串在同一事务里;中间插 await 的话 Safari 可能先把事务提交掉。
  const request = store.get("stats");
  request.onsuccess = () => {
    const current = request.result as Partial<ReadingStats> | undefined;
    const days: Record<string, number> = { ...(current?.days ?? {}) };
    for (const [day, seconds] of Object.entries(remote.days ?? {})) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= (days[day] ?? 0)) continue;
      days[day] = seconds;
      changed = true;
    }
    if (changed) store.put({ ...(current ?? {}), days }, "stats");
  };
  await transactionDone(transaction);
  return changed;
}

export async function getStats(): Promise<ReadingStats> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const stats = await requestToPromise(
    transaction.objectStore(SETTINGS_STORE).get("stats")
  );
  return { ...DEFAULT_STATS, ...(stats ?? {}) };
}

export async function clearLibrary(): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(
    [
      BOOK_STORE,
      CONTENT_STORE,
      NOTE_STORE,
      SETTINGS_STORE,
      IMAGE_STORE,
      CHAT_STORE,
      SESSION_STORE,
      PROGRESS_STORE,
    ],
    "readwrite"
  );
  transaction.objectStore(BOOK_STORE).clear();
  transaction.objectStore(CONTENT_STORE).clear();
  transaction.objectStore(NOTE_STORE).clear();
  transaction.objectStore(SETTINGS_STORE).clear();
  transaction.objectStore(IMAGE_STORE).clear();
  transaction.objectStore(CHAT_STORE).clear();
  transaction.objectStore(SESSION_STORE).clear();
  transaction.objectStore(PROGRESS_STORE).clear();
  await transactionDone(transaction);
}
