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
  getBookMeta,
  getBookMetas,
  getLegacyStats,
  getSettings,
  getSettingsMtime,
  getSyncState,
  mergeLegacyStats,
  removeBook,
  saveBookMeta,
  saveBookMetadata,
  saveChat,
  saveImportedBook,
  saveReadingPositions,
  saveSessionsIfNewer,
  saveSettings,
  saveSyncState,
  updateBookMeta,
  writeNotes,
  type SyncState,
} from "./storage";
import type { BookImage } from "./types";
import type { BookMetadataPatch } from "./book-metadata-types";
import type {
  Book,
  BookAiChat,
  BookMeta,
  BookNote,
  BookPosition,
  Chapter,
  ReaderSettings,
  ReadingSession,
  ReadingStats,
} from "./types";
import {
  bookPushTime,
  COVER_IMAGE_ID,
  countPayload,
  forEachLimit,
  mergeBookMeta,
  mergeNote,
  mergePosition,
  newerListening,
  splitPayload,
  toSyncBookMeta,
  toSyncPatch,
  type PushItem,
  type PushPayload,
  type SyncRecord,
} from "./sync-merge";

/**
 * 客户端同步数据的版本。新增同步类别时加一:按旧版本同步过的设备,
 * 它的 pushedAt 已经越过了那些旧记录的修改时间,不整体补传一轮就永远传不上去。
 * 2:补上旧设置(没有 mtime)、早期阅读统计、听书进度。
 */
export const SYNC_SCHEMA = 2;

/** 插图/封面同时在路上的请求数。 */
const IMAGE_CONCURRENCY = 4;

/** 早期阅读统计在 settings 表里的键;它是只读的历史基数,固定用最旧的时间戳。 */
const LEGACY_STATS_KEY = "stats";

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
  listening?: SyncRecord[];
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
// since 是本机时钟(state.pushedAt),跟记录自己的修改时间同一把尺子;
// 数据版本落后时从 0 开始,整体补传一轮(服务端 LWW 会把没变的挡掉)。

export async function collectPushPayload(state: SyncState): Promise<PushPayload> {
  const since = state.schema === SYNC_SCHEMA ? state.pushedAt : 0;
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

  const listening: PushItem[] = [];
  for (const meta of metas) {
    const position = meta.listeningPosition;
    if (localOnly.has(meta.id) || !position) continue;
    const updatedAt = Math.floor(position.updatedAt);
    if (!(updatedAt > since)) continue;
    listening.push({ key: meta.id, data: JSON.stringify(position), updatedAt });
  }
  if (listening.length) payload.listening = listening;

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

  const settings: PushItem[] = [];
  const settingsMtime = await getSettingsMtime();
  if (settingsMtime > since) {
    settings.push({ key: "reader", data: JSON.stringify(await getSettings()), updatedAt: settingsMtime });
  }
  // 早期阅读统计不再增长,只需要在整体补传时带一次;各设备按天取大合并。
  if (since === 0) {
    const stats = await getLegacyStats();
    if (stats) settings.push({ key: LEGACY_STATS_KEY, data: JSON.stringify(stats), updatedAt: 1 });
  }
  if (settings.length) payload.settings = settings;

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

function contentPath(bookId: string): string {
  return `/api/sync/book/${encodeURIComponent(bookId)}/content`;
}

function imagePath(bookId: string, imageId: string): string {
  return `/api/sync/book/${encodeURIComponent(bookId)}/images/${encodeURIComponent(imageId)}`;
}

/** 云端是否已有这个对象。续传时先问一声,省得把几 MB 的正文再发一遍才收到 409。 */
async function existsInCloud(path: string, signal: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await fetchWithTimeout(path, { method: "HEAD", credentials: "same-origin", cache: "no-store", signal }, 30_000);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SyncError("连接超时或网络不可用,稍后会自动重试", 503);
  }
  if (response.status === 404) return false;
  if (!response.ok) throw new SyncError(`同步服务返回 ${response.status}`, response.status);
  return true;
}

