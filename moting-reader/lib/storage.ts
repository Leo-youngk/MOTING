import type { BookMetadataPatch } from "./book-metadata-types";
import type {
  Book,
  BookAiChat,
  BookImage,
  BookNote,
  BookPosition,
  ReaderSettings,
  ReadingSession,
  ReadingStats,
} from "./types";
import { DEFAULT_SETTINGS, DEFAULT_STATS } from "./types";

const DB_NAME = "moting-reader";
const DB_VERSION = 4;
const BOOK_STORE = "books";
const NOTE_STORE = "notes";
const SETTINGS_STORE = "settings";
const IMAGE_STORE = "images";
const CHAT_STORE = "chats";
const SESSION_STORE = "sessions";
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

/** 书籍元数据:不含正文 chapters 的 Book,同步时只传这部分。 */
export type BookMeta = Omit<Book, "chapters">;

/** 已删除书/划线的墓碑。push 被服务端接受后清理。 */
export interface SyncTombstones {
  books: Record<string, number>;
  notes: Record<string, number>;
}

/**
 * 云端同步的本地状态。两个水位分属两台时钟,绝不能混用:
 * - pushedAt:本机时钟(毫秒)。上次成功同步开始的时刻,本地记录的修改时间比它新才需要上传。
 * - pullCursor:服务端号段(server_at)。下次 pull 从这里接着拉。
 */
export interface SyncState {
  pushedAt: number;
  pullCursor: number;
  tombstones: SyncTombstones;
  pendingContent: string[];
}

const DEFAULT_SYNC_STATE: SyncState = {
  pushedAt: 0,
  pullCursor: 0,
  tombstones: { books: {}, notes: {} },
  pendingContent: [],
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

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("当前浏览器不支持本地书库"));
  }
  if (dbPromise) return dbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
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
    };
    request.onsuccess = () => {
      const db = request.result;
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

export async function getAllBooks(): Promise<Book[]> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, SETTINGS_STORE], "readonly");
  const booksRequest = transaction.objectStore(BOOK_STORE).getAll() as IDBRequest<Book[]>;
  const settingsStore = transaction.objectStore(SETTINGS_STORE);
  const settingsRequest = settingsStore.getAll() as IDBRequest<unknown[]>;
  const keysRequest = settingsStore.getAllKeys();
  const [books, settings, keys] = await Promise.all([
    requestToPromise(booksRequest),
    requestToPromise(settingsRequest),
    requestToPromise(keysRequest),
  ]);
  const positions = new Map<string, StoredReadingPosition>();
  const metadata = new Map<string, BookMetadataPatch>();
  keys.forEach((key, index) => {
    if (typeof key !== "string") return;
    const value = settings[index];
    if (!value || typeof value !== "object") return;
    if (key.startsWith(BOOK_METADATA_PREFIX)) {
      metadata.set(
        key.slice(BOOK_METADATA_PREFIX.length),
        value as BookMetadataPatch
      );
      return;
    }
    if (!key.startsWith(READING_POSITION_PREFIX)) return;
    const record = value as Partial<StoredReadingPosition>;
    if (
      !record.position ||
      typeof record.savedAt !== "number" ||
      !Number.isFinite(record.savedAt) ||
      typeof record.lastOpenedAt !== "number" ||
      !Number.isFinite(record.lastOpenedAt)
    ) return;
    positions.set(key.slice(READING_POSITION_PREFIX.length), record as StoredReadingPosition);
  });
  return books
    .map((book) => {
      const record = positions.get(book.id);
      const merged =
        !record || record.savedAt <= book.updatedAt
          ? book
          : {
              ...book,
              readingPosition: record.position,
              lastOpenedAt: Math.max(book.lastOpenedAt, record.lastOpenedAt),
              updatedAt: record.savedAt,
            };
      return applyBookMetadata(merged, metadata.get(book.id));
    })
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/**
 * 线上补全的书名/作者/封面只在读出来的这一刻盖上去，Book 记录本身保持导入时的原样。
 * 删掉补丁记录，书就恢复原貌——这也是「还原成导入时的资料」能成立的前提。
 */
