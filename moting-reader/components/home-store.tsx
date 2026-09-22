"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw, Trophy } from "lucide-react";
import { fetchWereadRecommend } from "../lib/weread";
import { loadCatalog, rankOf } from "../lib/store-catalog";
import { preferredCategory, type WereadBook } from "../lib/weread-types";
import { StoreCard, StoreRow } from "./bookstore";
import "./home-store.css";

/**
 * 一次取 20 本，主页只露 8 本。
 *
 * 20 这个数字不是随便定的：书城页的「为你推荐」取的就是 (0, 20)，主页跟它对齐
 * 才能共用同一份边缘缓存——进书城时那条流是现成的，不用再冷启一次。
 */
const FEED_COUNT = 20;
const FEED_SHOWN = 8;
const RANK_COUNT = 3;

/**
 * 主页的书城条：为你推荐一条横滑 + 一个榜的前三名。
 *
 * 这里是「逛」的入口，不是书城本身——所有要挑、要筛、要搜的动作都在书城页里，
 * 主页只负责让人一眼看见有什么新东西，以及一个「全部」的去处。
 */
export function HomeStore({
  onOpenStore,
  onOpenBook,
}: {
  onOpenStore: () => void;
  onOpenBook: (bookId: string) => void;
}) {
  const [feed, setFeed] = useState<WereadBook[]>([]);
  const [feedIdx, setFeedIdx] = useState(0);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedFailed, setFeedFailed] = useState(false);
  const feedController = useRef<AbortController | null>(null);
  /** 后台先取好的下一批。「换一批」点下去时直接换上，不用现场等网络。 */
  const ahead = useRef<{ from: number; books: WereadBook[]; next: number } | null>(null);
  const aheadController = useRef<AbortController | null>(null);

  const [category] = useState(() => preferredCategory());
  const [rank, setRank] = useState<WereadBook[]>([]);
  const [rankLoading, setRankLoading] = useState(true);

  /**
   * 预取下一批。
   *
   * 「换一批」每次换的是新的 maxIdx，也就是每次都是一个没被缓存过的请求——
   * 实测回源要 2.8 秒，点下去干等。趁用户在看这一批，先把下一批取回来。
   */
  const prefetch = useCallback((from: number) => {
    aheadController.current?.abort();
    const controller = new AbortController();
    aheadController.current = controller;
    ahead.current = null;
    fetchWereadRecommend(from, FEED_COUNT, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || !data.books.length) return;
        ahead.current = { from, books: data.books, next: data.hasMore ? data.nextIdx : 0 };
      })
      .catch(() => {
        // 预取失败无所谓，点「换一批」时还会正常走一次请求。
      });
  }, []);

  const loadFeed = useCallback(
    (fromIdx: number) => {
      feedController.current?.abort();
      const controller = new AbortController();
      feedController.current = controller;

      // 用函数声明是为了能自己回头调一次：翻到池子尽头时从头再来，
      // 这样「换一批」永远换得出东西。retried 保证最多回头一次，不会转圈。
      function run(idx: number, retried: boolean) {
        fetchWereadRecommend(idx, FEED_COUNT, controller.signal)
          .then((data) => {
            if (controller.signal.aborted) return;
            if (!data.books.length && idx > 0 && !retried) {
              run(0, true);
              return;
            }
            const next = data.hasMore ? data.nextIdx : 0;
            setFeed(data.books);
            setFeedIdx(next);
            setFeedFailed(false);
            setFeedLoading(false);
            prefetch(next);
          })
          .catch(() => {
            if (controller.signal.aborted) return;
            setFeedFailed(true);
            setFeedLoading(false);
          });
      }

      run(fromIdx, false);
    },
    [prefetch]
  );

  function shuffle() {
    const ready = ahead.current;
    if (ready && ready.from === feedIdx) {
      ahead.current = null;
      setFeed(ready.books);
      setFeedIdx(ready.next);
      prefetch(ready.next);
      return;
    }
    setFeedLoading(true);
    loadFeed(feedIdx);
  }

  useEffect(() => {
    loadFeed(0);
    return () => {
      feedController.current?.abort();
      aheadController.current?.abort();
    };
  }, [loadFeed]);

  useEffect(() => {
    let alive = true;
    // 书目是本地文件，这一下基本不花时间。
    loadCatalog(category)
      .then((data) => {
        if (!alive) return;
        setRank(rankOf(data.books, RANK_COUNT));
        setRankLoading(false);
      })
      .catch(() => {
        if (alive) setRankLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [category]);

  // 两块都没拿到就只留一行交代，别在主页上摆一块空白或者红色报错。
  if (feedFailed && !rankLoading && !rank.length) {
    return (
      <section className="home-store__down">
        <p>书城暂时打不开，稍后再试。</p>
      </section>
    );
  }

  return (
    <>
      <section className="home-row home-store">
        <div className="home-store__head">
          <h2 className="home-row__title home-store__title">书城</h2>
          <button type="button" className="text-button" onClick={onOpenStore}>
            全部
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>

        {/* 推荐要实时查接口，它挂了就只收起这一段，榜单读的是本地书目，照常显示。 */}
        {feedFailed ? (
          <p className="home-store__subhead home-store__quiet">推荐暂时取不到，先看看榜单</p>
        ) : (
          <>
            <div className="home-store__subhead">
              <small>为你推荐 · 微信读书按你的阅读记录挑的</small>
              <button
                type="button"
                className="text-button"
                disabled={feedLoading}
                onClick={shuffle}
              >
                <RefreshCw size={13} aria-hidden="true" />
                换一批
              </button>
            </div>

            <div className="home-row__track" aria-busy={feedLoading}>
              {feedLoading && !feed.length
                ? Array.from({ length: 4 }, (_, index) => (
                    <div className="store-skeleton store-skeleton--card" key={index} />
                  ))
                : feed.slice(0, FEED_SHOWN).map((book, index) => (
                    <StoreCard
                      key={book.bookId}
                      book={book}
                      priority={index < 3}
                      onOpen={(target) => onOpenBook(target.bookId)}
                    />
                  ))}
            </div>
          </>
        )}
      </section>

      {rankLoading || rank.length ? (
        <section className="home-store__rank">
          <div className="home-store__rank-head">
            <h3>
              <Trophy size={15} aria-hidden="true" />
              {category}榜
            </h3>
            <small>按微信读书推荐值排序，墨听自己排的</small>
          </div>

          {rankLoading ? (
            <div className="store-ranklist" role="status" aria-label="正在加载榜单">
              {Array.from({ length: RANK_COUNT }, (_, index) => (
                <div className="store-skeleton store-skeleton--row" key={index} />
              ))}
            </div>
          ) : (
            <div className="store-ranklist">
              {rank.map((book, index) => (
                <StoreRow
                  key={book.bookId}
                  book={book}
                  rank={index + 1}
                  // 榜只有三行，滚一下就到，别让它懒加载出一排空封面。
                  priority
                  onOpen={(target) => onOpenBook(target.bookId)}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
