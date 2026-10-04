import { INLINE_RECORD_BYTES, MAX_RECORD_BYTES, RECORD_PROTOCOL, recordHash, recordPath, utf8Bytes,
  retryDelay, retryableStatus, isRecordBlob, type PushFailure, type RecordIssue, type RecordReceipt } from "./sync-record";
// 云端同步客户端:收集本地脏记录 push、拉取远端增量按记录级 LWW 合并、
// 按 syncReadyAt 下载完整正文。绝不整库覆盖——每条记录单独比时间,新者胜。
import { recoverPendingImage } from "./sync-images";
import { fetchWithTimeout } from "./fetch-utils";
import type { ProgressReceipt, ProgressRecord } from "./sync-progress";
import {
  getAllBookMetadata,
  getAllChats,
  getAllNotes,
  getAllSessions,
  getBook,
  getBookImage,
  getBookMeta,
  getBookMetas,
  getLegacyStats,
  getSettings,
  getSettingsMtime,
  getSyncState,
  getProgressQueue,
  applyProgressReceipt,
  rejectProgress,
  applySyncedProgress,
  commitProgressCursor,
  commitSyncState,
  applySyncedNotes,
  mergeLegacyStats,
  removeBookIfOlder,
  saveBookMetaIfNewer,
  saveRecoveredCover,
  saveRecoveredImage,
  saveBookMetadataIfNewer,
  saveChat,
  saveImportedBookIfMissing,
  saveSessionsIfNewer,
  saveSettingsIfNewer,
  updateBookMeta,
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
 * 5:大记录 R2 引用与普通记录确认；旧失败队列补传，异常版本保留诊断和退避状态。
 */
export const SYNC_SCHEMA = 5;

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
  receipts?: ProgressReceipt[];
  recordReceipts?: RecordReceipt[];
  issues?: RecordIssue[];
}

/** keepalive 请求体的上限（浏览器规定同时在路上的 keepalive 请求合计不超过 64 KB，留点余量）。 */
const KEEPALIVE_MAX_BYTES = 60_000;

