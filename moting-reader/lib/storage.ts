import type { Book, BookNote, ReaderSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const DB_NAME = "moting-reader";
const DB_VERSION = 1;
const BOOK_STORE = "books";
const NOTE_STORE = "notes";
const SETTINGS_STORE = "settings";

let dbPromise: Promise<IDBDatabase> | null = null;

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

  dbPromise = new Promise((resolve, reject) => {
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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("无法打开浏览器本地书库"));
    request.onblocked = () =>
      reject(new Error("请关闭其他正在使用墨听的页面后重试"));
  });

  return dbPromise;
}

export async function getAllBooks(): Promise<Book[]> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readonly");
  const books = await requestToPromise(
    transaction.objectStore(BOOK_STORE).getAll() as IDBRequest<Book[]>
  );
  return books.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function saveBook(book: Book): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readwrite");
  transaction.objectStore(BOOK_STORE).put(book);
  await transactionDone(transaction);
}

export async function removeBook(bookId: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(
    [BOOK_STORE, NOTE_STORE],
    "readwrite"
  );
  transaction.objectStore(BOOK_STORE).delete(bookId);
  const noteStore = transaction.objectStore(NOTE_STORE);
  const index = noteStore.index("bookId");
  const request = index.openCursor(IDBKeyRange.only(bookId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  await transactionDone(transaction);
}

export async function getAllNotes(): Promise<BookNote[]> {
  const db = await openDatabase();
  const transaction = db.transaction(NOTE_STORE, "readonly");
  const notes = await requestToPromise(
    transaction.objectStore(NOTE_STORE).getAll() as IDBRequest<BookNote[]>
  );
  return notes.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveNote(note: BookNote): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(NOTE_STORE, "readwrite");
  transaction.objectStore(NOTE_STORE).put(note);
  await transactionDone(transaction);
}

export async function removeNote(noteId: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(NOTE_STORE, "readwrite");
  transaction.objectStore(NOTE_STORE).delete(noteId);
  await transactionDone(transaction);
}

export async function getSettings(): Promise<ReaderSettings> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const settings = await requestToPromise(
    transaction.objectStore(SETTINGS_STORE).get("reader")
  );
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function saveSettings(
  settings: ReaderSettings
): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  transaction.objectStore(SETTINGS_STORE).put(settings, "reader");
  await transactionDone(transaction);
}

export async function clearLibrary(): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(
    [BOOK_STORE, NOTE_STORE, SETTINGS_STORE],
    "readwrite"
  );
  transaction.objectStore(BOOK_STORE).clear();
  transaction.objectStore(NOTE_STORE).clear();
  transaction.objectStore(SETTINGS_STORE).clear();
  await transactionDone(transaction);
}
