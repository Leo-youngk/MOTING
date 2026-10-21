"use client";

import { ChevronRight, RefreshCw, Trophy } from "lucide-react";
import { useStoreDiscovery } from "../hooks/use-store-discovery";
import { RANKING_LABELS, rememberRanking } from "../lib/store-catalog";
import { rememberCategory } from "../lib/weread-types";
import type { BookMeta, ReadingSession } from "../lib/types";
import { StoreCard, StoreCardSkeleton, StoreRow, StoreRowSkeleton } from "./bookstore";
import "./home-store.css";

/** 主页与完整书城共享推荐；只在主动换批或新一天进入时更换。 */
export function HomeStore({ books, sessions, onOpenStore, onOpenBook }: {
  books: BookMeta[];
  sessions: ReadingSession[];
  onOpenStore: () => void;
  onOpenBook: (bookId: string) => void;
}) {
  const { feed, board, loading, error, notice, shuffle, shuffleBoard } = useStoreDiscovery(books, sessions);

  function openBoard() {
    if (board) {
      rememberCategory(board.category);
      rememberRanking(board.kind);
    }
    onOpenStore();
  }

  return (
    <>
      <section className="home-row home-store" aria-label="为你推荐">
        <div className="section-head">
          <h2>为你推荐</h2>
          <div className="section-head__actions">
            <button type="button" className="section-link" disabled={loading} onClick={shuffle}>
              <RefreshCw size={13} aria-hidden="true" />
              换一批
            </button>
            <button type="button" className="section-link" onClick={onOpenStore}>
              查看全部<ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="home-row__track" aria-busy={loading}>
          {loading && !feed?.books.length
            ? Array.from({ length: 4 }, (_, i) => <StoreCardSkeleton key={i} />)
            : feed?.books.slice(0, 8).map((book, i) => (
                <StoreCard key={book.bookId} book={book} priority={i < 3}
                  onOpen={(target) => onOpenBook(target.bookId)} />
              ))}
        </div>
        {error || notice ? <p className="home-store__quiet" role="status">{error || notice}</p> : null}
        {!loading && !error && !feed?.books.length
          ? <p className="home-store__quiet">暂时没有合适的推荐，可以去书城换个分类逛逛。</p> : null}
      </section>

      {loading || board ? (
        <section className="home-store__rank" aria-label="今日榜单选看">
          <div className="section-head">
            <h2><Trophy size={17} aria-hidden="true" />
              {board ? `${board.category} · ${RANKING_LABELS[board.kind]}` : "今日榜单"}
            </h2>
            <div className="section-head__actions">
              <button type="button" className="section-link" disabled={loading} onClick={shuffleBoard}>换个榜</button>
              <button type="button" className="section-link" onClick={openBoard} aria-label="查看当前完整榜单">
                全部<ChevronRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
          <p className="home-store__note">
            {board
              ? `选看第 ${board.entries[0].rank}～${board.entries.at(-1)!.rank} 名 · 墨听整理`
              : "每天换个角度，发现更多好书"}
          </p>
          <div className="store-ranklist" aria-busy={loading && !board}>
            {!board
              ? Array.from({ length: 3 }, (_, i) => <StoreRowSkeleton key={i} />)
              : board.entries.map(({ book, rank }) => (
                  <StoreRow key={book.bookId} book={book} rank={rank} priority
                    onOpen={(target) => onOpenBook(target.bookId)} />
                ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
