"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Search, Sparkles, X } from "lucide-react";
import {
  buildTopRated,
  fetchWereadBook,
  fetchWereadRecommend,
  fetchWereadSimilar,
  searchWeread,
  wereadCoverUrl,
} from "../lib/weread";
import {
  formatRatingCount,
  formatReadingCount,
  ratingPercent,
  RATING_TRUSTWORTHY_COUNT,
  type WereadBook,
  type WereadBookDetail,
  type WereadLane,
} from "../lib/weread-types";
import type { Book } from "../lib/types";
import "./bookstore.css";

const TOP_RATED_LIMIT = 8;

function Cover({ book, large = false }: { book: WereadBook; large?: boolean }) {
  return (
    <span className={`store-cover${large ? " store-cover--large" : ""}`}>
      <BookOpen size={large ? 26 : 18} aria-hidden="true" />
      {book.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={wereadCoverUrl(book.coverUrl, large ? "full" : "thumb")}
          alt=""
          loading={large ? "eager" : "lazy"}
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
function Rating({ book, compact = false }: { book: WereadBook; compact?: boolean }) {
  const percent = ratingPercent(book.rating);
  const people = formatRatingCount(book.ratingCount);
  const trusted = (book.ratingCount ?? 0) >= RATING_TRUSTWORTHY_COUNT;

  if (!percent || !trusted) {
    const reading = formatReadingCount(book.readingCount);
    if (people && !trusted) {
      return <span className="store-rating store-rating--thin">评分人数偏少 · {people}</span>;
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

function StoreCard({ book, onOpen }: { book: WereadBook; onOpen: (book: WereadBook) => void }) {
  return (
    <button type="button" className="store-card" onClick={() => onOpen(book)}>
      <Cover book={book} />
      <span className="store-card__title">{book.title}</span>
      <span className="store-card__author">{book.author || "作者未提供"}</span>
      <Rating book={book} compact />
    </button>
  );
}

function StoreRow({ book, onOpen }: { book: WereadBook; onOpen: (book: WereadBook) => void }) {
  return (
    <button type="button" className="store-row" onClick={() => onOpen(book)}>
      <Cover book={book} />
      <span className="store-row__info">
        <strong>{book.title}</strong>
        <small>{book.author || "作者未提供"}</small>
        <Rating book={book} />
      </span>
    </button>
  );
}

function LaneSkeleton() {
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

export function Bookstore({
  books,
  onFindBook,
}: {
  /** 本地书库。最近读的那本会被当成「相似推荐」的种子。 */
  books: Book[];
  onFindBook: (title: string) => void;
}) {
  const [lanes, setLanes] = useState<WereadLane[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WereadBook[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<WereadBook | null>(null);
  const [detail, setDetail] = useState<WereadBookDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const searchController = useRef<AbortController | null>(null);

  // 种子取最近打开、且不是内置示例的那本书。没有就只出「为你推荐」。
  const seed = books.find((book) => book.format !== "demo");
  const seedTitle = seed?.title ?? "";

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;

    // 刻意不在开头 setLoading(true)：换种子时保留旧内容直到新数据到位，
    // 既避开在 effect 同步阶段 setState，也不会让整页闪一下骨架屏再跳回来。
    const loadLanes = async () => {
      const next: WereadLane[] = [];
      const pool: WereadBook[] = [];

      try {
        const recommend = await fetchWereadRecommend(0, 12, signal);
        if (signal.aborted) return;
        if (recommend.books.length) {
          pool.push(...recommend.books);
          next.push({
            kind: "recommend",
            title: "为你推荐",
            subtitle: "微信读书按你的阅读记录挑的",
            books: recommend.books,
          });
        }
      } catch (reason) {
        if (signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "书城暂时打不开");
        setLoading(false);
        return;
      }

      // 相似推荐要先拿种子书在微信读书里的 bookId，本地书库里没有这个 id。
      if (seedTitle) {
        try {
          const matched = await searchWeread(seedTitle, 0, 1, signal);
          const target = matched.books[0];
          if (target && !signal.aborted) {
            const similar = await fetchWereadSimilar(target.bookId, 0, 8, "", signal);
            if (similar.books.length && !signal.aborted) {
              pool.push(...similar.books);
              next.push({
                kind: "similar",
                title: `因为你在读《${seedTitle}》`,
                seedTitle,
                subtitle: "微信读书的相似推荐",
                books: similar.books,
              });
            }
          }
        } catch {
          // 相似推荐拿不到就少一条流，不影响书城其余部分。
        }
      }
      if (signal.aborted) return;

      // 「高分好书」是本地按推荐值合成的，不是微信读书的官方榜单——副标题里写清楚。
      const top = buildTopRated(pool, RATING_TRUSTWORTHY_COUNT, TOP_RATED_LIMIT);
      if (top.length >= 3) {
        next.push({
          kind: "top-rated",
          title: "高分好书",
          subtitle: "本页书目里推荐值最高的几本，墨听自己排的",
          books: top,
        });
      }

      setLanes(next);
      setError("");
      setLoading(false);
    };

    void loadLanes();
    return () => controller.abort();
  }, [seedTitle]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    fetchWereadBook(selected.bookId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setDetail(data);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setDetailError(reason instanceof Error ? reason.message : "书籍详情读取失败");
        }
      });
    return () => controller.abort();
  }, [selected]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const keyword = query.trim();
    if (!keyword) return;
    (document.activeElement as HTMLElement)?.blur();
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    setError("");
    searchWeread(keyword, 0, 10, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResults(data.books);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "搜索失败，请重试");
          setResults([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
  }

  function openBook(book: WereadBook) {
    setDetail(null);
    setDetailError("");
    setSelected(book);
  }

  function clearSearch() {
    searchController.current?.abort();
    setQuery("");
    setResults(null);
    setSearching(false);
    setError("");
  }

  if (selected) {
    const shown = detail ?? selected;
    const percent = ratingPercent(shown.rating);
    const people = formatRatingCount(shown.ratingCount);
    const total = (detail?.ratingGood ?? 0) + (detail?.ratingFair ?? 0) + (detail?.ratingPoor ?? 0);
    return (
      <section className="store store--detail" aria-label="书籍详情">
        <button type="button" className="store-back" onClick={() => setSelected(null)}>
          <ArrowLeft size={17} />
          返回书城
        </button>

        <div className="store-detail__hero">
          <Cover book={shown} large />
          <div>
            <h2>{shown.title}</h2>
            <p>{shown.author || "作者未提供"}</p>
            {shown.translator ? <small>{shown.translator} 译</small> : null}
            <Rating book={shown} />
          </div>
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
                  <i className={`store-bar__fill store-bar__fill--${tone}`} style={{ width: `${(value / total) * 100}%` }} />
                </span>
                <span className="store-bar__value">{Math.round((value / total) * 100)}%</span>
              </div>
            ))}
            <p className="store-bars__note">共 {people} 评价</p>
          </div>
        ) : null}

        <div className="store-detail__actions">
          <button type="button" className="primary-button" onClick={() => onFindBook(shown.title)}>
            去找这本书
            <ArrowRight size={17} />
          </button>
        </div>

        <div className="store-detail__body">
          <h3>简介</h3>
          {detailError ? (
            <p className="store-error" role="alert">{detailError}</p>
          ) : shown.intro ? (
            <p>{shown.intro}</p>
          ) : detail ? (
            <p className="store-muted">这本书没有提供简介。</p>
          ) : (
            <p className="store-muted" role="status">正在读取简介…</p>
          )}
          {shown.category ? <span className="store-tag">{shown.category}</span> : null}
        </div>

        <p className="store-credit">
          书目、推荐值与封面来自微信读书。墨听不提供下载，「去找这本书」会带你到在线找书。
        </p>
      </section>
    );
  }

  return (
    <section className="store" aria-label="书城">
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

      {error ? (
        <p className="store-error" role="alert">{error}</p>
      ) : null}

      {results ? (
        <div className="store-results">
          <div className="store-lane__head">
            <h3>搜索结果</h3>
            <button type="button" className="text-button" onClick={clearSearch}>回到书城</button>
          </div>
          {searching ? (
            <p className="store-muted" role="status">正在搜索…</p>
          ) : results.length ? (
            results.map((book) => <StoreRow key={book.bookId} book={book} onOpen={openBook} />)
          ) : (
            <div className="store-empty">
              <BookOpen size={26} />
              <h3>没有找到这本书</h3>
              <p>微信读书按书名精确匹配，换个写法再试试。</p>
            </div>
          )}
        </div>
      ) : loading ? (
        <>
          <LaneSkeleton />
          <LaneSkeleton />
        </>
      ) : lanes.length ? (
        lanes.map((lane) => (
          <div className="store-lane" key={lane.kind}>
            <div className="store-lane__head">
              <div>
                <h3>
                  {lane.kind === "top-rated" ? <Sparkles size={15} aria-hidden="true" /> : null}
                  {lane.title}
                </h3>
                <small>{lane.subtitle}</small>
              </div>
            </div>
            <div className="store-lane__track">
              {lane.books.map((book) => (
                <StoreCard key={`${lane.kind}-${book.bookId}`} book={book} onOpen={openBook} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="store-empty">
          <BookOpen size={26} />
          <h3>书城暂时没有内容</h3>
          <p>稍后再来，或直接用上面的搜索找书。</p>
        </div>
      )}

      {!results && !loading ? (
        <p className="store-credit">书目、推荐值与封面来自微信读书。</p>
      ) : null}
    </section>
  );
}
