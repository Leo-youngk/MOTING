"use client";

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { BookOpen, Check, ChevronLeft, Download, LoaderCircle, Search, UserRound, X } from "lucide-react";
import { downloadZlibrary, getZlibrarySession, loginZlibrary, logoutZlibrary, searchZlibrary, ZlibraryError } from "../lib/zlibrary";
import { MAX_BOOK_FILE_LABEL } from "../lib/file-limits";
import { ONLINE_BOOK_FORMATS, ONLINE_BOOK_MAX_BYTES, type OnlineBook } from "../lib/zlibrary-types";
import type { BookMeta } from "../lib/types";
import { Modal } from "./sheet";
import "./online-library.css";

const FORMAT_CHIPS: Array<{ value: string; label: string }> = [
  { value: "", label: "全部" },
  ...ONLINE_BOOK_FORMATS.map((value) => ({ value, label: value.toUpperCase() })),
];

function bookKey(book: OnlineBook) {
  return `${book.id}:${book.hash}`;
}

/** 封面：没有图或者图挂了，就留一块写着「暂无封面」的浅色底。 */
function OnlineCover({ book, large = false }: { book: OnlineBook; large?: boolean }) {
  return (
    <span className={`online-cover${large ? " online-cover--large" : ""}`}>
      <BookOpen size={large ? 26 : 22} aria-hidden="true" />
      <small>暂无封面</small>
      {book.cover ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={book.cover}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </span>
  );
}

export function OnlineLibrary({ books, onImport, onOpen, onBack, initialQuery = "" }: {
  books: BookMeta[];
  onImport: (file: File, sourceId: string, onProgress: (label: string) => void) => Promise<void>;
  onOpen: (book: BookMeta) => void;
  onBack: () => void;
  /** 从书库搜不到、或从书城「去找这本书」进来时带的书名，进来就直接搜。 */
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [format, setFormat] = useState("");
  const [results, setResults] = useState<OnlineBook[]>([]);
  const [lastSearch, setLastSearch] = useState<{ query: string; format: string; page: number } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(Boolean(initialQuery.trim()));
  const [connected, setConnected] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [downloading, setDownloading] = useState("");
  const [progress, setProgress] = useState("");
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<OnlineBook | null>(null);
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
    if (!initialQuery.trim()) return;
    const controller = new AbortController();
    searchController.current = controller;
    searchOnce(initialQuery.trim(), 1, "", controller.signal).then(({ data, keyword, fellBackFrom }) => {
      if (controller.signal.aborted) return;
      if (fellBackFrom) {
        setQuery(keyword);
        setNotice(`没有「${fellBackFrom}」，改成只搜《${keyword}》。`);
      }
      setResults(data.books);
      setLastSearch({ query: keyword, format: "", page: data.page });
      setHasMore(data.hasMore);
    }).catch((error) => {
      if (!controller.signal.aborted) showError(error);
    }).finally(() => {
      if (!controller.signal.aborted) setSearching(false);
    });
    return () => controller.abort();
  }, [initialQuery]);

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
      setShowAccount(true);
    }
  }

  /**
   * 搜一次；「书名 作者」一本都搜不到时，退回只搜书名。
   *
   * 书城的「去找这本书」带进来的就是「书名 作者」——加作者是为了甩掉同名书，
   * 但 Z-Library 上作者名的写法千奇百怪，加上去有时候会把结果搜成零。
   * 那就自己退一步，并且在反馈栏里说清楚退过，别让人以为这本书根本没有。
   */
  async function searchOnce(keyword: string, page: number, fmt: string, signal: AbortSignal) {
    const data = await searchZlibrary(keyword, page, fmt, signal);
    if (page > 1 || data.books.length || !keyword.includes(" ")) {
      return { data, keyword, fellBackFrom: "" };
    }
    const titleOnly = keyword.slice(0, keyword.lastIndexOf(" ")).trim();
    if (!titleOnly || titleOnly === keyword) return { data, keyword, fellBackFrom: "" };
    const retry = await searchZlibrary(titleOnly, page, fmt, signal);
    return { data: retry, keyword: titleOnly, fellBackFrom: keyword };
  }

  async function search(nextPage = 1, formatOverride?: string) {
    const searchQuery = nextPage > 1 && lastSearch ? lastSearch.query : query.trim();
    const searchFormat = nextPage > 1 && lastSearch ? lastSearch.format : formatOverride ?? format;
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
      const { data, keyword, fellBackFrom } = await searchOnce(
        searchQuery,
        nextPage,
        searchFormat,
        controller.signal
      );
      if (controller.signal.aborted) return;
      if (fellBackFrom) {
        setQuery(keyword);
        setNotice(`没有「${fellBackFrom}」，改成只搜《${keyword}》。`);
      }
      setResults((current) => {
        const all = nextPage === 1 ? data.books : [...current, ...data.books];
        return [...new Map(all.map((book) => [bookKey(book), book])).values()];
      });
      setLastSearch({ query: keyword, format: searchFormat, page: data.page });
      setHasMore(data.hasMore);
    } catch (error) {
      if (!controller.signal.aborted) showError(error);
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  /** 换格式：已经搜过（或者框里有字）就按新格式立刻重搜，不用再按一次搜索。 */
  function pickFormat(next: string) {
    if (next === format) return;
    setFormat(next);
    if (query.trim() && !downloading) void search(1, next);
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
      setShowAccount(false);
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
      setShowAccount(false);
      setNotice("已退出 Z-Library");
    } catch (error) { showError(error); }
    finally { setAuthBusy(false); }
  }

  async function addBook(book: OnlineBook) {
    if (importBusy.current) return;
    importBusy.current = true;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(bookKey(book));
    setError("");
    setNotice("");
    try {
      const file = await downloadZlibrary(book, setProgress, controller.signal);
      if (controller.signal.aborted) return;
      setSaving(true);
      await onImport(file, `zlibrary:${bookKey(book)}`, setProgress);
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

  /** 这本书的状态：已经在书库里、能不能加、按钮上写什么。卡片和详情共用。 */
  function stateOf(book: OnlineBook) {
    const key = bookKey(book);
    const existing = books.find((item) => item.onlineSourceId === `zlibrary:${key}`);
    const supported = (ONLINE_BOOK_FORMATS as readonly string[]).includes(book.extension);
    const tooLarge = book.bytes !== null && book.bytes > ONLINE_BOOK_MAX_BYTES;
    const active = downloading === key;
    const label = active
      ? "处理中…"
      : tooLarge
        ? `超过 ${MAX_BOOK_FILE_LABEL}`
        : !supported
          ? "格式暂不支持"
          : "加入书库";
    const blocked = !!downloading || searching || !supported || tooLarge;
    return { key, existing, active, label, blocked };
  }

  // 登录面板开着时，错误写在面板里；关着才写在反馈行。两处都写，屏幕阅读器会念两遍。
  const feedback = showAccount
    ? notice
    : error || notice || (connected ? "已连接 Z-Library · 下载后自动加入本地书库" : "Z-Library · 按书名查找，选择版本后加入书库");
  const detailState = detail ? stateOf(detail) : null;

  return (
    <div className="screen online-screen">
      <header className="online-bar">
        <button type="button" className="online-round" aria-label="返回" onClick={onBack}>
          <ChevronLeft size={22} />
        </button>
        <h1>在线找书</h1>
        <button
          type="button"
          className={`online-round${connected ? " is-connected" : ""}`}
          aria-label={connected ? "Z-Library 账号" : "登录"}
          disabled={authBusy}
          onClick={() => setShowAccount(true)}
        >
          <UserRound size={21} />
        </button>
      </header>

      <section className="online-library" aria-label="在线找书">
        <form className="online-search" onSubmit={(event) => { event.preventDefault(); (document.activeElement as HTMLElement)?.blur(); void search(); }}>
          <label className="ios-search">
            <Search size={18} aria-hidden="true" />
            <input aria-label="在线搜索书名或作者" placeholder="搜索书名或作者" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} enterKeyHint="search" disabled={!!downloading} />
            {query ? <button type="button" aria-label="清除在线搜索" onClick={() => setQuery("")} disabled={!!downloading}><X size={14} /></button> : null}
          </label>
          <button className="online-search__submit" disabled={!query.trim() || !!downloading || authBusy || searching} type="submit">搜索</button>
        </form>

        <div className="online-formats" role="group" aria-label="文件格式">
          {FORMAT_CHIPS.map((chip) => (
            <button
              type="button"
              key={chip.value || "all"}
              className={format === chip.value ? "is-active" : ""}
              aria-pressed={format === chip.value}
              disabled={!!downloading}
              onClick={() => pickFormat(chip.value)}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="online-feedback" aria-live="polite">
          {error && !showAccount ? <p role="alert" className="online-error">{error}</p> : <p>{feedback}</p>}
        </div>

        <div className="online-results" ref={resultsRef} aria-busy={searching}>
          {results.map((book) => {
            const { key, existing, active, label, blocked } = stateOf(book);
            const stop = (event: MouseEvent) => event.stopPropagation();
            return (
              <article className="online-card" key={key} onClick={() => setDetail(book)}>
                <OnlineCover book={book} />
                <div className="online-card__info">
                  <h3>{book.title}</h3>
                  <p>{book.author || "作者未提供"}</p>
                  {book.language || book.year ? <p>{[book.language, book.year].filter(Boolean).join(" · ")}</p> : null}
                  <div className="online-card__tags">
                    <span>{book.extension.toUpperCase()}</span>
                    {book.size ? <span>{book.size}</span> : null}
                  </div>
                </div>
                <div className="online-card__actions" onClick={stop}>
                  {existing ? (
                    <>
                      <span className="online-card__owned"><Check size={14} />已在书库</span>
                      <button type="button" className="online-pill online-pill--plain" disabled={!!downloading || searching} onClick={() => onOpen(existing)}>打开阅读</button>
                    </>
                  ) : (
                    <button type="button" className="online-pill" disabled={blocked} onClick={() => void addBook(book)}>
                      {active ? <LoaderCircle size={14} className="online-spin" /> : null}
                      {label}
                    </button>
                  )}
                  {active && !saving ? <button type="button" className="text-button online-cancel" onClick={() => { downloadController.current?.abort(); setNotice("已取消下载"); }}>取消</button> : null}
                </div>
                {active ? <p className="online-card__progress" role="status">{progress}</p> : null}
              </article>
            );
          })}
          {searching ? <div className="online-skeletons" role="status" aria-label="正在搜索书籍">{[0, 1, 2].map((i) => <div className="online-skeleton" key={i}><span /><div><i /><i /><i /></div></div>)}</div> : null}
          {!searching && !results.length ? <div className="online-empty"><BookOpen size={28} /><h3>{lastSearch ? "没有找到匹配的书" : "下一本想读什么？"}</h3><p>{lastSearch ? "换个书名、作者，或调整格式后再搜索。" : "输入书名或作者，找到后直接加入书库。"}</p></div> : null}
          {lastSearch && hasMore ? <button type="button" className="secondary-button online-more" disabled={searching || !!downloading} onClick={() => void search(lastSearch.page + 1)}>{searching ? "正在查找…" : "更多结果"}</button> : null}
        </div>
      </section>

      {showAccount ? (
        <Modal title="Z-Library 账号" onClose={() => setShowAccount(false)}>
          {connected ? (
            <div className="online-account">
              <p>已连接 Z-Library（zh.z-lib.gd）。搜到的书下载完直接加入本地书库。</p>
              <button type="button" className="secondary-button" disabled={authBusy} onClick={() => void logout()}>
                退出账号
              </button>
            </div>
          ) : (
            <form className="online-login" onSubmit={login}>
              <p>使用你的 Z-Library 账号登录。墨听不保存密码。</p>
              <label>邮箱<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} disabled={authBusy} /></label>
              <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={1024} disabled={authBusy} /></label>
              {error ? <p role="alert" className="online-error">{error}</p> : null}
              <button className="primary-button" type="submit" disabled={authBusy || !email.trim() || !password}>{authBusy ? "正在连接…" : "登录并继续"}</button>
            </form>
          )}
        </Modal>
      ) : null}

      {detail && detailState ? (
        <Modal title="版本详情" onClose={() => setDetail(null)}>
          <div className="online-detail">
            <div className="online-detail__head">
              <OnlineCover book={detail} large />
              <div>
                <strong>{detail.title}</strong>
                <small>{detail.author || "作者未提供"}</small>
              </div>
            </div>
            <dl className="online-detail__table">
              <div><dt>文件格式</dt><dd>{detail.extension.toUpperCase()}</dd></div>
              <div><dt>文件大小</dt><dd>{detail.size || "未知"}</dd></div>
              <div><dt>语言</dt><dd>{detail.language || "未知"}</dd></div>
              <div><dt>年份</dt><dd>{detail.year || "未知"}</dd></div>
              <div><dt>来源</dt><dd>Z-Library</dd></div>
            </dl>
            <p className="online-detail__note">
              {detailState.existing ? "这个版本已经在你的书库里。" : "下载完成后自动加入本地书库。"}
            </p>
            {detailState.existing ? (
              <button type="button" className="online-detail__cta" onClick={() => { const book = detailState.existing!; setDetail(null); onOpen(book); }}>
                <BookOpen size={19} />
                打开阅读
              </button>
            ) : (
              <button type="button" className="online-detail__cta" disabled={detailState.blocked} onClick={() => { const book = detail; setDetail(null); void addBook(book); }}>
                <Download size={19} />
                {detailState.label}
              </button>
            )}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
