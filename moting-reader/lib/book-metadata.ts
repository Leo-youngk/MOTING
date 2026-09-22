import type {
  BookMetadataCandidate,
  BookMetadataLookup,
} from "./book-metadata-types";
import type { Book } from "./types";
import { searchWeread, wereadCoverUrl, WereadError } from "./weread.ts";
import type { WereadBook, WereadSearchResult } from "./weread-types";

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

/**
 * 作者字段要剥的只有圆括号里的角色标注（「(翻译 )」「（评）」）。
 * 方括号不能一起剥：微信读书用「[哥]加西亚•马尔克斯」标国别，那是真信息不是噪声。
 */
const AUTHOR_ROLE = /[（(][^）)]*[）)]/g;

/**
 * 「去找这本书」发给在线找书的查询词：干净书名 + 第一个作者。
 *
 * 只给书名不够用——Z-Library 上同名书一大堆，《活着》能翻出十几个不相干的版本。
 * 作者这里要连方括号国别一起剥掉：展示时「[英]简·奥斯汀」里的国别是有用信息
 * （formatAuthors 特意保留），但当搜索词就是纯噪声，会把结果搜没。
 */
export function bookSearchQuery(title: string, author: string): string {
  // 这里**不能**用 cleanTitleText：它把「全集 / 完整版」当盗版噪声剥掉，
  // 那是对着导入文件的脏文件名定的规则。微信读书给的是正规书名，
  // 《简·奥斯汀小说全集》被剥成《简·奥斯汀小说》就搜不到了。只去括号和书名号。
  const name =
    title
      .normalize("NFKC")
      .replace(BRACKETED, " ")
      .replace(TITLE_MARKS, " ")
      .replace(/\s+/g, " ")
      .trim() || title.trim();
  const cleaned = (author ?? "")
    .normalize("NFKC")
    .replace(/[[【][^\]】]*[\]】]/g, " ")
    .replace(AUTHOR_ROLE, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 多作者只取第一个：合著书的第二作者反而会让搜索落空。
  const head = cleaned.split(/[、,，;；/]/)[0].trim();
  const words = head.split(/\s+/).filter(Boolean);
  // 中文名不含空格，空格后面多半是第二个作者或「著 / 编」这类后缀；
  // 西文名反过来，空格是名字的一部分，得留住。
  const who = (/[\u4e00-\u9fa5]/.test(head) ? words[0] ?? "" : words.slice(0, 3).join(" "))
    .replace(/[著编译]$/, "")
    .trim();
  return [name, who].filter(Boolean).join(" ");
}

/** 上游的作者字段很脏：会带角色后缀、重复、繁简混排。最多留两个。 */
export function formatAuthors(authors: string[]): string {
  const cleaned = authors
    .map((name) =>
      name
        .normalize("NFKC")
        .replace(AUTHOR_ROLE, " ")
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
  // 封面要比书名多一道门槛：候选必须带作者。
  //
  // 上游有一批「标题对、封面错」的记录——实测查《三体》会返回一条标题就叫「三体」、
  // 但封面图是《三体II 黑暗森林·上》的条目，而它恰好没有作者字段。标题指纹管不住
  // 这种脏源，没有作者可以当作「这条记录本身不规范」的信号，宁可不补封面。
  if (!book.coverDataUrl && candidate.coverUrl && author) decision.wantCover = true;

  return decision.title || decision.author || decision.wantCover
    ? decision
    : null;
}

export class BookMetadataError extends Error {}

/**
 * 候选一律来自微信读书。早先用过 Google Books，中文书的封面收录几乎为零
 * （围城、人类简史返回 0 封面），换源之后 8/8 命中且全部有封面，就没有再保留它的理由。
 */
export async function lookupBookMetadata(
  book: Book,
  signal?: AbortSignal
): Promise<BookMetadataLookup> {
  const { title } = lookupQuery(book);
  if (!title) return { candidates: [] };
  let result: WereadSearchResult;
  try {
    result = await searchWeread(title, 0, 5, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new BookMetadataError(
      error instanceof WereadError ? error.message : "书籍资料查询失败"
    );
  }
  return { candidates: result.books.map(toCandidate) };
}

function toCandidate(book: WereadBook): BookMetadataCandidate {
  return {
    volumeId: book.bookId,
    title: book.title,
    // 微信读书的作者是一个字符串（有时含「/」分隔的多作者），拆开交给 formatAuthors 统一清洗。
    authors: book.author ? book.author.split(/[\/、,，]/).map((name) => name.trim()).filter(Boolean) : [],
    publishedDate: null,
    description: book.intro,
    categories: book.category ? [book.category] : [],
    coverUrl: book.coverUrl,
    language: null,
    infoLink: null,
    rating: book.rating,
    ratingCount: book.ratingCount,
    ratingLabel: book.ratingLabel,
  };
}

/** 封面转发统一走书城那一条，不再单独留一个 metadata 的代理口。 */
export const coverProxyUrl = wereadCoverUrl;

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
