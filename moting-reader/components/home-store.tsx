"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw, Trophy } from "lucide-react";
import { fetchWereadRank, fetchWereadRecommend } from "../lib/weread";
import { WEREAD_CATEGORIES, type WereadBook } from "../lib/weread-types";
import { StoreCard, StoreRow } from "./bookstore";
import "./home-store.css";

/** 主页只露这么多。再多就把下面的阅读看板挤出屏幕，逛完整的去书城。 */
const FEED_COUNT = 8;
const RANK_COUNT = 3;
/** 主页固定看这一个分类的榜，换分类是书城里的事。 */
const RANK_CATEGORY = WEREAD_CATEGORIES[0];

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

  const [rank, setRank] = useState<WereadBook[]>([]);
  const [rankLoading, setRankLoading] = useState(true);

  const loadFeed = useCallback((fromIdx: number) => {
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
          setFeed(data.books);
          setFeedIdx(data.hasMore ? data.nextIdx : 0);
          setFeedFailed(false);
          setFeedLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setFeedFailed(true);
          setFeedLoading(false);
        });
    }

    run(fromIdx, false);
  }, []);

  useEffect(() => {
    loadFeed(0);
    return () => feedController.current?.abort();
  }, [loadFeed]);

  useEffect(() => {
    const controller = new AbortController();
    fetchWereadRank(RANK_CATEGORY, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setRank(data.books.slice(0, RANK_COUNT));
          setRankLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setRankLoading(false);
      });
    return () => controller.abort();
  }, []);

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

        <div className="home-store__subhead">
          <small>为你推荐 · 微信读书按你的阅读记录挑的</small>
          <button
            type="button"
            className="text-button"
            disabled={feedLoading || feedFailed}
            onClick={() => {
              setFeedLoading(true);
              loadFeed(feedIdx);
            }}
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
            : feed.map((book, index) => (
                <StoreCard
                  key={book.bookId}
                  book={book}
                  priority={index < 3}
                  onOpen={(target) => onOpenBook(target.bookId)}
                />
              ))}
        </div>
      </section>

      {rankLoading || rank.length ? (
        <section className="home-store__rank">
          <div className="home-store__rank-head">
            <h3>
              <Trophy size={15} aria-hidden="true" />
              {RANK_CATEGORY}榜
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
