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
  commitSyncState,
  applySyncedNotes,
  mergeLegacyStats,
  removeBookIfOlder,
  saveBookMetaIfNewer,
  saveBookImages,
  saveBookMetadataIfNewer,
  saveChat,
  saveImportedBookIfMissing,
  saveReadingPositions,
  saveSessionsIfNewer,
  saveSettingsIfNewer,
  updateBookMeta,
  updateListeningIfNewer,
  type SyncState,
  type SyncPushKind,
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
  mergeChatTurns,
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
 * 3:为被服务端逐条拒收的数据保留重试队列，并重试下载失败的插图。
 */
export const SYNC_SCHEMA = 3;

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
  const pending = (kind: SyncPushKind) => new Set(state.pendingPush[kind] ?? []);
  const payload: PushPayload = {};

  // 内置示例书每台设备书库为空时各生成一本、编号随机,同步出去只会越积越多。
  // 它本身和挂在它上面的划线、位置、对话都只留在本机。
  const metas = await getBookMetas();
  const localOnly = new Set(metas.filter((meta) => meta.format === "demo").map((meta) => meta.id));

  const books: PushItem[] = [];
  const retryBooks = pending("books");
  for (const [id, deletedAt] of Object.entries(state.tombstones.books)) {
    books.push({ key: id, data: "", updatedAt: deletedAt, deletedAt });
  }
  for (const meta of metas) {
    if (localOnly.has(meta.id) || (bookPushTime(meta) <= since && !retryBooks.has(meta.id))) continue;
    books.push({ key: meta.id, data: JSON.stringify(toSyncBookMeta(meta)), updatedAt: bookPushTime(meta) });
  }
  if (books.length) payload.books = books;

  const listening: PushItem[] = [];
  const retryListening = pending("listening");
  for (const meta of metas) {
    const position = meta.listeningPosition;
    if (localOnly.has(meta.id) || !position) continue;
    const updatedAt = Math.floor(position.updatedAt);
    if (!(updatedAt > since) && !retryListening.has(meta.id)) continue;
    listening.push({ key: meta.id, data: JSON.stringify(position), updatedAt });
  }
  if (listening.length) payload.listening = listening;

  const notes: PushItem[] = [];
  const retryNotes = pending("notes");
  for (const [id, deletedAt] of Object.entries(state.tombstones.notes)) {
    notes.push({ key: id, data: "", updatedAt: deletedAt, deletedAt });
  }
  for (const note of await getAllNotes()) {
    const updatedAt = note.updatedAt ?? note.createdAt;
    if (localOnly.has(note.bookId) || (updatedAt <= since && !retryNotes.has(note.id))) continue;
    notes.push({ key: note.id, data: JSON.stringify(note), updatedAt, bookId: note.bookId });
  }
  if (notes.length) payload.notes = notes;

  const positions: PushItem[] = [];
  const retryPositions = pending("positions");
  for (const entry of await getAllReadingPositions()) {
    if (localOnly.has(entry.bookId) || (entry.savedAt <= since && !retryPositions.has(entry.bookId))) continue;
    positions.push({
      key: entry.bookId,
      data: JSON.stringify({ position: entry.position, lastOpenedAt: entry.lastOpenedAt, savedAt: entry.savedAt }),
      updatedAt: entry.savedAt,
    });
  }
  if (positions.length) payload.positions = positions;

  const sessions: PushItem[] = [];
  const retrySessions = pending("sessions");
  for (const session of await getAllSessions()) {
    if (session.endedAt <= since && !retrySessions.has(session.id)) continue;
    sessions.push({ key: session.id, data: JSON.stringify(session), updatedAt: session.endedAt });
  }
  if (sessions.length) payload.sessions = sessions;

  const settings: PushItem[] = [];
  const retrySettings = pending("settings");
  const settingsMtime = await getSettingsMtime();
  if (settingsMtime > since || retrySettings.has("reader")) {
    settings.push({ key: "reader", data: JSON.stringify(await getSettings()), updatedAt: settingsMtime });
  }
  // 早期阅读统计不再增长,只需要在整体补传时带一次;各设备按天取大合并。
  if (since === 0 || retrySettings.has(LEGACY_STATS_KEY)) {
    const stats = await getLegacyStats();
    if (stats) settings.push({ key: LEGACY_STATS_KEY, data: JSON.stringify(stats), updatedAt: 1 });
  }
  if (settings.length) payload.settings = settings;

  const chats: PushItem[] = [];
  const retryChats = pending("chats");
  for (const chat of await getAllChats()) {
    if (localOnly.has(chat.bookId) || (chat.updatedAt <= since && !retryChats.has(chat.bookId))) continue;
    chats.push({ key: chat.bookId, data: JSON.stringify(chat), updatedAt: chat.updatedAt });
  }
  if (chats.length) payload.chats = chats;

  const patches: PushItem[] = [];
  const retryPatches = pending("patches");
  for (const patch of await getAllBookMetadata()) {
    if (localOnly.has(patch.bookId) || (patch.fetchedAt <= since && !retryPatches.has(patch.bookId))) continue;
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
  const response = await fetchWithTimeout(
    imagePath(bookId, imageId),
    { credentials: "same-origin", cache: "no-store", signal },
    120_000
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await readError(response);
  return response.blob();
}

/** 下载一本书:正文 + 封面 + 插图。封面/插图缺失跳过,阅读器显示占位。 */
async function downloadBook(
  meta: BookMeta,
  signal: AbortSignal,
  onProgress: (label: string) => void
): Promise<{ book: Book; images: BookImage[]; pendingImages: string[] } | null> {
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
  const pendingImages: string[] = [];
  await forEachLimit(wanted, IMAGE_CONCURRENCY, async (imageId) => {
    try {
      const blob = await downloadImage(meta.id, imageId, signal);
      if (blob) blobs.set(imageId, blob);
    } catch (error) {
      if (signal.aborted) throw error;
      pendingImages.push(imageId);
    }
  });

  const coverBlob = blobs.get(COVER_IMAGE_ID);
  const coverDataUrl = coverBlob ? await blobToDataUrl(coverBlob) : undefined;
  const images: BookImage[] = [];
  for (const imageId of wanted.slice(1)) {
    const blob = blobs.get(imageId);
    if (blob) images.push({ id: imageId, bookId: meta.id, blob });
  }
  return { book: { ...meta, ...(coverDataUrl ? { coverDataUrl } : {}), chapters }, images, pendingImages };
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
  | "books" | "notes" | "positions" | "sessions" | "settings" | "chats" | "patches" | "images";

export interface SyncDeps {
  signal: AbortSignal;
  onProgress?: (label: string) => void;
  /** 云端记录落库后通知 UI 重读本地数据。 */
  onApplied?: (kind: SyncAppliedKind) => void;
}

interface PushResult {
  skipped: number;
  rejected: Partial<Record<SyncPushKind, string[]>>;
}

async function pushAll(payload: PushPayload, signal: AbortSignal): Promise<PushResult> {
  let skipped = 0;
  const rejected: Partial<Record<SyncPushKind, string[]>> = {};
  for (const batch of splitPayload(payload)) {
    if (!countPayload(batch)) continue;
    const response = await request<{ tooLarge?: Record<string, string[]>; rejected?: Record<string, string[]> }>(
      "push",
      batch,
      signal,
      120_000
    );
    for (const groups of [response.tooLarge, response.rejected]) {
      for (const [table, keys] of Object.entries(groups ?? {})) {
        skipped += keys.length;
        const pushKind = table as SyncPushKind;
        (rejected[pushKind] ??= []).push(...keys);
      }
    }
    if (response.tooLarge && Object.keys(response.tooLarge).length) console.warn("sync_push_too_large", response.tooLarge);
    if (response.rejected && Object.keys(response.rejected).length) console.warn("sync_push_rejected", response.rejected);
  }
  for (const [kind, keys] of Object.entries(rejected) as Array<[SyncPushKind, string[]]>) {
    rejected[kind] = [...new Set(keys)];
  }
  return { skipped, rejected };
}

/** 跨页攒起来、等全部页拉完再处理的东西。 */
interface PullAccumulator {
  /** 待下载正文的新书。 */
  downloads: Map<string, BookMeta>;
  /** 本轮见到的删书墓碑:拉完后按书清掉划线、位置、对话,不留孤儿。 */
  deadBooks: Map<string, number>;
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
      const previous = acc.deadBooks.get(record.key) ?? 0;
      acc.deadBooks.set(record.key, Math.max(previous, record.updatedAt));
      acc.downloads.delete(record.key);
    } else {
      acc.deadBooks.delete(record.key);
    }
    const action = mergeBookMeta(localMetaById.get(record.key), record);
    if (action.op === "delete") {
      // 删除留到分页结束后再做：届时在一个 IndexedDB 事务里确认没有较新的本地书目。
    } else if (action.op === "write") {
      const local = await getBookMeta(record.key);
      if (local) {
        const freshAction = mergeBookMeta(local, record);
        if (freshAction.op === "keep") {
          localMetaById.set(record.key, local);
          continue;
        }
        if (freshAction.op === "delete") {
          acc.deadBooks.set(record.key, Math.max(acc.deadBooks.get(record.key) ?? 0, record.updatedAt));
          continue;
        }
        // 目录和两个位置都不跟远端 meta 走:目录是本机从正文算的,位置各有各的通道。
        const merged: BookMeta = {
          ...local,
          ...freshAction.value,
          chapterOutline: local.chapterOutline,
          readingPosition: local.readingPosition,
          listeningPosition: local.listeningPosition,
        };
        const saved = await saveBookMetaIfNewer(merged);
        const latest = saved ?? await getBookMeta(record.key);
        if (latest) localMetaById.set(record.key, latest);
        if (saved) {
          changed = true;
          deps.onApplied?.("books");
        }
      } else {
        acc.downloads.set(record.key, action.value);
      }
    } else {
      // 本地列表快照之后可能删过书；重新查一次，必要时恢复可完整下载的远端版本。
      const local = await getBookMeta(record.key);
      if (local) localMetaById.set(record.key, local);
      else if ((record.data as BookMeta | undefined)?.syncReadyAt) {
        acc.downloads.set(record.key, record.data as BookMeta);
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
    const noteDeletes: Array<{ id: string; deletedAt: number }> = [];
    for (const record of page.notes) {
      const action = mergeNote(localNotes.get(record.key), record);
      if (action.op === "write") noteWrites.push(action.value);
      else if (action.op === "delete") noteDeletes.push({ id: record.key, deletedAt: record.deletedAt ?? record.updatedAt });
    }
    if (noteWrites.length || noteDeletes.length) {
      if (await applySyncedNotes(noteWrites, noteDeletes)) {
        changed = true;
        deps.onApplied?.("notes");
      }
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
    } else if (record.key === "reader") {
      if (await saveSettingsIfNewer(record.data as ReaderSettings, record.updatedAt)) {
        changed = true;
        deps.onApplied?.("settings");
      }
    }
  }

  if (page.chats?.length) {
    const localChats = new Map((await getAllChats()).map((chat) => [chat.bookId, chat]));
    let wrote = false;
    for (const record of page.chats) {
      if (!record.data) continue;
      const remote = record.data as BookAiChat;
      const local = localChats.get(record.key);
      if (!local) {
        await saveChat(remote);
        localChats.set(record.key, remote);
        wrote = true;
        continue;
      }
      const turns = mergeChatTurns(local.turns ?? [], remote.turns ?? []);
      const turnsChanged = JSON.stringify(turns) !== JSON.stringify(local.turns);
      const remoteNewer = remote.updatedAt > local.updatedAt;
      if (!turnsChanged && !remoteNewer) continue;
      // 新合并出来的分支用新的本机时间戳推回服务端，下一轮让其他设备也拿到并集。
      const merged: BookAiChat = {
        bookId: record.key,
        turns,
        updatedAt: turnsChanged ? Math.max(Date.now(), local.updatedAt, remote.updatedAt) : remote.updatedAt,
      };
      await saveChat(merged);
      localChats.set(record.key, merged);
      wrote = true;
    }
    if (wrote) {
      changed = true;
      deps.onApplied?.("chats");
    }
  }

  if (page.patches?.length) {
    let wrote = false;
    for (const record of page.patches) {
      if (!record.data) continue;
      const remote = record.data as BookMetadataPatch;
      if (await saveBookMetadataIfNewer(remote)) wrote = true;
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
  const rejectedPush: Partial<Record<SyncPushKind, string[]>> = {};
  const recordPushResult = (result: PushResult) => {
    skipped += result.skipped;
    for (const [kind, keys] of Object.entries(result.rejected) as Array<[SyncPushKind, string[]]>) {
      (rejectedPush[kind] ??= []).push(...keys);
    }
  };
  if (countPayload(payload)) {
    onProgress("正在上传本地记录…");
    recordPushResult(await pushAll(payload, signal));
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
      recordPushResult(await pushAll(
        { books: [{ key: bookId, data: JSON.stringify(toSyncBookMeta(ready)), updatedAt: bookPushTime(ready) }] },
        signal
      ));
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
  const acc: PullAccumulator = { downloads: new Map(), deadBooks: new Map(), listening: new Map() };
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
  const pendingImages = new Map(
    state.pendingImages.map((entry) => [`${entry.bookId}\u0000${entry.imageId}`, entry] as const)
  );
  const refreshedBooks = new Set<string>();
  for (const meta of acc.downloads.values()) {
    if (signal.aborted) break;
    const downloaded = await downloadBook(meta, signal, onProgress);
    if (!downloaded) continue;
    const imported = await saveImportedBookIfMissing(downloaded.book, downloaded.images);
    if (!imported) {
      const current = await getBookMeta(meta.id);
      if (current) localMetaById.set(meta.id, current);
      continue;
    }
    refreshedBooks.add(meta.id);
    for (const [key, entry] of pendingImages) if (entry.bookId === meta.id) pendingImages.delete(key);
    for (const imageId of downloaded.pendingImages) {
      const entry = { bookId: meta.id, imageId };
      pendingImages.set(`${meta.id}\u0000${imageId}`, entry);
    }
    const { chapters: _chapters, ...savedMeta } = downloaded.book;
    localMetaById.set(meta.id, savedMeta);
    changed = true;
    deps.onApplied?.("books");
  }
  if (signal.aborted) throw new DOMException("同步已取消", "AbortError");

  // 5. 失败的单张插图单独重试；404 表示源端没有该图片，其余失败保留到下轮。
  const recoveredImages: BookImage[] = [];
  for (const [key, entry] of pendingImages) {
    if (refreshedBooks.has(entry.bookId)) continue;
    if (signal.aborted) throw new DOMException("同步已取消", "AbortError");
    const meta = await getBookMeta(entry.bookId);
    if (!meta) {
      pendingImages.delete(key);
      continue;
    }
    try {
      const existing = await getBookImage(entry.imageId);
      if (existing) {
        pendingImages.delete(key);
        continue;
      }
      const blob = await downloadImage(entry.bookId, entry.imageId, signal);
      pendingImages.delete(key);
      if (blob) recoveredImages.push({ id: entry.imageId, bookId: entry.bookId, blob });
    } catch (error) {
      if (signal.aborted) throw error;
      // 短暂网络/服务端错误下轮重试。
    }
  }
  if (recoveredImages.length) {
    await saveBookImages(recoveredImages);
    for (const image of recoveredImages) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("moting:image-updated", { detail: { imageId: image.id } }));
      }
    }
    changed = true;
    deps.onApplied?.("images");
  }

  // 6. 听书进度:远端比本地新才写。不动书的 updatedAt,免得这本书的 meta 下一轮又被推回去。
  for (const [bookId, position] of acc.listening) {
    if (acc.deadBooks.has(bookId)) continue;
    const updated = await updateListeningIfNewer(bookId, position);
    if (!updated) continue;
    localMetaById.set(bookId, updated);
    changed = true;
    deps.onApplied?.("books");
  }

  // 7. 删书连带清理:划线、位置、对话、资料补丁可能排在墓碑后面的页里才落地,
  // 全新设备还可能从没见过这本书,只收到了它的划线。拉完再按书清一遍。
  for (const [bookId, deletedAt] of acc.deadBooks) {
    const removed = await removeBookIfOlder(bookId, deletedAt);
    const local = await getBookMeta(bookId);
    if (local) localMetaById.set(bookId, local);
    else localMetaById.delete(bookId);
    if (removed) changed = true;
    // 删书会一并清理相关记录，内存中的笔记/聊天/位置也要同步重读。
    deps.onApplied?.("books");
    deps.onApplied?.("notes");
    deps.onApplied?.("positions");
    deps.onApplied?.("chats");
    deps.onApplied?.("patches");
  }

  // 8. 推进水位。已成功 push 的墓碑使命完成(生效或被服务端新值否决),清除;
  // 同步期间新增或改写的墓碑要从最新 state 里保住。
  const retryPush = Object.fromEntries(
    Object.entries(rejectedPush).map(([kind, keys]) => [kind, [...new Set(keys)]])
  ) as Partial<Record<SyncPushKind, string[]>>;
  await commitSyncState({
    schema: SYNC_SCHEMA,
    pushedAt: startedAt,
    pullCursor: cursor,
    tombstones: state.tombstones,
    pendingContent: stillPending,
    pendingImages: [...pendingImages.values()],
    pendingPush: retryPush,
  }, state, { books: rejectedPush.books, notes: rejectedPush.notes });

  return { syncedAt: startedAt, changed, failedContent, skipped };
}