function applyBookMetadata(
  book: Book,
  patch: BookMetadataPatch | undefined
): Book {
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
  const store = transaction.objectStore(SETTINGS_STORE);
  const [values, keys] = await Promise.all([
    requestToPromise(store.getAll() as IDBRequest<unknown[]>),
    requestToPromise(store.getAllKeys()),
  ]);
  const patches: BookMetadataPatch[] = [];
  keys.forEach((key, index) => {
    if (typeof key !== "string" || !key.startsWith(BOOK_METADATA_PREFIX)) return;
    const value = values[index];
    if (value && typeof value === "object") patches.push(value as BookMetadataPatch);
  });
  return patches;
}

export async function saveBookMetadata(patch: BookMetadataPatch): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  transaction
    .objectStore(SETTINGS_STORE)
    .put(patch, bookMetadataKey(patch.bookId));
  await transactionDone(transaction);
}

export async function removeBookMetadata(bookId: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  transaction.objectStore(SETTINGS_STORE).delete(bookMetadataKey(bookId));
  await transactionDone(transaction);
}

export async function saveBook(book: Book): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readwrite");
  transaction.objectStore(BOOK_STORE).put(book);
  await transactionDone(transaction);
}

/** 同步下载正文时按 id 取整本;内存里同时只有这一本。 */
export async function getBook(bookId: string): Promise<Book | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readonly");
  return requestToPromise(
    transaction.objectStore(BOOK_STORE).get(bookId) as IDBRequest<Book | undefined>
  );
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

/** 书籍 meta 的轻量读:逐本游标读、当场丢掉 chapters,内存峰值只有一本。 */
export async function getBookMetas(): Promise<BookMeta[]> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readonly");
  return new Promise((resolve, reject) => {
    const metas: BookMeta[] = [];
    const request = transaction.objectStore(BOOK_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(metas.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));
        return;
      }
      const book = cursor.value as Book;
      if (book && typeof book === "object") {
        const { chapters: _chapters, ...meta } = book;
        metas.push(meta);
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("无法读取书库"));
  });
}

/** 全部阅读/听书位置,同步用。 */
export async function getAllReadingPositions(): Promise<
  Array<{ bookId: string; position: BookPosition; lastOpenedAt: number; savedAt: number }>
> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const store = transaction.objectStore(SETTINGS_STORE);
  const [values, keys] = await Promise.all([
    requestToPromise(store.getAll() as IDBRequest<unknown[]>),
    requestToPromise(store.getAllKeys()),
  ]);
  const positions: Array<{ bookId: string; position: BookPosition; lastOpenedAt: number; savedAt: number }> = [];
  keys.forEach((key, index) => {
    if (typeof key !== "string" || !key.startsWith(READING_POSITION_PREFIX)) return;
    const record = values[index] as Partial<StoredReadingPosition> | undefined;
    if (!record?.position || typeof record.savedAt !== "number" || typeof record.lastOpenedAt !== "number") return;
    positions.push({
      bookId: key.slice(READING_POSITION_PREFIX.length),
      position: record.position,
      lastOpenedAt: record.lastOpenedAt,
      savedAt: record.savedAt,
    });
  });
  return positions;
}

export async function getSyncState(): Promise<SyncState> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const state = await requestToPromise(transaction.objectStore(SETTINGS_STORE).get(SYNC_STATE_KEY));
  if (!state || typeof state !== "object") return { ...DEFAULT_SYNC_STATE, tombstones: { books: {}, notes: {} } };
  const stored = state as Partial<SyncState>;
  return {
    pushedAt: typeof stored.pushedAt === "number" ? stored.pushedAt : 0,
    pullCursor: typeof stored.pullCursor === "number" ? stored.pullCursor : 0,
    tombstones: {
      books: stored.tombstones?.books ?? {},
      notes: stored.tombstones?.notes ?? {},
    },
    pendingContent: Array.isArray(stored.pendingContent) ? stored.pendingContent : [],
  };
}