async function uploadImage(
  bookId: string,
  imageId: string,
  blob: Blob,
  signal: AbortSignal,
  resuming: boolean
): Promise<void> {
  const path = imagePath(bookId, imageId);
  if (resuming && (await existsInCloud(path, signal))) return;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      path,
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
  // 正文已在云端 = 上次传到一半被打断(App 被杀、断网)。那就只补缺的插图。
  const resuming = await existsInCloud(contentPath(bookId), signal);
  if (!resuming) {
    let response: Response;
    try {
      response = await fetchWithTimeout(contentPath(bookId), {
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
    // 409 = 另一台设备刚好抢先传完,当作成功继续插图。
    if (!response.ok && response.status !== 409) throw await readError(response);
  }

  // 封面不进 D1 的 meta(见 toSyncBookMeta),随正文一起放 R2。
  const uploads: Array<{ id: string; load: () => Promise<Blob | null> }> = [];
  if (book.coverDataUrl) {
    const cover = book.coverDataUrl;
    uploads.push({ id: COVER_IMAGE_ID, load: async () => dataUrlToBlob(cover) });
  }
  for (const imageId of collectImageIds(book.chapters)) {
    uploads.push({ id: imageId, load: async () => (await getBookImage(imageId))?.blob ?? null });
  }
  await forEachLimit(uploads, IMAGE_CONCURRENCY, async ({ id, load }) => {
    const blob = await load();
    if (blob) await uploadImage(bookId, id, blob, signal, resuming);
  });
}

async function downloadImage(bookId: string, imageId: string, signal: AbortSignal): Promise<Blob | null> {
  try {
    const response = await fetchWithTimeout(imagePath(bookId, imageId), { credentials: "same-origin", cache: "no-store", signal }, 120_000);
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
    response = await fetchWithTimeout(contentPath(meta.id), { credentials: "same-origin", cache: "no-store", signal }, 300_000);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SyncError("正文下载中断,请稍后重试", 503);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw await readError(response);
  const chapters = (await response.json()) as Chapter[];
  if (!Array.isArray(chapters) || !chapters.length) throw new SyncError(`《${meta.title}》的云端正文无效`, 502);

  const wanted = [COVER_IMAGE_ID, ...collectImageIds(chapters)];
  const blobs = new Map<string, Blob>();
  await forEachLimit(wanted, IMAGE_CONCURRENCY, async (imageId) => {
    const blob = await downloadImage(meta.id, imageId, signal);
    if (blob) blobs.set(imageId, blob);
  });

  const coverBlob = blobs.get(COVER_IMAGE_ID);
  const coverDataUrl = coverBlob ? await blobToDataUrl(coverBlob) : undefined;
  const images: BookImage[] = [];
  for (const imageId of wanted.slice(1)) {
    const blob = blobs.get(imageId);
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
  /** 被服务端跳过的记录数(单条超过上限,或数据异常);调用方应提示用户。 */
  skipped: number;
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
  let skipped = 0;
  for (const batch of splitPayload(payload)) {
    if (!countPayload(batch)) continue;
    const response = await request<{ tooLarge?: Record<string, string[]>; rejected?: Record<string, string[]> }>(
      "push",
      batch,
      signal,
      120_000
    );
    for (const keys of Object.values(response.tooLarge ?? {})) skipped += keys.length;
    for (const keys of Object.values(response.rejected ?? {})) skipped += keys.length;
    if (response.tooLarge && Object.keys(response.tooLarge).length) console.warn("sync_push_too_large", response.tooLarge);
    if (response.rejected && Object.keys(response.rejected).length) console.warn("sync_push_rejected", response.rejected);
  }
  return skipped;
}

/** 跨页攒起来、等全部页拉完再处理的东西。 */
interface PullAccumulator {
  /** 待下载正文的新书。 */
  downloads: Map<string, BookMeta>;
  /** 本轮见到的删书墓碑:拉完后按书清掉划线、位置、对话,不留孤儿。 */
  deadBooks: Set<string>;
  /** 听书进度;书可能在后面的页甚至本轮下载后才落地,所以最后统一套。 */
  listening: Map<string, BookPosition>;
}

/** 把一页 pull 结果逐条合并进本地。 */
async function applyPullPage(
  page: SyncResponse,
  localMetaById: Map<string, BookMeta>,
  acc: PullAccumulator,
  deps: SyncDeps
): Promise<boolean> {
  let changed = false;

  for (const record of page.books ?? []) {
    if (record.deletedAt) {
      acc.deadBooks.add(record.key);
      acc.downloads.delete(record.key);
    } else {
      acc.deadBooks.delete(record.key);
    }
    const action = mergeBookMeta(localMetaById.get(record.key), record);
    if (action.op === "delete") {
      await removeBook(record.key, { tombstone: false });
      localMetaById.delete(record.key);
      changed = true;
      deps.onApplied?.("books");
    } else if (action.op === "write") {
      const local = localMetaById.has(record.key) ? await getBookMeta(record.key) : undefined;
      if (local) {
        // 目录和两个位置都不跟远端 meta 走:目录是本机从正文算的,位置各有各的通道。
        const merged: BookMeta = {
          ...local,
          ...action.value,
          chapterOutline: local.chapterOutline,
          readingPosition: local.readingPosition,
          listeningPosition: local.listeningPosition,
        };
        await saveBookMeta(merged);
        localMetaById.set(record.key, merged);
        changed = true;
        deps.onApplied?.("books");
      } else {
        acc.downloads.set(record.key, action.value);
      }
    }
  }

  for (const record of page.listening ?? []) {
    const position = record.data as BookPosition | undefined;
    const newer = newerListening(acc.listening.get(record.key), position);
    if (newer) acc.listening.set(record.key, newer);
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
    const incoming = page.sessions.filter((record) => record.data).map((record) => record.data as ReadingSession);
    // 本机刚推上去的记录会原样拉回来一遍,只有真写进去的才算变化。
    if (await saveSessionsIfNewer(incoming)) {
      changed = true;
      deps.onApplied?.("sessions");
    }
  }

  for (const record of page.settings ?? []) {
    if (!record.data) continue;
    if (record.key === LEGACY_STATS_KEY) {
      if (await mergeLegacyStats(record.data as ReadingStats)) {
        changed = true;
        deps.onApplied?.("sessions");
      }
    } else if (record.key === "reader" && record.updatedAt > (await getSettingsMtime())) {
      await saveSettings(record.data as ReaderSettings, record.updatedAt);
      changed = true;
      deps.onApplied?.("settings");
    }
  }

  if (page.chats?.length) {
    const localChats = new Map((await getAllChats()).map((chat) => [chat.bookId, chat.updatedAt]));
    let wrote = false;
    for (const record of page.chats) {
      if (!record.data) continue;
      const remote = record.data as BookAiChat;
      if (!localChats.has(record.key) || remote.updatedAt > (localChats.get(record.key) ?? 0)) {
        await saveChat(remote);
        wrote = true;
      }
    }
    if (wrote) {
      changed = true;
      deps.onApplied?.("chats");
    }
  }

  if (page.patches?.length) {
    const localPatches = new Map((await getAllBookMetadata()).map((patch) => [patch.bookId, patch.fetchedAt]));
    let wrote = false;
    for (const record of page.patches) {
      if (!record.data) continue;
      const remote = record.data as BookMetadataPatch;
      if (!localPatches.has(record.key) || remote.fetchedAt > (localPatches.get(record.key) ?? 0)) {
        await saveBookMetadata(remote);
        wrote = true;
      }
    }
    if (wrote) {
      changed = true;
      deps.onApplied?.("patches");
    }
  }

  return changed;
}

/**
 * 一轮同步 = push 脏记录 → 逐本上传待传正文、传完一本立刻标 ready → 分页 pull 增量逐条 LWW 合并 →
 * 下载缺失书籍 → 套听书进度、清删书孤儿 → 推进两个水位并清掉已确认的墓碑。
 * 任何一步抛错整轮中止,水位不动;重跑时重复的 push/pull 都是幂等的。
 */
export async function runSync(deps: SyncDeps): Promise<SyncRunResult> {
  const { signal, onProgress = () => {} } = deps;
  const state = await getSyncState();
  // 先记时刻再收集:收集期间新改的记录修改时间 ≥ 这个值,下一轮一定还会被捡到。
  const startedAt = Date.now();

  // 1. push 本地脏记录。
  const payload = await collectPushPayload(state);
  const pushedBookIds = new Set((payload.books ?? []).filter((item) => !item.deletedAt).map((item) => item.key));
  let skipped = 0;
  if (countPayload(payload)) {
    onProgress("正在上传本地记录…");
    skipped += await pushAll(payload, signal);
  }

  // 2. 上传待传正文(meta 已 push 但还没标 ready 的书 + 之前没传完的)。
  // 传完一本就标一本:中途被系统杀掉,下次只会从没传完的那本接着来。
  const pending = [...new Set([...state.pendingContent, ...pushedBookIds])];
  const failedContent: string[] = [];
  const stillPending: string[] = [];
  for (const bookId of pending) {
    if (signal.aborted) break;
    const meta = await getBookMeta(bookId);
    if (!meta || meta.syncReadyAt) continue; // 书已删(墓碑另行同步),或早已传完。
    try {
      onProgress(`正在上传《${meta.title}》…`);
      const book = await getBook(bookId);
      if (!book) continue;
      await uploadBookBody(bookId, book, signal);
      // 只改这一个字段:上传期间这本书可能又被写过(听书进度每 20 秒落一次盘)。
      const ready = await updateBookMeta(bookId, { syncReadyAt: Date.now() });
      if (!ready) continue;
      skipped += await pushAll(
        { books: [{ key: bookId, data: JSON.stringify(toSyncBookMeta(ready)), updatedAt: bookPushTime(ready) }] },
        signal
      );
      deps.onApplied?.("books");
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

  // 3. 分页 pull 远端增量,逐页合并。
  onProgress("正在拉取云端变更…");
  let changed = !!countPayload(payload);
  let cursor = state.pullCursor;
  const localMetaById = new Map((await getBookMetas()).map((meta) => [meta.id, meta]));
  const acc: PullAccumulator = { downloads: new Map(), deadBooks: new Set(), listening: new Map() };
  for (;;) {
    const page = await request<SyncResponse>("pull", { since: cursor }, signal, 120_000);
    if (await applyPullPage(page, localMetaById, acc, deps)) changed = true;
    const next = Number(page.cursor);
    if (!Number.isSafeInteger(next) || next < cursor) throw new SyncError("同步服务返回了无效的水位", 502);
    cursor = next;
    if (!page.hasMore) break;
    if (signal.aborted) throw new DOMException("同步已取消", "AbortError");
  }

  // 4. 下载缺失书籍(只有对端标记过 syncReadyAt 的)。
  for (const meta of acc.downloads.values()) {
    if (signal.aborted) break;
    const downloaded = await downloadBook(meta, signal, onProgress);
    if (!downloaded) continue;
    await saveImportedBook(downloaded.book, downloaded.images);
    const { chapters: _chapters, ...savedMeta } = downloaded.book;
    localMetaById.set(meta.id, savedMeta);
    changed = true;
    deps.onApplied?.("books");
  }
  if (signal.aborted) throw new DOMException("同步已取消", "AbortError");

  // 5. 听书进度:远端比本地新才写。不动书的 updatedAt,免得这本书的 meta 下一轮又被推回去。
  for (const [bookId, position] of acc.listening) {
    if (acc.deadBooks.has(bookId)) continue;
    const meta = localMetaById.get(bookId);
    if (!meta || !newerListening(meta.listeningPosition, position)) continue;
    const latest = await getBookMeta(bookId);
    if (!latest || !newerListening(latest.listeningPosition, position)) continue;
    await updateBookMeta(bookId, { listeningPosition: position });
    changed = true;
    deps.onApplied?.("books");
  }

  // 6. 删书连带清理:划线、位置、对话、资料补丁可能排在墓碑后面的页里才落地,
  // 全新设备还可能从没见过这本书,只收到了它的划线。拉完再按书清一遍。
  for (const bookId of acc.deadBooks) {
    if (localMetaById.has(bookId)) continue;
    await removeBook(bookId, { tombstone: false });
  }

  // 7. 推进水位。已成功 push 的墓碑使命完成(生效或被服务端新值否决),清除;
  // 同步期间新增或改写的墓碑要从最新 state 里保住。
  const latest = await getSyncState();
  const settled = (pushed: Record<string, number>, current: Record<string, number>) =>
    Object.fromEntries(Object.entries(current).filter(([id, at]) => pushed[id] !== at));
  await saveSyncState({
    schema: SYNC_SCHEMA,
    pushedAt: startedAt,
    pullCursor: cursor,
    tombstones: {
      books: settled(state.tombstones.books, latest.tombstones.books),
      notes: settled(state.tombstones.notes, latest.tombstones.notes),
    },
    pendingContent: stillPending,
  });

  return { syncedAt: startedAt, changed, failedContent, skipped };
}
