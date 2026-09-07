"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { BookOpen, Check, Download, LoaderCircle, Search, UserRound, X } from "lucide-react";
import { downloadZlibrary, getZlibrarySession, loginZlibrary, logoutZlibrary, searchZlibrary, ZlibraryError } from "../lib/zlibrary";
import { ONLINE_BOOK_FORMATS, ONLINE_BOOK_MAX_BYTES, type OnlineBook } from "../lib/zlibrary-types";
import type { Book } from "../lib/types";

export function OnlineLibrary({ books, onImport, onOpen }: {
  books: Book[];
  onImport: (file: File, sourceId: string, onProgress: (label: string) => void) => Promise<void>;
  onOpen: (book: Book) => void;
}) {
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState("");
  const [results, setResults] = useState<OnlineBook[]>([]);
  const [lastSearch, setLastSearch] = useState<{ query: string; format: string; page: number } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [downloading, setDownloading] = useState("");
  const [progress, setProgress] = useState("");
  const [saving, setSaving] = useState(false);
  const searchController = useRef<AbortController | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const authController = useRef<AbortController | null>(null);
  const importBusy = useRef(false);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getZlibrarySession(controller.signal).then((data) => setConnected(data.connected)).catch((error) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "无法读取登录状态");
    });
    return () => {
      controller.abort();
      searchController.current?.abort();
      downloadController.current?.abort();
      authController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const element = resultsRef.current;
    if (!element) return;
    let y = 0;
    const start = (event: TouchEvent) => { y = event.touches[0]?.clientY ?? 0; };
    const move = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? y;
      const delta = nextY - y;
      y = nextY;
      if (event.touches.length > 1 || (delta > 0 && element.scrollTop <= 0) || (delta < 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 1)) {
        if (event.cancelable) event.preventDefault();
      }
    };
    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    return () => {
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
    };
  }, []);

  function showError(error: unknown) {
    setError(error instanceof Error ? error.message : "请求失败，请重试");
    if (error instanceof ZlibraryError && error.status === 401) {
      setConnected(false);
      setShowLogin(true);
    }
  }

  async function search(nextPage = 1) {
    const searchQuery = nextPage > 1 && lastSearch ? lastSearch.query : query.trim();
    const searchFormat = nextPage > 1 && lastSearch ? lastSearch.format : format;
    if (!searchQuery || importBusy.current) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    setError("");
    setNotice("");
    if (nextPage === 1) {
      setResults([]); setLastSearch(null); setHasMore(false);
      resultsRef.current?.scrollTo({ top: 0 });
    }
    try {
      const data = await searchZlibrary(searchQuery, nextPage, searchFormat, controller.signal);
      if (controller.signal.aborted) return;
      setResults((current) => {
        const all = nextPage === 1 ? data.books : [...current, ...data.books];
        return [...new Map(all.map((book) => [`${book.id}:${book.hash}`, book])).values()];
      });
      setLastSearch({ query: searchQuery, format: searchFormat, page: data.page });
      setHasMore(data.hasMore);
    } catch (error) {
      if (!controller.signal.aborted) showError(error);
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authBusy) return;
    const controller = new AbortController();
    authController.current = controller;
    setAuthBusy(true);
    setError("");
    try {
      await loginZlibrary(email.trim(), password, controller.signal);
      if (controller.signal.aborted) return;
      setConnected(true);
      setShowLogin(false);
      setNotice("已连接 Z-Library");
      if (query.trim()) void search();
    } catch (error) {
      if (!controller.signal.aborted) showError(error);
    } finally {
      setPassword("");
      setAuthBusy(false);
    }
  }

  async function logout() {
    setAuthBusy(true);
    setError("");
    try {
      await logoutZlibrary();
      setConnected(false);
      setNotice("已退出 Z-Library");
    } catch (error) { showError(error); }
    finally { setAuthBusy(false); }
  }

  async function addBook(book: OnlineBook) {
    if (importBusy.current) return;
    importBusy.current = true;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(`${book.id}:${book.hash}`);
    setError("");
    setNotice("");
    try {
      const file = await downloadZlibrary(book, setProgress, controller.signal);
      if (controller.signal.aborted) return;
      setSaving(true);
      await onImport(file, `zlibrary:${book.id}:${book.hash}`, setProgress);
      setNotice(`《${book.title}》已加入书库`);
    } catch (error) {
      if (!controller.signal.aborted) showError(error);
    } finally {
      importBusy.current = false;
      setDownloading("");
      setSaving(false);
      setProgress("");
    }
  }

  return (
    <section className="online-library" aria-label="在线找书">
      <form className="online-search" onSubmit={(event) => { event.preventDefault(); (document.activeElement as HTMLElement)?.blur(); void search(); }}>
        <label className="ios-search">
          <Search size={16} aria-hidden="true" />
          <input aria-label="在线搜索书名或作者" placeholder="搜索书名或作者" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} enterKeyHint="search" disabled={!!downloading} />
          {query ? <button type="button" aria-label="清除在线搜索" onClick={() => setQuery("")} disabled={!!downloading}><X size={15} /></button> : null}
        </label>
        <button className="primary-button" disabled={!query.trim() || !!downloading || authBusy} type="submit">搜索</button>
      </form>
      <div className="online-toolbar">
        <label>格式 <select aria-label="在线书籍格式" value={format} onChange={(event) => setFormat(event.target.value)} disabled={!!downloading}>
          <option value="">全部 · EPUB 优先</option>
          {ONLINE_BOOK_FORMATS.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}
        </select></label>
        <button className="text-button" type="button" disabled={authBusy || !!downloading || searching} onClick={() => connected ? void logout() : setShowLogin(!showLogin)}>
          <UserRound size={15} />{connected ? "退出账号" : "登录"}
        </button>
      </div>
      {showLogin ? (
        <form className="online-login" onSubmit={login}>
          <div><strong>连接 Z-Library</strong><span>zh.z-lib.gd</span></div>
          <label>邮箱<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} disabled={authBusy} /></label>
          <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={1024} disabled={authBusy} /></label>
          <small>使用你的 Z-Library 账号。墨听不保存密码。</small>
          <button className="primary-button" type="submit" disabled={authBusy || !email.trim() || !password}>{authBusy ? "正在连接…" : "登录并继续"}</button>
        </form>
      ) : null}
      <div className="online-feedback" aria-live="polite">
        {error ? <p role="alert" className="online-error">{error}</p> : notice ? <p>{notice}</p> : <p>{connected ? "已连接 Z-Library · 下载后自动加入本地书库" : "Z-Library · 按书名查找，选择版本后加入书库"}</p>}
      </div>
      <div className="online-results" ref={resultsRef} aria-busy={searching}>
        {results.map((book) => {
          const key = `${book.id}:${book.hash}`;
          const existing = books.find((item) => item.onlineSourceId === `zlibrary:${key}`);
          const supported = (ONLINE_BOOK_FORMATS as readonly string[]).includes(book.extension);
          const tooLarge = book.bytes !== null && book.bytes > ONLINE_BOOK_MAX_BYTES;
          const active = downloading === key;
          return (
            <article className="online-book" key={key}>
              <div className="online-book__cover">
                <BookOpen size={23} aria-hidden="true" /><span>暂无封面</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {book.cover ? <img src={book.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
              </div>
              <div className="online-book__info">
                <h3>{book.title}</h3>
                <p>{book.author || "作者未提供"}</p>
                <small>{[book.extension.toUpperCase(), book.language, book.year, book.size].filter(Boolean).join(" · ")}</small>
                <div className="online-book__action">
                  <button type="button" className="secondary-button" disabled={!!downloading || searching || (!existing && (!supported || tooLarge))} onClick={() => existing ? onOpen(existing) : void addBook(book)}>
                    {existing ? <Check size={14} /> : active ? <LoaderCircle size={14} /> : <Download size={14} />}
                    {existing ? "已加入 · 阅读" : active ? "处理中…" : tooLarge ? "超过 80 MB" : !supported ? "格式暂不支持" : "加入书库"}
                  </button>
                  {active && !saving ? <button type="button" className="text-button" onClick={() => { downloadController.current?.abort(); setNotice("已取消下载"); }}>取消</button> : null}
                </div>
                <div className="online-book__progress" role={active ? "status" : undefined}>{active ? progress : ""}</div>
              </div>
            </article>
          );
        })}
        {searching ? <div className="online-skeletons" role="status" aria-label="正在搜索书籍">{[0, 1, 2].map((i) => <div className="online-skeleton" key={i}><span /><div><i /><i /><i /></div></div>)}</div> : null}
        {!searching && !results.length ? <div className="online-empty"><BookOpen size={28} /><h3>{lastSearch ? "没有找到匹配的书" : "下一本想读什么？"}</h3><p>{lastSearch ? "换个书名、作者，或调整格式后再搜索。" : "输入书名或作者，找到后直接加入书库。"}</p></div> : null}
        {lastSearch && hasMore ? <button type="button" className="secondary-button online-more" disabled={searching || !!downloading} onClick={() => void search(lastSearch.page + 1)}>{searching ? "正在查找…" : "更多结果"}</button> : null}
      </div>
    </section>
  );
}
