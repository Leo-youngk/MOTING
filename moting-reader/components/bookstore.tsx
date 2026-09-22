"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, ChevronLeft, ChevronRight, Search, Trophy, X } from "lucide-react";
import {
  fetchWereadBook,
  fetchWereadRank,
  fetchWereadRecommend,
  fetchWereadSimilar,
  searchWeread,
  wereadCoverUrl,
} from "../lib/weread";
import {
  formatRatingCount,
  formatReadingCount,
  preferredCategory,
  ratingPercent,
  RATING_TRUSTWORTHY_COUNT,
  rememberCategory,
  WEREAD_CATEGORIES,
  type WereadBook,
  type WereadBookDetail,
  type WereadLane,
} from "../lib/weread-types";
import type { Book } from "../lib/types";
import "./bookstore.css";

/** 横滑轨道里先露几本，其余收进「全部」里，免得一条流拖出几十张图。 */
const LANE_PREVIEW = 8;
const RANK_PREVIEW = 5;

/** 打开的是哪一份完整列表。null 表示停在书城首页。 */
type Expanded = { title: string; subtitle: string; books: WereadBook[] } | null;

export function Cover({
  book,
  size = "card",
  priority = false,
}: {
  book: WereadBook;
  /** 决定取哪一档图源，档位和渲染尺寸对应关系见 wereadCoverUrl。 */
  size?: "row" | "card" | "large";
  /** 首屏能看见的封面不能懒加载，否则进书城第一眼是一片空白。 */
  priority?: boolean;
}) {
  const large = size === "large";
  return (
    <span className={`store-cover${large ? " store-cover--large" : ""}`}>
      <BookOpen size={large ? 26 : 18} aria-hidden="true" />
      {book.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={wereadCoverUrl(book.coverUrl, size)}
          alt=""
          loading={large || priority ? "eager" : "lazy"}
          fetchPriority={large || priority ? "high" : "auto"}
          decoding="async"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </span>
  );
}

/**
 * 推荐值徽章。这是整个书城存在的理由——一眼看出这本书别人读完觉得好不好。
 * 评分人数太少就只报人数不报百分比：三十个人打出的 96% 说明不了任何事。
 */
export function Rating({ book, compact = false }: { book: WereadBook; compact?: boolean }) {
  const percent = ratingPercent(book.rating);
  const people = formatRatingCount(book.ratingCount);
  const trusted = (book.ratingCount ?? 0) >= RATING_TRUSTWORTHY_COUNT;

  if (!percent || !trusted) {
    const reading = formatReadingCount(book.readingCount);
    if (people && !trusted) {
      return <span className="store-rating store-rating--thin">评分 {people}</span>;
    }
    return reading ? <span className="store-rating store-rating--thin">{reading}</span> : null;
  }
  return (
    <span className="store-rating">
      {book.ratingLabel ? <b>{book.ratingLabel}</b> : null}
      <strong>{percent}</strong>
      {compact ? null : <small>{people}</small>}
    </span>
  );
}

export function StoreCard({
  book,
  priority = false,
  onOpen,
}: {
  book: WereadBook;
  priority?: boolean;
  onOpen: (book: WereadBook) => void;
}) {
  return (
    <button type="button" className="store-card" onClick={() => onOpen(book)}>
      <Cover book={book} size="card" priority={priority} />
      <span className="store-card__title">{book.title}</span>
      <span className="store-card__author">{book.author || "作者未提供"}</span>
      <Rating book={book} compact />
    </button>
  );
}

export function StoreRow({
  book,
  rank,
  priority = false,
  onOpen,
}: {
  book: WereadBook;
  /** 榜单里的名次，从 1 开始；普通列表不传。 */
  rank?: number;
  priority?: boolean;
  onOpen: (book: WereadBook) => void;
}) {
  return (
    <button type="button" className="store-row" onClick={() => onOpen(book)}>
      {rank ? (
        <span className={`store-rank${rank <= 3 ? " store-rank--top" : ""}`}>{rank}</span>
      ) : null}
      <Cover book={book} size="row" priority={priority} />
      <span className="store-row__info">
        <strong>{book.title}</strong>
        <small>{book.author || "作者未提供"}</small>
        <Rating book={book} />
      </span>
    </button>
  );
}

export function LaneSkeleton() {
  return (
    <div className="store-lane" role="status" aria-label="正在加载书城">
      <div className="store-lane__head">
        <span className="store-skeleton store-skeleton--title" />
      </div>
      <div className="store-lane__track">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="store-skeleton store-skeleton--card" key={index} />
        ))}
      </div>
    </div>
  );
}