export async function saveSyncState(state: SyncState): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  transaction.objectStore(SETTINGS_STORE).put(state, SYNC_STATE_KEY);
  await transactionDone(transaction);
}

/** settings 本身的修改时间,LWW 用;没有它就分不清「没改」和「改了」。 */
export async function getSettingsMtime(): Promise<number> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const mtime = await requestToPromise(transaction.objectStore(SETTINGS_STORE).get(SETTINGS_MTIME_KEY));
  return typeof mtime === "number" ? mtime : 0;
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
    Object.assign(list, added);
    const tombstones: SyncTombstones = { ...state.tombstones, [kind]: list };
    store.put({ ...state, tombstones }, SYNC_STATE_KEY);
  };
}

/** 阅读记录不跟着删：书没了，那段时间也确实读过。 */
export async function removeBook(bookId: string, { tombstone = true }: SyncWriteOptions = {}): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(
    [BOOK_STORE, NOTE_STORE, IMAGE_STORE, CHAT_STORE, SETTINGS_STORE],
    "readwrite"
  );
  transaction.objectStore(BOOK_STORE).delete(bookId);
  deleteByBookId(transaction.objectStore(NOTE_STORE), bookId);
  deleteByBookId(transaction.objectStore(IMAGE_STORE), bookId);
  transaction.objectStore(CHAT_STORE).delete(bookId);
  transaction.objectStore(SETTINGS_STORE).delete(readingPositionKey(bookId));
  // 补丁必须跟着删：留着的话重新导入同一本书、复用到同一个 id 时会串到旧资料上。
  transaction.objectStore(SETTINGS_STORE).delete(bookMetadataKey(bookId));
  // 删除墓碑:同步时告知其他设备同样删除。本地清空(clearLibrary)不走这里,云端保留。
  if (tombstone) editTombstones(transaction.objectStore(SETTINGS_STORE), "books", { [bookId]: Date.now() });
  await transactionDone(transaction);
}

/** 只保存阅读位置，不复制整本正文；正文仍由 saveBook 负责持久化。 */
export async function saveReadingPositions(
  entries: Array<{
    bookId: string;
    position: BookPosition;
    lastOpenedAt: number;
    savedAt: number;
  }>
): Promise<void> {
  if (!entries.length) return;
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  for (const entry of entries) {
    store.put(
      {
        position: entry.position,
        lastOpenedAt: entry.lastOpenedAt,
        savedAt: entry.savedAt,
      } satisfies StoredReadingPosition,
      readingPositionKey(entry.bookId)
    );
  }
  await transactionDone(transaction);
}

/** 在线导入将正文与插图放在同一个事务，存储失败时不留下半本书。 */
export async function saveImportedBook(book: Book, images: BookImage[]): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, IMAGE_STORE], "readwrite");
  transaction.objectStore(BOOK_STORE).put(book);
  for (const image of images) transaction.objectStore(IMAGE_STORE).put(image);
  await transactionDone(transaction);
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
  transaction.objectStore(CHAT_STORE).put(chat);
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
      NOTE_STORE,
      SETTINGS_STORE,
      IMAGE_STORE,
      CHAT_STORE,
      SESSION_STORE,
    ],
    "readwrite"
  );
  transaction.objectStore(BOOK_STORE).clear();
  transaction.objectStore(NOTE_STORE).clear();
  transaction.objectStore(SETTINGS_STORE).clear();
  transaction.objectStore(IMAGE_STORE).clear();
  transaction.objectStore(CHAT_STORE).clear();
  transaction.objectStore(SESSION_STORE).clear();
  await transactionDone(transaction);
}
