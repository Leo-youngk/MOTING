// 云端同步客户端:收集本地脏记录 push、拉取远端增量按记录级 LWW 合并、
// 按 syncReadyAt 下载完整正文。绝不整库覆盖——每条记录单独比时间,新者胜。
import { fetchWithTimeout } from "./fetch-utils";
import {
  getAllBookMetadata,
  getAllChats,
  getAllNotes,
  getAllReadingPositions,
  getAllSessions,
  getBook,
  getBookImage,
  getBookMetas,
  getSettings,
  getSettingsMtime,
  getSyncState,
  removeBook,
  saveBook,
  saveBookMetadata,
  saveChat,
  saveImportedBook,
  saveReadingPositions,
  saveSession,
  saveSettings,
  saveSyncState,
  writeNotes,
  type BookMeta,
  type SyncState,
} from "./storage";
import type { BookImage } from "./types";
import type { BookMetadataPatch } from "./book-metadata-types";
import type {
  Book,
  BookAiChat,
  BookNote,
  BookPosition,
  Chapter,
  ReaderSettings,
  ReadingSession,
} from "./types";
import {
  bookPushTime,
  COVER_IMAGE_ID,
  countPayload,
  mergeBookMeta,
  mergeNote,
  mergePosition,
  splitPayload,
  toSyncBookMeta,
  toSyncPatch,
  type PushItem,
  type PushPayload,
  type SyncRecord,
} from "./sync-merge";

export class SyncError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "SyncError";
  }
}

interface SyncResponse {
  connected?: boolean;
  enabled?: boolean;
  /** pull:下一页(或下一轮)从这个 server_at 接着拉。 */
  cursor?: number;
  hasMore?: boolean;
  books?: SyncRecord[];
  notes?: SyncRecord[];
  positions?: SyncRecord[];
  sessions?: SyncRecord[];
  settings?: SyncRecord[];
  chats?: SyncRecord[];
  patches?: SyncRecord[];
  error?: string;
}

async function request<T extends object>(
  path: string,
  body: object | null,
  signal: AbortSignal,
  timeoutMs = 60_000
): Promise<T & SyncResponse> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`/api/sync/${path}`, {
      method: body === null ? "GET" : "POST",
      headers: body === null ? undefined : { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: body === null ? undefined : JSON.stringify(body),
      signal,
    }, timeoutMs);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SyncError("连接超时或网络不可用,请稍后重试", 503);
  }
  const data = (await response.json().catch(() => null)) as (T & SyncResponse) | null;
  if (!response.ok) {
    throw new SyncError(
      data && typeof data.error === "string" ? data.error : `同步服务返回 ${response.status}`,
      response.status
    );
  }
  if (!data) throw new SyncError("同步服务返回了无法读取的数据", 502);
  return data;
}

export async function getSyncSession(signal: AbortSignal): Promise<{ connected: boolean; enabled: boolean }> {
  const data = await request<{ connected?: boolean; enabled?: boolean }>("session", null, signal);
  return { connected: !!data.connected, enabled: data.enabled !== false };
}

export async function loginSync(username: string, password: string, signal: AbortSignal): Promise<void> {
  await request("login", { username, password }, signal, 20_000);
}

export async function logoutSync(signal: AbortSignal): Promise<void> {
  await request("logout", {}, signal, 20_000);
}

// ---------------------------------------------------------------------------
// push 收集:从本地 IndexedDB 找出「上次同步之后改过的记录」。全部走轻量读,
// 不把整本书的正文捞进内存。分批与合并的纯逻辑在 ./sync-merge。
// since 是本机时钟(state.pushedAt),跟记录自己的修改时间同一把尺子。

