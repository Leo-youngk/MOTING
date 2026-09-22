"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, BookOpen, ExternalLink, Search, X } from "lucide-react";
import { fetchDiscoveryDetail, fetchDiscoveryPage } from "../lib/discovery";
import {
  DISCOVERY_TOPICS,
  type DiscoveryBook,
  type DiscoveryDetail,
  type DiscoveryLanguage,
  type DiscoverySelection,
} from "../lib/discovery-types";
import "./discovery.css";

function BookImage({ book, large = false }: { book: DiscoveryBook; large?: boolean }) {
  return (
    <span className={`discovery-cover${large ? " discovery-cover--large" : ""}`}>
      <span className="discovery-cover__fallback"><BookOpen size={large ? 30 : 22} aria-hidden="true" /><span>{book.title}</span></span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {book.coverUrl ? <img src={book.coverUrl} alt="" loading={large ? "eager" : "lazy"} referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
    </span>
  );
}

export function Discovery({ onFindBook }: { onFindBook: (title: string) => void }) {
  const [selection, setSelection] = useState<DiscoverySelection>({ kind: "topic", value: "literature" });
  const [language, setLanguage] = useState<DiscoveryLanguage>("all");
  const [query, setQuery] = useState("");
  const [books, setBooks] = useState<DiscoveryBook[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<DiscoveryBook | null>(null);
  const [detail, setDetail] = useState<DiscoveryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const pageController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    pageController.current = controller;
    fetchDiscoveryPage(selection, language, 1, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setBooks(result.books);
      setPage(result.page);
      setHasMore(result.hasMore);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "书目加载失败，请重试");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [selection, language]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    fetchDiscoveryDetail(selected.workId, controller.signal).then((data) => {
      if (!controller.signal.aborted) setDetail(data);
    }).catch((reason) => {
      if (!controller.signal.aborted) setDetailError(reason instanceof Error ? reason.message : "书籍详情加载失败");
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false);
    });
    return () => controller.abort();
  }, [selected]);

  function resetPage() {
    pageController.current?.abort();
    setLoading(true);
    setLoadingMore(false);
    setBooks([]);
    setPage(0);
    setHasMore(false);
    setError("");
  }

  function selectTopic(topic: (typeof DISCOVERY_TOPICS)[number]["id"]) {
    resetPage();
    setQuery("");
    setSelection({ kind: "topic", value: topic });
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    (document.activeElement as HTMLElement)?.blur();
    resetPage();
    setSelection({ kind: "search", value });
  }

  async function loadMore() {
    if (loading || loadingMore || !hasMore || !page) return;
    const controller = new AbortController();
    pageController.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const result = await fetchDiscoveryPage(selection, language, page + 1, controller.signal);
      if (controller.signal.aborted) return;
      setBooks((current) => [...new Map([...current, ...result.books].map((book) => [book.workId, book])).values()]);
      setPage(result.page);
      setHasMore(result.hasMore);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "更多书目加载失败，请重试");
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  function openBook(book: DiscoveryBook) {
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    setSelected(book);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function retryDetail() {
    if (!selected) return;
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    setSelected({ ...selected });
  }

  function retryPage() {
    if (books.length && hasMore) {
      void loadMore();
      return;
    }
    resetPage();
    setSelection({ ...selection });
  }

  if (selected) {
    return (
      <section className="discovery discovery--detail" aria-label="书籍详情">
        <button type="button" className="discovery-back" onClick={() => setSelected(null)}><ArrowLeft size={17} />返回发现</button>
        <div className="discovery-detail__hero">
          <BookImage book={selected} large />
          <div className="discovery-detail__identity">
            <span className="discovery-eyebrow">书籍资料</span>
            <h2>{selected.title}</h2>
            <p>{selected.author || "作者未提供"}</p>
            <small>{selected.year ? `${selected.year} 年首次出版` : "出版年份未提供"}</small>
          </div>
        </div>
        <div className="discovery-detail__actions">
          <button type="button" className="primary-button" onClick={() => onFindBook(selected.title)}>找这本书<ArrowRight size={17} /></button>
          <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer">在 Open Library 查看<ExternalLink size={14} /></a>
        </div>
        <div className="discovery-detail__body" aria-busy={detailLoading}>
          <h3>关于这本书</h3>
          {detailLoading ? <p className="discovery-detail__muted" role="status">正在读取书籍简介…</p>
            : detailError ? <p className="discovery-error" role="alert">{detailError}。<button type="button" onClick={retryDetail}>重试</button></p>
              : <p className={detail?.description ? "discovery-detail__description" : "discovery-detail__muted"}>{detail?.description || "Open Library 暂无这本书的简介。"}</p>}
          {detail?.subjects.length ? <div className="discovery-detail__subjects" aria-label="书籍主题">{detail.subjects.map((subject) => <span key={subject}>{subject}</span>)}</div> : null}
        </div>
        <p className="discovery-credit">书目资料来自 Open Library。找到的书籍信息不代表在线找书一定有可用版本。</p>
      </section>
    );
  }

  return (
    <section className="discovery" aria-label="发现书籍">
      <div className="discovery-intro">
        <span className="discovery-eyebrow">OPEN LIBRARY · DISCOVER</span>
        <h2>发现下一本好书</h2>
        <p>从世界书目中，按兴趣慢慢逛。</p>
      </div>
      <form className="discovery-search" role="search" onSubmit={submitSearch}>
        <label className="ios-search">
          <Search size={16} aria-hidden="true" />
          <input aria-label="发现书籍搜索" placeholder="搜索书名或作者" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} enterKeyHint="search" />
          {query ? <button type="button" aria-label="清除发现搜索" onClick={() => setQuery("")}><X size={15} /></button> : null}
        </label>
        <button className="primary-button" type="submit" disabled={!query.trim()}>搜索</button>
      </form>
      <div className="discovery-categories" role="group" aria-label="书籍分类">
        {DISCOVERY_TOPICS.map((topic) => (
          <button key={topic.id} type="button" aria-pressed={selection.kind === "topic" && selection.value === topic.id} onClick={() => selectTopic(topic.id)}>{topic.label}</button>
        ))}
      </div>
      <div className="discovery-heading">
        <div>
          <span className="discovery-eyebrow">EXPLORE THE SHELVES</span>
          <h3>{selection.kind === "topic" ? DISCOVERY_TOPICS.find((topic) => topic.id === selection.value)?.label : `“${selection.value}”的结果`}</h3>
        </div>
        <label>版本语言
          <select aria-label="书籍版本语言" value={language} onChange={(event) => { resetPage(); setLanguage(event.target.value as DiscoveryLanguage); }}>
            <option value="all">全部</option>
            <option value="zh">中文</option>
            <option value="en">英文</option>
          </select>
        </label>
      </div>
      {loading ? <div className="discovery-grid" role="status" aria-label="正在加载书目">{Array.from({ length: 8 }, (_, index) => <div className="discovery-skeleton" key={index}><span /><i /><i /></div>)}</div>
        : books.length ? <div className="discovery-grid">{books.map((book) => (
          <button type="button" className="discovery-card" key={book.workId} aria-label={`查看《${book.title}》详情`} onClick={() => openBook(book)}>
            <BookImage book={book} />
            <span className="discovery-card__title">{book.title}</span>
            <span className="discovery-card__author">{book.author || "作者未提供"}</span>
            <span className="discovery-card__year">{book.year ? `${book.year} 年` : "年份未提供"}</span>
          </button>
        ))}</div>
          : !error ? <div className="discovery-empty"><BookOpen size={28} /><h3>这里还没有找到书</h3><p>换个分类、语言，或搜索其他书名试试。</p></div> : null}
      {error ? <div className="discovery-error" role="alert">{error}<button type="button" onClick={retryPage}>重试</button></div> : null}
      {hasMore && !loading ? <button className="discovery-more secondary-button" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在加载…" : "再看一些"}</button> : null}
      <p className="discovery-credit">书目资料来自 <a href="https://openlibrary.org" target="_blank" rel="noopener noreferrer">Open Library</a>。语言表示有对应版本，书籍信息可能不完整。</p>
    </section>
  );
}