async function request<T extends object>(
  path: string,
  body: object | null,
  signal: AbortSignal,
  timeoutMs = 60_000,
  keepalive = false
): Promise<T & SyncResponse> {
  const text = body === null ? undefined : JSON.stringify(body);
  let response: Response;
  try {
    response = await fetchWithTimeout(`/api/sync/${path}`, {
      method: body === null ? "GET" : "POST",
      headers: body === null ? undefined : { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: text,
      // 超过上限的请求带 keepalive 会被浏览器直接拒掉，那就只能按普通请求发。
      keepalive:
        keepalive && !!text && new TextEncoder().encode(text).length <= KEEPALIVE_MAX_BYTES,
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

export async function collectPushPayload(state: SyncState, manual = false, presentKeys?: Set<string>): Promise<PushPayload> {
  const since = state.schema === SYNC_SCHEMA ? state.pushedAt : 0;
  const pending = (kind: SyncPushKind) => new Set([...(state.pendingPush[kind] ?? []),
    ...(state.pushFailures ?? []).filter((failure) => failure.kind === kind).map((failure) => failure.key)]);
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
    if (localOnly.has(meta.id) || (bookPushTime(meta) < since && !retryBooks.has(meta.id))) continue;
    books.push({ key: meta.id, data: JSON.stringify(toSyncBookMeta(meta)), updatedAt: bookPushTime(meta) });
  }
  if (books.length) payload.books = books;

  Object.assign(payload, await collectProgressPayload());

  const notes: PushItem[] = [];
  const retryNotes = pending("notes");
  for (const [id, deletedAt] of Object.entries(state.tombstones.notes)) {
    notes.push({ key: id, data: "", updatedAt: deletedAt, deletedAt });
  }
  for (const note of await getAllNotes()) {
    const updatedAt = note.updatedAt ?? note.createdAt;
    if (localOnly.has(note.bookId) || (updatedAt < since && !retryNotes.has(note.id))) continue;
    notes.push({ key: note.id, data: JSON.stringify(note), updatedAt, bookId: note.bookId });
  }
  if (notes.length) payload.notes = notes;


  const sessions: PushItem[] = [];
  const retrySessions = pending("sessions");
  for (const session of await getAllSessions()) {
    if (session.endedAt < since && !retrySessions.has(session.id)) continue;
    sessions.push({ key: session.id, data: JSON.stringify(session), updatedAt: session.endedAt });
  }
  if (sessions.length) payload.sessions = sessions;

  const settings: PushItem[] = [];
  const retrySettings = pending("settings");
  const settingsMtime = await getSettingsMtime();
  if ((settingsMtime > 0 && settingsMtime >= since) || retrySettings.has("reader")) {
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
    if (localOnly.has(chat.bookId) || (chat.updatedAt < since && !retryChats.has(chat.bookId))) continue;
    chats.push({ key: chat.bookId, data: JSON.stringify(chat), updatedAt: chat.updatedAt });
  }
  if (chats.length) payload.chats = chats;

  const patches: PushItem[] = [];
  const retryPatches = pending("patches");
  for (const patch of await getAllBookMetadata()) {
    if (localOnly.has(patch.bookId) || (patch.fetchedAt < since && !retryPatches.has(patch.bookId))) continue;
    patches.push({ key: patch.bookId, data: JSON.stringify(toSyncPatch(patch)), updatedAt: patch.fetchedAt });
  }
  if (patches.length) payload.patches = patches;

  for (const [kind, items] of Object.entries(payload) as Array<[SyncPushKind, PushItem[]]>) {
    for (const item of items) presentKeys?.add(`${kind}:${item.key}`);
    const held = state.pushFailures?.filter((failure) => failure.kind === kind) ?? [];
    if (!held.length || manual) continue;
    const allowed: PushItem[] = [];
    for (const item of items) {
      const failure = held.find((value) => value.key === item.key && value.updatedAt === item.updatedAt);
      if (!failure || failure.protocol !== RECORD_PROTOCOL ||
          (failure.retryable && failure.retryAt <= Date.now()) || failure.fingerprint !== await pushFingerprint(item)) allowed.push(item);
    }
    if (allowed.length) payload[kind] = allowed;
    else delete payload[kind];
  }
  return payload;
}

async function pushFingerprint(item: PushItem): Promise<string> {
  return recordHash(JSON.stringify([item.data, item.bookId ?? null, item.deletedAt ?? null]));
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
  blockedContent: Array<{ bookId: string; reason: string }>;
  /** 被服务端跳过的记录数(单条超过上限,或数据异常);调用方应提示用户。 */
  skipped: number;
  pendingResources: number;
  conflicts: number;
  failures: PushFailure[];
  complete: boolean;
  pendingRecords: number;
}

export type SyncAppliedKind =
  | "books" | "notes" | "positions" | "sessions" | "settings" | "chats" | "patches" | "images";

export interface SyncDeps {
  signal: AbortSignal;
  manual?: boolean;
  onProgress?: (label: string) => void;
  /** 云端记录落库后通知 UI 重读本地数据。 */
  onApplied?: (kind: SyncAppliedKind) => void;
  /**
   * 别的设备存的阅读位置比本机新、刚写进本地。本机自己推上去再拉回来的不算
   * （已知服务端版本，合并时就挡掉了）。正开着这本书时界面据此提示跳转。
   */
  onRemotePosition?: (bookId: string, position: BookPosition) => void;
  onProgressSynced?: () => void;
}

interface PushResult {
  skipped: number;
  rejected: Partial<Record<SyncPushKind, string[]>>;
  failures: PushFailure[];
  acknowledged: Array<{ kind: SyncPushKind; key: string; updatedAt: number; fingerprint: string }>;
}

async function pushAll(payload: PushPayload, signal: AbortSignal, deps?: SyncDeps, keepalive = false,
  previousFailures: PushFailure[] = []): Promise<PushResult> {
  const failures = new Map(previousFailures.map((failure) => [`${failure.kind}:${failure.key}`, failure]));
  const ready: PushPayload = {};
  const sources = new Map<PushItem, PushItem>();
  const acknowledged: PushResult["acknowledged"] = [];
  const failedProgress: Partial<Record<SyncPushKind, string[]>> = {};
  const fail = async (kind: SyncPushKind, item: PushItem, issue: RecordIssue) => {
    if (kind === "positions" || kind === "listening") {
      (failedProgress[kind] ??= []).push(item.key);
      if (!issue.retryable && item.mutationId) await rejectProgress(kind, item.key, item.mutationId);
      return;
    }
    const fingerprint = await pushFingerprint(item);
    const previous = failures.get(`${kind}:${item.key}`);
    const attempts = previous?.fingerprint === fingerprint ? previous.attempts + 1 : 1;
    failures.set(`${kind}:${item.key}`, { ...issue, fingerprint, protocol: RECORD_PROTOCOL, attempts,
      retryAt: issue.retryable ? Date.now() + retryDelay(attempts) : 0 });
  };
  // 大正文独立上传；引用的 JSON 批次很小。成功的正文即使 D1 确认丢失，也可通过 HEAD 复用。
  for (const [kind, items] of Object.entries(payload) as Array<[SyncPushKind, PushItem[]]>) {
    for (const item of items) {
      try {
        let wire = item;
        const bytes = utf8Bytes(item.data);
        if (!keepalive && kind !== "positions" && kind !== "listening" && !item.deletedAt && bytes > INLINE_RECORD_BYTES) {
          if (bytes > MAX_RECORD_BYTES) throw new SyncError("单条记录超过 32 MB 同步上限", 413);
          const hash = await recordHash(item.data);
          const path = recordPath(kind, item.key, hash);
          if (!(await existsInCloud(path, signal))) {
            let response: Response;
            try { response = await fetchWithTimeout(path, { method: "POST", credentials: "same-origin", cache: "no-store",
              headers: { "content-type": "application/json" }, body: item.data, signal }, 300_000); }
            catch (error) { if (signal.aborted) throw error; throw new SyncError("大记录上传中断，稍后自动重试", 503); }
            if (!response.ok) throw await readError(response);
          }
          wire = { ...item, data: "", blob: { hash, bytes } };
        }
        (ready[kind] ??= []).push(wire);
        sources.set(wire, item);
      } catch (error) {
        if (signal.aborted || error instanceof SyncError && (error.status === 401 || error.status === 426)) throw error;
        const retryable = !(error instanceof SyncError) || retryableStatus(error.status);
        await fail(kind, item, { kind, key: item.key, updatedAt: item.updatedAt, bytes: utf8Bytes(item.data),
          code: retryable ? "upload_unavailable" : "invalid_record",
          reason: error instanceof Error ? error.message : "记录上传失败", retryable });
      }
    }
  }
  for (const batch of splitPayload(ready, 400, keepalive ? 45_000 : undefined)) {
    if (!countPayload(batch)) continue;
    const response = await request<{ tooLarge?: Record<string, string[]>; rejected?: Record<string, string[]> }>(
      "push", { ...batch, protocol: RECORD_PROTOCOL }, signal, keepalive ? 30_000 : 120_000, keepalive
    );
    for (const [kind, items] of Object.entries(batch) as Array<[SyncPushKind, PushItem[]]>) {
      for (const wire of items) {
        const item = sources.get(wire)!;
        let issue = response.issues?.find((value) => value.kind === kind && value.key === item.key && value.updatedAt === item.updatedAt);
        if (!issue && (response.rejected?.[kind]?.includes(item.key) || response.tooLarge?.[kind]?.includes(item.key))) {
          issue = { kind, key: item.key, updatedAt: item.updatedAt, code: "invalid_record", reason: "记录被云端拒收，请更新应用或修改对应记录后重试",
            bytes: utf8Bytes(item.data), retryable: false };
        }
        if (issue) { await fail(kind, item, issue); continue; }
        if (kind === "positions" || kind === "listening") {
          const receipt = response.receipts?.find((value) => value.kind === kind && value.key === item.key && value.mutationId === item.mutationId);
          if (!receipt) throw new SyncError("云端尚未启用进度确认协议，请稍后重试", 502);
          if (await applyProgressReceipt(receipt)) {
            deps?.onApplied?.(kind === "positions" ? "positions" : "books");
            if (kind === "positions") deps?.onRemotePosition?.(item.key, (receipt.record?.data as { position: BookPosition }).position);
          }
        } else {
          const receipt = response.recordReceipts?.find((value) => value.kind === kind && value.key === item.key && value.updatedAt === item.updatedAt);
          if (!receipt || (receipt.status !== "accepted" && receipt.status !== "stale")) {
            throw new SyncError("云端未确认记录保存结果，稍后自动重试", 502);
          }
          failures.delete(`${kind}:${item.key}`);
          acknowledged.push({ kind, key: item.key, updatedAt: item.updatedAt, fingerprint: await pushFingerprint(item) });
        }
      }
    }
  }
  const rejected: Partial<Record<SyncPushKind, string[]>> = { ...failedProgress };
  for (const failure of failures.values()) (rejected[failure.kind] ??= []).push(failure.key);
  for (const [kind, keys] of Object.entries(rejected) as Array<[SyncPushKind, string[]]>) rejected[kind] = [...new Set(keys)];
  return { skipped: Object.values(rejected).reduce((sum, keys) => sum + keys.length, 0), rejected, failures: [...failures.values()], acknowledged };
}

/** 一页正文全部取回并校验后才应用；中断时不推进游标，下次仍能拿到同一页。 */
async function resolveRecordBlobs(page: SyncResponse, signal: AbortSignal): Promise<void> {
  for (const kind of ["books", "notes", "sessions", "settings", "chats", "patches"] as const) {
    for (const record of page[kind] ?? []) {
      if (!record.blob) continue;
      if (!isRecordBlob(record.blob)) throw new SyncError("云端大记录引用无效", 502);
      const blob = record.blob;
      let response: Response;
      try { response = await fetchWithTimeout(recordPath(kind, record.key, blob.hash), {
        credentials: "same-origin", cache: "no-store", signal,
      }, 300_000); }
      catch (error) { if (signal.aborted) throw error; throw new SyncError("大记录下载中断，稍后自动重试", 503); }
      if (!response.ok) throw await readError(response);
      const text = await response.text();
      if (utf8Bytes(text) !== blob.bytes || await recordHash(text) !== blob.hash) throw new SyncError("大记录正文校验失败，稍后自动重试", 502);
      try { record.data = JSON.parse(text); } catch { throw new SyncError("大记录正文格式无效", 502); }
      delete record.blob;
    }
  }
}

/**
 * 只推不拉：离开前台、停止播放、锁屏听书时，把本机的改动先送上云端。
 *
 * 一整轮同步（推 → 传正文 → 分页拉 → 下书）在 iOS 切后台后跑不完：页面几秒内就被冻结，
 * 锁屏听书时更是一轮都不会发起，最后那段进度要等下次打开 App 才传上去（实测晚过 70 分钟、6 小时）。
 * 这里只发小体积的 keepalive 推送，页面冻结前尽力提交；未确认条目保留到下次重试。
 *
 * 不动拉取水位；逐条确认成功才清理待传状态，重复 mutation 幂等。
 */
async function collectProgressPayload(): Promise<PushPayload> {
  const payload: PushPayload = {};
  const localOnly = new Set((await getBookMetas()).filter((meta) => meta.format === "demo").map((meta) => meta.id));
  for (const entry of await getProgressQueue()) {
    if (!entry.pending || entry.rejection || localOnly.has(entry.key)) continue;
    (payload[entry.kind] ??= []).push({ key: entry.key, data: entry.data, updatedAt: entry.updatedAt,
      mutationId: entry.mutationId, baseServerRev: entry.baseServerRev, bootstrap: entry.bootstrap });
  }
  return payload;
}

async function withProgressLock<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("moting-reader-progress", { mode: "exclusive", signal }, run)
    : run();
}

export async function pushPending(signal: AbortSignal, deps?: SyncDeps): Promise<number> {
  return withProgressLock(signal, async () => {
    const payload = await collectProgressPayload();
    const result = await pushAll(payload, signal, deps, true);
    return countPayload(payload) - result.skipped;
  });
}

/** 前台进度通道独立于资源同步；先检查版本，没有变更时不扫八张 D1 表。 */
export async function runProgressSync(deps: SyncDeps): Promise<void> {
  await pushPending(deps.signal, deps);
  const state = await getSyncState();
  const version = await request<{ version: number }>("version", null, deps.signal, 20_000);
  let cursor = state.progressCursor ?? 0;
  if (version.version + 1 <= cursor) { await commitProgressCursor(cursor); return; }
  for (;;) {
    const page = await request<SyncResponse>("pull", { since: cursor, progressOnly: true }, deps.signal, 30_000);
    for (const kind of ["positions", "listening"] as const) {
      for (const record of page[kind] ?? []) {
        if (!record.data || !Number.isSafeInteger(record.serverAt)) continue;
        if (await applySyncedProgress(kind, record as ProgressRecord)) {
          deps.onApplied?.(kind === "positions" ? "positions" : "books");
          if (kind === "positions") deps.onRemotePosition?.(record.key, (record.data as { position: BookPosition }).position);
        }
      }
    }
    const next = Number(page.cursor);
    if (!Number.isSafeInteger(next) || next < cursor || (page.hasMore && next === cursor)) throw new SyncError("同步服务返回了无效的水位", 502);
    cursor = next;
    await commitProgressCursor(cursor);
    if (!page.hasMore) break;
  }
}

/** 跨页攒起来、等全部页拉完再处理的东西。 */
interface PullAccumulator {
  /** 待下载正文的新书。 */
  downloads: Map<string, BookMeta>;
  /** 本轮见到的删书墓碑:拉完后按书清掉划线、位置、对话,不留孤儿。 */
  deadBooks: Map<string, number>;
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

  for (const kind of ["positions", "listening"] as const) {
    for (const record of page[kind] ?? []) {
      if (!record.data || !Number.isSafeInteger(record.serverAt)) continue;
      if (await applySyncedProgress(kind, record as ProgressRecord)) {
        changed = true;
        deps.onApplied?.(kind === "positions" ? "positions" : "books");
        if (kind === "positions") deps.onRemotePosition?.(record.key, (record.data as { position: BookPosition }).position);
      }
    }
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
 * 一轮同步 = 确认进度队列 → push 普通记录 → 分页 pull 并落盘进度、游标和资源队列 →
 * 上传/下载正文和图片 → 清理删书孤儿并保存剩余资源任务。
 * 进度和资源分别确认；资源失败不撤销进度，也不会丢掉跨页面重启的重试任务。
 */
export async function runSync(deps: SyncDeps): Promise<SyncRunResult> {
  const { signal, onProgress = () => {} } = deps;
  const state = await getSyncState();
  // 先记时刻再收集:收集期间新改的记录修改时间 ≥ 这个值,下一轮一定还会被捡到。
  const startedAt = Date.now();

  // 1. push 本地脏记录。
  await pushPending(signal, deps);
  const presentKeys = new Set<string>();
  const payload = await collectPushPayload(state, deps.manual, presentKeys);
  delete payload.positions;
  delete payload.listening;
  const pushedBookIds = new Set((payload.books ?? []).filter((item) => !item.deletedAt).map((item) => item.key));
  let failures = (state.pushFailures ?? []).filter((failure) => presentKeys.has(`${failure.kind}:${failure.key}`));
  let skipped = failures.length;
  let rejectedPush: Partial<Record<SyncPushKind, string[]>> = {};
  for (const failure of failures) (rejectedPush[failure.kind] ??= []).push(failure.key);
  const acknowledged = new Map<string, PushResult["acknowledged"][number]>();
  const recordPushResult = (result: PushResult) => {
    for (const receipt of result.acknowledged) acknowledged.set(`${receipt.kind}:${receipt.key}`, receipt);
    skipped = result.skipped;
    failures = result.failures;
    rejectedPush = result.rejected;
  };
  if (countPayload(payload)) {
    onProgress("正在上传本地记录…");
    recordPushResult(await pushAll(payload, signal, deps, false, failures));
  }

  // 普通记录已逐条确认：立即保存结果。下载中断不会让已确认的大正文再上传。
  await commitSyncState({ ...state, schema: SYNC_SCHEMA, pushedAt: startedAt,
    pendingPush: rejectedPush, pushFailures: failures,
    pendingContent: [...new Set([...state.pendingContent, ...pushedBookIds])] }, state,
    { books: rejectedPush.books, notes: rejectedPush.notes });

  // 2. 分页 pull 远端增量,逐页合并。
  onProgress("正在拉取云端变更…");
  let changed = !!countPayload(payload);
  let cursor = state.pullCursor;
  const localMetaById = new Map((await getBookMetas()).map((meta) => [meta.id, meta]));
  const acc: PullAccumulator = { downloads: new Map(), deadBooks: new Map() };
  for (;;) {
    const page = await request<SyncResponse>("pull", { since: cursor, recordBlobs: true }, signal, 120_000);
    await resolveRecordBlobs(page, signal);
    if (await applyPullPage(page, localMetaById, acc, deps)) changed = true;
    const next = Number(page.cursor);
    if (!Number.isSafeInteger(next) || next < cursor || (page.hasMore && next === cursor)) throw new SyncError("同步服务返回了无效的水位", 502);
    cursor = next;
    if (!page.hasMore) break;
    if (signal.aborted) throw new DOMException("同步已取消", "AbortError");
  }

  // 游标提交前清理整轮见到的删书，资源中断或页面回收后也不能留下孤儿记录。
  for (const [bookId, deletedAt] of acc.deadBooks) {
    const removed = await removeBookIfOlder(bookId, deletedAt);
    const local = await getBookMeta(bookId);
    if (local) localMetaById.set(bookId, local);
    else localMetaById.delete(bookId);
    if (removed) changed = true;
    deps.onApplied?.("books");
    deps.onApplied?.("notes");
    deps.onApplied?.("positions");
    deps.onApplied?.("chats");
    deps.onApplied?.("patches");
  }

  const pending = [...new Set([...state.pendingContent, ...(state.blockedContent ?? []).map((entry) => entry.bookId), ...pushedBookIds])];
  const downloads = new Map((state.pendingDownloads ?? []).map((meta) => [meta.id, meta]));
  for (const [id, meta] of acc.downloads) downloads.set(id, meta);
  for (const id of acc.deadBooks.keys()) downloads.delete(id);
  // 先落盘资源队列和拉取游标；资源失败或页面被回收不能丢掉已见过的新书。
  await commitSyncState({ ...state, schema: SYNC_SCHEMA, pushedAt: startedAt,
    pullCursor: cursor, progressCursor: cursor, lastProgressAt: Date.now(), pendingContent: pending,
    pendingDownloads: [...downloads.values()], pendingPush: rejectedPush, pushFailures: failures }, state,
    { books: rejectedPush.books, notes: rejectedPush.notes });
  deps.onProgressSynced?.();

  // 3. 上传待传正文(meta 已 push 但还没标 ready 的书 + 之前没传完的)。
  // 传完一本就标一本:中途被系统杀掉,下次只会从没传完的那本接着来。
  const blockedContent = new Map((state.blockedContent ?? []).map((entry) => [entry.bookId, entry]));
  const stillPending: string[] = [];
  for (const bookId of pending) {
    if (signal.aborted) break;
    const meta = await getBookMeta(bookId);
    if (!meta || meta.syncReadyAt) { blockedContent.delete(bookId); continue; }
    if (blockedContent.has(bookId) && !deps.manual) continue;
    blockedContent.delete(bookId);
    try {
      onProgress(`正在上传《${meta.title}》…`);
      const book = await getBook(bookId);
      if (!book) continue;
      await uploadBookBody(bookId, book, signal);
      // 只改这一个字段，保留上传期间产生的新听书位置等本地变化。
      const ready = await updateBookMeta(bookId, { syncReadyAt: Date.now() });
      if (!ready) continue;
      recordPushResult(await pushAll(
        { books: [{ key: bookId, data: JSON.stringify(toSyncBookMeta(ready)), updatedAt: bookPushTime(ready) }] },
        signal, deps, false, failures
      ));
      deps.onApplied?.("books");
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof SyncError && (error.status === 413 || error.status === 400)) {
        blockedContent.set(bookId, { bookId, reason: error.message });
      } else {
        stillPending.push(bookId); // 网络类错误留下轮重试。
      }
    }
  }
  if (signal.aborted) throw new DOMException("同步已取消", "AbortError");

  // 4. 下载缺失书籍(只有对端标记过 syncReadyAt 的)。
  const pendingImages = new Map(
    state.pendingImages.map((entry) => [`${entry.bookId}\u0000${entry.imageId}`, entry] as const)
  );
  const refreshedBooks = new Set<string>();
  for (const meta of downloads.values()) {
    if (signal.aborted) break;
    if (await getBookMeta(meta.id)) { downloads.delete(meta.id); continue; }
    let downloaded: Awaited<ReturnType<typeof downloadBook>>;
    try { downloaded = await downloadBook(meta, signal, onProgress); }
    catch (error) {
      if (signal.aborted) throw error;
      console.warn("sync_download_pending", { bookId: meta.id });
      continue;
    }
    if (!downloaded) continue;
    const imported = await saveImportedBookIfMissing(downloaded.book, downloaded.images);
    if (!imported) {
      const current = await getBookMeta(meta.id);
      if (current) { localMetaById.set(meta.id, current); downloads.delete(meta.id); }
      continue;
    }
    downloads.delete(meta.id);
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
  for (const [key, entry] of pendingImages) {
    if (refreshedBooks.has(entry.bookId)) continue;
    if (signal.aborted) throw new DOMException("同步已取消", "AbortError");
    try {
      const kind = await recoverPendingImage(entry, {
        getBook: getBookMeta,
        getImage: getBookImage,
        download: (bookId, imageId) => downloadImage(bookId, imageId, signal),
        toDataUrl: blobToDataUrl,
        saveCover: saveRecoveredCover,
        saveImage: saveRecoveredImage,
      });
      pendingImages.delete(key);
      if (kind) {
        changed = true;
        deps.onApplied?.(kind);
        if (kind === "images" && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("moting:image-updated", { detail: { imageId: entry.imageId } }));
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // 下载或落盘失败都保留队列，下轮重试。
    }
  }

  // 6. 保存剩余任务。已成功 push 的墓碑使命完成(生效或被服务端新值否决),清除;
  // 同步期间新增或改写的墓碑要从最新 state 里保住。
  const retryPush = Object.fromEntries(
    Object.entries(rejectedPush).map(([kind, keys]) => [kind, [...new Set(keys)]])
  ) as Partial<Record<SyncPushKind, string[]>>;
  const progress = await getProgressQueue();
  const pendingResources = stillPending.length + blockedContent.size + downloads.size + pendingImages.size;
  const trailing = await collectPushPayload({ ...await getSyncState(), schema: SYNC_SCHEMA, pushedAt: startedAt,
    pendingPush: retryPush, pushFailures: failures });
  let unconfirmed = 0;
  for (const [kind, items] of Object.entries(trailing) as Array<[SyncPushKind, PushItem[]]>) {
    if (kind === "positions" || kind === "listening") continue;
    for (const item of items) {
      const receipt = acknowledged.get(`${kind}:${item.key}`);
      if (!receipt || receipt.updatedAt !== item.updatedAt || receipt.fingerprint !== await pushFingerprint(item)) unconfirmed++;
    }
  }
  const pendingRecords = failures.length + unconfirmed;
  const complete = !pendingRecords && !blockedContent.size && !pendingResources &&
    !progress.some((entry) => entry.pending || entry.rejection || entry.conflict);
  await commitSyncState({
    lastCompleteAt: complete ? Date.now() : state.lastCompleteAt,
    schema: SYNC_SCHEMA,
    pushedAt: startedAt,
    pullCursor: cursor,
    tombstones: state.tombstones,
    pendingContent: [...stillPending, ...blockedContent.keys()],
    blockedContent: [...blockedContent.values()],
    pendingDownloads: [...downloads.values()],
    progressCursor: cursor,
    pendingImages: [...pendingImages.values()],
    pendingPush: retryPush,
    pushFailures: failures,
  }, state, { books: rejectedPush.books, notes: rejectedPush.notes });

  return { complete, pendingRecords, failures, syncedAt: Date.now(), changed, failedContent: [...blockedContent.keys()], blockedContent: [...blockedContent.values()], skipped: skipped + progress.filter((entry) => entry.rejection).length,
    pendingResources,
    conflicts: progress.filter((entry) => entry.conflict).length };
}