export function RankSkeleton() {
  return (
    <div className="store-ranklist" role="status" aria-label="正在加载榜单">
      {Array.from({ length: RANK_PREVIEW }, (_, index) => (
        <div className="store-skeleton store-skeleton--row" key={index} />
      ))}
    </div>
  );
}

export function Bookstore({
  books,
  onBack,
  onFindBook,
  initialBookId = "",
}: {
  /** 本地书库。最近读的那本会被当成「相似推荐」的种子。 */
  books: Book[];
  onBack: () => void;
  onFindBook: (title: string, author: string) => void;
  /** 从主页的书城条点进来时带的书，直接落在这本书的详情上。 */
  initialBookId?: string;
}) {
  const [lanes, setLanes] = useState<WereadLane[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [category, setCategory] = useState<string>(() => preferredCategory());
  /**
   * 分类下的两种看法，缺一不可：
   * rank 是挑出来的好书（按推荐值，卡评分人数），browse 是这个分类里能一直往下翻的全部书。
   * 只给 rank 等于逼着用户只能看「神作」，想随便逛就没地方去。
   */
  const [mode, setMode] = useState<"rank" | "browse">("rank");
  const [rank, setRank] = useState<WereadBook[]>([]);
  const [rankPool, setRankPool] = useState(0);
  const [rankLoading, setRankLoading] = useState(true);
  const [rankError, setRankError] = useState("");
  const [rankAll, setRankAll] = useState(false);

  const [browse, setBrowse] = useState<WereadBook[]>([]);
  const [browseIdx, setBrowseIdx] = useState(0);
  const [browseMore, setBrowseMore] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const browseController = useRef<AbortController | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WereadBook[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchMore, setSearchMore] = useState(false);
  const [searchIdx, setSearchIdx] = useState(0);

  const [expanded, setExpanded] = useState<Expanded>(null);
  const [selected, setSelected] = useState<WereadBook | null>(null);
  const [detail, setDetail] = useState<WereadBookDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const searchController = useRef<AbortController | null>(null);

  // 种子取最近打开、且不是内置示例的那本书。没有就只出「为你推荐」。
  const seedTitle = books.find((book) => book.format !== "demo")?.title ?? "";

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;

    // 刻意不在开头 setLoading(true)：换种子时保留旧内容直到新数据到位，
    // 既避开在 effect 同步阶段 setState，也不会让整页闪一下骨架屏再跳回来。
    const loadLanes = async () => {
      try {
        const recommend = await fetchWereadRecommend(0, 20, signal);
        if (signal.aborted) return;
        // 推荐一到就渲染。相似推荐要先搜种子书再查相似，是串着的两跳，
        // 从前把三个请求攒齐才 setLanes，进书城得盯着骨架屏等三四秒。
        setLanes(
          recommend.books.length
            ? [
                {
                  kind: "recommend",
                  title: "为你推荐",
                  subtitle: "微信读书按你的阅读记录挑的",
                  books: recommend.books,
                },
              ]
            : []
        );
        setError("");
        setLoading(false);
      } catch (reason) {
        if (signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "书城暂时打不开");
        setLoading(false);
        return;
      }

      // 相似推荐要先拿种子书在微信读书里的 bookId，本地书库里没有这个 id。
      if (!seedTitle) return;
      try {
        const matched = await searchWeread(seedTitle, 0, 1, signal);
        const target = matched.books[0];
        if (!target || signal.aborted) return;
        const similar = await fetchWereadSimilar(target.bookId, 0, 20, "", signal);
        if (!similar.books.length || signal.aborted) return;
        setLanes((current) => [
          ...current,
          {
            kind: "similar",
            title: `因为你在读《${seedTitle}》`,
            seedTitle,
            subtitle: "微信读书的相似推荐",
            books: similar.books,
          },
        ]);
      } catch {
        // 相似推荐拿不到就少一条流，不影响书城其余部分。
      }
    };

    void loadLanes();
    return () => controller.abort();
  }, [seedTitle]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const loadRank = async () => {
      try {
        const data = await fetchWereadRank(category, signal);
        if (signal.aborted) return;
        setRank(data.books);
        setRankPool(data.poolSize);
        setRankError("");
      } catch (reason) {
        if (signal.aborted) return;
        setRank([]);
        setRankError(reason instanceof Error ? reason.message : "榜单暂时取不到");
      } finally {
        if (!signal.aborted) setRankLoading(false);
      }
    };
    void loadRank();
    return () => controller.abort();
  }, [category]);

  useEffect(() => {
    const bookId = selected?.bookId ?? initialBookId;
    if (!bookId) return;
    const controller = new AbortController();
    fetchWereadBook(bookId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setDetail(data);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setDetailError(reason instanceof Error ? reason.message : "书籍详情读取失败");
        }
      });
    return () => controller.abort();
  }, [selected, initialBookId]);

  function openBook(book: WereadBook) {
    setDetail(null);
    setDetailError("");
    setSelected(book);
  }

  function pickCategory(next: string) {
    if (next === category) return;
    browseController.current?.abort();
    setRankLoading(true);
    setRankAll(false);
    setBrowse([]);
    setBrowseIdx(0);
    setBrowseMore(false);
    setBrowseError("");
    setCategory(next);
    rememberCategory(next);
    if (mode === "browse") loadBrowse(next, 0);
  }

  /** 分类浏览直接复用搜索接口——分类词本来就是当关键词搜的。 */
  function loadBrowse(target: string, fromIdx: number) {
    browseController.current?.abort();
    const controller = new AbortController();
    browseController.current = controller;
    setBrowseLoading(true);
    searchWeread(target, fromIdx, 20, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setBrowse((current) => (fromIdx ? [...current, ...data.books] : data.books));
        setBrowseIdx(data.nextIdx);
        setBrowseMore(data.hasMore);
        setBrowseError("");
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setBrowseError(reason instanceof Error ? reason.message : "这个分类暂时打不开");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBrowseLoading(false);
      });
  }

  function pickMode(next: "rank" | "browse") {
    if (next === mode) return;
    setMode(next);
    if (next === "browse" && !browse.length) loadBrowse(category, 0);
  }

  function runSearch(keyword: string, fromIdx: number) {
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    setError("");
    searchWeread(keyword, fromIdx, 20, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setResults((current) => (fromIdx && current ? [...current, ...data.books] : data.books));
        setSearchIdx(data.nextIdx);
        setSearchMore(data.hasMore);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "搜索失败，请重试");
          if (!fromIdx) setResults([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const keyword = query.trim();
    if (!keyword) return;
    (document.activeElement as HTMLElement)?.blur();
    setExpanded(null);
    runSearch(keyword, 0);
  }

  function clearSearch() {
    searchController.current?.abort();
    setQuery("");
    setResults(null);
    setSearching(false);
    setSearchMore(false);
    setSearchIdx(0);
    setError("");
  }

  if (selected || initialBookId) {
    const shown = detail ?? selected;
    const percent = ratingPercent(shown?.rating ?? null);
    const people = formatRatingCount(shown?.ratingCount ?? null);
    const total =
      (detail?.ratingGood ?? 0) + (detail?.ratingFair ?? 0) + (detail?.ratingPoor ?? 0);
    // 从书城列表点进来的，返回回书城；从主页直接点进来的，返回就是回主页。
    const back = selected ? () => setSelected(null) : onBack;
    return (
      <section className="store store--detail" aria-label="书籍详情">
        <header className="ios-nav-bar">
          <button type="button" className="ios-back" onClick={back}>
            <ChevronLeft size={22} />
            {selected ? "书城" : "主页"}
          </button>
          <span>{shown?.title ?? "书籍详情"}</span>
        </header>

        <div className="store-detail__hero">
          {shown ? (
            <>
              <Cover book={shown} size="large" />
              <div>
                <h2>{shown.title}</h2>
                <p>{shown.author || "作者未提供"}</p>
                {shown.translator ? <small>{shown.translator} 译</small> : null}
                <Rating book={shown} />
              </div>
            </>
          ) : (
            <>
              <span className="store-skeleton store-skeleton--hero" />
              <div className="store-detail__hero-lines">
                <span className="store-skeleton store-skeleton--line" />
                <span className="store-skeleton store-skeleton--line store-skeleton--short" />
              </div>
            </>
          )}
        </div>

        {detail && total > 0 && percent ? (
          <div className="store-bars" aria-label="评分分布">
            {([
              ["好评", detail.ratingGood ?? 0, "good"],
              ["一般", detail.ratingFair ?? 0, "fair"],
              ["差评", detail.ratingPoor ?? 0, "poor"],
            ] as const).map(([label, value, tone]) => (
              <div className="store-bar" key={tone}>
                <span className="store-bar__label">{label}</span>
                <span className="store-bar__track">
                  <i
                    className={`store-bar__fill store-bar__fill--${tone}`}
                    style={{ width: `${(value / total) * 100}%` }}
                  />
                </span>
                <span className="store-bar__value">{Math.round((value / total) * 100)}%</span>
              </div>
            ))}
            <p className="store-bars__note">共 {people} 评价</p>
          </div>
        ) : null}

        <div className="store-detail__actions">
          <button
            type="button"
            className="primary-button"
            disabled={!shown}
            onClick={() => shown && onFindBook(shown.title, shown.author)}
          >
            去找这本书
            <ArrowRight size={17} />
          </button>
        </div>

        <div className="store-detail__body">
          <h3>简介</h3>
          {detailError ? (
            <p className="store-error" role="alert">{detailError}</p>
          ) : shown?.intro ? (
            <p>{shown.intro}</p>
          ) : detail ? (
            <p className="store-muted">这本书没有提供简介。</p>
          ) : (
            <p className="store-muted" role="status">正在读取简介…</p>
          )}
          {shown?.category ? <span className="store-tag">{shown.category}</span> : null}
        </div>

        <p className="store-credit">
          书目、推荐值与封面来自微信读书。墨听不提供下载，「去找这本书」会带你到在线找书。
        </p>
      </section>
    );
  }

  if (expanded) {
    return (
      <section className="store" aria-label={expanded.title}>
        <header className="ios-nav-bar">
          <button type="button" className="ios-back" onClick={() => setExpanded(null)}>
            <ChevronLeft size={22} />
            书城
          </button>
          <span>{expanded.title}</span>
        </header>
        <p className="store-expanded__note">
          {expanded.subtitle} · 共 {expanded.books.length} 本
        </p>
        <div className="store-results">
          {expanded.books.map((book, index) => (
            <StoreRow key={book.bookId} book={book} priority={index < 4} onOpen={openBook} />
          ))}
        </div>
      </section>
    );
  }

  const rankShown = rankAll ? rank : rank.slice(0, RANK_PREVIEW);

  return (
    <section className="store" aria-label="书城">
      <header className="ios-nav-bar">
        <button type="button" className="ios-back" onClick={onBack}>
          <ChevronLeft size={22} />
          主页
        </button>
        <span>书城</span>
      </header>

      <form className="store-search" role="search" onSubmit={submitSearch}>
        <label className="ios-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="在书城搜索书名或作者"
            placeholder="搜索书名或作者"
            value={query}
            maxLength={100}
            enterKeyHint="search"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" aria-label="清除搜索" onClick={clearSearch}>
              <X size={15} />
            </button>
          ) : null}
        </label>
        <button className="primary-button" type="submit" disabled={!query.trim() || searching}>
          搜索
        </button>
      </form>

      {error ? <p className="store-error" role="alert">{error}</p> : null}

      {results ? (
        <div className="store-results">
          <div className="store-lane__head">
            <h3>搜索结果</h3>
            <button type="button" className="text-button" onClick={clearSearch}>
              回到书城
            </button>
          </div>
          {results.map((book, index) => (
            <StoreRow key={book.bookId} book={book} priority={index < 4} onOpen={openBook} />
          ))}
          {searching ? (
            <p className="store-muted" role="status">正在搜索…</p>
          ) : null}
          {!searching && !results.length ? (
            <div className="store-empty">
              <BookOpen size={26} />
              <h3>没有找到这本书</h3>
              <p>换个书名或作者再试试。</p>
            </div>
          ) : null}
          {searchMore && !searching ? (
            <button
              type="button"
              className="secondary-button store-more"
              onClick={() => runSearch(query.trim(), searchIdx)}
            >
              更多结果
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="store-lane">
            <div className="store-lane__head">
              <div>
                <h3>
                  {mode === "rank" ? <Trophy size={15} aria-hidden="true" /> : null}
                  {mode === "rank" ? `${category}榜` : category}
                </h3>
                <small>
                  {mode === "rank"
                    ? `按微信读书推荐值排序${rankPool ? ` · 从 ${rankPool} 本里挑的` : ""}，墨听自己排的`
                    : "这个分类下的书，按微信读书的顺序，可以一直往下翻"}
                </small>
              </div>
            </div>

            <div className="store-chips" role="group" aria-label="榜单分类">
              {WEREAD_CATEGORIES.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={item === category}
                  onClick={() => pickCategory(item)}
                >
                  {item}
                </button>
              ))}
            </div>

            <div className="store-modes" role="group" aria-label="查看方式">
              <button type="button" aria-pressed={mode === "rank"} onClick={() => pickMode("rank")}>
                榜单
              </button>
              <button
                type="button"
                aria-pressed={mode === "browse"}
                onClick={() => pickMode("browse")}
              >
                全部
              </button>
            </div>

            {mode === "browse" ? (
              browseError && !browse.length ? (
                <p className="store-error" role="alert">{browseError}</p>
              ) : !browse.length && browseLoading ? (
                <RankSkeleton />
              ) : (
                <>
                  <div className="store-ranklist">
                    {browse.map((book, index) => (
                      <StoreRow
                        key={book.bookId}
                        book={book}
                        priority={index < RANK_PREVIEW}
                        onOpen={openBook}
                      />
                    ))}
                  </div>
                  {browseLoading ? (
                    <p className="store-muted store-rank-empty" role="status">正在加载…</p>
                  ) : browseMore ? (
                    <button
                      type="button"
                      className="secondary-button store-more"
                      onClick={() => loadBrowse(category, browseIdx)}
                    >
                      再看 20 本（已看 {browse.length} 本）
                    </button>
                  ) : (
                    <p className="store-muted store-rank-empty">这个分类翻到底了。</p>
                  )}
                </>
              )
            ) : rankLoading ? (
              <RankSkeleton />
            ) : rankError ? (
              <p className="store-error" role="alert">{rankError}</p>
            ) : rank.length ? (
              <>
                <div className="store-ranklist">
                  {rankShown.map((book, index) => (
                    <StoreRow
                      key={book.bookId}
                      book={book}
                      rank={index + 1}
                      priority={index < RANK_PREVIEW}
                      onOpen={openBook}
                    />
                  ))}
                </div>
                {rank.length > rankShown.length ? (
                  <button
                    type="button"
                    className="secondary-button store-more"
                    onClick={() => setRankAll(true)}
                  >
                    看完整榜单（{rank.length} 本）
                  </button>
                ) : null}
              </>
            ) : (
              <p className="store-muted store-rank-empty">
                这个分类里评分人数够多的书太少，排不出可信的榜。换个分类试试。
              </p>
            )}
          </div>

          {loading ? (
            <>
              <LaneSkeleton />
              <LaneSkeleton />
            </>
          ) : (
            lanes.map((lane) => (
              <div className="store-lane" key={lane.kind}>
                <div className="store-lane__head">
                  <div>
                    <h3>{lane.title}</h3>
                    <small>{lane.subtitle}</small>
                  </div>
                  {lane.books.length > LANE_PREVIEW ? (
                    <button
                      type="button"
                      className="text-button store-lane__more"
                      onClick={() =>
                        setExpanded({
                          title: lane.title,
                          subtitle: lane.subtitle,
                          books: lane.books,
                        })
                      }
                    >
                      全部
                      <ChevronRight size={15} />
                    </button>
                  ) : null}
                </div>
                <div className="store-lane__track">
                  {lane.books.slice(0, LANE_PREVIEW).map((book, index) => (
                    <StoreCard
                      key={`${lane.kind}-${book.bookId}`}
                      book={book}
                      priority={index < 2}
                      onOpen={openBook}
                    />
                  ))}
                </div>
              </div>
            ))
          )}

          <p className="store-credit">
            书目、推荐值与封面来自微信读书。榜单是墨听按推荐值在搜索结果里排的，不是微信读书的官方榜单。
          </p>
        </>
      )}
    </section>
  );
}