export async function collectPushPayload(state: SyncState): Promise<PushPayload> {
  const since = state.pushedAt;
  const payload: PushPayload = {};

  // 内置示例书每台设备书库为空时各生成一本、编号随机,同步出去只会越积越多。
  // 它本身和挂在它上面的划线、位置、对话都只留在本机。
  const metas = await getBookMetas();
  const localOnly = new Set(metas.filter((meta) => meta.format === "demo").map((meta) => meta.id));

  const books: PushItem[] = [];
  for (const [id, deletedAt] of Object.entries(state.tombstones.books)) {
    books.push({ key: id, data: "", updatedAt: deletedAt, deletedAt });
  }
  for (const meta of metas) {
    if (localOnly.has(meta.id) || bookPushTime(meta) <= since) continue;
    books.push({ key: meta.id, data: JSON.stringify(toSyncBookMeta(meta)), updatedAt: bookPushTime(meta) });
  }
  if (books.length) payload.books = books;

  const notes: PushItem[] = [];
  for (const [id, deletedAt] of Object.entries(state.tombstones.notes)) {
    notes.push({ key: id, data: "", updatedAt: deletedAt, deletedAt });
  }
  for (const note of await getAllNotes()) {
    const updatedAt = note.updatedAt ?? note.createdAt;
    if (localOnly.has(note.bookId) || updatedAt <= since) continue;
    notes.push({ key: note.id, data: JSON.stringify(note), updatedAt, bookId: note.bookId });
  }
  if (notes.length) payload.notes = notes;

  const positions: PushItem[] = [];
  for (const entry of await getAllReadingPositions()) {
    if (localOnly.has(entry.bookId) || entry.savedAt <= since) continue;
    positions.push({
      key: entry.bookId,
      data: JSON.stringify({ position: entry.position, lastOpenedAt: entry.lastOpenedAt, savedAt: entry.savedAt }),
      updatedAt: entry.savedAt,
    });
  }
  if (positions.length) payload.positions = positions;

  const sessions: PushItem[] = [];
  for (const session of await getAllSessions()) {
    if (session.endedAt <= since) continue;
    sessions.push({ key: session.id, data: JSON.stringify(session), updatedAt: session.endedAt });
  }
  if (sessions.length) payload.sessions = sessions;

  const settingsMtime = await getSettingsMtime();
  if (settingsMtime > since) {
    payload.settings = [{ key: "reader", data: JSON.stringify(await getSettings()), updatedAt: settingsMtime }];
  }

  const chats: PushItem[] = [];
  for (const chat of await getAllChats()) {
    if (localOnly.has(chat.bookId) || chat.updatedAt <= since) continue;
    chats.push({ key: chat.bookId, data: JSON.stringify(chat), updatedAt: chat.updatedAt });
  }
  if (chats.length) payload.chats = chats;

  const patches: PushItem[] = [];
  for (const patch of await getAllBookMetadata()) {
    if (localOnly.has(patch.bookId) || patch.fetchedAt <= since) continue;
    patches.push({ key: patch.bookId, data: JSON.stringify(toSyncPatch(patch)), updatedAt: patch.fetchedAt });
  }
  if (patches.length) payload.patches = patches;

  return payload;
}

// ---------------------------------------------------------------------------
// 正文、插图与封面的上传/下载。

function collectImageIds(chapters: Chapter[]): string[] {
  const ids: string[] = [];
  for (const chapter of chapters) {
    for (const paragraph of chapter.paragraphs) {
      if (paragraph.kind === "image" && paragraph.imageId) ids.push(paragraph.imageId);
    }
  }
  return ids;
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const [, type, base64, body] = match;
  if (!base64) return new Blob([decodeURIComponent(body)], { type });
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: type || "application/octet-stream" });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取云端封面"));
    reader.readAsDataURL(blob);
  });
}

async function readError(response: Response): Promise<SyncError> {
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const message = data && typeof data.error === "string" ? data.error : `请求失败 (${response.status})`;
  return new SyncError(message, response.status);
}

async function uploadImage(bookId: string, imageId: string, blob: Blob, signal: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `/api/sync/book/${encodeURIComponent(bookId)}/images/${encodeURIComponent(imageId)}`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": blob.type || "application/octet-stream" },
        body: blob,
        signal,
      },
      120_000
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SyncError("插图上传中断,稍后会自动重试", 503);
  }
  if (!response.ok) throw await readError(response);
}

