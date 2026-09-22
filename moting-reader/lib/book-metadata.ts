import type {
  BookMetadataCandidate,
  BookMetadataLookup,
} from "./book-metadata-types";
import type { Book } from "./types";

/** 压缩后封面的长边上限。书库最大的封面是 148×219 CSS px，3 倍屏也只要 ~440。 */
const COVER_MAX_EDGE = 440;
const COVER_QUALITY = 0.82;
/** 比这更小的图不是封面，是占位图或者 1×1 的追踪像素，宁可没有也不要挂上去。 */
const COVER_MIN_EDGE = 40;

const PLACEHOLDER_AUTHORS = new Set([
  "未知作者",
  "佚名",
  "无名氏",
  "unknown",
  "unknown author",
  "n/a",
]);

const FILE_EXTENSION = /\.(epub|pdf|txt|md|markdown)$/i;
/** 盗版电子书标题里最常见的几种噪声。 */
const TITLE_NOISE = /(完整版|精校版|精校|全本|全集|校对版|修订版|无删减|典藏版|下载|电子书|txt)/gi;
const BRACKETED = /[（(【\[｛{][^）)】\]｝}]*[）)】\]｝}]/g;
const SITE_TAG = /@\S+/g;
const TITLE_MARKS = /[《》〈〉「」『』“”‘’"']/g;
/** 比对用：标点、空白一律不算数，只看字本身。 */
const IGNORED_IN_KEY = /[\s　·・,，.。:：;；!！?？、_\-—–~～/\\|+*#]/g;

export function isPlaceholderAuthor(author: string | undefined): boolean {
  const value = (author ?? "").trim().toLowerCase();
  return !value || PLACEHOLDER_AUTHORS.has(value);
}

/** 去掉扩展名、括号噪声、书源水印标记，留下还能读的书名，用来发查询。 */
export function cleanTitleText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(FILE_EXTENSION, " ")
    .replace(BRACKETED, " ")
    .replace(SITE_TAG, " ")
    .replace(TITLE_MARKS, " ")
    .replace(TITLE_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 比对用的书名指纹。清洗之后再把所有标点空白抹掉，
 * 这样「三国演义(完整版)@某某书屋」和「三国演义」会得到同一个 key，
 * 而「三国演义」和「水浒传」不会。
 */
export function normalizeTitleKey(raw: string): string {
  return cleanTitleText(raw).replace(IGNORED_IN_KEY, "").toLowerCase();
}

function stripExtension(name: string): string {
  return name.replace(FILE_EXTENSION, "");
}

/**
 * 书名是不是「解析器没找到标题，拿文件名顶上」来的。
 * 三个解析器都是 `xxx || fileNameWithoutExtension(file.name)`（parsers.ts），
 * 所以脏标题必然跟文件名同源。
 */
export function titleLooksLikeFileName(book: Book): boolean {
  if (!book.fileName) return false;
  const fromFile = normalizeTitleKey(stripExtension(book.fileName));
  return Boolean(fromFile) && fromFile === normalizeTitleKey(book.title);
}

/** 上游的作者字段很脏：会带「(翻译 )」后缀、重复、繁简混排。最多留两个。 */
export function formatAuthors(authors: string[]): string {
  const cleaned = authors
    .map((name) =>
      name
        .normalize("NFKC")
        .replace(BRACKETED, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
  return [...new Set(cleaned)].slice(0, 2).join(" · ");
}

/**
 * 书名里有没有明显的噪声——清洗之后还跟原来一样，就说明它本来就是干净的。
 *
 * 注意不能拿 titleLooksLikeFileName 当这个判据：拿书名给文件命名是最普通不过的做法，
 * 「三国演义.epub」的标题跟文件名一致完全正常，按它去查等于每本书都查一遍。
 */
export function titleLooksDirty(book: Book): boolean {
  const title = book.title.trim();
  return Boolean(title) && cleanTitleText(title) !== title;
}

/** 这本书值不值得花一次请求。干净的书不查，省配额也省得配错。 */
export function needsMetadataLookup(book: Book): boolean {
  if (book.format === "demo" || book.status !== "ready") return false;
  return (
    isPlaceholderAuthor(book.author) || titleLooksDirty(book) || !book.coverDataUrl
  );
}

export function lookupQuery(book: Book): { title: string; author: string } {
  return {
    title: cleanTitleText(book.title) || book.title.trim(),
    author: isPlaceholderAuthor(book.author) ? "" : book.author.trim(),
  };
}

export interface MetadataDecision {
  candidate: BookMetadataCandidate;
  title?: string;
  author?: string;
  /** 候选有封面且这本书还没有封面——封面要另外下载，这里只给结论。 */
  wantCover: boolean;
}

/**
 * 自动套用的闸门：**只补明确的脏数据，且书名指纹必须完全对上**。
 *
 * 用户拍板的策略。指纹相等这一条是安全绳：清洗只去噪声不换字，
 * 所以「三国演义(完整版)」能配上「三国演义」，但配不上《水浒传》。
 * EPUB 里本来就正确的书名、作者、封面，一律不碰。
 */
export function decideAutoApply(
  book: Book,
  candidates: BookMetadataCandidate[]
): MetadataDecision | null {
  const key = normalizeTitleKey(book.title);
  if (!key) return null;
  const candidate = candidates.find(
    (item) => normalizeTitleKey(item.title) === key
  );
  if (!candidate) return null;

  const decision: MetadataDecision = { candidate, wantCover: false };
  const title = cleanTitleText(candidate.title);
  if (titleLooksLikeFileName(book) && title && title !== book.title) {
    decision.title = title;
  }
  const author = formatAuthors(candidate.authors);
  if (isPlaceholderAuthor(book.author) && author) decision.author = author;
  if (!book.coverDataUrl && candidate.coverUrl) decision.wantCover = true;

  return decision.title || decision.author || decision.wantCover
    ? decision
    : null;
}

export class BookMetadataError extends Error {}

export async function lookupBookMetadata(
  book: Book,
  signal?: AbortSignal
): Promise<BookMetadataLookup> {
  const { title, author } = lookupQuery(book);
  if (!title) return { candidates: [] };
  const params = new URLSearchParams({ title });
  if (author) params.set("author", author);

  let response: Response;
  try {
    response = await fetch(`/api/metadata/lookup?${params}`, {
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new BookMetadataError("网络不可用，无法读取书籍资料");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `书籍资料服务返回 ${response.status}`;
    throw new BookMetadataError(message);
  }
  const candidates =
    data && typeof data === "object" && "candidates" in data && Array.isArray(data.candidates)
      ? (data.candidates as BookMetadataCandidate[])
      : [];
  return { candidates };
}

/** 封面必须经 Worker 转发：books.google.com 不给 CORS 头，直接取会把 canvas 污染掉。 */
export function coverProxyUrl(coverUrl: string): string {
  return `/api/metadata/cover?u=${encodeURIComponent(coverUrl)}`;
}

/**
 * 取回封面并压到 440px webp。
 *
 * 解码和重编码都在主线程，所以调用方必须保证此刻没在读书——
 * 跟插图补量守的是同一条纪律。拿不到就返回 null，绝不塞一张假图。
 */
export async function fetchCoverDataUrl(
  coverUrl: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    return null;
  }
  let bitmap: ImageBitmap | null = null;
  try {
    const response = await fetch(coverProxyUrl(coverUrl), { signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.size || !blob.type.startsWith("image/")) return null;
    bitmap = await createImageBitmap(blob);
    if (Math.min(bitmap.width, bitmap.height) < COVER_MIN_EDGE) return null;

    const scale = Math.min(1, COVER_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const webp = canvas.toDataURL("image/webp", COVER_QUALITY);
    return webp.startsWith("data:image/webp")
      ? webp
      : canvas.toDataURL("image/jpeg", COVER_QUALITY);
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
