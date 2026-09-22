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

let dbPromise: Promise<IDBDatabase> | null = null;

interface StoredReadingPosition {
  position: BookPosition;
  lastOpenedAt: number;
  savedAt: number;
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
  keys.forEach((key, index) => {
    if (typeof key !== "string" || !key.startsWith(READING_POSITION_PREFIX)) return;
    const value = settings[index];
    if (!value || typeof value !== "object") return;
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
      if (!record || record.savedAt <= book.updatedAt) return book;
      return {
        ...book,
        readingPosition: record.position,
        lastOpenedAt: Math.max(book.lastOpenedAt, record.lastOpenedAt),
        updatedAt: record.savedAt,
      };
    })
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function saveBook(book: Book): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readwrite");
  transaction.objectStore(BOOK_STORE).put(book);
  await transactionDone(transaction);
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

/** 阅读记录不跟着删：书没了，那段时间也确实读过。 */
export async function removeBook(bookId: string): Promise<void> {
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
export async function writeNotes(notes: BookNote[], removedIds: string[] = []): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(NOTE_STORE, "readwrite");
  const done = transactionDone(transaction);
  try {
    const store = transaction.objectStore(NOTE_STORE);
    for (const note of notes) store.put(note);
    for (const id of removedIds) store.delete(id);
  } catch (error) {
    transaction.abort();
    await done.catch(() => undefined);
    throw error;
  }
  await done;
}

export async function removeNote(noteId: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(NOTE_STORE, "readwrite");
  transaction.objectStore(NOTE_STORE).delete(noteId);
  await transactionDone(transaction);
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
  settings: ReaderSettings
): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  transaction.objectStore(SETTINGS_STORE).put(settings, "reader");
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