async function uploadBookBody(bookId: string, book: Book, signal: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`/api/sync/book/${encodeURIComponent(bookId)}/content`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(book.chapters),
      signal,
    }, 300_000);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SyncError("正文上传中断,稍后会自动重试", 503);
  }
  // 409 = 正文已在云端,当作成功继续插图。
  if (!response.ok && response.status !== 409) throw await readError(response);

  // 封面不进 D1 的 meta(见 toSyncBookMeta),随正文一起放 R2。
  const cover = book.coverDataUrl ? dataUrlToBlob(book.coverDataUrl) : null;
  if (cover) await uploadImage(bookId, COVER_IMAGE_ID, cover, signal);

  for (const imageId of collectImageIds(book.chapters)) {
    const image = await getBookImage(imageId);
    if (!image) continue;
    await uploadImage(bookId, imageId, image.blob, signal);
  }
}

async function downloadImage(bookId: string, imageId: string, signal: AbortSignal): Promise<Blob | null> {
  try {
    const response = await fetchWithTimeout(
      `/api/sync/book/${encodeURIComponent(bookId)}/images/${encodeURIComponent(imageId)}`,
      { credentials: "same-origin", cache: "no-store", signal },
      120_000
    );
    return response.ok ? await response.blob() : null;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

/** 下载一本书:正文 + 封面 + 插图。封面/插图缺失跳过,阅读器显示占位。 */
async function downloadBook(
  meta: BookMeta,
  signal: AbortSignal,
  onProgress: (label: string) => void
): Promise<{ book: Book; images: BookImage[] } | null> {
  onProgress(`正在同步《${meta.title}》…`);
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `/api/sync/book/${encodeURIComponent(meta.id)}/content`,
      { credentials: "same-origin", cache: "no-store", signal },
      300_000
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SyncError("正文下载中断,请稍后重试", 503);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw await readError(response);
  const chapters = (await response.json()) as Chapter[];
  if (!Array.isArray(chapters) || !chapters.length) throw new SyncError(`《${meta.title}》的云端正文无效`, 502);

  const coverBlob = await downloadImage(meta.id, COVER_IMAGE_ID, signal);
  const coverDataUrl = coverBlob ? await blobToDataUrl(coverBlob) : undefined;

  const images: BookImage[] = [];
  for (const imageId of collectImageIds(chapters)) {
    const blob = await downloadImage(meta.id, imageId, signal);
    if (blob) images.push({ id: imageId, bookId: meta.id, blob });
  }
  return { book: { ...meta, ...(coverDataUrl ? { coverDataUrl } : {}), chapters }, images };
}

// ---------------------------------------------------------------------------
// 一整轮同步。

export interface SyncRunResult {
  /** 本轮同步开始的本机时刻,界面显示「上次同步」用。 */
  syncedAt: number;
  changed: boolean;
  /** 超过云端大小上限、永远传不上去的书;调用方应提示用户。 */
  failedContent: string[];
  /** 单条超过云端上限、被服务端跳过的记录数;调用方应提示用户。 */
  tooLarge: number;
}

export type SyncAppliedKind =
  | "books" | "notes" | "positions" | "sessions" | "settings" | "chats" | "patches";

export interface SyncDeps {
  signal: AbortSignal;
  onProgress?: (label: string) => void;
  /** 云端记录落库后通知 UI 重读本地数据。 */
  onApplied?: (kind: SyncAppliedKind) => void;
}

async function pushAll(payload: PushPayload, signal: AbortSignal): Promise<number> {
  let tooLarge = 0;
  for (const batch of splitPayload(payload)) {
    if (!countPayload(batch)) continue;
    const response = await request<{ tooLarge?: Record<string, string[]> }>("push", batch, signal, 120_000);
    for (const keys of Object.values(response.tooLarge ?? {})) tooLarge += keys.length;
  }
  if (tooLarge) console.warn("sync_push_too_large", { count: tooLarge });
  return tooLarge;
}

/** 把一页 pull 结果逐条合并进本地。待下载的新书先攒进 downloads,全部页拉完再下正文。 */
async function applyPullPage(
  page: SyncResponse,
  localMetaById: Map<string, BookMeta>,
  downloads: Map<string, BookMeta>,
  deps: SyncDeps
): Promise<boolean> {
  let changed = false;

  for (const record of page.books ?? []) {
    // 同一本书可能在更早的页里排进了下载队列,后面的页里又被删或更新。
    if (record.deletedAt) downloads.delete(record.key);
    const action = mergeBookMeta(localMetaById.get(record.key), record);
    if (action.op === "delete") {
      await removeBook(record.key, { tombstone: false });
      localMetaById.delete(record.key);
      changed = true;
      deps.onApplied?.("books");
    } else if (action.op === "write") {
      const local = localMetaById.has(record.key) ? await getBook(record.key) : undefined;
      if (local) {
        const merged: Book = {
          ...local,
          ...action.value,
          chapters: local.chapters,
          readingPosition: local.readingPosition,
          listeningPosition: local.listeningPosition,
        };
        await saveBook(merged);
        const { chapters: _chapters, ...meta } = merged;
        localMetaById.set(record.key, meta);
        changed = true;
        deps.onApplied?.("books");
      } else {
        downloads.set(record.key, action.value);
      }
    }
  }

  if (page.notes?.length) {
    const localNotes = new Map((await getAllNotes()).map((note) => [note.id, note]));
    const noteWrites: BookNote[] = [];
    const noteDeletes: string[] = [];
    for (const record of page.notes) {
      const action = mergeNote(localNotes.get(record.key), record);
      if (action.op === "write") noteWrites.push(action.value);
      else if (action.op === "delete") noteDeletes.push(record.key);
    }
    if (noteWrites.length || noteDeletes.length) {
      await writeNotes(noteWrites, noteDeletes, { tombstone: false });
      changed = true;
      deps.onApplied?.("notes");
    }
  }

  if (page.positions?.length) {
    const localPositions = new Map((await getAllReadingPositions()).map((entry) => [entry.bookId, entry.savedAt]));
    const positionWrites: Array<{ bookId: string; position: BookPosition; lastOpenedAt: number; savedAt: number }> = [];
    for (const record of page.positions) {
      const action = mergePosition<{ position: BookPosition; lastOpenedAt: number; savedAt: number }>(
        localPositions.get(record.key),
        record
      );
      if (action.op === "write") positionWrites.push({ bookId: record.key, ...action.value });
    }
    if (positionWrites.length) {
      await saveReadingPositions(positionWrites);
      changed = true;
      deps.onApplied?.("positions");
    }
  }

  if (page.sessions?.length) {
    for (const record of page.sessions) {
      if (!record.data) continue;
      await saveSession(record.data as ReadingSession);
      changed = true;
    }
    deps.onApplied?.("sessions");
  }

  for (const record of page.settings ?? []) {
    if (record.key !== "reader" || !record.data) continue;
    if (record.updatedAt > (await getSettingsMtime())) {
      await saveSettings(record.data as ReaderSettings, record.updatedAt);
      changed = true;
      deps.onApplied?.("settings");
    }
  }

  if (page.chats?.length) {
    const localChats = new Map((await getAllChats()).map((chat) => [chat.bookId, chat.updatedAt]));
    for (const record of page.chats) {
      if (!record.data) continue;
      const remote = record.data as BookAiChat;
      if (!localChats.has(record.key) || remote.updatedAt > (localChats.get(record.key) ?? 0)) {
        await saveChat(remote);
        changed = true;
      }
    }
    deps.onApplied?.("chats");
  }

  if (page.patches?.length) {
    const localPatches = new Map((await getAllBookMetadata()).map((patch) => [patch.bookId, patch.fetchedAt]));
    for (const record of page.patches) {
      if (!record.data) continue;
      const remote = record.data as BookMetadataPatch;
      if (!localPatches.has(record.key) || remote.fetchedAt > (localPatches.get(record.key) ?? 0)) {
        await saveBookMetadata(remote);
        changed = true;
      }
    }
    deps.onApplied?.("patches");
  }

  return changed;
}

/**
 * 一轮同步 = push 脏记录 → 上传 pending 正文并标 ready → 分页 pull 增量逐条 LWW 合并 →
 * 下载缺失书籍 → 推进两个水位并清掉已确认的墓碑。任何一步抛错整轮中止,水位不动;
 * 重跑时重复的 push/pull 都是幂等的(服务端 LWW、本地合并按时间比较)。
 */
export async function runSync(deps: SyncDeps): Promise<SyncRunResult> {
  const { signal, onProgress = () => {} } = deps;
  const state = await getSyncState();
  // 先记时刻再收集:收集期间新改的记录修改时间 ≥ 这个值,下一轮一定还会被捡到。
  const startedAt = Date.now();

  // 1. push 本地脏记录。
  const payload = await collectPushPayload(state);
  const pushedBookIds = new Set((payload.books ?? []).filter((item) => !item.deletedAt).map((item) => item.key));
  let tooLarge = 0;
  if (countPayload(payload)) {
    onProgress("正在上传本地记录…");
    tooLarge += await pushAll(payload, signal);
  }

  // 2. 上传待传正文(meta 已 push 但还没标 ready 的书 + 之前没传完的)。
  const pending = [...new Set([...state.pendingContent, ...pushedBookIds])];
  const failedContent: string[] = [];
  const readyBooks: Book[] = [];
  const stillPending: string[] = [];
  for (const bookId of pending) {
    if (signal.aborted) break;
    const book = await getBook(bookId);
    if (!book || book.syncReadyAt) continue; // 书已删(墓碑另行同步),或早已传完。
    try {
      onProgress(`正在上传《${book.title}》…`);
      await uploadBookBody(bookId, book, signal);
      readyBooks.push({ ...book, syncReadyAt: Date.now() });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof SyncError && (error.status === 413 || error.status === 400)) {
        failedContent.push(bookId); // 超上限/内容无效的书不再重试,也永远不标 ready。
      } else {
        stillPending.push(bookId); // 网络类错误留下轮重试。
      }
    }
  }
  if (signal.aborted) throw new DOMException("同步已取消", "AbortError");

  if (readyBooks.length) {
    for (const book of readyBooks) await saveBook(book);
    // ready 标记随 meta 再推一次;updatedAt 不动,靠 bookPushTime 让服务端接受。
    onProgress("正在登记已上传的书籍…");
    tooLarge += await pushAll(
      {
        books: readyBooks.map((book) => {
          const { chapters: _chapters, ...meta } = book;
          return { key: book.id, data: JSON.stringify(toSyncBookMeta(meta)), updatedAt: bookPushTime(book) };
        }),
      },
      signal
    );
  }

  // 3. 分页 pull 远端增量,逐页合并。
  onProgress("正在拉取云端变更…");
  let changed = !!countPayload(payload);
  let cursor = state.pullCursor;
  const localMetaById = new Map((await getBookMetas()).map((meta) => [meta.id, meta]));
  const downloads = new Map<string, BookMeta>();
  for (;;) {
    const page = await request<SyncResponse>("pull", { since: cursor }, signal, 120_000);
    if (await applyPullPage(page, localMetaById, downloads, deps)) changed = true;
    const next = Number(page.cursor);
    if (!Number.isSafeInteger(next) || next < cursor) throw new SyncError("同步服务返回了无效的水位", 502);
    cursor = next;
    if (!page.hasMore) break;
    if (signal.aborted) throw new DOMException("同步已取消", "AbortError");
  }

  // 4. 下载缺失书籍(只有对端标记过 syncReadyAt 的)。
  for (const meta of downloads.values()) {
    if (signal.aborted) break;
    const downloaded = await downloadBook(meta, signal, onProgress);
    if (!downloaded) continue;
    await saveImportedBook(downloaded.book, downloaded.images);
    changed = true;
    deps.onApplied?.("books");
  }

  if (signal.aborted) throw new DOMException("同步已取消", "AbortError");

  // 5. 推进水位。已成功 push 的墓碑使命完成(生效或被服务端新值否决),清除;
  // 同步期间新增或改写的墓碑要从最新 state 里保住。
  const latest = await getSyncState();
  const settled = (pushed: Record<string, number>, current: Record<string, number>) =>
    Object.fromEntries(Object.entries(current).filter(([id, at]) => pushed[id] !== at));
  await saveSyncState({
    pushedAt: startedAt,
    pullCursor: cursor,
    tombstones: {
      books: settled(state.tombstones.books, latest.tombstones.books),
      notes: settled(state.tombstones.notes, latest.tombstones.notes),
    },
    pendingContent: stillPending,
  });

  return { syncedAt: startedAt, changed, failedContent, tooLarge };
}
