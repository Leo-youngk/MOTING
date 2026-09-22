/**
 * 来源记在补丁里，便于区分老数据。
 * 早先是 "google-books"，2026-09 换成微信读书——中文书的封面它几乎一张都给不出来。
 */
export const BOOK_METADATA_SOURCE = "weread";

/** 一个候选版本，已经裁成书库真正用得上的字段。 */
export interface BookMetadataCandidate {
  volumeId: string;
  title: string;
  authors: string[];
  publishedDate: string | null;
  description: string | null;
  categories: string[];
  coverUrl: string | null;
  language: string | null;
  infoLink: string | null;
  /** 千分制推荐值，拿不到就是 null。挑版本时它比出版年份有用得多。 */
  rating: number | null;
  ratingCount: number | null;
  /** 神作 / 好评如潮 这类档位标签。 */
  ratingLabel: string | null;
}

export interface BookMetadataLookup {
  candidates: BookMetadataCandidate[];
}

/** 真正盖到 Book 上的字段，没列出的保持导入时的原样。 */
export interface AppliedBookMetadata {
  volumeId: string;
  title?: string;
  author?: string;
  coverDataUrl?: string;
}

/** 套用之前这本书长什么样，用来「还原成导入时的资料」。 */
export interface OriginalBookMetadata {
  title: string;
  author: string;
  coverDataUrl?: string;
}

/**
 * 补全结果单独存一条记录，不写回 Book 本身。
 *
 * 一本长篇的 Book 里挂着几万个句子对象，为了改一个作者名把整本重新序列化一遍不划算；
 * 阅读位置早就是这么存的（storage.ts 的 reading-position:），这里照抄同一套。
 * 删掉这条记录，书就回到导入时的元数据。
 */
export interface BookMetadataPatch {
  bookId: string;
  source: string;
  /** 实际发给上游的书名，排查「为什么没匹配上」时要看它。 */
  query: string;
  fetchedAt: number;
  candidates: BookMetadataCandidate[];
  applied: AppliedBookMetadata | null;
  original: OriginalBookMetadata | null;
  /** auto=后台按脏数据规则自动套用，user=用户在「书籍资料」里手选，null=没套用。 */
  appliedBy: "auto" | "user" | null;
  /** 查询失败时记一笔，避免每次开机都重试同一本；用户手动重试会清掉。 */
  failedAt?: number;
  failedReason?: string;
}
