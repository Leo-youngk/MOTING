"use client";

import "./book-metadata.css";

import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Headphones,
  Highlighter,
  Home,
  Info,
  Layers,
  Library,
  List,
  LoaderCircle,
  MoreHorizontal,
  NotebookText,
  Pause,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  Timer,
  Trash2,
  Type,
  Upload,
  Volume2,
  X,
} from "lucide-react";
import {
  Fragment,
  lazy,
  memo,
  Suspense,
  type ChangeEvent,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { RetainedTab } from "./retained-tab";
import { useAppNavigation } from "../hooks/use-app-navigation";
import { useAppUpdate } from "../hooks/use-app-update";
import { useKeyboardInset } from "../hooks/use-keyboard-inset";
import { useViewportFill } from "../hooks/use-viewport-fill";
import { useSpeechPlayer, type SleepMode } from "../hooks/use-speech-player";
import { AiRequestError, modelHistory, streamAiChat } from "../lib/ai";
import {
  BookMetadataError,
  cleanTitleText,
  bookSearchQuery,
  coverProxyUrl,
  decideAutoApply,
  fetchCoverDataUrl,
  formatAuthors,
  lookupBookMetadata,
  lookupQuery,
  needsMetadataLookup,
} from "../lib/book-metadata";
import {
  BOOK_METADATA_SOURCE,
  type AppliedBookMetadata,
  type BookMetadataCandidate,
  type BookMetadataPatch,
} from "../lib/book-metadata-types";
import {
  charsPerLine,
  findSentence,
  flattenChapter,
  formatReadingTime,
  formatRemaining,
  initialPosition,
  makeId,
  estimatePagination,
  pageAt,
  planChapterWindow,
  positionAtPercent,
  positionFor,
  remainingCharacters,
} from "../lib/content";
import { createDemoBook } from "../lib/demo";
import {
  chapterLabel,
  chapterLabelFor,
  displayTitle,
  isPlaceholderTitle,
  tocIndexes,
  tocIndexFor,
} from "../lib/display-title";
import { MAX_BOOK_FILE_BYTES, MAX_BOOK_FILE_ERROR } from "../lib/file-limits";
import { mergeChatTurns } from "../lib/sync-merge";
import { springTo } from "../lib/motion";
import {
  getSyncSession,
  loginSync,
  logoutSync,
  runSync,
  SyncError,
  type SyncAppliedKind,
} from "../lib/sync";
import {
  clearLibrary,
  getAllBookMetadata,
  getAllBooks,
  getAllChats,
  getAllNotes,
  getAllSessions,
  getBookContent,
  getBookImage,
  getSettings,
  getStats,
  getSyncState,
  onStorageUpgrade,
  saveSession,
  removeBook,
  removeBookMetadata,
  writeNotes,
  saveBook,
  saveBookMetadata,
  saveImportedBook,
  saveReadingPositions,
  saveChat,
  saveNote,
  saveSettings,
  updateBookMeta,
} from "../lib/storage";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  dayKey,
  type AppView,
  type AiChatTurn,
  type Book,
  type BookAiChat,
  type BookMeta,
  type BookNote,
  type BookPosition,
  type Chapter,
  type HighlightColor,
  type HighlightStyle,
  type ImportProgress,
  type MainView,
  type PlayerVoice,
  type ReaderSettings,
  type ReaderTheme,
  type ReadingSession,
  type ReadingStats,
  type ShellTheme,
} from "../lib/types";
import {
  dailyBookEntries,
  dailySeconds,
  groupEntriesByMonth,
  readingStreak,
  totalSeconds,
} from "../lib/reading-stats";
import { useReadingSession } from "../hooks/use-reading-session";
import {
  READER_FONTS,
  READER_THEMES,
  READER_THEME_SWATCH,
  type ReaderFont,
} from "../lib/reader-options";
import { wereadCoverDisplayUrl } from "../lib/weread";
import { useSafeInsets, type SafeInsets } from "../hooks/use-safe-insets";
import { useTextSelection } from "../hooks/use-text-selection";
import { SelectionLayer } from "./selection-layer";
import { Modal, SheetCancelButton, scrollWhenUnlocked, useScrollLock } from "./sheet";
import { SoftRange } from "./soft-range";
import { SettingsScreen } from "./settings-screen";
import {
  placeForSelection,
  type Placement,
  type Rect,
} from "../lib/popover-placement";
import { EDGE_VOICES, resolvedEdgeVoiceURI } from "../lib/edge-voices";
import { Bookstore } from "./bookstore";
import { HomeStore } from "./home-store";
import { OnlineLibrary } from "./online-library";

/**
 * 发了新版之后，还开着的旧页面去取自己那一版的分片会 404（Workers 只留最新一版的文件）。
 * 这时候刷新一次拿新版，别让 React 抛错把整页弄白；一分钟内只刷一次，免得来回转。
 */
function freshImport<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((error: unknown) => {
    let last = 0;
    try {
      last = Number(window.sessionStorage.getItem("moting:reloaded-at") ?? 0);
      if (Date.now() - last > 60_000) {
        window.sessionStorage.setItem("moting:reloaded-at", String(Date.now()));
      }
    } catch {
      // 存不了就当没刷过。
    }
    if (Date.now() - last <= 60_000) throw error;
    console.warn("[moting] 分片加载失败，刷新到新版本", error);
    window.location.reload();
    return new Promise<T>(() => {});
  });
}

/**
 * AI 回答的 Markdown 排版（react-markdown 一家子，一百多 KB）按需下载，开机闲下来先取回来。
 *
 * 取到之后直接同步渲染，没取到才走 React.lazy：lazy 第一次渲染必然先挂起、亮出占位，
 * 而 React 为了防闪烁，占位一旦亮出至少停 300ms 才换成内容——哪怕模块早就下好了。
 * 书城、在线找书不走懒加载：主页的书城条在首屏，那部分代码本来就在主包里。
 */
const loadAiMarkdown = () => freshImport(() => import("./ai-markdown"));
let aiMarkdownModule: Awaited<ReturnType<typeof loadAiMarkdown>> | null = null;
const LazyAiMarkdown = lazy(() =>
  loadAiMarkdown().then((module) => {
    aiMarkdownModule = module;
    return { default: module.AiMarkdown };
  })
);

/** 导入用的解析器很大，按需下载。发版后旧页面取不到旧分片时给一句人话，别甩一串英文报错。 */
async function loadParsers() {
  try {
    return await import("../lib/parsers");
  } catch {
    throw new Error("墨听刚更新过，关掉重新打开后再导入");
  }
}

/** 内存里最多留几本书的正文。长篇一本就是几十 MB 的对象。 */
const CONTENT_CACHE_BOOKS = 3;
/** 提示条退场动画的时长，和 CSS 里 .toast.is-leaving 对齐。 */
const TOAST_EXIT_MS = 180;
/** layout 里的开机脚本读这个键：上次的书架配色、阅读配色，和两者的底色。 */
const THEME_KEY = "moting:theme";

/** 记下这次的配色，下次开机第一帧就用它，不必等设置从本地库读出来。 */
function rememberTheme(shell: ShellTheme, reader: ReaderTheme) {
  try {
    const style = getComputedStyle(document.documentElement);
    window.localStorage.setItem(
      THEME_KEY,
      JSON.stringify({
        shell,
        reader,
        paper: style.getPropertyValue("--paper").trim(),
        readerBackground: style.getPropertyValue("--reader-background").trim(),
      })
    );
  } catch {
    // 存不了就下次按默认配色起，读到设置后再换，只是首帧会闪一下。
  }
}

type ContentView = Extract<AppView, { name: "reader" | "player" | "book-notes" }>;

/** 这几页要整本书（书目 + 正文），进页面之前得先把正文读进来。 */
function viewNeedsContent(view: AppView): view is ContentView {
  return view.name === "reader" || view.name === "player" || view.name === "book-notes";
}

/** 整本书去掉正文，就是书库里的那份书目。 */
function metaOf(book: Book): BookMeta {
  const { chapters: _chapters, ...meta } = book;
  return meta;
}

function AiMarkdown({ content, streaming }: { content: string; streaming?: boolean }) {
  if (aiMarkdownModule) {
    const Ready = aiMarkdownModule.AiMarkdown;
    return <Ready content={content} streaming={streaming} />;
  }
  return (
    <Suspense fallback={<span className="ai-markdown-loading">正在排版…</span>}>
      <LazyAiMarkdown content={content} streaming={streaming} />
    </Suspense>
  );
}

function FontPicker({
  value,
  onChange,
}: {
  value: ReaderFont;
  onChange: (value: ReaderFont) => void;
}) {
  return (
    <div className="font-picker">
      {READER_FONTS.map((font) => (
        <button
          type="button"
          key={font.value}
          className={`font-picker__item ${
            value === font.value ? "is-active" : ""
          }`}
          style={{ fontFamily: font.cssVar }}
          onClick={() => onChange(font.value)}
        >
          <span className="font-picker__name">{font.label}</span>
          {value === font.value ? <Check size={15} /> : null}
        </button>
      ))}
    </div>
  );
}

const NAV_ITEMS: Array<{
  id: MainView;
  label: string;
  icon: typeof Library;
}> = [
  { id: "home", label: "主页", icon: Home },
  { id: "library", label: "书库", icon: BookOpen },
  { id: "listen", label: "听书", icon: Headphones },
  { id: "notes", label: "笔记", icon: NotebookText },
];

const HIGHLIGHT_COLORS: Array<{ id: HighlightColor; label: string }> = [
  { id: "yellow", label: "黄色" },
  { id: "green", label: "绿色" },
  { id: "blue", label: "蓝色" },
  { id: "pink", label: "粉色" },
];

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `今天 ${date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
  return date.toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
}

/** 旧数据没有 groupId，退回自己的 id 当单元素组。 */
function groupKey(note: BookNote): string {
  return note.groupId ?? note.id;
}

/** 把一次划线拆出的多条记录合回一条：正文按阅读顺序拼，其余字段取第一条。 */
function mergeNoteGroup(items: BookNote[]): BookNote {
  const ordered = [...items].sort((a, b) => a.createdAt - b.createdAt);
  return { ...ordered[0], excerpt: ordered.map((n) => n.excerpt).join("") };
}

function BookCover({
  book,
  size = "medium",
}: {
  book: BookMeta;
  size?: "small" | "medium" | "large";
}) {
  const style = {
    "--book-accent": book.accent,
  } as CSSProperties;

  return (
    <div className={`book-cover book-cover--${size}`} style={style}>
      {book.coverDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={book.coverDataUrl} alt={`${book.title}封面`} />
      ) : (
        <div className="book-cover__generated">
          <span className="book-cover__rule" />
          <strong>{displayTitle(book.title)}</strong>
          <small>{book.author}</small>
          <span className="book-cover__mark">墨听</span>
        </div>
      )}
    </div>
  );
}

function ProgressBar({
  value,
  label,
}: {
  value: number;
  label?: string;
}) {
  return (
    <div className="progress-wrap" aria-label={label ?? `进度 ${value}%`}>
      <div className="progress-track">
        <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      {label ? <span className="progress-label">{label}</span> : null}
    </div>
  );
}

function BottomNavigation({
  active,
  onChange,
}: {
  active: MainView;
  onChange: (view: MainView) => void;
}) {
  return (
    <nav className="bottom-nav" aria-label="主要导航">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const selected = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={selected ? "is-active" : ""}
            aria-current={selected ? "page" : undefined}
            onClick={() => onChange(item.id)}
          >
            <Icon size={24} strokeWidth={selected ? 2 : 1.7} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * 目录一打开就落到当前这一章：读到第 80 章还要从头翻一遍实在难用。
 * 只滚列表自己，把当前章放在靠上三分之一处，前后都还能看到几章。
 */
function useRevealActiveChapter(open: boolean) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector(".is-active");
    if (!list || !active) return;
    list.scrollTop +=
      active.getBoundingClientRect().top -
      list.getBoundingClientRect().top -
      list.clientHeight / 3;
  }, [open]);
  return listRef;
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}

/** 小熊：跟桌面图标同一只，从图标原图里裁出来的头像。 */
function BearMark({ className }: { className: string }) {
  return (
    <span className={className} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/bear-mark.png" alt="" width={48} height={48} />
    </span>
  );
}

function LargeHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  /** 页名下面那一行统计，比如「4 本书 · 28 条笔记」。 */
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ios-header">
      <BearMark className="ios-header__mark" />
      <div className="ios-header__text">
        <h1>{title}</h1>
        {subtitle ? <span className="ios-header__subtitle">{subtitle}</span> : null}
      </div>
      {actions ? <div className="ios-header__actions">{actions}</div> : null}
    </header>
  );
}

function Shelf({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="shelf">
      <h2 className="shelf__title">{title}</h2>
      <div className="shelf__track">{children}</div>
    </section>
  );
}

function ShelfCard({
  book,
  size,
  onOpen,
  onPlay,
}: {
  book: BookMeta;
  size: "large" | "medium";
  onOpen: (book: BookMeta) => void;
  onPlay?: (book: BookMeta) => void;
}) {
  const position = book.readingPosition ?? book.listeningPosition;

  return (
    <article className={`shelf-card shelf-card--${size}`}>
      <div className="shelf-card__art">
        <button
          type="button"
          className="shelf-card__cover"
          onClick={() => onOpen(book)}
          aria-label={`阅读${book.title}`}
        >
          <BookCover book={book} size={size} />
        </button>
        {onPlay ? (
          <button
            type="button"
            className="shelf-card__play"
            aria-label={`收听${book.title}`}
            onClick={() => onPlay(book)}
          >
            <Play size={15} fill="currentColor" />
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="shelf-card__text"
        onClick={() => onOpen(book)}
      >
        <strong>{displayTitle(book.title)}</strong>
        <small>{book.author}</small>
        <em>{formatRemaining(book, position)}</em>
      </button>
    </article>
  );
}

/** 主页「继续阅读」的一张大卡：点封面或书名打开，右下的胶囊接着上次那一侧（读或听）往下走。 */
function HomeCard({
  book,
  percent,
  meta,
  action,
  onOpen,
  onAction,
}: {
  book: BookMeta;
  percent: number;
  meta: string;
  action: string;
  onOpen: (book: BookMeta) => void;
  onAction: (book: BookMeta) => void;
}) {
  return (
    <article className="home-card">
      <button
        type="button"
        className="home-card__cover"
        aria-label={`打开${displayTitle(book.title)}`}
        onClick={() => onOpen(book)}
      >
        <BookCover book={book} size="medium" />
      </button>
      <div className="home-card__body">
        <button
          type="button"
          className="home-card__info"
          onClick={() => onOpen(book)}
        >
          <strong>{displayTitle(book.title)}</strong>
          <small>{book.author}</small>
        </button>
        <ProgressBar value={percent} />
        <div className="home-card__foot">
          <em>{meta}</em>
          <button
            type="button"
            className="home-card__cta"
            onClick={() => onAction(book)}
          >
            {action}
          </button>
        </div>
      </div>
    </article>
  );
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function formatSpan(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} 时 ${rest} 分` : `${Math.floor(minutes / 60)} 时`;
}

/** 主页看板：一只极简时钟，指针按今日阅读时长转，走满一圈是 60 分钟。 */
function ReadingBoard({
  stats,
  sessions,
}: {
  stats: ReadingStats;
  sessions: ReadingSession[];
}) {
  // 回到主页会重新挂载，所以每次进来都是当天的日期，不用再自己定时刷新。
  const [now] = useState(() => Date.now());
  // 每天的总量由 session 现算，stats.days 只是早期版本留下的历史基数。
  const days = useMemo(
    () => dailySeconds(sessions, stats.days),
    [sessions, stats.days]
  );
  const todaySeconds = days[dayKey(now)] ?? 0;
  const minutes = Math.floor(todaySeconds / 60);
  const streak = readingStreak(days, now);
  const total = totalSeconds(days);

  const weekSeconds = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    return days[dayKey(date.getTime())] ?? 0;
  }).reduce((sum, item) => sum + item, 0);

  // 进主页时指针从 12 点扫到今天的位置，超过一小时就多转一圈。
  // 延一拍再给角度，让首帧停在 12 点，指针才有可扫的距离。
  const [swept, setSwept] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSwept(true), 60);
    return () => window.clearTimeout(timer);
  }, []);
  const angle = swept ? minutes * 6 : 0;

  const circumference = 2 * Math.PI * 46;
  const swept60 = Math.min(1, todaySeconds / 3600);

  const caption =
    todaySeconds < 60 ? "今日尚未落墨" : "心静下来，页页有声";

  return (
    <section className="zen-board">
      <div className="zen-board__clock">
        <svg viewBox="0 0 116 116" aria-hidden>
          <circle className="zen-clock__dial" cx="58" cy="58" r="46" />
          {Array.from({ length: 12 }, (_, index) => (
            <line
              key={index}
              className="zen-clock__tick"
              x1="58"
              y1="14"
              x2="58"
              y2={index % 3 === 0 ? 21 : 17.5}
              transform={`rotate(${index * 30} 58 58)`}
            />
          ))}
          <circle
            className="zen-clock__sweep"
            cx="58"
            cy="58"
            r="46"
            transform="rotate(-90 58 58)"
            strokeDasharray={`${circumference * swept60} ${circumference}`}
          />
          {/* 指针只画外圈那一段，中间留给分钟数。 */}
          <line
            className="zen-clock__hand"
            x1="58"
            y1="24"
            x2="58"
            y2="38"
            style={{ transform: `rotate(${angle}deg)` }}
          />
        </svg>
        <div className="zen-clock__center">
          <strong>{minutes}</strong>
          <small>分钟</small>
        </div>
      </div>

      <div className="zen-board__body">
        <p className="zen-board__caption">{caption}</p>

        <dl className="zen-board__stats">
          <div>
            <dt>连续</dt>
            <dd>{streak} 天</dd>
          </div>
          <div>
            <dt>本周</dt>
            <dd>{formatSpan(weekSeconds)}</dd>
          </div>
          <div>
            <dt>累计</dt>
            <dd>{formatSpan(total)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function dayLabel(key: string, now: number): string {
  if (key === dayKey(now)) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return "昨天";
  const [, month, day] = key.split("-");
  return `${Number(month)} 月 ${Number(day)} 日`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

/** 阅读记录：一天一本一条，只给日期、书名和时长。 */
function ReadingLog({
  sessions,
  onOpenHistory,
}: {
  sessions: ReadingSession[];
  onOpenHistory: () => void;
}) {
  const [now] = useState(() => Date.now());
  const entries = useMemo(() => dailyBookEntries(sessions), [sessions]);

  if (!entries.length) return null;

  return (
    <section className="zen-log">
      <div className="zen-log__head">
        <h2 className="zen-log__title">阅读记录</h2>
        <button type="button" className="zen-log__all" onClick={onOpenHistory}>
          查看全部
          <ChevronRight size={14} />
        </button>
      </div>

      <ul className="zen-log__list">
        {entries.slice(0, 5).map((entry) => (
          <li key={`${entry.key}-${entry.bookId}`} className="zen-log__entry">
            <span className="zen-log__date">{dayLabel(entry.key, now)}</span>
            <span className="zen-log__book-name">{displayTitle(entry.bookTitle)}</span>
            <span className="zen-log__span">{formatSpan(entry.seconds)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 历史页：按月摊开每天读了哪本、读了多久。 */
function HistoryScreen({
  sessions,
  onBack,
}: {
  sessions: ReadingSession[];
  onBack: () => void;
}) {
  const [now] = useState(() => Date.now());
  const months = useMemo(
    () => groupEntriesByMonth(dailyBookEntries(sessions)),
    [sessions]
  );

  return (
    <div className="screen">
      <header className="ios-nav-bar">
        <button type="button" className="ios-back" onClick={onBack}>
          <ChevronLeft size={22} />
          主页
        </button>
        <span>阅读记录</span>
      </header>

      {!months.length ? (
        <EmptyState
          icon={<BookOpen size={28} />}
          title="还没有记录"
          description="读上一会儿或听上一段，这里就会留下痕迹。"
        />
      ) : (
        months.map((month) => (
          <section key={month.key} className="zen-history">
            <div className="zen-history__head">
              <h2>{monthLabel(month.key)}</h2>
              <small>{formatSpan(month.seconds)}</small>
            </div>
            <ul className="zen-log__list">
              {month.entries.map((entry) => (
                <li
                  key={`${entry.key}-${entry.bookId}`}
                  className="zen-log__entry"
                >
                  <span className="zen-log__date">
                    {dayLabel(entry.key, now)}
                  </span>
                  <span className="zen-log__book-name">{displayTitle(entry.bookTitle)}</span>
                  <span className="zen-log__span">
                    {formatSpan(entry.seconds)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function HomeScreen({
  books,
  stats,
  sessions,
  onOpenReader,
  onPlay,
  onOpenPlayer,
  onImport,
  onOpenHistory,
  onOpenSettings,
  onOpenLibrary,
  onOpenStore,
  onSearchStore,
}: {
  books: BookMeta[];
  stats: ReadingStats;
  sessions: ReadingSession[];
  onOpenReader: (book: BookMeta) => void;
  onPlay: (book: BookMeta) => void;
  onOpenPlayer: (book: BookMeta) => void;
  onImport: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
  /** 去书城。带 bookId 就直接落在那本书的详情上。 */
  onOpenStore: (bookId?: string) => void;
  /** 在书城里搜这个词。 */
  onSearchStore: (query: string) => void;
}) {
  const [query, setQuery] = useState("");

  // 一本书一张卡：以前「继续阅读」和「继续收听」各排一行，
  // 同一本书既读过又听过就会上下重复出现，主页因此显得又长又乱。
  const resuming = books
    .filter((book) => book.readingPosition || book.listeningPosition)
    .map((book) => {
      const readAt = book.readingPosition?.updatedAt ?? 0;
      const listenAt = book.listeningPosition?.updatedAt ?? 0;
      return { book, listenLed: listenAt > readAt, touchedAt: Math.max(readAt, listenAt) };
    })
    .sort((a, b) => b.touchedAt - a.touchedAt);
  const untouched = resuming.length ? [] : books;

  // 卡片跟着最近动过的那一侧走：上次在听，进度条、「继续收听」都按听的位置算。
  const ledPercent = ({ book, listenLed }: (typeof resuming)[number]) =>
    Math.round(
      (listenLed ? book.listeningPosition?.percent : book.readingPosition?.percent) ?? 0
    );

  return (
    <div className="screen">
      <LargeHeader
        title="墨听"
        actions={
          <button
            type="button"
            className="icon-button"
            aria-label="设置"
            onClick={onOpenSettings}
          >
            <Settings size={23} strokeWidth={1.8} />
          </button>
        }
      />

      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const keyword = query.trim();
          if (!keyword) return;
          (document.activeElement as HTMLElement | null)?.blur();
          onSearchStore(keyword);
        }}
      >
        <label className="ios-search">
          <Search size={18} />
          <input
            value={query}
            maxLength={100}
            enterKeyHint="search"
            aria-label="在书城搜索书籍"
            placeholder="搜索书籍"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}>
              <X size={15} />
            </button>
          ) : null}
        </label>
      </form>

      {!books.length ? (
        <EmptyState
          icon={<BookOpen size={28} />}
          title="还没有书"
          description="导入 EPUB、文字型 PDF、TXT 或 Markdown，就能开始阅读和听书。"
          action={
            <button type="button" className="primary-button" onClick={onImport}>
              <Upload size={17} />
              导入第一本书
            </button>
          }
        />
      ) : (
        <>
          {resuming.length ? (
            <section className="home-row">
              <div className="section-head">
                <h2>继续阅读</h2>
                <button type="button" className="section-link" onClick={onOpenLibrary}>
                  查看全部
                  <ChevronRight size={15} />
                </button>
              </div>
              <div className="home-row__track">
                {resuming.map((entry) => (
                  <HomeCard
                    key={entry.book.id}
                    book={entry.book}
                    percent={ledPercent(entry)}
                    meta={`${entry.listenLed ? "已听" : "已读"} ${ledPercent(entry)}%`}
                    action={entry.listenLed ? "继续收听" : "继续阅读"}
                    onOpen={entry.listenLed ? onOpenPlayer : onOpenReader}
                    onAction={entry.listenLed ? onPlay : onOpenReader}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {untouched.length ? (
            <section className="home-row">
              <div className="section-head">
                <h2>从这里开始</h2>
                <button type="button" className="section-link" onClick={onOpenLibrary}>
                  查看全部
                  <ChevronRight size={15} />
                </button>
              </div>
              <div className="home-row__track">
                {untouched.map((book) => (
                  <HomeCard
                    key={book.id}
                    book={book}
                    percent={0}
                    meta={formatRemaining(book)}
                    action="开始阅读"
                    onOpen={onOpenReader}
                    onAction={onOpenReader}
                  />
                ))}
              </div>
            </section>
          ) : null}

        </>
      )}

      {/* 书城接在「继续读」下面：逛新书比回看统计更常用，统计往下滚就是。 */}
      <HomeStore
        onOpenStore={() => onOpenStore()}
        onOpenBook={(bookId) => onOpenStore(bookId)}
      />

      {books.length ? (
        <>
          <ReadingBoard stats={stats} sessions={sessions} />
          <ReadingLog sessions={sessions} onOpenHistory={onOpenHistory} />
        </>
      ) : null}
    </div>
  );
}

const LibraryBookCard = memo(function LibraryBookCard({
  book,
  onOpen,
  onMore,
}: {
  book: BookMeta;
  onOpen: (book: BookMeta) => void;
  onMore: (book: BookMeta) => void;
}) {
  const percent = Math.round(book.readingPosition?.percent ?? 0);
  const isNew = !book.readingPosition && !book.listeningPosition;
  const progressLabel = isNew
    ? "未读"
    : percent >= 99
      ? "已读完"
      : `已读 ${percent}%`;
  return (
    <article className="grid-book">
      <button type="button" className="grid-book__cover"
        aria-label={`阅读${displayTitle(book.title)}`} onClick={() => onOpen(book)}>
        <BookCover book={book} size="large" />
      </button>
      <strong className="grid-book__title">{displayTitle(book.title)}</strong>
      <div className="grid-book__footer">
        <span className="grid-book__progress">{progressLabel}</span>
        <button type="button" className="grid-book__more"
          aria-label={`${book.title}的更多操作`} onClick={() => onMore(book)}>
          <MoreHorizontal size={18} />
        </button>
      </div>
    </article>
  );
});

function LibraryScreen({
  books,
  onImport,
  onFind,
  onOpen,
  onPlay,
  onOpenNotes,
  onOpenMetadata,
  onDelete,
}: {
  books: BookMeta[];
  onImport: () => void;
  /** 去在线找书。带上关键词就进去直接搜。 */
  onFind: (query: string) => void;
  onOpen: (book: BookMeta) => void;
  onPlay: (book: BookMeta) => void;
  onOpenNotes: (book: BookMeta) => void;
  onOpenMetadata: (book: BookMeta) => void;
  onDelete: (book: BookMeta) => void;
}) {
  const [query, setQuery] = useState("");
  const [sheetBook, setSheetBook] = useState<BookMeta | null>(null);
  const [showSources, setShowSources] = useState(false);
  // Navigation creates a new handler on root renders. Keep list-row props stable;
  // reading progress should only update the one book whose progress changed.
  const onOpenRef = useRef(onOpen);
  useLayoutEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  const openBook = useCallback((book: BookMeta) => onOpenRef.current(book), []);

  const filtered = books.filter((book) =>
    `${book.title} ${book.author}`.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="screen">
      <LargeHeader
        title="书库"
        actions={
          <button
            type="button"
            className="icon-button icon-button--filled"
            aria-label="添加书籍"
            onClick={() => setShowSources(true)}
          >
            <Plus size={20} />
          </button>
        }
      />

      <label className="ios-search">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索书名或作者"
        />
        {query ? (
          <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}>
            <X size={15} />
          </button>
        ) : null}
      </label>

      {!books.length ? (
        <EmptyState
          icon={<Library size={28} />}
          title="书库还是空的"
          description="在线找一本，或者导入自己的文件。书都存在这台设备上，不会上传。"
          action={
            <div className="library-empty__actions">
              <button type="button" className="primary-button" onClick={() => onFind("")}>
                <Search size={17} />
                在线找书
              </button>
              <button type="button" className="text-button" onClick={onImport}>
                <Upload size={17} />
                从文件导入
              </button>
            </div>
          }
        />
      ) : (
        <>
          <div className="grid-heading">
            <h2>{query ? "搜索结果" : "全部图书"}</h2>
            <small>{filtered.length} 本</small>
          </div>

          {filtered.length ? (
            <div className="book-grid">
              {filtered.map((book) => (
                <LibraryBookCard key={book.id} book={book} onOpen={openBook} onMore={setSheetBook} />
              ))}
            </div>
          ) : (
            <div className="library-miss">
              <p>
                书库里没有<strong>「{query.trim()}」</strong>。
              </p>
              <button
                type="button"
                className="primary-button"
                onClick={() => onFind(query.trim())}
              >
                <Search size={17} />
                去在线找这本书
              </button>
            </div>
          )}
        </>
      )}

      {showSources ? (
        <Modal title="添加书籍" onClose={() => setShowSources(false)}>
          <div className="book-actions">
            <button
              type="button"
              className="book-action"
              onClick={() => {
                setShowSources(false);
                onFind("");
              }}
            >
              <Search size={19} />
              <span>在线找书</span>
            </button>
            <button
              type="button"
              className="book-action"
              onClick={() => {
                setShowSources(false);
                onImport();
              }}
            >
              <Upload size={19} />
              <span>从文件导入</span>
            </button>
          </div>
        </Modal>
      ) : null}

      {sheetBook ? (
        <Modal title={displayTitle(sheetBook.title)} onClose={() => setSheetBook(null)}>
          <div className="book-actions">
            <p className="book-actions__author">{sheetBook.author}</p>
            <button
              type="button"
              className="book-action"
              onClick={() => {
                const book = sheetBook;
                setSheetBook(null);
                onOpen(book);
              }}
            >
              <BookOpen size={19} />
              <span>阅读</span>
            </button>
            <button
              type="button"
              className="book-action"
              onClick={() => {
                const book = sheetBook;
                setSheetBook(null);
                onPlay(book);
              }}
            >
              <Headphones size={19} />
              <span>听书</span>
            </button>
            <button
              type="button"
              className="book-action"
              onClick={() => {
                const book = sheetBook;
                setSheetBook(null);
                onOpenNotes(book);
              }}
            >
              <PencilLine size={19} />
              <span>笔记与划线</span>
            </button>
            <button
              type="button"
              className="book-action"
              onClick={() => {
                const book = sheetBook;
                setSheetBook(null);
                onOpenMetadata(book);
              }}
            >
              <Info size={19} />
              <span>书籍资料</span>
            </button>
            <button
              type="button"
              className="book-action book-action--danger"
              onClick={() => {
                const book = sheetBook;
                setSheetBook(null);
                onDelete(book);
              }}
            >
              <Trash2 size={19} />
              <span>从书库删除</span>
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * 「书籍资料」弹层：看后台查到了什么、手动换一个版本、或者整个还原回导入时的样子。
 * 只显示和改书名、作者、封面三项——正文、阅读进度、划线一律不碰。
 */
function BookMetadataSheet({
  book,
  patch,
  busy,
  onApply,
  onRevert,
  onRefresh,
  onClose,
}: {
  book: BookMeta;
  patch: BookMetadataPatch | undefined;
  busy: boolean;
  onApply: (candidate: BookMetadataCandidate) => void;
  onRevert: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const applied = patch?.applied;
  return (
    <Modal title="书籍资料" onClose={onClose}>
      <div className="book-metadata" aria-busy={busy}>
        <div className="book-metadata__current">
          <BookCover book={book} size="medium" />
          <div>
            <strong>{book.title}</strong>
            <small>{book.author}</small>
            <em>{applied ? "已套用线上资料" : "导入时的资料"}</em>
          </div>
        </div>

        {busy ? (
          <p className="book-metadata__hint" role="status">
            正在查询 Google Books…
          </p>
        ) : patch?.failedReason ? (
          <p className="book-metadata__error" role="alert">
            {patch.failedReason}
          </p>
        ) : !patch ? (
          <p className="book-metadata__hint">
            这本书还没有查过。书名、作者和封面都齐全时不会自动查询。
          </p>
        ) : !patch.candidates.length ? (
          <p className="book-metadata__hint">
            Google Books 上没有找到「{patch.query}」。中文书的收录并不完整，查不到是常事。
          </p>
        ) : null}

        {patch?.candidates.length ? (
          <ul className="book-metadata__list">
            {patch.candidates.map((candidate) => {
              const active = applied?.volumeId === candidate.volumeId;
              return (
                <li key={candidate.volumeId}>
                  <button
                    type="button"
                    aria-pressed={active}
                    disabled={busy}
                    onClick={() => onApply(candidate)}
                  >
                    <span className="book-metadata__thumb">
                      <BookOpen size={17} aria-hidden="true" />
                      {candidate.coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={wereadCoverDisplayUrl(candidate.coverUrl, "row")}
                          alt=""
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          onError={(event) => {
                            const image = event.currentTarget;
                            if (image.dataset.fallback !== "1" && candidate.coverUrl) {
                              image.dataset.fallback = "1";
                              image.src = coverProxyUrl(candidate.coverUrl, "row");
                              return;
                            }
                            image.style.display = "none";
                          }}
                        />
                      ) : null}
                    </span>
                    <span className="book-metadata__info">
                      <strong>{candidate.title}</strong>
                      <small>{formatAuthors(candidate.authors) || "作者未提供"}</small>
                      <em>
                        {[candidate.publishedDate, candidate.categories[0]]
                          .filter(Boolean)
                          .join(" · ") || "出版信息未提供"}
                      </em>
                    </span>
                    {active ? <Check size={16} aria-label="已套用" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div className="book-metadata__actions">
          {applied ? (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={onRevert}
            >
              还原成导入时的资料
            </button>
          ) : null}
          <button type="button" className="text-button" disabled={busy} onClick={onRefresh}>
            重新查询
          </button>
        </div>

        <p className="book-metadata__credit">
          资料来自 Google Books，只替换书名、作者和封面，不改正文、阅读进度和划线。
        </p>
      </div>
    </Modal>
  );
}

function ListenScreen({
  books,
  onPlay,
  onOpenPlayer,
}: {
  books: BookMeta[];
  onPlay: (book: BookMeta) => void;
  onOpenPlayer: (book: BookMeta) => void;
}) {
  const [query, setQuery] = useState("");
  const started = books
    .filter((book) => book.listeningPosition)
    .sort(
      (a, b) =>
        (b.listeningPosition?.updatedAt ?? 0) -
        (a.listeningPosition?.updatedAt ?? 0)
    );
  const visible = books.filter((book) =>
    `${book.title} ${book.author}`.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="screen">
      <LargeHeader title="听书" />

      <label className="ios-search">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索可听书籍"
        />
        {query ? (
          <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}>
            <X size={15} />
          </button>
        ) : null}
      </label>

      {!books.length ? (
        <EmptyState
          icon={<Headphones size={28} />}
          title="还没有可以听的书"
          description="先到书库导入一本书，解析完成后会自动出现在这里。"
        />
      ) : (
        <>
          {started.length && !query ? (
            <Shelf title="继续收听">
              {started.map((book) => (
                <ShelfCard
                  key={book.id}
                  book={book}
                  size="large"
                  onOpen={onOpenPlayer}
                  onPlay={onPlay}
                />
              ))}
            </Shelf>
          ) : null}

          <section className="ios-section">
            <div className="section-head">
              <h2>{query ? "搜索结果" : "全部有声书"}</h2>
            </div>
            <div className="card-list">
              {visible.map((book) => (
                <div className="ios-row ios-row--media" key={book.id}>
                  <button
                    type="button"
                    className="ios-row__main"
                    onClick={() => onOpenPlayer(book)}
                  >
                    <BookCover book={book} size="small" />
                    <span>
                      <strong>{displayTitle(book.title)}</strong>
                      <small>{book.author}</small>
                      <em>{formatRemaining(book, book.listeningPosition)}</em>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ios-play-button"
                    aria-label={`播放${book.title}`}
                    onClick={() => onPlay(book)}
                  >
                    <Play size={15} fill="currentColor" />
                  </button>
                </div>
              ))}
            </div>
            {!visible.length ? (
              <p className="no-results">没有找到匹配的书籍。</p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

/** 月历式跳转条：有笔记的日子底下一个墨点，点一下按那天筛出来，回顾不用再往下翻。 */
function NotesCalendar({
  countsByDay,
  selected,
  onSelect,
}: {
  countsByDay: Map<string, number>;
  selected: string | null;
  onSelect: (day: string | null) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const latest = Array.from(countsByDay.keys()).sort().pop();
    const base = latest ? new Date(`${latest}T00:00:00`) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const [todayKey] = useState(() => dayKey(Date.now()));
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthHasNotes = Array.from(countsByDay.keys()).some((key) =>
    key.startsWith(monthKey)
  );

  const cells: ({ key: string; day: number } | null)[] = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push({
      key: `${monthKey}-${String(d).padStart(2, "0")}`,
      day: d,
    });
  }

  return (
    <div className="notes-calendar">
      <div className="notes-calendar__head">
        <button
          type="button"
          aria-label="上个月"
          onClick={() => setCursor(new Date(year, month - 1, 1))}
        >
          <ChevronLeft size={16} />
        </button>
        <strong>
          {year}年{month + 1}月
        </strong>
        <button
          type="button"
          aria-label="下个月"
          onClick={() => setCursor(new Date(year, month + 1, 1))}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="notes-calendar__weekdays">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="notes-calendar__grid">
        {cells.map((cell, index) => {
          if (!cell) return <span key={`blank-${index}`} />;
          const count = countsByDay.get(cell.key) ?? 0;
          return (
            <button
              type="button"
              key={cell.key}
              className={`notes-calendar__day ${
                cell.key === todayKey ? "is-today" : ""
              } ${cell.key === selected ? "is-selected" : ""}`}
              disabled={!count}
              aria-label={`${cell.day}日${count ? `，${count} 条笔记` : ""}`}
              onClick={() => onSelect(selected === cell.key ? null : cell.key)}
            >
              {cell.day}
              {count ? <i /> : null}
            </button>
          );
        })}
      </div>
      {!monthHasNotes ? <p className="notes-calendar__empty">这个月还没有笔记</p> : null}
    </div>
  );
}

/** 一次跨句划线在库里是多条记录，列表上要先合回用户划的那一整段。 */
function mergeNoteGroups(notes: BookNote[]): BookNote[] {
  const buckets = new Map<string, BookNote[]>();
  notes.forEach((note) => {
    const key = groupKey(note);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(note);
    else buckets.set(key, [note]);
  });
  return Array.from(buckets.values()).map(mergeNoteGroup);
}

/** 一条笔记：摘录按原色压一道下划线，底下是想法和操作。书内笔记页和旧的跨书列表共用这一种样式。 */
function InkNote({
  note,
  chapterTitle,
  onOpen,
  onEditThought,
  onDelete,
}: {
  note: BookNote;
  /** 已经按章节分段时不再重复显示章节名。 */
  chapterTitle?: string;
  onOpen: (note: BookNote) => void;
  onEditThought: (note: BookNote) => void;
  onDelete: (note: BookNote) => void;
}) {
  const listening = note.kind === "listening-mark";
  return (
    <article className="ink-note">
      <button type="button" className="ink-note__body" onClick={() => onOpen(note)}>
        <span className="ink-note__meta">
          {listening ? <Headphones size={11} /> : null}
          {chapterTitle ? <span className="ink-note__chapter">{chapterTitle}</span> : null}
          <em>{formatDate(note.createdAt)}</em>
        </span>
        <p className="ink-note__text">
          <span
            className={
              listening
                ? "ink-note__mark ink-note__mark--plain"
                : `ink-note__mark ink-note__mark--${note.color ?? "yellow"} ink-note__mark--${note.highlightStyle ?? "underline"}`
            }
          >
            {note.excerpt}
          </span>
        </p>
        {note.thought ? <span className="ink-note__thought">{note.thought}</span> : null}
      </button>
      <div className="ink-note__actions">
        <button type="button" onClick={() => onEditThought(note)}>
          <PencilLine size={13} />
          {note.thought ? "改想法" : "写想法"}
        </button>
        <button type="button" onClick={() => onDelete(note)}>
          <Trash2 size={13} />
          删除
        </button>
      </div>
    </article>
  );
}

/**
 * 笔记 tab：先是有笔记的书，点进去才看这本书的笔记（照微信读书「我的笔记」）。
 * 以前是所有书的笔记一路铺下来，书一多，找某一本的笔记要翻很久。
 */
function NotesScreen({
  notes,
  books,
  chats,
  onOpenBook,
  onOpenChat,
}: {
  notes: BookNote[];
  books: BookMeta[];
  chats: BookAiChat[];
  onOpenBook: (book: BookMeta) => void;
  onOpenChat: (book: BookMeta) => void;
}) {
  const [tab, setTab] = useState<"notes" | "chat">("notes");
  const [query, setQuery] = useState("");

  // 一本书一行。计数按「一次划线」算，跨句划线不会被数成好几条。
  const shelves = useMemo(() => {
    const byBook = new Map<string, { groups: Set<string>; thoughts: Set<string>; latest: number }>();
    notes.forEach((note) => {
      let entry = byBook.get(note.bookId);
      if (!entry) byBook.set(note.bookId, (entry = { groups: new Set(), thoughts: new Set(), latest: 0 }));
      const key = groupKey(note);
      entry.groups.add(key);
      if (note.thought) entry.thoughts.add(key);
      entry.latest = Math.max(entry.latest, note.updatedAt ?? note.createdAt);
    });
    return books
      .filter((book) => byBook.has(book.id))
      .map((book) => {
        const entry = byBook.get(book.id)!;
        return { book, count: entry.groups.size, thoughts: entry.thoughts.size, latest: entry.latest };
      })
      .sort((a, b) => b.latest - a.latest);
  }, [books, notes]);

  const chatShelves = useMemo(
    () =>
      chats
        .filter((chat) => chat.turns.length)
        .map((chat) => ({ chat, book: books.find((b) => b.id === chat.bookId) }))
        .filter((entry): entry is { chat: BookAiChat; book: BookMeta } => Boolean(entry.book))
        .sort((a, b) => b.chat.updatedAt - a.chat.updatedAt),
    [chats, books]
  );

  const needle = query.trim().toLowerCase();
  const matches = (book: BookMeta) => !needle || `${book.title} ${book.author}`.toLowerCase().includes(needle);
  const visibleShelves = shelves.filter(({ book }) => matches(book));
  const visibleChats = chatShelves.filter(({ book }) => matches(book));
  const totalNotes = shelves.reduce((sum, entry) => sum + entry.count, 0);
  const totalRounds = chatShelves.reduce(
    (sum, { chat }) => sum + chat.turns.filter((turn) => turn.role === "user").length,
    0
  );

  if (!shelves.length && !chatShelves.length) {
    return (
      <div className="screen">
        <LargeHeader title="笔记" />
        <EmptyState
          icon={<Highlighter size={27} />}
          title="还没有划线"
          description="阅读时选中一段文字，就能划线、写想法；听书时也可以随手标记。"
        />
      </div>
    );
  }

  return (
    <div className="screen">
      <LargeHeader
        title="笔记"
        subtitle={
          tab === "chat"
            ? `${chatShelves.length} 本书 · ${totalRounds} 轮对话`
            : `${shelves.length} 本书 · ${totalNotes} 条笔记`
        }
      />

      <div className="ios-segmented">
        {(
          [
            ["notes", "笔记"],
            ["chat", "AI 对话"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={tab === id ? "is-active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="ios-search">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索书名或作者"
        />
        {query ? (
          <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}>
            <X size={15} />
          </button>
        ) : null}
      </label>

      {tab === "chat" ? (
        !chatShelves.length ? (
          <EmptyState
            icon={<Sparkles size={26} />}
            title="还没有 AI 对话"
            description="阅读时选中一段文字问 AI，聊天记录会按书保存在这里。"
          />
        ) : !visibleChats.length ? (
          <p className="no-results">没有找到匹配的书籍。</p>
        ) : (
          <div className="card-list">
            {visibleChats.map(({ book, chat }) => {
              // 列表里露最近问的那一句：回答是 Markdown，截一段下来全是星号和井号。
              const asked = chat.turns.filter((turn) => turn.role === "user");
              const last = asked[asked.length - 1];
              const rounds = asked.length;
              return (
                <button
                  type="button"
                  className="ios-row ios-row--media notes-book-row"
                  key={book.id}
                  onClick={() => onOpenChat(book)}
                >
                  <span className="ios-row__main">
                    <BookCover book={book} size="small" />
                    <span>
                      <strong>{displayTitle(book.title)}</strong>
                      <small>{last?.content.slice(0, 30) || book.author}</small>
                      <em>{rounds} 轮对话</em>
                    </span>
                  </span>
                  <span className="notes-book-row__date">{formatDate(chat.updatedAt)}</span>
                  <ChevronRight size={15} className="ios-row__chevron" />
                </button>
              );
            })}
          </div>
        )
      ) : !shelves.length ? (
        <EmptyState
          icon={<Highlighter size={26} />}
          title="还没有划线"
          description="阅读时选中一段文字，就能划线、写想法；听书时也可以随手标记。"
        />
      ) : !visibleShelves.length ? (
        <p className="no-results">没有找到匹配的书籍。</p>
      ) : (
        <div className="card-list">
          {visibleShelves.map(({ book, count, thoughts, latest }) => (
            <button
              type="button"
              className="ios-row ios-row--media notes-book-row"
              key={book.id}
              onClick={() => onOpenBook(book)}
            >
              <span className="ios-row__main">
                <BookCover book={book} size="small" />
                <span>
                  <strong>{displayTitle(book.title)}</strong>
                  <small>{book.author}</small>
                  <em>
                    {count} 条笔记
                    {thoughts ? ` · ${thoughts} 条想法` : ""}
                  </em>
                </span>
              </span>
              <span className="notes-book-row__date">{formatDate(latest)}</span>
              <ChevronRight size={15} className="ios-row__chevron" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 一本书的笔记：按章节分段、按在书里的先后排（跟微信读书一致），
 * 找「第三章划过的那句」不用在时间线里来回翻。日历筛选照旧保留。
 */
function BookNotesScreen({
  book,
  notes,
  onBack,
  onOpen,
  onDelete,
  onEditThought,
}: {
  book: Book;
  notes: BookNote[];
  onBack: () => void;
  onOpen: (note: BookNote) => void;
  onDelete: (note: BookNote) => void;
  onEditThought: (note: BookNote) => void;
}) {
  const [filter, setFilter] = useState<"all" | "thought" | "listening-mark">("all");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const merged = useMemo(() => mergeNoteGroups(notes), [notes]);

  // 句子在全书里的先后。一本长篇几万句，只在正文变了时算一次。
  const order = useMemo(() => {
    const chapterIndex = new Map<string, number>();
    const sentenceIndex = new Map<string, number>();
    let position = 0;
    book.chapters.forEach((chapter, index) => {
      chapterIndex.set(chapter.id, index);
      for (const paragraph of chapter.paragraphs) {
        for (const sentence of paragraph.sentences ?? []) {
          sentenceIndex.set(sentence.id, position);
          position += 1;
        }
      }
    });
    return { chapterIndex, sentenceIndex };
  }, [book.chapters]);

  const countsByDay = useMemo(() => {
    const counts = new Map<string, number>();
    merged.forEach((note) => {
      const key = dayKey(note.createdAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [merged]);

  const sections = useMemo(() => {
    const visible = merged
      .filter((note) => {
        if (selectedDay && dayKey(note.createdAt) !== selectedDay) return false;
        if (filter === "thought") return Boolean(note.thought);
        if (filter === "listening-mark") return note.kind === "listening-mark";
        return true;
      })
      .sort((a, b) => {
        const chapterA = order.chapterIndex.get(a.chapterId) ?? Number.MAX_SAFE_INTEGER;
        const chapterB = order.chapterIndex.get(b.chapterId) ?? Number.MAX_SAFE_INTEGER;
        if (chapterA !== chapterB) return chapterA - chapterB;
        const sentenceA = order.sentenceIndex.get(a.sentenceId) ?? Number.MAX_SAFE_INTEGER;
        const sentenceB = order.sentenceIndex.get(b.sentenceId) ?? Number.MAX_SAFE_INTEGER;
        return sentenceA - sentenceB || a.createdAt - b.createdAt;
      });
    const result: Array<{ chapterId: string; title: string; items: BookNote[] }> = [];
    for (const note of visible) {
      const index = order.chapterIndex.get(note.chapterId);
      // 续页上的笔记归到前面那个有名字的章下面，跟目录一致。
      const title = index === undefined ? "正文" : chapterLabel(book.chapters, index);
      const last = result[result.length - 1];
      if (last && last.title === title) {
        last.items.push(note);
      } else {
        result.push({ chapterId: note.chapterId, title, items: [note] });
      }
    }
    return result;
  }, [book.chapters, filter, merged, order, selectedDay]);

  const thoughts = merged.filter((note) => note.thought).length;

  return (
    <div className="screen screen--book-notes">
      <header className="ios-nav-bar">
        <button type="button" className="ios-back" onClick={onBack}>
          <ChevronLeft size={22} />
          返回
        </button>
        <span>笔记</span>
      </header>

      <div className="book-notes-hero">
        <BookCover book={book} size="small" />
        <span>
          <strong>{displayTitle(book.title)}</strong>
          <small>{book.author}</small>
          <em>
            {merged.length} 条笔记
            {thoughts ? ` · ${thoughts} 条想法` : ""}
          </em>
        </span>
      </div>

      <div className="ios-segmented">
        {(
          [
            ["all", "全部"],
            ["thought", "想法"],
            ["listening-mark", "听书标记"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={filter === id ? "is-active" : ""}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <NotesCalendar countsByDay={countsByDay} selected={selectedDay} onSelect={setSelectedDay} />

      {selectedDay ? (
        <button type="button" className="notes-day-chip" onClick={() => setSelectedDay(null)}>
          只看 {selectedDay.replace(/-/g, ".")}
          <X size={13} />
        </button>
      ) : null}

      {!sections.length ? (
        <EmptyState
          icon={<Highlighter size={26} />}
          title={selectedDay ? "这天没有笔记" : "这里还是空的"}
          description={
            selectedDay ? "换一天看看，或者清除筛选看全部。" : "换个筛选，或者回到正文里划一段。"
          }
        />
      ) : (
        <div className="ink-feed ink-feed--book">
          {sections.map((section) => (
            <section className="ink-chapter" key={section.chapterId}>
              <h3 className="ink-chapter__title">{section.title}</h3>
              {section.items.map((note) => (
                <InkNote
                  key={note.id}
                  note={note}
                  onOpen={onOpen}
                  onEditThought={onEditThought}
                  onDelete={onDelete}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** base URL 填完（失焦）就自动拉一次模型列表；拉不到就退回手填，不强求。内嵌在聊天面板里，不再是独立设置页。 */
const HEADING_TAGS = ["h2", "h2", "h3", "h4", "h5", "h6"] as const;

/** 滑动中离底还有这么多像素就先往下接一章。往下接只动视口下方，滑动中做也不会跳。 */
const CHAPTER_LOAD_MARGIN = 1200;
/**
 * 停稳后，视口上方、下方各备好几屏已经排好版的正文。
 * iPhone 上用力一甩能滑出十来屏；缓冲不够就会在半路撞上「假的书顶」停住。
 * 纯文字一屏大约四百字，十几屏也就上千个句子 span，挂得起。
 */
const WINDOW_BUFFER_SCREENS = 12;
/** 整章离视口超过这么多屏就摘掉。比缓冲大一截，免得摘了又接、来回抖。 */
const WINDOW_TRIM_SCREENS = 24;
/** 最后一次滚动（含惯性）之后这么久没动、手也不在屏上，才算停稳。 */
const WINDOW_IDLE_MS = 200;
/** 停稳后调整窗口是一步一步做的，步与步之间让出主线程，手指随时能落下来。 */
const WINDOW_STEP_GAP_MS = 32;

/** 停稳后每一步最多排这么多字的段落。一步的排版控制在十几毫秒，手指落下来不用等。 */
const PRIME_CHUNK_CHARS = 2400;

/**
 * 把一章里还按估算高度占位的段落，挑离视口最近的一批改成真实排版。
 * 整章都排完了就在章上打 data-primed，之后这章新挂上来的段落（比如批注卡把段落
 * 重新包了一层）也跟着按真实排版走。
 */
function primeChunk(section: HTMLElement, budget: number) {
  const pending = Array.from(
    section.querySelectorAll<HTMLElement>(".reader-block:not([data-primed])")
  );
  const viewportHeight = window.innerHeight;
  const distance = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom < 0
      ? -rect.bottom
      : rect.top > viewportHeight
        ? rect.top - viewportHeight
        : 0;
  };
  const ordered = pending
    .map((element) => ({ element, distance: distance(element) }))
    .sort((a, b) => a.distance - b.distance);
  let used = 0;
  let done = 0;
  for (const { element } of ordered) {
    if (used >= budget) break;
    element.dataset.primed = "";
    used += Number(element.style.getPropertyValue("--chars")) || 60;
    done += 1;
  }
  if (done === pending.length) section.dataset.primed = "";
}

/** 整章一次排好。只在跳转、进书这种本来就要等一下的时候用。 */
function primeSection(section: HTMLElement | null | undefined) {
  if (section) section.dataset.primed = "";
}

/** 每章「句子 id → 章内序号」。按章对象缓存，章不变就是同一个 Map，按章 memo 才管用。 */
const sentenceIndexCache = new WeakMap<Chapter, Map<string, number>>();
function sentenceIndexOf(chapter: Chapter): Map<string, number> {
  let map = sentenceIndexCache.get(chapter);
  if (!map) {
    map = new Map();
    flattenChapter(chapter).forEach((sentence, i) => map!.set(sentence.id, i));
    sentenceIndexCache.set(chapter, map);
  }
  return map;
}

/** 一条划线落在某一句上的片段。跨句选中会拆成多条。 */
export interface HighlightPart {
  chapterIndex: number;
  sentenceId: string;
  sentenceIndex: number;
  start: number;
  end: number;
  text: string;
}

/** 选区落在这个元素里的那一截，偏移量按纯文本算，和 sentence.text 对得上。 */
function offsetsWithin(
  element: HTMLElement,
  range: Range
): { start: number; end: number; text: string } | null {
  const full = document.createRange();
  full.selectNodeContents(element);
  if (range.compareBoundaryPoints(Range.START_TO_END, full) <= 0) return null;
  if (range.compareBoundaryPoints(Range.END_TO_START, full) >= 0) return null;

  const clipped = range.cloneRange();
  if (clipped.compareBoundaryPoints(Range.START_TO_START, full) < 0) {
    clipped.setStart(full.startContainer, full.startOffset);
  }
  if (clipped.compareBoundaryPoints(Range.END_TO_END, full) > 0) {
    clipped.setEnd(full.endContainer, full.endOffset);
  }

  const lead = document.createRange();
  lead.setStart(full.startContainer, full.startOffset);
  lead.setEnd(clipped.startContainer, clipped.startOffset);
  const text = clipped.toString();
  const start = lead.toString().length;
  return { start, end: start + text.length, text };
}

/** 把一句话按划线切成若干段，命中的部分包一层 mark。 */
function renderSentence(text: string, marks: BookNote[]): ReactNode {
  if (!marks.length) return text;
  const ordered = marks
    .map((note) => ({
      note,
      start: Math.max(0, Math.min(text.length, note.start ?? 0)),
      end: Math.max(0, Math.min(text.length, note.end ?? text.length)),
    }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const item of ordered) {
    if (item.end <= cursor) continue;
    const from = Math.max(cursor, item.start);
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(
      <mark
        key={item.note.id}
        data-note-id={item.note.id}
        className={`reader-mark reader-mark--${item.note.color ?? "yellow"} reader-mark--${item.note.highlightStyle ?? "underline"} ${
          item.note.thought ? "has-thought" : ""
        }`}
      >
        {text.slice(from, item.end)}
      </mark>
    );
    cursor = item.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/**
 * 插图的 blob URL 按图片 id 缓存，整个阅读器共用一份。
 *
 * 连续阅读里章节会随滑动摘掉又挂回来，每挂一次都重新读库、重新建 URL、重新解码，
 * 表现就是图片先空一下再「闪」出来。离开这本书时统一释放。
 */
const imageUrlCache = new Map<string, string>();

function releaseImageUrls() {
  for (const url of imageUrlCache.values()) URL.revokeObjectURL(url);
  imageUrlCache.clear();
}

/** 图片离视口还有这么远就开始取、开始解码，滑到时已经是解好的位图。 */
const IMAGE_PRELOAD_MARGIN = "1600px";

const ReaderImage = memo(function ReaderImage({
  imageId,
  alt,
  width,
  height,
}: {
  imageId: string;
  alt: string;
  width?: number;
  height?: number;
}) {
  const figureRef = useRef<HTMLElement>(null);
  const [url, setUrl] = useState(() => imageUrlCache.get(imageId) ?? "");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const onImageUpdated = (event: Event) => {
      if ((event as CustomEvent<{ imageId?: string }>).detail?.imageId !== imageId) return;
      const cached = imageUrlCache.get(imageId);
      if (cached) {
        imageUrlCache.delete(imageId);
        URL.revokeObjectURL(cached);
      }
      setUrl("");
      // A missing image may already have disconnected its observer after the first attempt.
      setRevision((value) => value + 1);
    };
    window.addEventListener("moting:image-updated", onImageUpdated);
    return () => window.removeEventListener("moting:image-updated", onImageUpdated);
  }, [imageId]);

  useEffect(() => {
    if (url) return;
    const figure = figureRef.current;
    if (!figure) return;
    let cancelled = false;

    const load = async () => {
      let objectUrl = imageUrlCache.get(imageId);
      if (!objectUrl) {
        const image = await getBookImage(imageId).catch(() => undefined);
        if (!image || cancelled) return;
        objectUrl = imageUrlCache.get(imageId) ?? URL.createObjectURL(image.blob);
        imageUrlCache.set(imageId, objectUrl);
      }
      // 先在后台解码好再换上。直接给 src 的话，大图要在主线程上边解码边画：
      // 滑到它那一下会顿，图也是一截一截出来的。
      const decoder = new Image();
      decoder.src = objectUrl;
      await decoder.decode().catch(() => undefined);
      if (!cancelled) setUrl(objectUrl);
    };

    if (!("IntersectionObserver" in window)) {
      void load();
      return () => {
        cancelled = true;
      };
    }
    // 分页模式的下一页在右边，所以四个方向都留余量。
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void load();
      },
      { rootMargin: IMAGE_PRELOAD_MARGIN }
    );
    observer.observe(figure);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [imageId, url, revision]);

  // 宽高提前写在 img 上，浏览器就按这个比例先把版面占住，
  // 图到了只是填进已经量好的位置，下方正文一个像素都不动。
  // alt 要等图片到位再给，否则空 img 会把 alt 文案当占位内容画出来。
  return (
    <figure ref={figureRef} className="reader-block is-image">
      {/* IndexedDB 返回的是 blob URL，不能交给 next/image 的远程优化器。 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url || undefined}
        alt={url ? alt : ""}
        width={width}
        height={height}
        decoding="async"
      />
    </figure>
  );
});

/** 划词问 AI 的批注卡：只交给锚点句所在的那一章，其余章拿到 null，不跟着对话流式重渲染。 */
interface InlineAskProps {
  ask: { text: string; sentenceIds: string[]; anchorId: string };
  book: Book;
  settings: ReaderSettings;
  turns: AiChatTurn[];
  onTurnsChange: (turns: AiChatTurn[]) => void;
  onExpand: () => void;
  onClose: () => void;
}

const NO_IDS: ReadonlySet<string> = new Set();

interface ChapterSectionProps {
  item: Chapter;
  index: number;
  indexById: Map<string, number> | undefined;
  marksBySentence: Map<string, BookNote[]>;
  /** 只有朗读句在这一章时才有值，别的章不跟着每一句重渲染。 */
  speakingId: string;
  askingIds: ReadonlySet<string>;
  inline: InlineAskProps | null;
}

/**
 * 一章正文。按章 memo：朗读换句、划线、批注对话流式输出、跨章时 chapterIndex 变化，
 * 都只重渲染相关的那一章，而不是把窗口里几章、上千个句子 span 全部重建一遍——
 * 那一下在手机上就是滑动中的小卡顿。
 */
const ChapterSection = memo(function ChapterSection({
  item,
  index,
  indexById,
  marksBySentence,
  speakingId,
  askingIds,
  inline,
}: ChapterSectionProps) {
  return (
    // data-primed 由 primeChunk() 直接写在 DOM 上，React 不管它：排版进度不走 state，
    // 排一段就不必重渲染一章。
    <section className="reader-chapter" data-chapter-section={index}>
      {/* 没名字的章是上一章的续页（章名页和正文拆成了两个文件），接着排，不另起章首。 */}
      {isPlaceholderTitle(item.title) ? null : (
        <div className="reader-title">
          <h1>{item.title}</h1>
          <span className="reader-title__ornament" aria-hidden />
        </div>
      )}

      {item.paragraphs.map((paragraph) => {
        if (paragraph.kind === "image") {
          return (
            <ReaderImage
              key={paragraph.id}
              imageId={paragraph.imageId ?? ""}
              alt={paragraph.alt ?? ""}
              width={paragraph.imageWidth}
              height={paragraph.imageHeight}
            />
          );
        }

        // 还没整章排版时，段落在视口外只按估算高度占位（content-visibility），
        // 估算用字数算，撑开时差得越少越好。
        const blockStyle = {
          "--chars": paragraph.sentences.reduce(
            (sum, sentence) => sum + sentence.text.length,
            0
          ),
        } as CSSProperties;

        const sentenceSpans = paragraph.sentences.map((sentence) => (
          <span
            key={sentence.id}
            data-sentence-id={sentence.id}
            data-sentence-index={indexById?.get(sentence.id)}
            data-chapter-index={index}
            className={[
              sentence.id === speakingId ? "is-speaking" : "",
              askingIds.has(sentence.id) ? "is-asking" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {renderSentence(sentence.text, marksBySentence.get(sentence.id) ?? [])}
          </span>
        ));

        // 批注挂在选区最后一句所在的段落后面：往下长不会推动正在读的这段。
        const inlineCard =
          inline &&
          paragraph.sentences.some((s) => s.id === inline.ask.anchorId) ? (
            <AiInlineAsk
              text={inline.ask.text}
              book={inline.book}
              chapter={item}
              settings={inline.settings}
              turns={inline.turns}
              onTurnsChange={inline.onTurnsChange}
              onExpand={inline.onExpand}
              onClose={inline.onClose}
            />
          ) : null;

        const withCard = (block: ReactNode) =>
          inlineCard ? (
            <Fragment key={paragraph.id}>
              {block}
              {inlineCard}
            </Fragment>
          ) : (
            block
          );

        if (paragraph.kind === "heading") {
          // 章节名已经占了 h1，章内小标题从 h2 起排。
          const Heading = HEADING_TAGS[(paragraph.level ?? 3) - 1] ?? "h3";
          return withCard(
            <Heading
              key={paragraph.id}
              className="reader-block is-heading"
              style={blockStyle}
            >
              {sentenceSpans}
            </Heading>
          );
        }
        if (paragraph.kind === "quote") {
          return withCard(
            <blockquote
              key={paragraph.id}
              className="reader-block is-quote"
              style={blockStyle}
            >
              {sentenceSpans}
            </blockquote>
          );
        }
        return withCard(
          <p
            key={paragraph.id}
            className={`reader-block ${paragraph.kind === "list" ? "is-list" : ""}`}
            style={blockStyle}
          >
            {sentenceSpans}
          </p>
        );
      })}
    </section>
  );
});

interface ArticleBodyProps {
  paged: boolean;
  book: Book;
  settings: ReaderSettings;
  visibleChapters: { chapter: Chapter; index: number }[];
  sentenceIndexByChapter: Map<number, Map<string, number>>;
  marksBySentence: Map<string, BookNote[]>;
  currentSentenceId: string;
  speakingChapterIndex: number;
  askingIds: Set<string>;
  inlineAsk: { text: string; sentenceIds: string[]; anchorId: string } | null;
  chatTurns: AiChatTurn[];
  onChatChange: (turns: AiChatTurn[]) => void;
  onInlineExpand: () => void;
  onInlineClose: () => void;
  showEnd: boolean;
  startSentinelRef: RefObject<HTMLDivElement | null>;
  endSentinelRef: RefObject<HTMLDivElement | null>;
}

/**
 * 正文主体。单独抽出来 memo 是这次划线顺滑的关键。
 *
 * 选区状态（selection/geometry）挂在 ReaderScreen 上，拖手柄时每个 pointermove 都会
 * setState；若正文还内联在 ReaderScreen 里，就会跟着每帧重建上千个句子 span +
 * renderSentence，iPhone 上直接掉帧。正文只依赖下面这批数据 props，选区怎么变都不重渲染。
 */
const ArticleBody = memo(function ArticleBody({
  paged,
  book,
  settings,
  visibleChapters,
  sentenceIndexByChapter,
  marksBySentence,
  currentSentenceId,
  speakingChapterIndex,
  askingIds,
  inlineAsk,
  chatTurns,
  onChatChange,
  onInlineExpand,
  onInlineClose,
  showEnd,
  startSentinelRef,
  endSentinelRef,
}: ArticleBodyProps) {
  // 渲染探针：memo 命中（只有选区在变）时 ArticleBody 不会 commit，这个 effect 不跑，
  // 计数不增；正文真的重渲染才 +1 并写到哨兵上。浏览器回归测试读它，
  // 用来确认拖手柄期间正文子树没被反复重建。
  const bodyRenders = useRef(0);
  useEffect(() => {
    bodyRenders.current += 1;
    if (startSentinelRef.current) {
      startSentinelRef.current.dataset.bodyRenders = String(bodyRenders.current);
    }
  });

  const hasAsking = askingIds.size > 0;

  return (
    <>
      {paged ? null : (
        <div ref={startSentinelRef} className="reader-sentinel" aria-hidden />
      )}

      {visibleChapters.map(({ chapter: item, index }) => {
        const indexById = sentenceIndexByChapter.get(index);
        const holdsAnchor =
          inlineAsk !== null && indexById?.has(inlineAsk.anchorId) === true;
        return (
          <ChapterSection
            key={item.id}
            item={item}
            index={index}
            indexById={indexById}
            marksBySentence={marksBySentence}
            speakingId={index === speakingChapterIndex ? currentSentenceId : ""}
            askingIds={hasAsking ? askingIds : NO_IDS}
            inline={
              holdsAnchor && inlineAsk
                ? {
                    ask: inlineAsk,
                    book,
                    settings,
                    turns: chatTurns,
                    onTurnsChange: onChatChange,
                    onExpand: onInlineExpand,
                    onClose: onInlineClose,
                  }
                : null
            }
          />
        );
      })}

      {showEnd ? (
        <div className="reader-end">
          <span>全书完</span>
          <p>{displayTitle(book.title)}</p>
        </div>
      ) : null}

      {paged ? null : (
        <div ref={endSentinelRef} className="reader-sentinel" aria-hidden />
      )}
    </>
  );
});

type ReaderPopupState =
  | {
      kind: "selection";
      anchor: Rect;
      /** 选区逐行的矩形。菜单要靠它决定摆在选区上端还是下端，不然会压住正文。 */
      rects: Rect[];
      parts: HighlightPart[];
      text: string;
    }
  | { kind: "mark"; anchor: Rect; note: BookNote };

/**
 * 划词后浮在选区上的操作条。
 *
 * 定位必须拿量出来的真实尺寸算，不能按估计的半宽夹——这条菜单在 390px 的屏上
 * 曾经宽到接近 400px，靠边的选区会把它整个挤出屏幕，最边上那一项根本点不到。
 * 所以先渲染、量、再摆，第一帧用 visibility 藏住，避免闪一下。
 *
 * 内容也跟着收敛：第一层只留划线、想法、复制，其余进「更多」，
 * 这样常规宽度就压在 300px 上下，靠边时也还有夹取余量。
 */
function ReaderPopover({
  popup,
  insets,
  defaultColor,
  defaultStyle,
  onHighlight,
  onCopy,
  onThought,
  onListen,
  onDelete,
  onAskAi,
}: {
  popup: ReaderPopupState;
  insets: SafeInsets;
  defaultColor: HighlightColor;
  defaultStyle: HighlightStyle;
  onHighlight: (color: HighlightColor, style?: HighlightStyle) => void;
  onCopy: () => void;
  onThought: () => void;
  onListen: () => void;
  onDelete: () => void;
  onAskAi: () => void;
}) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  /**
   * 最近一次按在浮条上的时刻。长按选字抬手时，浏览器会在手指的位置补发一个 click，
   * 而浮条正是这一刻弹出来的：要是正好弹在手指底下（比如最后一行字），这一下就会
   * 点中浮条上的按钮，凭空多出一条划线。所以只认「按下也落在浮条上」的点击。
   */
  const pressedAtRef = useRef(-Infinity);

  const { top, bottom, left, right } = popup.anchor;
  // 已有划线只有一块锚点矩形，选区则是逐行的一串。
  // 走 useMemo 是为了给下面的量位 effect 一个稳定依赖，否则每渲染一次都要重量。
  const rects = useMemo(
    () => (popup.kind === "selection" ? popup.rects : [popup.anchor]),
    [popup]
  );

  // 换了一处选区就回到第一层，否则上次翻开的「更多」会粘在下一次。
  // 这里按「选中的是哪几个字」比，不按像素位置——滚动时菜单会重新量位置，
  // 拿坐标当身份会让用户正看着的那一层被重置掉。
  const identity =
    popup.kind === "mark"
      ? popup.note.id
      : popup.parts
          .map((part) => `${part.sentenceId}:${part.start}-${part.end}`)
          .join("|");
  const [lastIdentity, setLastIdentity] = useState(identity);
  if (identity !== lastIdentity) {
    setLastIdentity(identity);
    setMore(false);
  }

  // 翻到「更多」会换一批按钮、宽度跟着变，所以 more 也得进依赖重新量。
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const update = () => {
      node.style.maxWidth = `${Math.max(1, window.innerWidth - insets.left - insets.right - 24)}px`;
      node.style.maxHeight = `${Math.max(1, window.innerHeight - insets.top - insets.bottom - 24)}px`;
      const box = node.getBoundingClientRect();
      const next = placeForSelection({
        rects,
        union: { top, bottom, left, right },
        menu: { width: box.width, height: box.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        insets,
      });
      setPlacement((current) => current && current.left === next.left && current.top === next.top && current.side === next.side && current.arrowLeft === next.arrowLeft ? current : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [top, bottom, left, right, rects, insets, more, popup.kind]);

  const style: CSSProperties = placement
    ? {
        left: `${placement.left}px`,
        top: `${placement.top}px`,
        ["--arrow-left" as string]: `${placement.arrowLeft}px`,
      }
    : { left: "0px", top: "0px", visibility: "hidden" };

  return (
    <div
      ref={nodeRef}
      className={`reader-popover ${placement?.side === "below" ? "is-below" : ""}`}
      style={style}
      role="dialog"
      aria-label="划线操作"
      onPointerDownCapture={() => {
        pressedAtRef.current = performance.now();
      }}
      onPointerDown={(event) => {
        // 桌面按按钮时保留原生选区，避免 selectionchange 把菜单先卸载。
        if (event.pointerType === "mouse") event.preventDefault();
      }}
      onClickCapture={(event) => {
        // 键盘触发的 click（detail 为 0）没有按下这一步，照常放行。
        const pressedHere = performance.now() - pressedAtRef.current < 1500;
        pressedAtRef.current = -Infinity;
        if (pressedHere || event.detail === 0) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {popup.kind === "mark" ? (
        <div className="reader-popover__appearance">
          <div className="reader-popover__styles" aria-label="划线样式">
            <button
              type="button"
              className={(popup.note.highlightStyle ?? "underline") === "underline" ? "is-active" : ""}
              aria-pressed={(popup.note.highlightStyle ?? "underline") === "underline"}
              onClick={() => onHighlight(popup.note.color ?? "yellow", "underline")}
            >
              下划线
            </button>
            <button
              type="button"
              className={popup.note.highlightStyle === "marker" ? "is-active" : ""}
              aria-pressed={popup.note.highlightStyle === "marker"}
              onClick={() => onHighlight(popup.note.color ?? "yellow", "marker")}
            >
              马克笔
            </button>
          </div>
          <div className="reader-popover__colors">
            {HIGHLIGHT_COLORS.map((color) => (
              <button
                type="button"
                key={color.id}
                className={`swatch swatch--${color.id} ${
                  (popup.note.color ?? "yellow") === color.id ? "is-active" : ""
                }`}
                aria-label={color.label}
                onClick={() => onHighlight(color.id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="reader-popover__actions">
        {popup.kind === "mark" ? (
          <>
            <button type="button" onClick={onThought}>
              <PencilLine size={16} />
              {popup.note.thought ? "改想法" : "想法"}
            </button>
            <button type="button" onClick={onCopy}>
              <Copy size={16} />
              复制
            </button>
            <button type="button" onClick={onDelete}>
              <Trash2 size={16} />
              删除
            </button>
          </>
        ) : more ? (
          <>
            <button
              type="button"
              className="reader-popover__back"
              aria-label="返回上一层"
              onClick={() => setMore(false)}
            >
              <ChevronLeft size={16} />
            </button>
            <button type="button" onClick={onListen}>
              <Headphones size={16} />
              从这里听
            </button>
            <button type="button" onClick={onAskAi}>
              <Sparkles size={16} />
              问 AI
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onHighlight(defaultColor, defaultStyle)}
            >
              <Highlighter size={16} />
              划线
            </button>
            <button type="button" onClick={onThought}>
              <PencilLine size={16} />
              想法
            </button>
            <button type="button" onClick={onCopy}>
              <Copy size={16} />
              复制
            </button>
            <button type="button" onClick={() => setMore(true)}>
              <MoreHorizontal size={16} />
              更多
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** 章节全文太长会把请求撑爆、也烧钱，只带前面这么多字，够回答「这章讲了什么」就行。 */
const AI_CHAPTER_TEXT_LIMIT = 6000;
/** 目录也有上限：几百章的网文目录能有上万字，连同章节正文会顶破单条消息的上限（整个请求被拒）。 */
const AI_TOC_LIMIT = 6000;

/** 刚发出的问题滚到顶栏下面时离顶栏的距离。改它要同步 CSS 里 .ai-chat__latest 的最小高度。 */
const LATEST_GAP = 16;

/** 起手提问：拿真实的书名和章节标题拼，只是把常问的几件事摆出来，不编造内容。 */
function starterPrompts(
  book: BookMeta,
  chapter: Chapter | undefined,
  hasQuote: boolean
) {
  if (hasQuote) return ["这段在说什么", "举个例子", "和前后文什么关系"];
  const list = ["这本书主要在讲什么"];
  if (chapter) list.push(`讲讲《${chapterLabelFor(book.chapterOutline, chapter.id)}》这一章`);
  list.push(`列一份《${book.title}》的阅读要点`);
  return list;
}

/**
 * 组装书籍上下文并发一次请求。内联批注和全屏对话共用这一套 prompt，
 * 两处各写一遍迟早会漂移成两种回答风格。
 */
async function askAi({
  book,
  chapter,
  settings,
  history,
  signal,
  brief = false,
  onDelta,
  onModel,
}: {
  book: BookMeta;
  chapter: Chapter | undefined;
  settings: ReaderSettings;
  history: AiChatTurn[];
  signal: AbortSignal;
  /** 正文批注只是页边的一小块，长篇大论会把正文淹掉，所以额外要一句简短。 */
  brief?: boolean;
  onDelta: (delta: { content?: string; reasoning?: string }) => void;
  onModel?: (model: string) => void;
}) {
  const fullToc = tocIndexes(book.chapterOutline)
    .map((index, number) => `${number + 1}. ${chapterLabel(book.chapterOutline, index)}`)
    .join("\n");
  const toc =
    fullToc.length > AI_TOC_LIMIT
      ? `${fullToc.slice(0, AI_TOC_LIMIT)}\n……（目录太长，后面的省略了）`
      : fullToc;
  const chapterTitle = chapter ? chapterLabelFor(book.chapterOutline, chapter.id) : "正文";
  const chapterText = chapter
    ? flattenChapter(chapter)
        .map((sentence) => sentence.text)
        .join("")
        .slice(0, AI_CHAPTER_TEXT_LIMIT)
    : "";
  const chapterContext = chapter
    ? `\n\n当前章节《${chapterTitle}》正文${chapterText.length >= AI_CHAPTER_TEXT_LIMIT ? "（篇幅较长，只截取了前面一部分）" : ""}：\n${chapterText}`
    : "";
  await streamAiChat(
    {
      baseUrl: settings.aiBaseUrl,
      apiKey: settings.aiApiKey,
      model: settings.aiModel,
      fallbackModel: settings.aiFallbackModel,
      deepThinking: settings.aiDeepThinking,
      signal,
      onModel,
      messages: [
        {
          role: "system",
          content: `你是《${book.title}》的阅读助手。\n全书目录：\n${toc}${chapterContext}\n\n请结合以上内容和对话上下文简洁作答，除非用户要求，不必逐句复述原文。\n如有需要可使用 Markdown 格式（标题、加粗、列表、代码块等）让回答更清晰，但不必为简短回答刻意加格式。${brief ? "\n这次回答显示在正文旁边的批注里，控制在 200 字以内，直接说结论，不要用标题。" : ""}`,
        },
        ...modelHistory(history),
      ],
    },
    onDelta
  );
}

/** 对话记录只留答上来的回答（出错、被打断、模型什么都没给的空回答不留），提问都留。 */
function isAnsweredTurn(turn: AiChatTurn): boolean {
  return turn.role === "user" || turn.content.trim().length > 0;
}

/** 这条是备用模型答的就记下模型名，界面上标出来；主模型答的不记，免得每条都挂一行字。 */
function fallbackMark(answeredBy: string, settings: ReaderSettings): Pick<AiChatTurn, "model"> {
  return answeredBy && answeredBy !== settings.aiModel ? { model: answeredBy } : {};
}

/** 划词后「问 AI」，多轮聊天面板；模型设置默认收起，把注意力留给原文和对话。 */
function AiAskPanel({
  text,
  initialTurns,
  onTurnsChange,
  book,
  chapter,
  settings,
  onClose,
}: {
  text: string;
  initialTurns: AiChatTurn[];
  onTurnsChange: (turns: AiChatTurn[]) => void;
  book: BookMeta;
  chapter: Chapter | undefined;
  settings: ReaderSettings;
  onClose: () => void;
}) {
  const configured = Boolean(settings.aiBaseUrl && settings.aiModel);
  const [localTurns, setTurns] = useState<AiChatTurn[]>(initialTurns);
  const turns = useMemo(
    () => mergeChatTurns(localTurns, initialTurns),
    [localTurns, initialTurns]
  );
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 思考过程每轮各自展开，默认收起：展开的长思考会把下面的回答整段推走。
  const [openReasoning, setOpenReasoning] = useState<ReadonlySet<number>>(() => new Set());
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  // 这次打开后发出的最新一问（turns 下标）。它连同回答至少占一屏，问题才能停在顶栏下面。
  const [pinned, setPinned] = useState<number | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const latestRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const streamTextRef = useRef({ content: "", reasoning: "" });
  const streamingTurnRef = useRef<{ id: string; replyTo?: string }>({ id: "" });
  const [activeAnswerId, setActiveAnswerId] = useState("");
  const streamFrameRef = useRef<number | null>(null);

  useScrollLock();
  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (streamFrameRef.current !== null) {
        window.cancelAnimationFrame(streamFrameRef.current);
      }
    },
    []
  );

  /**
   * 回答的末尾还在屏幕下面，就亮出「回到最新」。走 DOM 属性不走 state：
   * 滚动中重渲染一整屏 Markdown 就是卡顿本身。
   */
  const syncBelow = useCallback(() => {
    const scroller = scrollRef.current;
    const end = endRef.current;
    if (!scroller || !end) return;
    const below = end.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom > 8;
    chatRef.current?.toggleAttribute("data-below", below);
  }, []);

  // 打开时停在对话末尾。赶在第一帧之前滚好，不先闪一下开头。
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, []);

  // 消息区变矮（键盘弹起、输入框长高）时，原来停在底部的继续停在底部。
  // 内容长高则不跟着滚：回答在问题下面往下长，读到哪由人自己决定。
  useEffect(() => {
    const scroller = scrollRef.current;
    const thread = threadRef.current;
    if (!scroller || !thread) return;
    let height = scroller.clientHeight;
    const observer = new ResizeObserver(() => {
      scroller.style.setProperty("--chat-viewport", `${scroller.clientHeight}px`);
      if (scroller.clientHeight !== height) {
        height = scroller.clientHeight;
        if (atBottomRef.current) scroller.scrollTop = scroller.scrollHeight;
      }
      syncBelow();
    });
    observer.observe(scroller);
    observer.observe(thread);
    return () => observer.disconnect();
  }, [syncBelow]);

  // 刚发出的问题滚到顶栏下面，回答从它下面长出来（Claude、ChatGPT 的做法）。
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const latest = latestRef.current;
    if (pinned === null || !scroller || !latest) return;
    const top =
      latest.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      parseFloat(getComputedStyle(scroller).paddingTop) -
      LATEST_GAP;
    scroller.scrollTo({ top, behavior: "smooth" });
  }, [pinned]);

  const jumpToEnd = () => {
    const scroller = scrollRef.current;
    const end = endRef.current;
    if (!scroller || !end) return;
    const endTop =
      end.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, endTop - scroller.clientHeight + 24), behavior: "smooth" });
  };

  const copyAnswer = async (index: number, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedIndex(null), 1600);
    } catch {
      setError("复制失败，请手动选择文字");
    }
  };

  const toggleReasoning = (index: number) =>
    setOpenReasoning((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  const scheduleStreamRender = useCallback(() => {
    if (streamFrameRef.current !== null) return;
    streamFrameRef.current = window.requestAnimationFrame(() => {
      streamFrameRef.current = null;
      const { content, reasoning } = streamTextRef.current;
      const { id, replyTo } = streamingTurnRef.current;
      setTurns((prev) => {
        if (!prev.length) return prev;
        const next = [...prev];
        next[next.length - 1] = { id, replyTo, role: "assistant", content, reasoning };
        return next;
      });
    });
  }, []);

  // 找最近一次「带了新片段」的用户提问，用来判断眼下这段是不是已经问过。
  // text === "" 是从历史入口直接打开、没有选中文字的情况，不算新片段。
  const lastQuote = [...turns].reverse().find((t) => t.role === "user" && t.quote)?.quote;
  const isFreshQuote = text !== "" && lastQuote !== text;
  const canSend = configured && !busy && (question.trim().length > 0 || isFreshQuote);

  /** preset 是点起手提问进来的，不走输入框，所以不能拿 canSend 拦。 */
  const ask = (preset?: string) => {
    if (busy || !configured) return;
    const userText =
      (preset ?? question).trim() || (isFreshQuote ? "帮我讲讲这段话" : "");
    if (!userText) return;
    const userTurn: AiChatTurn = {
      id: makeId("turn"),
      role: "user",
      content: userText,
      ...(isFreshQuote ? { quote: text } : {}),
    };
    // 之前没答上来的空回答不留：界面上本来就不显示，发给模型的历史里也不该有。
    const history: AiChatTurn[] = [...turns.filter(isAnsweredTurn), userTurn];
    setPinned(history.length - 1);
    setQuestion("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    void run(history);
  };

  /** 上一问没答上来：拿同一段历史再问一次，问题留在原处。 */
  const retry = () => {
    if (busy) return;
    void run(turns.slice(0, -1));
  };

  const run = async (history: AiChatTurn[]) => {
    const assistantId = makeId("turn");
    const replyTo = history.at(-1)?.id;
    streamingTurnRef.current = { id: assistantId, replyTo };
    setActiveAnswerId(assistantId);
    setTurns([...history, { id: assistantId, replyTo, role: "assistant", content: "", reasoning: "" }]);
    setBusy(true);
    setError("");
    const controller = new AbortController();
    controllerRef.current = controller;
    let content = "";
    let reasoning = "";
    let answeredBy = "";
    streamTextRef.current = { content: "", reasoning: "" };
    try {
      await askAi({
        book,
        chapter,
        settings,
        history,
        signal: controller.signal,
        onDelta: (delta) => {
          if (delta.content) content += delta.content;
          if (delta.reasoning) reasoning += delta.reasoning;
          streamTextRef.current = { content, reasoning };
          scheduleStreamRender();
        },
        onModel: (model) => {
          answeredBy = model;
        },
      });
    } catch (err) {
      if (err instanceof AiRequestError) setError(err.message);
      else if ((err as Error)?.name !== "AbortError") setError("请求失败，稍后再试");
    } finally {
      if (streamFrameRef.current !== null) {
        window.cancelAnimationFrame(streamFrameRef.current);
        streamFrameRef.current = null;
      }
      streamTextRef.current = { content, reasoning };
      const next: AiChatTurn[] = [
        ...history,
        { id: assistantId, replyTo, role: "assistant", content, reasoning, ...fallbackMark(answeredBy, settings) },
      ];
      setTurns(next);
      setBusy(false);
      // 没答上来的这一轮只留在眼前（带着「重试」），不写进这本书的对话记录。
      onTurnsChange(next.filter(isAnsweredTurn));
    }
  };

  const renderTurn = (turn: AiChatTurn, index: number) => {
    if (turn.role === "user") {
      return (
        <div className="ai-ask__turn-user" key={turn.id ?? index}>
          <div className="ai-ask__bubble">
            {turn.quote ? <blockquote className="ai-ask__quote-sent">{turn.quote}</blockquote> : null}
            <p className="ai-ask__question">{turn.content}</p>
          </div>
        </div>
      );
    }
    const streaming = busy && turn.id === activeAnswerId;
    const reasoningOpen = openReasoning.has(index);
    return (
      <div className="ai-ask__turn-assistant" key={turn.id ?? index}>
        {turn.reasoning ? (
          <div className={`ai-ask__reasoning${reasoningOpen ? " is-open" : ""}`}>
            <button
              type="button"
              className="ai-ask__reasoning-toggle"
              aria-expanded={reasoningOpen}
              onClick={() => toggleReasoning(index)}
            >
              {streaming && !turn.content ? "正在思考…" : "思考过程"}
              <ChevronDown size={14} />
            </button>
            {reasoningOpen ? <p className="ai-ask__reasoning-text">{turn.reasoning}</p> : null}
          </div>
        ) : null}
        {turn.content ? (
          <div className="ai-ask__answer">
            <AiMarkdown content={turn.content} streaming={streaming} />
          </div>
        ) : streaming && !turn.reasoning ? (
          <div className="ai-ask__answer">
            <span className="ai-chat__thinking" aria-label="正在思考">
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : null}
        {/* 操作行在出字时就占好位置、只是先不显示，答完亮出来时下面的东西不会被推一下。 */}
        {turn.content ? (
          <div className="ai-ask__actions" data-hidden={streaming || undefined}>
            <button
              type="button"
              className="ai-ask__copy"
              onClick={() => void copyAnswer(index, turn.content)}
              aria-label={copiedIndex === index ? "已复制" : "复制回答"}
            >
              {copiedIndex === index ? <Check size={14} /> : <Copy size={14} />}
              {copiedIndex === index ? "已复制" : "复制"}
            </button>
            {turn.model ? <span className="ai-ask__via">主模型太忙，由备用模型 {turn.model} 回答</span> : null}
          </div>
        ) : null}
        {turn.id === activeAnswerId && error && !busy ? (
          <div className="ai-ask__failed">
            <p className="ai-ask__error">{error}</p>
            {turn.content ? null : (
              <button type="button" className="ai-ask__retry" onClick={retry}>
                <RefreshCw size={14} />
                重试
              </button>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className="ai-chat"
      ref={chatRef}
      role="dialog"
      aria-modal="true"
      aria-label="问 AI"
    >
      {/* 顶栏只留返回和书名，聊天时把空间交给正文。 */}
      <header className="ai-chat__bar">
        <button
          type="button"
          className="ai-chat__close"
          aria-label="关闭"
          onClick={onClose}
        >
          <ChevronDown size={23} />
        </button>
        <span className="ai-chat__title">{displayTitle(book.title)}</span>
      </header>

      <div
        className="ai-chat__scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const scroller = event.currentTarget;
          atBottomRef.current =
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
          syncBelow();
        }}
      >
        <div className="ai-chat__thread" ref={threadRef}>
          {!turns.length ? (
            <div className="ai-chat__intro">
              <BearMark className="ai-chat__mark" />
              <strong>{isFreshQuote ? "这段话，想聊些什么？" : "你好，想聊聊这本书吗？"}</strong>
              {!configured ? (
                <p className="ai-chat__unset">
                  <Layers size={15} />
                  还没配模型。去主页右上角的设置里，「AI 助手」那一栏填一次就好。
                </p>
              ) : null}
            </div>
          ) : null}

          {turns.slice(0, pinned ?? turns.length).map(renderTurn)}
          {pinned !== null ? (
            <div className="ai-chat__latest" ref={latestRef}>
              {turns.slice(pinned).map((turn, offset) => renderTurn(turn, pinned + offset))}
              <div ref={endRef} />
            </div>
          ) : (
            <div ref={endRef} />
          )}
        </div>
      </div>

      <div className="ai-chat__composer">
        <button
          type="button"
          className="ai-chat__jump"
          aria-label="回到最新"
          onClick={jumpToEnd}
        >
          <ArrowDown size={18} />
        </button>
        <div className={`ai-chat__input${turns.length ? " has-history" : ""}`}>
          {/* 从正文划词带进来的原文挂在输入框里，发出去之前一直看得见。 */}
          {isFreshQuote ? <p className="ai-chat__quote">{text}</p> : null}
          <textarea
            ref={inputRef}
            rows={1}
            placeholder={isFreshQuote ? "留空就是让 AI 讲讲这段话" : "发消息…"}
            value={question}
            onChange={(event) => {
              setQuestion(event.target.value);
              event.currentTarget.style.height = "auto";
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask();
              }
            }}
          />
          <div className="ai-chat__row">
            {configured && !turns.length ? (
              <div className="ai-chat__starters" aria-label="建议提问">
                {starterPrompts(book, chapter, isFreshQuote).map((preset) => (
                  <button
                    type="button"
                    key={preset}
                    className="ai-chat__starter"
                    onClick={() => void ask(preset)}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            ) : null}
            {/* 发送键常驻，没东西可发时置灰：时有时无的话输入框宽度跟着变，字会重新折行。 */}
            <button
              type="button"
              className="ai-chat__send"
              disabled={!busy && !canSend}
              onClick={() => {
                if (busy) controllerRef.current?.abort();
                else void ask();
              }}
              aria-label={busy ? "停止回答" : "发送"}
            >
              {busy ? <Square size={14} fill="currentColor" /> : <ArrowUp size={20} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 划词问 AI 的轻量形态：回答直接落在原文段落下面，像页边批注，不离开正文。
 * 只做一问一答——想继续追问就把这一轮带进全屏对话，别在正文里长出一条聊天流。
 */
function AiInlineAsk({
  text,
  book,
  chapter,
  settings,
  turns,
  onTurnsChange,
  onExpand,
  onClose,
}: {
  text: string;
  book: BookMeta;
  chapter: Chapter | undefined;
  settings: ReaderSettings;
  turns: AiChatTurn[];
  onTurnsChange: (turns: AiChatTurn[]) => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const configured = Boolean(settings.aiBaseUrl && settings.aiModel);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [via, setVia] = useState<string | undefined>();
  const controllerRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    []
  );

  const run = async (preset?: string) => {
    if (busy || !configured) return;
    const userText = (preset ?? question).trim() || "帮我讲讲这段话";
    const history: AiChatTurn[] = [
      ...turns,
      { id: makeId("turn"), role: "user", content: userText, quote: text },
    ];
    setAsked(userText);
    setQuestion("");
    setAnswer("");
    setBusy(true);
    setError("");
    const controller = new AbortController();
    controllerRef.current = controller;
    let content = "";
    let reasoning = "";
    let answeredBy = "";
    const assistantId = makeId("turn");
    const replyTo = history.at(-1)?.id;
    setVia(undefined);
    try {
      await askAi({
        book,
        chapter,
        settings,
        history,
        signal: controller.signal,
        brief: true,
        onDelta: (delta) => {
          if (delta.content) content += delta.content;
          if (delta.reasoning) reasoning += delta.reasoning;
          setAnswer(content);
        },
        onModel: (model) => {
          answeredBy = model;
          setVia(fallbackMark(model, settings).model);
        },
      });
    } catch (err) {
      if (err instanceof AiRequestError) setError(err.message);
      else if ((err as Error)?.name !== "AbortError") setError("请求失败，稍后再试");
    } finally {
      setBusy(false);
      // 这一轮照样进这本书的常驻对话，正文里的批注只是它的即时视图。没答上来的空回答不留。
      onTurnsChange(
        [
          ...history,
          { id: assistantId, replyTo, role: "assistant" as const, content, reasoning, ...fallbackMark(answeredBy, settings) },
        ].filter(isAnsweredTurn)
      );
    }
  };

  const copy = async () => {
    if (!answer) return;
    try {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("复制失败，请手动选择文字");
    }
  };

  return (
    <aside className="ai-inline" aria-label="AI 批注">
      <header className="ai-inline__head">
        <Sparkles size={13} />
        <span>{asked || "问 AI"}</span>
        <button
          type="button"
          className="ai-inline__close"
          aria-label="收起批注"
          onClick={() => {
            controllerRef.current?.abort();
            onClose();
          }}
        >
          <X size={15} />
        </button>
      </header>

      {answer === null ? (
        !configured ? (
          <p className="ai-inline__hint">
            还没配模型。去主页右上角的设置里，「AI 助手」那一栏填一次就好。
          </p>
        ) : (
          <>
            <div className="ai-inline__compose">
              <input
                type="text"
                autoFocus
                value={question}
                placeholder="留空就是让 AI 讲讲这段"
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void run();
                  }
                }}
              />
              <button
                type="button"
                className="ai-inline__send"
                aria-label="发送"
                onClick={() => void run()}
              >
                <ArrowUp size={17} />
              </button>
            </div>
            <div className="ai-inline__starters">
              {starterPrompts(book, chapter, true).map((preset) => (
                <button
                  type="button"
                  key={preset}
                  className="ai-inline__starter"
                  onClick={() => void run(preset)}
                >
                  {preset}
                </button>
              ))}
            </div>
          </>
        )
      ) : (
        <div className="ai-inline__answer">
          {answer ? <AiMarkdown content={answer} streaming={busy} /> : null}
          {busy && !answer ? (
            <span className="ai-chat__thinking" aria-label="正在思考">
              <i />
              <i />
              <i />
            </span>
          ) : null}
        </div>
      )}

      {error ? <p className="ai-inline__error">{error}</p> : null}

      {answer !== null && !busy ? (
        <div className="ai-inline__actions">
          <button type="button" onClick={() => void copy()}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "已复制" : "复制"}
          </button>
          <button type="button" onClick={onExpand}>
            <Sparkles size={13} />
            继续聊
          </button>
          {via && answer ? <span className="ai-ask__via">由备用模型 {via} 回答</span> : null}
        </div>
      ) : null}
    </aside>
  );
}

function readPageViewport() {
  if (typeof window === "undefined") return { width: 390, height: 844 };
  const width = window.innerWidth;
  // 手机上按物理屏算：Safari 的地址栏、工具栏随滑动伸缩，打开目录时又会展开，
  // innerHeight 一直在变。拿它估页码，同一本书一会儿 645 页、一会儿 703 页。
  if (window.matchMedia?.("(pointer: coarse)").matches && window.screen) {
    const long = Math.max(window.screen.width, window.screen.height);
    const short = Math.min(window.screen.width, window.screen.height);
    return { width, height: width > window.innerHeight ? short : long };
  }
  return { width, height: window.innerHeight };
}

/**
 * 估页码用的视口尺寸。只在宽度变了（转屏、分屏、拖窗口）时才换，
 * 高度的伸缩不算——那只是工具栏收起展开，排版并没有变。
 */
function usePageViewport() {
  const [viewport, setViewport] = useState(readPageViewport);
  useEffect(() => {
    const onResize = () =>
      setViewport((current) => {
        const next = readPageViewport();
        return Math.abs(next.width - current.width) > 1 ? next : current;
      });
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  return viewport;
}

/** 跳转落地后最多盯这么久。 */
const HOLD_MS = 1500;
/** 连续这么久没再被推动，就算落稳了，提前收手。 */
const HOLD_QUIET_MS = 300;

/**
 * 跳转（目录跳章、回到朗读处）落地后，把目标按在刚落下的高度，直到版面稳下来。
 *
 * 目标上方的段落大多还是 content-visibility 的估算占位，滚过去之后才按真实高度排版。
 * Chrome 有 scroll anchoring，自己会把位移补回来；iOS Safari 没有，占位一撑开，
 * 目标就被整个往下推——实测关掉 anchoring 跳章偏 900～1900px，
 * 「回到朗读处」要连点几下才对得准，也是这个原因。
 *
 * ResizeObserver 在排版之后、绘制之前回调，这时补回去用户看不到那一下跳；
 * rAF 兜住没有改变正文尺寸的位移（比如上方图片换了高度又被抵消）。
 * 手一碰屏幕就松手，不跟用户抢滚动。
 */
function holdInPlace(element: HTMLElement, container: HTMLElement): () => void {
  const targetTop = element.getBoundingClientRect().top;
  const deadline = performance.now() + HOLD_MS;
  let quietSince = performance.now();
  let frame = 0;
  let stopped = false;

  const correct = () => {
    if (stopped) return;
    if (!element.isConnected) {
      stop();
      return;
    }
    const drift = element.getBoundingClientRect().top - targetTop;
    if (Math.abs(drift) > 1) {
      window.scrollBy(0, drift);
      quietSince = performance.now();
    }
  };

  const tick = () => {
    correct();
    const now = performance.now();
    if (now > deadline || now - quietSince > HOLD_QUIET_MS) {
      stop();
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  const resize = new ResizeObserver(correct);
  const inputs = ["touchstart", "wheel", "keydown", "pointerdown"] as const;

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    for (const type of inputs) window.removeEventListener(type, stop);
  }

  resize.observe(container);
  for (const type of inputs) {
    window.addEventListener(type, stop, { passive: true });
  }
  frame = requestAnimationFrame(tick);
  return stop;
}

/**
 * 阅读进度的锚点高度：距视口顶多少像素的那一句算「你正读到这里」。
 *
 * 存和取必须共用这一个数。之前存的是「距顶 150px 那句」，恢复却用
 * scrollIntoView({block:"center"}) 把它放到屏幕正中，两边差了约四分之一屏，
 * 每次重新进书都被往回推五六行，看起来就是「进度有偏移」。
 * 改这个值要同时确认它落在下面 IntersectionObserver 的 rootMargin 观察带里。
 */
const READING_ANCHOR_TOP = 150;

/** 滚动过程中最多隔这么久留一份「卸载兜底」快照。防抖落盘仍然是 400ms。 */
const SNAPSHOT_INTERVAL_MS = 250;

/**
 * 阅读位置的同步兜底。
 *
 * 正式的落盘走 IndexedDB，但那是攒 2.5 秒一批、而且是异步的：手机上把应用划掉、
 * 或者系统回收 PWA 时，pagehide 里那次补写根本来不及完成，最近几秒读的就丢了，
 * 下次进来退回更早的位置——这正是「有时候进度有偏移」。localStorage 是同步写，
 * 拿它兜住最后一下；两边谁新用谁。
 */
const POSITION_KEY = "moting:pos:";

function rememberPosition(bookId: string, position: BookPosition) {
  try {
    window.localStorage.setItem(POSITION_KEY + bookId, JSON.stringify(position));
  } catch {
    // 隐私模式下写不了，那就只剩 IndexedDB 那条路，不影响正常使用。
  }
}

/** 取 IndexedDB 和同步兜底里较新的那个位置。 */
function latestPosition(book: BookMeta): BookPosition | undefined {
  const stored = book.readingPosition;
  try {
    const raw = window.localStorage.getItem(POSITION_KEY + book.id);
    if (!raw) return stored;
    const backup = JSON.parse(raw) as BookPosition;
    if (!backup?.sentenceId) return stored;
    return !stored || backup.updatedAt > stored.updatedAt ? backup : stored;
  } catch {
    return stored;
  }
}

function ReaderScreen({
  book,
  notes,
  settings,
  currentSentenceId,
  speakingChapterIndex,
  chatTurns,
  onChatChange,
  onBack,
  onProgress,
  onStartListening,
  onHighlight,
  onUpdateNote,
  onDeleteNote,
  onSettingsChange,
  onToast,
}: {
  book: Book;
  notes: BookNote[];
  settings: ReaderSettings;
  currentSentenceId: string;
  speakingChapterIndex: number;
  chatTurns: AiChatTurn[];
  onChatChange: (turns: AiChatTurn[]) => void;
  onBack: () => void;
  onProgress: (position: BookPosition) => void;
  onStartListening: (position: BookPosition) => void;
  onHighlight: (
    parts: HighlightPart[],
    color: HighlightColor,
    style?: HighlightStyle
  ) => Promise<BookNote | null>;
  onUpdateNote: (note: BookNote) => Promise<boolean>;
  onDeleteNote: (note: BookNote) => Promise<boolean>;
  onSettingsChange: (settings: ReaderSettings) => void;
  onToast: (message: string) => void;
}) {
  const restorePosition = latestPosition(book);
  const initial = restorePosition ?? initialPosition(book);
  const [chapterIndex, setChapterIndex] = useState(initial.chapterIndex);
  const [showChapters, setShowChapters] = useState(false);
  const tocListRef = useRevealActiveChapter(showChapters);
  const [showSettings, setShowSettings] = useState(false);
  // 书内右下角那枚圆形按钮唤起的堆叠菜单（目录／主题与设置／问 AI），
  // 对齐 Apple Books 阅读页的单一入口。
  const [showReaderMenu, setShowReaderMenu] = useState(false);
  // 沉浸阅读：默认露出浮层控件，点空白处收起，只留正文。
  const [chromeVisible, setChromeVisible] = useState(true);
  // 分页模式横向翻页的跟手位移：拖拽中实时跟手指、松手后弹簧归零。
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [popup, setPopup] = useState<ReaderPopupState | null>(null);
  const [thoughtDraft, setThoughtDraft] = useState<{
    note: BookNote;
    value: string;
  } | null>(null);
  const [askAiText, setAskAiText] = useState<string | null>(null);
  // 划词问 AI 的批注就长在正文里，anchorId 是它挂在哪个段落后面。
  const [inlineAsk, setInlineAsk] = useState<{
    text: string;
    sentenceIds: string[];
    anchorId: string;
  } | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const insets = useSafeInsets();
  // iPhone 上由应用接管正文选择，桌面和拿不到 caret 定位的浏览器退回系统选择。
  const textSelection = useTextSelection(articleRef, { enabled: true });
  const clearTextSelection = textSelection.clear;
  const selectionActiveRef = useRef(false);
  useEffect(() => {
    selectionActiveRef.current = textSelection.active;
  }, [textSelection.active]);
  const customSelect = textSelection.supported;
  // 下面几个监听挂在空依赖的 effect 上，只能靠 ref 读到最新值。
  const customSelectRef = useRef(customSelect);
  const insetsRef = useRef(insets);
  useEffect(() => {
    customSelectRef.current = customSelect;
    insetsRef.current = insets;
  }, [customSelect, insets]);
  const savedSentenceRef = useRef(initial.sentenceId);
  /** 上次存下来的「锚点线落在这句第几像素」，用来判断同一段里是否已经读过了一行以上。 */
  const savedOffsetRef = useRef(initial.anchorOffset ?? 0);
  // onProgress 每次渲染都是新的箭头函数，book 也随每一次进度回写换引用。把它们直接
  // 写进观察器的依赖，就等于每渲染一次都把盯着上千个句子元素的观察器拆了重建。
  const progressRef = useRef(onProgress);
  const bookRef = useRef(book);
  useEffect(() => {
    progressRef.current = onProgress;
    bookRef.current = book;
  }, [book, onProgress]);
  const paged = settings.readingMode === "page";
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageStep, setPageStep] = useState(0);
  // 连按翻页时 state 还没重渲染，只能靠 ref 记住已经翻到第几页。
  const pageIndexRef = useRef(0);
  const goToPage = useCallback((next: number) => {
    pageIndexRef.current = next;
    setPageIndex(next);
    setPopup(null);
  }, []);
  const chapter = book.chapters[chapterIndex];
  const tocList = useMemo(() => tocIndexes(book.chapters), [book.chapters]);

  // 滚动模式是连续阅读：range 覆盖的这几章一起挂在 DOM 里。滑动中只往下接章；
  // 往上接章、摘章、整章排版都会动到视口上方，留到停稳之后做（见下面的 rebalance）。
  // 分页模式仍旧一次只排当前这一章。
  const [range, setRange] = useState({
    start: initial.chapterIndex,
    end: initial.chapterIndex,
  });
  const rangeRef = useRef(range);
  // 下一次提交后要当场整章排好的章。进书那一章一开始就排好，恢复阅读位置才能一次落准；
  // 跳转时目标章和它上面那章排好，落点上方就没有会被撑开的估算占位。
  const pendingPrimeRef = useRef<number[]>([initial.chapterIndex]);

  const pagedChapters = useMemo(
    () => (chapter ? [{ chapter, index: chapterIndex }] : []),
    [chapter, chapterIndex]
  );
  // 滚动模式不能依赖 chapterIndex：它随滑动一直在变，一变就会把整窗正文重建一遍。
  const scrollChapters = useMemo(
    () =>
      book.chapters
        .slice(range.start, range.end + 1)
        .map((item, offset) => ({ chapter: item, index: range.start + offset })),
    [book.chapters, range.start, range.end]
  );
  const visibleChapters = paged ? pagedChapters : scrollChapters;

  const sentenceIndexByChapter = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const { chapter: item, index } of visibleChapters) {
      map.set(index, sentenceIndexOf(item));
    }
    return map;
  }, [visibleChapters]);

  // 页脚页码、顶上「已读」跟着阅读器自己量到的位置走，不等书架那份节流过的进度。
  // 之前直接读 book.readingPosition：它半秒才刷一次，和 chapterIndex 对不上时
  // 页码会退回「这一章第一页」。
  const [livePosition, setLivePosition] = useState(() => ({
    chapterIndex: initial.chapterIndex,
    sentenceIndex: initial.sentenceIndex,
  }));
  const showLivePosition = useCallback(
    (nextChapter: number, nextSentence: number) =>
      setLivePosition((current) =>
        current.chapterIndex === nextChapter &&
        current.sentenceIndex === nextSentence
          ? current
          : { chapterIndex: nextChapter, sentenceIndex: nextSentence }
      ),
    []
  );
  const marksBySentence = useMemo(() => {
    const map = new Map<string, BookNote[]>();
    for (const note of notes) {
      if (note.kind !== "highlight") continue;
      const list = map.get(note.sentenceId);
      if (list) list.push(note);
      else map.set(note.sentenceId, [note]);
    }
    return map;
  }, [notes]);

  // 进入章节时要落到哪一页：句子 id、章末，或者不动。
  const restoreRef = useRef<string | "last" | null>(
    book.readingPosition?.sentenceId ?? null
  );
  const previousPagedRef = useRef(paged);

  useLayoutEffect(() => {
    if (paged && !previousPagedRef.current) {
      // 连续阅读中保存点一直在更新；切入分页时应使用当前屏幕的锚点，而非进书时的旧位置。
      restoreRef.current = savedSentenceRef.current;
    } else if (!paged) {
      restoreRef.current = null;
    }
    previousPagedRef.current = paged;
  }, [paged]);

  useLayoutEffect(() => {
    const article = articleRef.current;
    if (!paged || !article) {
      // 切回滚动模式要把分页时写进去的栏宽抹掉，否则正文还留在多栏容器里。
      article?.style.removeProperty("column-width");
      setPageStep(0);
      setPageCount(1);
      return;
    }

    const measure = () => {
      const width = article.clientWidth;
      if (!width) return;
      // 每一栏正好一页宽，多出来的内容就横向溢出成后面几页。
      article.style.columnWidth = `${width}px`;
      const gap = Number.parseFloat(getComputedStyle(article).columnGap) || 0;
      const step = width + gap;
      const count = Math.max(1, Math.round((article.scrollWidth + gap) / step));
      setPageStep(step);
      setPageCount(count);

      // 没有指定落点时锚回当前这句，这样改字号、转屏之后还停在原处。
      const restore = restoreRef.current ?? savedSentenceRef.current;
      restoreRef.current = null;
      if (restore === "last") {
        goToPage(count - 1);
        return;
      }
      const target = article.querySelector<HTMLElement>(
        `[data-sentence-id="${restore}"]`
      );
      const offset = target
        ? target.getBoundingClientRect().left -
          article.getBoundingClientRect().left
        : pageIndexRef.current * step;
      goToPage(Math.max(0, Math.min(count - 1, Math.round(offset / step))));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(article);
    return () => observer.disconnect();
  }, [
    paged,
    chapterIndex,
    book.id,
    settings.fontSize,
    settings.lineHeight,
    settings.fontFamily,
    settings.contentWidth,
    goToPage,
  ]);

  useEffect(() => {
    if (paged) return;
    const targetId = restorePosition?.sentenceId;
    if (!targetId) return;
    // 刚打开一本没读过的书时，openReader 会写一条「第一章第一句」的起始位置。
    // 那种情况不该去定位：把第一句对到锚点线等于把章节标题顶出屏幕，
    // 而书本来就该从头显示。真读到过第一句也一样——那时页面本来就在顶上。
    if (
      restorePosition.chapterIndex === 0 &&
      restorePosition.sentenceIndex === 0 &&
      !restorePosition.anchorOffset
    ) {
      return;
    }

    // 定位只在进书后的这一小段窗口里做，而且一旦成功、或者发现用户已经在滚，
    // 就立刻把所有钩子摘干净。之前放到 8 秒、成功后还留着 ResizeObserver，
    // iPhone 上冷启动版面稳得慢（读库、渲染、图片占位、地址栏收起导致视口变高），
    // 会被一次次重新唤醒，表现就是刚进书滑动发滞、过一会才正常。
    const SETTLE_WINDOW_MS = 1500;
    let settled = false;
    let frame = 0;
    let resize: ResizeObserver | null = null;
    const deadline = Date.now() + SETTLE_WINDOW_MS;
    /** 我们自己滚到的位置，用来把「用户在滚」和「我们在滚」区分开。 */
    let appliedY = window.scrollY;

    const stop = () => {
      if (settled) return;
      settled = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      resize?.disconnect();
      resize = null;
      window.removeEventListener("scroll", onUserScroll);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("touchmove", stop);
      window.removeEventListener("keydown", stop);
    };

    function onUserScroll() {
      // 这一下要是我们自己滚出来的就不算；否则说明用户已经在读了，立刻收手。
      if (Math.abs(window.scrollY - appliedY) <= 1) return;
      stop();
    }

    /**
     * 把这句话放回保存时的那个高度。返回「是不是已经到位」。
     *
     * 不能把「找到元素」当成成功：正文刚挂上时文档高度还没撑开（实测那一刻
     * scrollHeight 只有一屏、maxScroll 为 0），scrollBy 会被整个夹掉，滚了等于没滚。
     * 所以这里要实际复查一次位置，没到位就交给下面的循环继续盯。
     */
    const place = () => {
      const element = articleRef.current?.querySelector<HTMLElement>(
        `[data-sentence-id="${targetId}"]`
      );
      if (!element) return false;
      // 目标高度 = 锚点线往上退回「当初读到这句第几像素」，这样长段落读到一半
      // 也能回到原处，而不是退回整段开头。
      const targetTop =
        READING_ANCHOR_TOP - (restorePosition?.anchorOffset ?? 0);
      const driftNow = () => element.getBoundingClientRect().top - targetTop;

      const drift = driftNow();
      if (Math.abs(drift) <= 2) return true;
      window.scrollBy(0, drift);
      appliedY = window.scrollY;

      // 这里不能用「已经滚到底了就算到位」来提前收工：正文刚挂上的那几帧
      // scrollHeight 只有一屏、maxScroll 恰好是 0，那个判断会在第一帧就为真，
      // 等于什么都没做就宣告成功。到不了位就交给循环继续盯，超时兜底。
      return Math.abs(driftNow()) <= 2;
    };

    const settle = () => {
      if (settled) return;
      // 用户已经在滚了（scrollY 离开了我们上次 place() 落下的位置），别再拽回去。
      // scroll 事件是异步派发的，ResizeObserver／rAF 回调有可能先跑到——
      // 尤其是滑动触发接章／摘章时，版面变化会让 ResizeObserver 抢先回调，
      // 光靠 onUserScroll 拦不住这一下，表现就是「刚进书滑动会被弹回原位」。
      if (Math.abs(window.scrollY - appliedY) > 1) {
        stop();
        return;
      }
      // 一次落位就收手，不再留着钩子等下一次版面变化。
      if (place() || Date.now() > deadline) {
        stop();
        return;
      }
      frame = requestAnimationFrame(settle);
    };
    settle();

    // 窗口内版面还在长高（接章、图片占位、视口变化）时补一次；一旦落位，
    // stop() 会把这个观察器一起摘掉。
    resize = new ResizeObserver(() => {
      if (settled || Date.now() > deadline) return;
      settle();
    });
    if (articleRef.current) resize.observe(articleRef.current);

    void document.fonts?.ready.then(() => {
      if (settled || Date.now() > deadline) return;
      settle();
    });

    window.addEventListener("scroll", onUserScroll, { passive: true });
    window.addEventListener("wheel", stop, { passive: true, once: true });
    window.addEventListener("touchstart", stop, { passive: true, once: true });
    // 点进书的那一下 touchstart 在 effect 挂上之前就派发过了，once 监听器接不到；
    // 手指还没抬就开始滑时，靠 touchmove 兜住这段手势，立刻停止位置恢复。
    window.addEventListener("touchmove", stop, { passive: true, once: true });
    window.addEventListener("keydown", stop, { once: true });
    return stop;
    // 只在进入这本书／切换阅读模式时回到上次的位置。连续滚动里 chapterIndex 会随滑动
    // 一直变，把它放进依赖会让页面自己跳回去。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, paged]);

  // 分页模式下没有滚动事件，进度改从当前页上的第一句话推出来。
  useEffect(() => {
    const article = articleRef.current;
    if (!paged || !article) return;
    const timer = setTimeout(() => {
      // 正文整体被平移过，当前页的左边界要把平移量加回去才算得对。
      const left =
        article.getBoundingClientRect().left + pageIndex * pageStep;
      const target = Array.from(
        article.querySelectorAll<HTMLElement>("[data-sentence-id]")
      ).find((element) => element.getBoundingClientRect().right > left + 1);
      const id = target?.dataset.sentenceId;
      const index = Number(target?.dataset.sentenceIndex);
      if (!id || Number.isNaN(index) || savedSentenceRef.current === id) return;
      savedSentenceRef.current = id;
      showLivePosition(chapterIndex, index);
      progressRef.current(positionFor(bookRef.current, chapterIndex, index));
    }, 320);
    return () => clearTimeout(timer);
  }, [paged, pageIndex, pageStep, pageCount, chapterIndex, showLivePosition]);

  useEffect(() => {
    if (paged) return;
    if (!articleRef.current || !("IntersectionObserver" in window)) return;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingSave: (() => void) | null = null;
    /**
     * 正读到哪一句 —— 就看锚点线穿过的是谁。
     *
     * 不能拿 observer 给的 entries 去挑：它每次只报告「刚跨过观察带边缘」的那一两个
     * 元素，挑来挑去永远挑不中真正压在锚点线上的那句。真机日志里 candidates 恒为 1、
     * 选中句的 top 稳定落在 320~338px（观察带下沿），而不是锚点的 150px——
     * 存的位置比你实际读到的地方晚了小半屏，回来自然就对不上。
     *
     * 锚点线正好落在段间留白时探几个邻近的 y，免得这一下白存。
     */
    /** 这一段里哪一句的某一行压着 y。行内元素的整体矩形不可靠，得看逐行矩形。 */
    const sentenceCrossing = (block: Element, y: number): HTMLElement | null => {
      for (const sentence of block.querySelectorAll<HTMLElement>(
        "[data-sentence-id]"
      )) {
        for (const rect of sentence.getClientRects()) {
          if (rect.top <= y && rect.bottom > y) return sentence;
        }
      }
      return null;
    };

    const sentenceAtAnchor = (): HTMLElement | null => {
      const article = articleRef.current;
      if (!article) return null;
      const box = article.getBoundingClientRect();
      const x = box.left + box.width / 2;
      for (const dy of [0, 10, -10, 24, -24]) {
        const y = READING_ANCHOR_TOP + dy;
        for (const hit of document.elementsFromPoint(x, y)) {
          if (!article.contains(hit)) continue;
          const inside = hit.closest<HTMLElement>("[data-sentence-id]");
          if (inside) return inside;
          // 句子是行内 span，锚点线经常落在行与行之间的空隙里，命中测试只能
          // 打到外层段落。这时就在这一段里按「逐行矩形」找真正压着线的那一句，
          // 不然这次滚动会被整个丢掉——进度停在上一次，回来就差一大截。
          //
          // 只能在段落里找。命中栈里除了段落还有 section、article 这些祖先，
          // 在它们身上扫等于把整章的句子逐个量一遍：实测一章 15799 句时单次要 370ms，
          // 而这是每个 scroll 事件都要走的路径，滚动会直接掉到 4fps。
          const block = hit.closest<HTMLElement>(".reader-block");
          if (!block) continue;
          const byLine = sentenceCrossing(block, y);
          if (byLine) return byLine;
        }
      }
      return null;
    };

    /**
     * 把「此刻锚点线压着的那一句」记成阅读进度。
     *
     * 一定要在滚动停下来之后再量：之前是在 observer 回调里当场把位置算好、再延迟
     * 500ms 落盘，中间手指还在滑，存下来的是几百像素之前的位置。
     */
    const measureAnchor = () => {
      const element = sentenceAtAnchor();
      if (!element) return null;
      const index = Number(element.dataset.sentenceIndex);
      // 连续滚动里视口内可能横跨两章，章节号只能从元素上读，不能用闭包里的。
      const chIndex = Number(element.dataset.chapterIndex);
      const id = element.dataset.sentenceId;
      if (!id || Number.isNaN(index) || Number.isNaN(chIndex)) return null;
      // 不能钳到 >=0：锚点线落在段间留白时探到的是下面那句，它的顶边在线下方，
      // 偏移本来就是负的。钳成 0 等于把它硬拉到线上，恢复时整页抬高几十像素。
      const anchorOffset = Math.round(
        READING_ANCHOR_TOP - element.getBoundingClientRect().top
      );
      return { id, index, chIndex, anchorOffset };
    };

    type Anchor = NonNullable<ReturnType<typeof measureAnchor>>;

    const commitAnchor = (anchor: Anchor) => {
      setChapterIndex(anchor.chIndex);
      showLivePosition(anchor.chIndex, anchor.index);
      // 一整段可能有好几屏高：同一段里往下读时 id 不变但句内偏移在变，
      // 只按 id 去重会把这段时间读的都丢掉。差过一行就重存。
      if (
        savedSentenceRef.current === anchor.id &&
        Math.abs(anchor.anchorOffset - savedOffsetRef.current) < 24
      ) {
        return;
      }
      savedSentenceRef.current = anchor.id;
      savedOffsetRef.current = anchor.anchorOffset;
      const position: BookPosition = {
        ...positionFor(bookRef.current, anchor.chIndex, anchor.index),
        anchorOffset: anchor.anchorOffset,
      };
      rememberPosition(bookRef.current.id, position);
      progressRef.current(position);
    };

    const saveAnchor = () => {
      const anchor = measureAnchor();
      if (anchor) commitAnchor(anchor);
    };

    let snapshotAt = 0;

    const schedule = () => {
      // 当场先量一份快照：卸载时（退出阅读器、切书）effect 清理跑在 DOM 拆掉之后，
      // 那时再量是量不到的，只能靠这份快照把最后这一下补写进去。
      //
      // 但它只是兜底，不必每个 scroll 事件都量——滚动中 scroll 事件按帧来，
      // 每次都量等于把一次强制同步布局摊进每一帧。隔一段留一份就够了，
      // 正常路径仍然以「停下来那一刻重新量」的结果为准。
      const now = performance.now();
      if (now - snapshotAt >= SNAPSHOT_INTERVAL_MS) {
        snapshotAt = now;
        const snapshot = measureAnchor();
        pendingSave = snapshot ? () => commitAnchor(snapshot) : null;
        // 页码边滑边走，不用等停下来才一下跳过去。
        if (snapshot) showLivePosition(snapshot.chIndex, snapshot.index);
      }
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        pendingSave = null;
        // 正常路径按停下来那一刻重新量一次，比快照更准。
        saveAnchor();
      }, 400);
    };

    // 滚动本身就是「位置变了」最可靠的信号。以前还给窗口里每个句子挂 IntersectionObserver
    // 当触发器，每接一章就得把上千个句子重新 observe 一遍，白白压在接章那一帧上。
    window.addEventListener("scroll", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      // 卸载前如果还有没落盘的最新位置（防抖还没到），立即量一次存掉，
      // 不能让 clearTimeout 把用户刚读到的地方悄悄扔了。
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingSave?.();
      }
    };
  }, [book.id, paged, showLivePosition]);

  // 接章、摘章、整章排版都会改变正文上方的高度，不补偿的话页面会当场跳一下。
  // 改之前记住视口里正在看的那一段在哪，改完按它的位移把滚动条推回去。
  // 只在停稳时这么做（见 rebalance），而且改动和补偿在同一个任务里完成、中间不绘制，
  // 读者看不到那一下。滑动中往下接章不动视口上方，不需要补偿。
  const viewAnchorRef = useRef<{ element: HTMLElement; top: number } | null>(
    null
  );
  const captureViewAnchor = useCallback(() => {
    viewAnchorRef.current = null;
    const article = articleRef.current;
    if (!article) return;
    const box = article.getBoundingClientRect();
    const x = box.left + box.width / 2;
    for (const y of [READING_ANCHOR_TOP, window.innerHeight / 2]) {
      for (const hit of document.elementsFromPoint(x, y)) {
        const block = hit.closest<HTMLElement>(
          ".reader-block, .reader-title, .reader-end"
        );
        if (block && article.contains(block)) {
          viewAnchorRef.current = {
            element: block,
            top: block.getBoundingClientRect().top,
          };
          return;
        }
      }
    }
    // 两条探测线都落在段间留白里：退回视口里第一个露出来的章。
    for (const section of article.querySelectorAll<HTMLElement>(
      "[data-chapter-section]"
    )) {
      const rect = section.getBoundingClientRect();
      if (rect.bottom > 0) {
        viewAnchorRef.current = { element: section, top: rect.top };
        return;
      }
    }
  }, []);

  const restoreViewAnchor = useCallback(() => {
    const anchor = viewAnchorRef.current;
    viewAnchorRef.current = null;
    if (!anchor || !anchor.element.isConnected) return;
    const delta = anchor.element.getBoundingClientRect().top - anchor.top;
    if (delta) window.scrollBy(0, delta);
  }, []);

  useLayoutEffect(() => {
    rangeRef.current = range;
    const pending = pendingPrimeRef.current;
    pendingPrimeRef.current = [];
    for (const index of pending) {
      primeSection(
        articleRef.current?.querySelector<HTMLElement>(
          `[data-chapter-section="${index}"]`
        )
      );
    }
    restoreViewAnchor();
  }, [range, restoreViewAnchor]);

  // 换窗口之后才知道目标元素在哪，所以跳转的滚动必须等这次提交落地再做，而且得是瞬时的。
  // 在点击事件里同步发平滑滚动，动画是照着旧窗口的文档高度跑的；等它跑到一半，窗口调整
  // 补偿用的 scrollBy 又会按规范中止这段动画，最后停在半路。
  const pendingScrollRef = useRef<{
    selector: string;
    block: ScrollLogicalPosition;
  } | null>(null);

  // 滚到目标，再盯住它直到上方的占位都撑开完。只滚一下的话 iOS 上会被撑开的段落推走。
  const releaseHoldRef = useRef<(() => void) | null>(null);
  const revealTarget = useCallback(
    (selector: string, block: ScrollLogicalPosition) => {
      releaseHoldRef.current?.();
      releaseHoldRef.current = null;
      const article = articleRef.current;
      const element = article?.querySelector<HTMLElement>(selector);
      if (!article || !element) return;
      element.scrollIntoView({ block });
      releaseHoldRef.current = holdInPlace(element, article);
    },
    []
  );
  useEffect(() => () => releaseHoldRef.current?.(), []);
  // 阅读器按书 key，离开这本书时组件卸载，图片缓存跟着释放。
  useEffect(() => releaseImageUrls, []);

  /**
   * 跳到某一章里的某个位置：以这一章为中心重新开窗，落地后再滚过去。
   *
   * 前后两章一起挂上：落地时两端的哨兵往往已经在缓冲区里，observer 不会再为它们
   * 报第二次，只挂目标章的话就再也接不上邻章，只能在这一章里上下滑。
   * 跳转是重新开窗，不是接章，所以不做锚点补偿。
   */
  const jumpWithin = useCallback(
    (index: number, selector: string, block: ScrollLogicalPosition) => {
      const last = bookRef.current.chapters.length - 1;
      viewAnchorRef.current = null;
      pendingScrollRef.current = { selector, block };
      const next = {
        start: Math.max(0, index - 1),
        end: Math.min(last, index + 1),
      };
      // 目标章和它上面那章当场整章排好：落点上方没有估算占位，就没有东西会把目标推走。
      // 下面那章留给停稳之后再排，跳转这一下只多花两章的排版。
      pendingPrimeRef.current = [index, next.start];
      rangeRef.current = next;
      setRange(next);
    },
    []
  );

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    pendingScrollRef.current = null;
    // 目录之类的浮层通常是"点了就关"，跳转落地时它可能还在收起、body 还锁着。
    scrollWhenUnlocked(() => revealTarget(pending.selector, pending.block));
  }, [range, revealTarget]);

  // 改排版会让正文整体重排。分页模式在 measure() 里按句子重新对页，连续滚动这边得自己来：
  // 先记下锚点句在视口里的位置，重排后按位移把滚动条推回去，否则调一次字号就找不到读到哪了。
  const typographyAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const applySettings = (next: ReaderSettings) => {
    const id = savedSentenceRef.current;
    const element = articleRef.current?.querySelector<HTMLElement>(
      `[data-sentence-id="${id}"]`
    );
    typographyAnchorRef.current =
      paged || !element
        ? null
        : { id, top: element.getBoundingClientRect().top };
    onSettingsChange(next);
  };

  useLayoutEffect(() => {
    const anchor = typographyAnchorRef.current;
    typographyAnchorRef.current = null;
    if (paged || !anchor) return;
    const element = articleRef.current?.querySelector<HTMLElement>(
      `[data-sentence-id="${anchor.id}"]`
    );
    if (!element) return;
    const delta = element.getBoundingClientRect().top - anchor.top;
    if (delta) window.scrollBy(0, delta);
  }, [paged, settings]);

  // 正文不跟着朗读自己滚——读者的手在上面，正文就不该动。只在朗读句被甩出视口时
  // 露一个很淡的小按钮，想回去点一下即可。初值当成看得见，免得刚进来先闪一下。
  const speakingMounted =
    !!currentSentenceId &&
    speakingChapterIndex >= range.start &&
    speakingChapterIndex <= range.end;
  const [speakingVisible, setSpeakingVisible] = useState(true);

  useEffect(() => {
    if (paged || !speakingMounted) return;
    const element = articleRef.current?.querySelector<HTMLElement>(
      `[data-sentence-id="${currentSentenceId}"]`
    );
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) =>
      setSpeakingVisible(entry.isIntersecting)
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [paged, speakingMounted, currentSentenceId, range.start, range.end]);

  const showRecall =
    !paged && !!currentSentenceId && !(speakingMounted && speakingVisible);

  const scrollToSpeaking = () => {
    const selector = `[data-sentence-id="${currentSentenceId}"]`;
    if (articleRef.current?.querySelector(selector)) {
      revealTarget(selector, "center");
      return;
    }
    // 朗读已经走到窗口之外的章去了，先按那一章重新开窗，落地后再滚过去。
    jumpWithin(speakingChapterIndex, selector, "center");
  };

  // 正文两端各放一个哨兵。尾部哨兵进缓冲区就往下接一章：只动视口下方，滑动中也能做。
  // 用 observer 而不是 scroll 事件，免得每次滚动都去读 scrollHeight 触发同步布局。
  // 头部哨兵只留作渲染探针的挂载点，往上接章交给 rebalance。
  const startSentinelRef = useRef<HTMLDivElement>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paged) return;
    const endEl = endSentinelRef.current;
    if (!endEl || !("IntersectionObserver" in window)) return;
    const last = book.chapters.length - 1;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // 拖选期间保留当前章节 DOM，避免窗口变化打断选区。
        if (!entry?.isIntersecting || selectionActiveRef.current) return;
        const current = rangeRef.current;
        if (current.end >= last) return;
        const next = { start: current.start, end: current.end + 1 };
        rangeRef.current = next;
        setRange(next);
      },
      { rootMargin: `0px 0px ${CHAPTER_LOAD_MARGIN}px 0px` }
    );
    observer.observe(endEl);
    return () => observer.disconnect();
  }, [paged, book.chapters.length, range, textSelection.active]);

  /**
   * 停稳之后调整窗口：往上接章、摘掉远处的章、把附近的章整章排好。
   *
   * 这些都会改变视口上方的高度，必须补偿滚动位置。iOS 惯性滚动期间脚本发的 scrollBy
   * 会被丢掉——补偿一丢，正文就整章地跳（「从第 90 页直接跳到 53 页」就是这个），
   * 就算没丢也会把惯性掐断，滑着滑着突然一顿。所以手在屏上、或者还在惯性里时一律不动，
   * 停稳 200ms 后再一步一步做，每一步都在同一个任务里改完、补偿完，中间不绘制。
   *
   * 整章排好之后正文就和原生排版一样：滑进视口的段落早就排完了，不会先空一下再出字，
   * 也不会被撑开把正在读的地方顶走。
   */
  useEffect(() => {
    if (paged) return;
    let touching = false;
    let lastScrollAt = performance.now();
    /** 我们自己补偿滚动落下的位置：它引发的 scroll 事件不算用户在滑。 */
    let ownScrollY = -1;
    let timer = 0;

    const arm = (delay: number) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(step, delay);
    };

    function step() {
      timer = 0;
      if (touching || selectionActiveRef.current) return;
      const quietFor = performance.now() - lastScrollAt;
      if (quietFor < WINDOW_IDLE_MS) {
        arm(WINDOW_IDLE_MS - quietFor);
        return;
      }
      const article = articleRef.current;
      if (!article) return;
      const sections = Array.from(
        article.querySelectorAll<HTMLElement>("[data-chapter-section]"),
        (element) => {
          const rect = element.getBoundingClientRect();
          return {
            index: Number(element.dataset.chapterSection),
            top: rect.top,
            bottom: rect.bottom,
          };
        }
      );
      const viewportHeight = window.innerHeight;
      const current = rangeRef.current;
      const primed = new Set(
        Array.from(
          article.querySelectorAll<HTMLElement>("[data-chapter-section][data-primed]"),
          (element) => Number(element.dataset.chapterSection)
        )
      );
      const action = planChapterWindow({
        range: current,
        lastChapter: bookRef.current.chapters.length - 1,
        primed,
        sections,
        viewportHeight,
        buffer: viewportHeight * WINDOW_BUFFER_SCREENS,
        trimDistance: viewportHeight * WINDOW_TRIM_SCREENS,
      });
      if (!action) return;

      captureViewAnchor();
      if (action.kind === "prime") {
        // 不经过 React：直接改段落上的标记，量一下、补偿，一步十几毫秒。
        const section = article.querySelector<HTMLElement>(
          `[data-chapter-section="${action.index}"]`
        );
        if (section) primeChunk(section, PRIME_CHUNK_CHARS);
        restoreViewAnchor();
      } else {
        const nextRange =
          action.kind === "prepend"
            ? { start: current.start - 1, end: current.end }
            : action.kind === "append"
              ? { start: current.start, end: current.end + 1 }
              : action.kind === "trim-start"
                ? { start: current.start + 1, end: current.end }
                : { start: current.start, end: current.end - 1 };
        rangeRef.current = nextRange;
        // 同步提交：改版面和补偿滚动在这一个任务里做完，不留给手指插进来的空档。
        // 新接上的章先按估算占位挂上（便宜），后面几步再一段段排好。
        flushSync(() => setRange(nextRange));
      }
      ownScrollY = window.scrollY;
      arm(WINDOW_STEP_GAP_MS);
    }

    const onScroll = () => {
      if (Math.abs(window.scrollY - ownScrollY) <= 1) return;
      ownScrollY = -1;
      lastScrollAt = performance.now();
      arm(WINDOW_IDLE_MS);
    };
    const onTouchStart = () => {
      touching = true;
      if (timer) window.clearTimeout(timer);
      timer = 0;
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length) return;
      touching = false;
      lastScrollAt = performance.now();
      arm(WINDOW_IDLE_MS);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    arm(WINDOW_IDLE_MS);
    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [paged, book.id, captureViewAnchor, restoreViewAnchor]);

  // 换书或切换阅读模式时重新以当前章开窗，别把旧窗口带过去。
  useEffect(() => {
    const reset = { start: chapterIndex, end: chapterIndex };
    rangeRef.current = reset;
    pendingPrimeRef.current = [chapterIndex];
    // 这里是在换书／切模式后同步重置窗口，避免旧章节窗口短暂残留。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRange(reset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, paged]);

  const captureSelection = () => {
    const article = articleRef.current;
    const selection = window.getSelection();
    // 接管了选择就没有系统选区可读，这条路只留给桌面和老浏览器。
    if (customSelectRef.current) return false;
    if (!article || !selection || selection.isCollapsed || !selection.rangeCount) {
      return false;
    }
    const range = selection.getRangeAt(0);
    if (!article.contains(range.commonAncestorContainer)) return false;

    const parts: HighlightPart[] = [];
    article
      .querySelectorAll<HTMLElement>("[data-sentence-id]")
      .forEach((element) => {
        const hit = offsetsWithin(element, range);
        if (!hit || !hit.text.trim()) return;
        parts.push({
          chapterIndex: Number(element.dataset.chapterIndex),
          sentenceId: element.dataset.sentenceId ?? "",
          sentenceIndex: Number(element.dataset.sentenceIndex),
          start: hit.start,
          end: hit.end,
          text: hit.text,
        });
      });
    if (!parts.length) return false;

    setPopup({
      kind: "selection",
      anchor: range.getBoundingClientRect(),
      rects: Array.from(range.getClientRects()),
      parts,
      text: parts.map((part) => part.text).join(""),
    });
    return true;
  };

  const openMarkPopup = (element: HTMLElement, note: BookNote) => {
    window.getSelection()?.removeAllRanges();
    setPopup({ kind: "mark", anchor: element.getBoundingClientRect(), note });
  };

  /**
   * 自定义选区活着时，菜单由它推出来；否则用 setPopup 存的那份（系统选区 / 点已有划线）。
   * 两条路产出的是同一种结构，下面的操作不必各写一遍。
   */
  const activePopup: ReaderPopupState | null = textSelection.active
    ? // 自定义选区活着时只认它自己：拖手柄期间 anchor 是 null，那就什么都不显示，
      // 让菜单从正在选的那几行上让开。这里不能回退到 popup——上一次划线留下的
      // 颜色菜单会在拖动途中翻出来，挡着正文还牛头不对马嘴。
      textSelection.anchor && textSelection.parts.length
      ? {
          kind: "selection",
          anchor: textSelection.anchor,
          rects: textSelection.rects,
          parts: textSelection.parts,
          text: textSelection.text,
        }
      : null
    : popup;

  /** 收掉菜单和选区。两条选择路径都要清，不然会留下画在屏幕上的幽灵选区。 */
  const dismissSelection = useCallback(() => {
    setPopup(null);
    clearTextSelection();
    window.getSelection()?.removeAllRanges();
  }, [clearTextSelection]);

  /** 同一次划线拆成的几条记录，拼回用户当时选中的那整段文字。 */
  const groupText = (note: BookNote) =>
    mergeNoteGroup(notes.filter((item) => groupKey(item) === groupKey(note)))
      .excerpt;

  const applyHighlight = async (
    color: HighlightColor,
    highlightStyle?: HighlightStyle
  ) => {
    if (activePopup?.kind === "mark") {
      const resolvedStyle =
        highlightStyle ?? activePopup.note.highlightStyle ?? "underline";
      if (
        await onUpdateNote({
          ...activePopup.note,
          color,
          highlightStyle: resolvedStyle,
        })
      ) {
        if (
          settings.highlightColor !== color ||
          settings.highlightStyle !== resolvedStyle
        ) {
          onSettingsChange({
            ...settings,
            highlightColor: color,
            highlightStyle: resolvedStyle,
          });
        }
        setPopup(null);
      }
      return;
    }
    if (activePopup?.kind !== "selection") return;
    const anchor = activePopup.anchor;
    const created = await onHighlight(
      activePopup.parts,
      color,
      highlightStyle ?? "underline"
    );
    if (!created) {
      // 存不下就别把选区收掉，用户原地再点一次「划线」就是重试。
      onToast("划线没保存上，再点一次试试");
      return;
    }
    // 划完线选区就该退场，留着的话高亮会被选区底色盖住看不见颜色。
    textSelection.clear();
    window.getSelection()?.removeAllRanges();
    setPopup({ kind: "mark", anchor, note: created });
  };

  const handleArticleClick = (event: MouseEvent<HTMLElement>) => {
    // 刚翻过页就别再顺手把那一下当成选句子。
    if (turnedRef.current) {
      turnedRef.current = false;
      return;
    }
    // 长按刚选出东西，抬手后浏览器补发的这一下属于那次长按，不是「点空白取消」。
    if (textSelection.consumeTapAfterSelect()) return;
    // 正在划词时，点空白只表示「不选了」，不该顺手把顶栏也收掉。
    if (textSelection.active) {
      if (!(event.target as HTMLElement).closest(".selection-handle")) {
        dismissSelection();
      }
      return;
    }
    // 划词时不要改选句子，否则刚拉出来的选区会被重新渲染打断。
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;

    const mark = (event.target as HTMLElement).closest<HTMLElement>(
      "mark[data-note-id]"
    );
    if (mark) {
      const note = notes.find((item) => item.id === mark.dataset.noteId);
      if (note) {
        openMarkPopup(mark, note);
        return;
      }
    }
    // 单击一律只切沉浸模式。想从某处开始听要先划词，再用浮条上的「从这里听」。
    setPopup(null);
    setChromeVisible((value) => !value);
  };

  const changeChapter = useCallback((nextIndex: number, landing: "first" | "last" = "first") => {
    clearTextSelection();
    const currentBook = bookRef.current;
    const safe = Math.max(0, Math.min(currentBook.chapters.length - 1, nextIndex));
    setChapterIndex(safe);
    const position = positionFor(currentBook, safe, 0);
    savedSentenceRef.current = position.sentenceId;
    onProgress(position);
    restoreRef.current = landing === "last" ? "last" : null;
    setPopup(null);
    goToPage(0);
    // 分页模式一次只排一章、靠平移正文切页，不动滚动条。
    showLivePosition(safe, 0);
    if (paged) {
      viewAnchorRef.current = null;
      const jumped = { start: safe, end: safe };
      rangeRef.current = jumped;
      setRange(jumped);
      return;
    }
    jumpWithin(safe, `[data-chapter-section="${safe}"]`, "start");
  }, [clearTextSelection, goToPage, jumpWithin, onProgress, paged, showLivePosition]);

  const turnPage = useCallback((delta: number) => {
    const next = pageIndexRef.current + delta;
    if (next < 0) {
      if (chapterIndex > 0) changeChapter(chapterIndex - 1, "last");
      return;
    }
    if (next >= pageCount) {
      if (chapterIndex < bookRef.current.chapters.length - 1) changeChapter(chapterIndex + 1);
      return;
    }
    goToPage(next);
  }, [chapterIndex, changeChapter, goToPage, pageCount]);

  const turnPageRef = useRef(turnPage);
  useEffect(() => {
    turnPageRef.current = turnPage;
  }, [turnPage]);

  useEffect(() => {
    if (!paged) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [contenteditable='true'], [role='dialog']"))
      ) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") turnPageRef.current(1);
      else if (event.key === "ArrowLeft" || event.key === "PageUp") turnPageRef.current(-1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paged]);

  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const turnedRef = useRef(false);
  const cancelSpringRef = useRef<(() => void) | null>(null);

  // 拖拽期间的橡皮筋阻尼：位移越大越"粘手"，不分是不是真的翻到头，纯按距离压。
  const dampPageDrag = (rawDx: number) => {
    const limit = pageStep > 0 ? pageStep * 3 : 300;
    return rawDx * (1 - Math.min(0.8, Math.abs(rawDx) / limit));
  };

  // 选区可能是拖动系统选择手柄结束的，那一下不落在正文元素上，只能听 document。
  useEffect(() => {
    const onPointerUp = (event: PointerEvent) => {
      // target 不一定是元素（document、文本节点都可能），直接 .closest 会抛。
      const target = event.target;
      if (target instanceof Element && target.closest(".reader-popover")) return;
      window.setTimeout(captureSelection, 10);
    };
    document.addEventListener("pointerup", onPointerUp);
    return () => document.removeEventListener("pointerup", onPointerUp);
  }, []);

  useEffect(() => {
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      setPopup((current) => (current?.kind === "selection" ? null : current));
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // 系统选区那条路的浮条锚点是划线那一刻的视口坐标，一滚就会飘到别的句子上面去，
  // 只能收起来。自定义选区不走这里：它记的是句子和字符位置，滚动时自己重量一次。
  useEffect(() => {
    if (!popup) return;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".reader-popover")) return;
      setPopup(null);
    };
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener("scroll", onScroll, { capture: true });
  }, [popup]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    swipeRef.current = { x: event.clientX, y: event.clientY, t: performance.now() };
    cancelSpringRef.current?.();
    cancelSpringRef.current = null;
    textSelection.viewportHandlers.onPointerDown(event);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    textSelection.viewportHandlers.onPointerMove(event);
    if (!paged) return;
    const start = swipeRef.current;
    if (!start) return;
    // 进了选区状态就把跟手让出去：同一次手势不该既拖选区又拖页面。
    if (textSelection.active || textSelection.dragging) {
      if (isDragging) {
        setIsDragging(false);
        setDragX(0);
      }
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      if (isDragging) {
        setIsDragging(false);
        setDragX(0);
      }
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!isDragging) {
      // 横向位移明显超过纵向、且过了一个小阈值，才判定是翻页手势，
      // 避免跟纵向滚动、轻点误判打架。
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      setIsDragging(true);
    }
    setDragX(dampPageDrag(dx));
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    swipeRef.current = null;
    textSelection.viewportHandlers.onPointerCancel(event);
    if (isDragging) {
      cancelSpringRef.current?.();
      cancelSpringRef.current = null;
      setIsDragging(false);
      setDragX(0);
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    textSelection.viewportHandlers.onPointerUp(event);
    // 进了选区状态就先把翻页让出去：同一次手势不该既调选区又翻页。
    if (textSelection.active || textSelection.dragging) {
      if (isDragging) {
        setIsDragging(false);
        setDragX(0);
      }
      return;
    }
    // 正在划词就别把这一下当成翻页手势。
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      if (isDragging) {
        setIsDragging(false);
        setDragX(0);
      }
      return;
    }
    if (!paged || !start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;

    if (isDragging) {
      // 手指已经在实时跟手了：按位移+速度判定完成翻页还是弹回原位，
      // 两种情况都交给弹簧把视觉位置遛到 0，CSS transition 这时候必须是关着的
      // （isDragging 一直保持到弹簧 onDone 才关，避免弹簧的每一帧又被 CSS 过渡二次拖尾）。
      const elapsed = Math.max(1, performance.now() - start.t);
      const velocity = (dx / elapsed) * 1000;
      const step = pageStep || 1;
      const shouldTurn = Math.abs(dx) > step * 0.35 || Math.abs(velocity) > 500;
      const settle = () => {
        cancelSpringRef.current = null;
        setIsDragging(false);
      };
      if (shouldTurn) {
        turnedRef.current = true;
        const delta = dx < 0 ? 1 : -1;
        turnPage(delta);
        cancelSpringRef.current = springTo(setDragX, {
          from: dampPageDrag(dx) - delta * step,
          to: 0,
          velocity,
          onDone: settle,
        });
      } else {
        cancelSpringRef.current = springTo(setDragX, {
          from: dampPageDrag(dx),
          to: 0,
          velocity,
          onDone: settle,
        });
      }
      return;
    }

    // 没有触发实时跟手（比如很短促的一下）时，退回原来「松手一次性判定」的翻页/点击逻辑。
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy)) {
      turnedRef.current = true;
      turnPage(dx < 0 ? 1 : -1);
      return;
    }
    // 版心以外的留白整片都用来翻页，版心里只在左右各留两成，中间照旧点句子。
    // 比例得按版心算：窗口宽的时候版心只占中间一条，拿窗口宽度算会把正文首字也吞进翻页区。
    const article = articleRef.current;
    if (article && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const pageLeft =
        article.getBoundingClientRect().left + pageIndex * pageStep;
      const ratio = (event.clientX - pageLeft) / article.clientWidth;
      if (ratio >= 0.2 && ratio <= 0.8) return;
      turnedRef.current = true;
      turnPage(ratio < 0.2 ? -1 : 1);
    }
  };

  // 批注展开时给选中的那几句留一层淡底，不然不知道正在讨论哪一段。
  const askingIds = useMemo(
    () => new Set(inlineAsk?.sentenceIds ?? []),
    [inlineAsk]
  );

  // 正文里那张批注卡的展开/关闭。做成稳定引用，ArticleBody 才能靠 memo 在选区变化时 bail out。
  const handleInlineExpand = useCallback(() => {
    setInlineAsk(null);
    setAskAiText("");
  }, []);
  const handleInlineClose = useCallback(() => setInlineAsk(null), []);

  const pageViewport = usePageViewport();

  const readerStyle = {
    "--reader-font-size": `${settings.fontSize}px`,
    "--reader-line-height": String(settings.lineHeight),
    "--reader-width": `${settings.contentWidth}px`,
    // 段落占位高度的估算要用：一行几个字。
    "--reader-cpl": charsPerLine(
      settings,
      typeof window === "undefined" ? 390 : window.innerWidth
    ),
  } as CSSProperties;

  const remainingPages = Math.max(0, pageCount - pageIndex - 1);
  const readPercent = useMemo(
    () =>
      positionFor(book, livePosition.chapterIndex, livePosition.sentenceIndex)
        .percent,
    [book, livePosition]
  );

  // 目录与页脚用的全书绝对页码：按当前排版估算，改字号／转屏会跟着重算。
  const pagination = useMemo(
    () => estimatePagination(book, settings, pageViewport),
    [book, settings, pageViewport]
  );
  const currentPage = pageAt(
    pagination,
    livePosition.chapterIndex,
    livePosition.sentenceIndex,
    book.chapters[livePosition.chapterIndex]?.sentenceCount ?? 0
  );

  // 目录/设置/写想法/问 AI 这几个全屏浮层打开时，顶/底浮条必须跟着强制隐藏，
  // 不然浮层的呼吸缺口里会露出还在显示、还能点的浮条，看着像一条横杠。
  // 不改 chromeVisible 本身：浮层关掉后 chrome 要精确回到用户手动切换前的显隐状态。
  const overlayOpen = showChapters || showSettings || Boolean(thoughtDraft) || askAiText !== null;
  // 进度条的实时页码：分页模式用手指翻页时立刻变的 pageIndex，跟底栏原来那行文字
  // 同一个算法；滚动模式没有 pageIndex，退回 currentPage（阅读位置驱动，锚点线
  // 停稳后 400ms 内更新，跟 TOC 里「第 X 页」用的是同一个近似值）。
  const livePage = paged
    ? pagination.chapterStart[chapterIndex] + pageIndex
    : currentPage;

  return (
    <div
      className={`reader-shell reader-theme--${settings.theme} ${
        paged ? "is-paged" : "is-scroll"
      } ${chromeVisible && !overlayOpen ? "" : "chrome-hidden"}`}
      style={readerStyle}
    >
      <div className="reader-chrome reader-chrome--top">
        <button
          type="button"
          className="reader-chrome__back"
          aria-label="返回书架"
          onClick={onBack}
        >
          <ChevronLeft size={24} />
        </button>
        <span className="reader-chrome__remain">
          {paged ? `本章还剩 ${remainingPages} 页` : `已读 ${readPercent}%`}
        </span>
      </div>

      <div
        className="reader-viewport"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <article
          ref={articleRef}
          className={`reader-article is-font-${settings.fontFamily} ${
            customSelect ? "is-custom-select" : ""
          } ${isDragging ? "is-dragging" : ""}`}
          style={
            paged
              ? { transform: `translateX(${-pageIndex * pageStep + dragX}px)` }
              : undefined
          }
          onClick={handleArticleClick}
        >
        <ArticleBody
          paged={paged}
          book={book}
          settings={settings}
          visibleChapters={visibleChapters}
          sentenceIndexByChapter={sentenceIndexByChapter}
          marksBySentence={marksBySentence}
          currentSentenceId={currentSentenceId}
          speakingChapterIndex={speakingChapterIndex}
          askingIds={askingIds}
          inlineAsk={inlineAsk}
          chatTurns={chatTurns}
          onChatChange={onChatChange}
          onInlineExpand={handleInlineExpand}
          onInlineClose={handleInlineClose}
          showEnd={!paged && range.end >= book.chapters.length - 1}
          startSentinelRef={startSentinelRef}
          endSentinelRef={endSentinelRef}
        />
        </article>
        {paged ? (
          <span key={pageIndex} className="reader-page-turn" aria-hidden />
        ) : null}
      </div>

      <div className="reader-chrome reader-chrome--bottom">
        <span className="reader-chrome__pos-label">
          {livePage}/{pagination.total}页
        </span>
        <button
          type="button"
          className="reader-chrome__menu"
          aria-label="阅读菜单"
          onClick={() => setShowReaderMenu(true)}
        >
          <List size={20} />
        </button>
      </div>

      {showReaderMenu ? (
        <>
          <button
            type="button"
            className="reader-menu__scrim"
            aria-label="关闭菜单"
            onClick={() => setShowReaderMenu(false)}
          />
          <div className="reader-menu" role="menu">
            <button
              type="button"
              className="reader-menu__row"
              onClick={() => {
                setShowReaderMenu(false);
                setShowChapters(true);
              }}
            >
              <span>目录</span>
              <List size={18} />
            </button>
            <button
              type="button"
              className="reader-menu__row"
              onClick={() => {
                setShowReaderMenu(false);
                setShowSettings(true);
              }}
            >
              <span>主题与设置</span>
              <Type size={18} />
            </button>
            {/* 划词问 AI 走正文批注，这本书的常驻对话得另有入口，否则聊过的就找不回来了。 */}
            <button
              type="button"
              className="reader-menu__row"
              onClick={() => {
                setShowReaderMenu(false);
                setInlineAsk(null);
                setAskAiText("");
              }}
            >
              <span>问 AI</span>
              <Sparkles size={18} />
            </button>
          </div>
        </>
      ) : null}

      {showRecall ? (
        <button
          type="button"
          className="reader-recall"
          aria-label="回到朗读处"
          onClick={scrollToSpeaking}
        >
          <Volume2 size={15} />
        </button>
      ) : null}

      <SelectionLayer
        rects={textSelection.rects}
        handles={textSelection.handles}
        onHandleDown={textSelection.beginHandleDrag}
        dragging={textSelection.dragging}
      />

      {activePopup ? (
        <ReaderPopover
          popup={activePopup}
          insets={insets}
          defaultColor={settings.highlightColor}
          defaultStyle={settings.highlightStyle}
          onHighlight={applyHighlight}
          onCopy={async () => {
            const text =
              activePopup.kind === "selection"
                ? activePopup.text
                : groupText(activePopup.note);
            try {
              if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
              await navigator.clipboard.writeText(text);
              dismissSelection();
              onToast("已复制");
            } catch {
              // 非 HTTPS 或用户拒了剪贴板权限时会走到这儿，不能装作复制成功。
              onToast("复制失败，选区已保留，请重试");
            }
          }}
          onListen={() => {
            const place =
              activePopup.kind === "selection"
                ? activePopup.parts[0]
                : findSentence(book, activePopup.note.sentenceId);
            dismissSelection();
            if (!place) return;
            onStartListening(
              positionFor(book, place.chapterIndex, place.sentenceIndex)
            );
          }}
          onThought={async () => {
            const note =
              activePopup.kind === "mark"
                ? activePopup.note
                : await onHighlight(
                    activePopup.parts,
                    settings.highlightColor,
                    settings.highlightStyle
                  );
            if (!note) {
              onToast("划线没保存上，再点一次试试");
              return;
            }
            dismissSelection();
            setThoughtDraft({ note, value: note.thought ?? "" });
          }}
          onDelete={async () => {
            if (activePopup.kind === "mark" && await onDeleteNote(activePopup.note)) setPopup(null);
          }}
          onAskAi={() => {
            const isSelection = activePopup.kind === "selection";
            const text = isSelection
              ? activePopup.text
              : groupText(activePopup.note);
            const ids = isSelection
              ? activePopup.parts.map((part) => part.sentenceId)
              : notes
                  .filter((item) => groupKey(item) === groupKey(activePopup.note))
                  .map((item) => item.sentenceId);
            dismissSelection();
            // 分页模式往正文里插内容会把分好的页算乱，那边照旧开全屏对话。
            if (paged || !ids.length) setAskAiText(text);
            else
              setInlineAsk({
                text,
                sentenceIds: ids,
                anchorId: ids[ids.length - 1],
              });
          }}
        />
      ) : null}

      {askAiText !== null ? (
        <AiAskPanel
          text={askAiText}
          initialTurns={chatTurns}
          onTurnsChange={onChatChange}
          book={book}
          chapter={chapter}
          settings={settings}
          onClose={() => setAskAiText(null)}
        />
      ) : null}

      {thoughtDraft ? (
        <Modal
          title="写想法"
          onClose={() => setThoughtDraft(null)}
          className="modal-sheet--reader"
        >
          <div className="thought-editor">
            <blockquote>{groupText(thoughtDraft.note)}</blockquote>
            <textarea
              autoFocus
              rows={5}
              value={thoughtDraft.value}
              placeholder="写点什么…"
              onChange={(event) =>
                setThoughtDraft({
                  note: thoughtDraft.note,
                  value: event.target.value,
                })
              }
            />
            <button
              type="button"
              className="primary-button"
              onClick={async () => {
                const saved = await onUpdateNote({
                  ...thoughtDraft.note,
                  thought: thoughtDraft.value.trim() || undefined,
                });
                if (saved) setThoughtDraft(null);
              }}
            >
              保存想法
            </button>
          </div>
        </Modal>
      ) : null}

      {showChapters ? (
        <Modal
          title="目录"
          onClose={() => setShowChapters(false)}
          className="modal-sheet--toc"
        >
          <div className="toc">
            <div className="toc__head">
              <div className="toc__cover">
                <BookCover book={book} size="small" />
              </div>
              <div className="toc__meta">
                <strong>{displayTitle(book.title)}</strong>
                <span className="toc__pos">
                  页码
                  <b>{`第 ${currentPage} 页，共 ${pagination.total} 页`}</b>
                  <ChevronDown size={16} />
                </span>
              </div>
              <button
                type="button"
                className="toc__close"
                aria-label="关闭目录"
                onClick={() => setShowChapters(false)}
              >
                <X size={22} />
              </button>
            </div>
            <div className="toc__list" ref={tocListRef}>
              {tocList.map((index) => {
                const active = index === tocIndexFor(tocList, chapterIndex);
                return (
                  <button
                    type="button"
                    key={book.chapters[index].id}
                    className={`toc__item ${active ? "is-active" : ""}`}
                    onClick={() => {
                      changeChapter(index);
                      setShowChapters(false);
                    }}
                  >
                    <span className="toc__title">{chapterLabel(book.chapters, index)}</span>
                    <span className="toc__page">
                      {pagination.chapterStart[index]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </Modal>
      ) : null}

      {showSettings ? (
        <Modal
          title="主题与设置"
          onClose={() => setShowSettings(false)}
          className="modal-sheet--reader"
        >
          <div className="reader-settings">
            <div className="rset-themes">
              {READER_THEMES.map((opt) => (
                <button
                  type="button"
                  key={opt.value}
                  className={`rset-theme rset-theme--${opt.value} ${
                    settings.theme === opt.value ? "is-active" : ""
                  }`}
                  aria-label={opt.label}
                  onClick={() =>
                    applySettings({ ...settings, theme: opt.value })
                  }
                >
                  <span
                    className="rset-theme__glyph"
                    style={{
                      background: READER_THEME_SWATCH[opt.value].bg,
                      color: READER_THEME_SWATCH[opt.value].ink,
                    }}
                  >
                    Aa
                  </span>
                  <span className="rset-theme__label">{opt.label}</span>
                </button>
              ))}
            </div>

            <FontPicker
              value={settings.fontFamily}
              onChange={(fontFamily) =>
                applySettings({ ...settings, fontFamily })
              }
            />

            <div className="rset-row">
              <span className="rset-row__label">字号</span>
              <div className="rset-stepper">
                <button
                  type="button"
                  aria-label="减小字号"
                  disabled={settings.fontSize <= 15}
                  onClick={() =>
                    applySettings({
                      ...settings,
                      fontSize: Math.max(15, settings.fontSize - 1),
                    })
                  }
                >
                  <span className="rset-a rset-a--sm">A</span>
                </button>
                <button
                  type="button"
                  aria-label="增大字号"
                  disabled={settings.fontSize >= 28}
                  onClick={() =>
                    applySettings({
                      ...settings,
                      fontSize: Math.min(28, settings.fontSize + 1),
                    })
                  }
                >
                  <span className="rset-a rset-a--lg">A</span>
                </button>
              </div>
            </div>

            <label className="rset-row">
              <span className="rset-row__label">行距</span>
              <SoftRange
                className="rset-slider"
                min={1.4}
                max={2.4}
                step={0.1}
                value={settings.lineHeight}
                onValue={(lineHeight) => applySettings({ ...settings, lineHeight })}
              />
            </label>

            <div className="compact-toggle rset-layout">
              {(["scroll", "page"] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  className={settings.readingMode === mode ? "is-active" : ""}
                  onClick={() =>
                    applySettings({ ...settings, readingMode: mode })
                  }
                >
                  {mode === "scroll" ? "上下滑动" : "左右翻页"}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

interface PlayerControls {
  voices: PlayerVoice[];
  isPlaying: boolean;
  isPaused: boolean;
  isBuffering: boolean;
  location: {
    bookId: string;
    chapterIndex: number;
    sentenceIndex: number;
    sentenceId: string;
  } | null;
  currentSentenceId: string;
  error: string;
  sleepMode: SleepMode;
  activeVoiceURI: string;
  pendingVoiceURI: string;
  voiceError: string;
  start: (bookId: string, position?: BookPosition) => void;
  toggle: () => void;
  stop: () => void;
  skipSentences: (delta: number) => void;
  changeChapter: (delta: number) => void;
  setSleepMode: (mode: SleepMode) => void;
  retryVoiceSwitch: () => void;
  prefetchVoices: (voiceURIs: string[]) => void;
  cancelVoicePrefetch: () => void;
  prefetchStart: (book: Book, position: BookPosition) => void;
  recentVoiceURIs: string[];
}

function PlayerScreen({
  book,
  settings,
  player,
  onBack,
  onOpenReader,
  onAddNote,
  onSettingsChange,
}: {
  book: Book;
  settings: ReaderSettings;
  player: PlayerControls;
  onBack: () => void;
  onOpenReader: (position: BookPosition) => void;
  onAddNote: (position: BookPosition, excerpt: string) => void;
  onSettingsChange: (settings: ReaderSettings) => void;
}) {
  const [showChapters, setShowChapters] = useState(false);
  const chapterListRef = useRevealActiveChapter(showChapters);
  const [showSleep, setShowSleep] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [viewMode, setViewMode] = useState<"cover" | "text">("cover");
  /**
   * 拖进度条时先只挪圆点、预览拖到了哪一章哪一句，松手才真的跳过去——
   * 拖的一路上每动一下就重新开播，云端合成会被来回掐断。
   * ref 是同一个值的同步副本：松手时 pointerup 和 touchend 可能前后脚都到，只认第一次。
   */
  const [seeking, setSeeking] = useState<number | null>(null);
  const seekRef = useRef<number | null>(null);

  const activeForBook = player.location?.bookId === book.id;
  const basePosition =
    activeForBook && player.location
      ? positionFor(
          book,
          player.location.chapterIndex,
          player.location.sentenceIndex
        )
      : book.listeningPosition ?? initialPosition(book);
  // 拖动时整块信息（章名、这一句、时长）都跟着预览拖到的位置。
  const shown = seeking === null ? basePosition : positionAtPercent(book, seeking);
  const chapter = book.chapters[shown.chapterIndex];
  const tocList = useMemo(() => tocIndexes(book.chapters), [book.chapters]);
  const tocActive = tocIndexFor(tocList, basePosition.chapterIndex);
  const sentences = chapter ? flattenChapter(chapter) : [];
  const sentence = sentences[shown.sentenceIndex] ?? sentences[0];
  const playing = activeForBook && player.isPlaying;
  const remaining = remainingCharacters(book, shown);
  const elapsed = Math.max(0, book.characterCount - remaining);
  const seekValue = seeking ?? shown.percent;

  const toggle = () => {
    if (activeForBook && (player.isPlaying || player.isPaused)) player.toggle();
    else player.start(book.id, basePosition);
  };

  const commitSeek = () => {
    const value = seekRef.current;
    seekRef.current = null;
    setSeeking(null);
    // 跟点目录换章一样：跳过去就从那里开始听。
    if (value !== null) player.start(book.id, positionAtPercent(book, value));
  };

  // 进到这一页多半就是要听。趁用户还在看封面、调速度的这几秒把首段备上，
  // 点下去就能同步命中缓存、立刻出声，而不是干等一轮云端合成。
  // 只认书和章句：播放中 basePosition 每句都在变，那时也不需要再备。
  const prefetchStart = player.prefetchStart;
  const prefetchChapter = basePosition.chapterIndex;
  const prefetchSentence = basePosition.sentenceIndex;
  useEffect(() => {
    if (playing) return;
    prefetchStart(book, positionFor(book, prefetchChapter, prefetchSentence));
  }, [book, prefetchChapter, prefetchSentence, playing, prefetchStart]);

  /**
   * 打开音色面板就顺手把几个候选的短首段备上：用户开面板多半就是要换，
   * 备好之后点下去能命中缓存、同步起播，这才是 1 秒内出声的来源。
   * 最近用过的排前面，剩下的按云端音色本身的顺序补齐。
   */
  const openVoicePanel = () => {
    setShowVoice(true);
    if (!activeForBook) return;
    const candidates = [
      ...player.recentVoiceURIs,
      ...EDGE_VOICES.map((voice) => voice.voiceURI),
    ].filter((voiceURI) => voiceURI !== player.activeVoiceURI);
    player.prefetchVoices(candidates);
  };

  const closeVoicePanel = () => {
    setShowVoice(false);
    // 面板一关，没人要的准备任务就该停，别再占着上游连接。
    player.cancelVoicePrefetch();
  };

  const toggleView = () =>
    setViewMode((mode) => (mode === "cover" ? "text" : "cover"));

  const sleepLabel =
    player.sleepMode === "off"
      ? "定时"
      : player.sleepMode === "chapter"
        ? "本章结束"
        : `${player.sleepMode} 分钟`;

  return (
    <div className="player-screen">
      <header className="player-header">
        <button
          type="button"
          className="icon-button"
          aria-label="返回"
          onClick={onBack}
        >
          <ChevronLeft size={26} />
        </button>
        <span>正在听</span>
        <button
          type="button"
          className="icon-button"
          aria-label="更多"
          onClick={() => setShowMore(true)}
        >
          <MoreHorizontal size={22} />
        </button>
      </header>

      <main className="player-main">
        {/* 封面和文稿共用这一块，点一下来回切。 */}
        <div
          className="player-stage"
          role="button"
          tabIndex={0}
          aria-label={viewMode === "cover" ? "显示文稿" : "显示封面"}
          onClick={toggleView}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleView();
            }
          }}
        >
          {viewMode === "cover" ? (
            <BookCover book={book} size="large" />
          ) : (
            <div className="player-transcript-inline">
              {sentences
                .slice(
                  Math.max(0, shown.sentenceIndex - 1),
                  shown.sentenceIndex + 2
                )
                .map((item) => (
                  <p
                    key={item.id}
                    className={item.id === sentence?.id ? "is-current" : ""}
                  >
                    {item.text}
                  </p>
                ))}
            </div>
          )}
        </div>

        <div className="player-title">
          <h1>{displayTitle(book.title)}</h1>
          <p>{book.author}</p>
          <strong>
            {chapter ? chapterLabel(book.chapters, shown.chapterIndex) : "正文"}
          </strong>
        </div>

        <p className="player-line" data-hidden={viewMode === "text" || undefined}>
          {sentence?.text ?? ""}
        </p>

        <div className="player-seek">
          <SoftRange
            min={0}
            max={100}
            step={0.1}
            aria-label="播放进度"
            value={seekValue}
            onValue={(value) => {
              seekRef.current = value;
              setSeeking(value);
            }}
            onPointerUp={commitSeek}
            onTouchEnd={commitSeek}
            onKeyUp={commitSeek}
            onBlur={() => {
              // 拖到一半失焦（比如来电）就当没拖过，别在用户没松手时替他跳。
              seekRef.current = null;
              setSeeking(null);
            }}
          />
          <div>
            <span>已听{formatReadingTime(elapsed)}</span>
            <span>剩余{formatReadingTime(remaining)}</span>
          </div>
        </div>

        <div className="player-controls">
          <button
            type="button"
            className="skip-control"
            aria-label="后退约15秒"
            onClick={() =>
              activeForBook
                ? player.skipSentences(-2)
                : player.start(book.id, basePosition)
            }
          >
            <span>15</span>
          </button>
          <button
            type="button"
            className="player-primary-control"
            aria-label={player.isBuffering && activeForBook ? "正在准备音频" : playing ? "暂停" : "播放"}
            onClick={toggle}
          >
            {player.isBuffering && activeForBook ? (
              <LoaderCircle className="player-buffering-icon" size={30} />
            ) : playing ? (
              <Pause size={32} fill="currentColor" />
            ) : (
              <Play size={32} fill="currentColor" style={{ marginLeft: 4 }} />
            )}
          </button>
          <button
            type="button"
            className="skip-control skip-control--forward"
            aria-label="前进约15秒"
            onClick={() =>
              activeForBook
                ? player.skipSentences(2)
                : player.start(book.id, basePosition)
            }
          >
            <span>15</span>
          </button>
        </div>

        {player.isBuffering && activeForBook ? (
          <p className="player-preparing">正在准备音频，很快就会开始…</p>
        ) : player.error && activeForBook ? (
          <p className="player-error">{player.error}</p>
        ) : null}

        <div className="player-tools">
          <button type="button" onClick={() => setShowChapters(true)}>
            <List size={22} />
            <small>目录</small>
          </button>
          <button type="button" aria-label="朗读速度" onClick={openVoicePanel}>
            <span className="player-tools__speed">
              {settings.speechRate.toFixed(1)}×
            </span>
            <small>倍速</small>
          </button>
          <button
            type="button"
            className={player.sleepMode === "off" ? "" : "is-on"}
            onClick={() => setShowSleep(true)}
          >
            <Timer size={22} />
            <small>{sleepLabel}</small>
          </button>
          <button type="button" onClick={openVoicePanel}>
            <AudioLines size={22} />
            <small>{player.pendingVoiceURI && activeForBook ? "切换中" : "音色"}</small>
          </button>
        </div>
      </main>

      {showMore ? (
        <Modal title="更多" onClose={() => setShowMore(false)}>
          <div className="book-actions">
            <button
              type="button"
              className="book-action"
              onClick={() => {
                setShowMore(false);
                onOpenReader(basePosition);
              }}
            >
              <BookOpen size={19} />
              <span>查看原文</span>
            </button>
            <button
              type="button"
              className="book-action"
              onClick={() => {
                setShowMore(false);
                onAddNote(basePosition, sentence?.text ?? "听书标记");
              }}
            >
              <Bookmark size={19} />
              <span>标记这一句</span>
            </button>
            {activeForBook ? (
              <button
                type="button"
                className="book-action book-action--danger"
                onClick={() => {
                  setShowMore(false);
                  player.stop();
                }}
              >
                <Square size={17} />
                <span>停止播放</span>
              </button>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {showChapters ? (
        <Modal title="目录" onClose={() => setShowChapters(false)}>
          <div className="chapter-list" ref={chapterListRef}>
            {tocList.map((index, number) => (
              <button
                type="button"
                key={book.chapters[index].id}
                className={index === tocActive ? "is-active" : ""}
                onClick={() => {
                  player.start(book.id, positionFor(book, index, 0));
                  setShowChapters(false);
                }}
              >
                <span>{String(number + 1).padStart(2, "0")}</span>
                <strong>{chapterLabel(book.chapters, index)}</strong>
                {index === tocActive ? <Volume2 size={17} /> : null}
              </button>
            ))}
          </div>
        </Modal>
      ) : null}

      {showSleep ? (
        <Modal title="定时关闭" onClose={() => setShowSleep(false)}>
          <div className="option-list">
            {(
              [
                ["off", "不开启"],
                ["15", "15 分钟后"],
                ["30", "30 分钟后"],
                ["45", "45 分钟后"],
                ["chapter", "本章结束后"],
              ] as Array<[SleepMode, string]>
            ).map(([mode, label]) => (
              <button
                type="button"
                key={mode}
                className={player.sleepMode === mode ? "is-active" : ""}
                onClick={() => {
                  player.setSleepMode(mode);
                  setShowSleep(false);
                }}
              >
                <span>{label}</span>
                {player.sleepMode === mode ? <Check size={18} /> : null}
              </button>
            ))}
          </div>
        </Modal>
      ) : null}

      {showVoice ? (
        <Modal title="倍速与声音" onClose={closeVoicePanel}>
          <div className="voice-settings">
            <label>
              <span>
                <strong>朗读速度</strong>
                <em>{settings.speechRate.toFixed(1)}×</em>
              </span>
              <SoftRange
                min={0.6}
                max={2}
                step={0.1}
                value={settings.speechRate}
                onValue={(speechRate) => onSettingsChange({ ...settings, speechRate })}
              />
            </label>

            {player.voiceError && activeForBook ? (
              <div className="voice-retry" role="status">
                <span>{player.voiceError}</span>
                <button type="button" onClick={player.retryVoiceSwitch}>
                  重试
                </button>
              </div>
            ) : null}

            <div className="voice-list">
              {player.voices.map((voice) => {
                // 没选过（空串）就是默认音色，折算之后再比，默认那一个才会打勾。
                const chosen = resolvedEdgeVoiceURI(settings.voiceURI) === voice.voiceURI;
                // 「选中」是用户的意愿，「正在播放」是事实。云端失败退回系统朗读时
                // 这两者会不一致，必须分开显示，不能拿勾当成已经在用这个声音。
                const playing =
                  activeForBook && player.activeVoiceURI === voice.voiceURI;
                const preparing =
                  activeForBook && player.pendingVoiceURI === voice.voiceURI;
                return (
                  <button
                    type="button"
                    key={voice.voiceURI}
                    className={`${chosen ? "is-active" : ""} ${
                      preparing ? "is-preparing" : ""
                    }`}
                    aria-busy={preparing}
                    onClick={() =>
                      onSettingsChange({
                        ...settings,
                        voiceURI: voice.voiceURI,
                      })
                    }
                  >
                    <span>
                      <strong>{voice.name}</strong>
                      <small>{voice.lang}</small>
                    </span>
                    {preparing ? (
                      <em className="voice-state">
                        <LoaderCircle className="player-buffering-icon" size={14} />
                        切换中
                      </em>
                    ) : playing ? (
                      <em className="voice-state is-playing">正在播放</em>
                    ) : chosen ? (
                      <Check size={18} />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function MiniPlayer({
  book,
  chapterTitle,
  line,
  isPlaying,
  isBuffering,
  onToggle,
  onOpen,
  onStop,
}: {
  book: BookMeta;
  chapterTitle: string;
  /** 正在读的那一句。正文还没读进来时是空串，这一行就先写章名。 */
  line: string;
  isPlaying: boolean;
  isBuffering: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onStop: () => void;
}) {
  return (
    <div className="mini-player">
      <button type="button" className="mini-player__main" onClick={onOpen}>
        <BookCover book={book} size="small" />
        <span>
          <strong>
            {displayTitle(book.title)}
            {line ? ` · ${chapterTitle}` : ""}
          </strong>
          <small>{line || chapterTitle}</small>
        </span>
      </button>
      <button
        type="button"
        className="icon-button mini-player__toggle"
        aria-label={isBuffering ? "正在准备音频" : isPlaying ? "暂停" : "继续"}
        onClick={onToggle}
      >
        {isBuffering ? (
          <LoaderCircle className="player-buffering-icon" size={20} />
        ) : isPlaying ? (
          <Pause size={20} fill="currentColor" />
        ) : (
          <Play size={20} fill="currentColor" />
        )}
      </button>
      <button
        type="button"
        className="icon-button mini-player__stop"
        aria-label="关闭播放器"
        onClick={onStop}
      >
        <X size={18} />
      </button>
    </div>
  );
}

export default function MotingApp() {
  useKeyboardInset();
  // 书库里只有书目；正文在 contentRef 里，打开哪本读哪本。
  const [books, setBooks] = useState<BookMeta[]>([]);
  const [notes, setNotes] = useState<BookNote[]>([]);
  const [chats, setChats] = useState<BookAiChat[]>([]);
  const chatsRef = useRef(chats);
  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);
  // 线上补全的书籍资料。不并进 books，这样「还原」永远能拿回导入时的原始值。
  const [bookMetadata, setBookMetadata] = useState<BookMetadataPatch[]>([]);
  const [metadataBook, setMetadataBook] = useState<BookMeta | null>(null);
  // 从「笔记」Tab 的历史入口点开的书，跟 view 无关，纯弹层状态。
  const [chatBook, setChatBook] = useState<BookMeta | null>(null);
  const [settings, setSettings] =
    useState<ReaderSettings>(DEFAULT_SETTINGS);
  const pendingSyncedSettingsRef = useRef<ReaderSettings | null>(null);
  const [stats, setStats] = useState<ReadingStats>(DEFAULT_STATS);
  const [sessions, setSessions] = useState<ReadingSession[]>([]);
  // 导航接在 History API 上：返回回到来处、刷新/被系统回收后还在原地、
  // 系统返回手势也能用。切板块是平级移动，下钻才进历史栈。
  const { view, backgroundView, navigate, selectTab, replace: replaceView, goBack } =
    useAppNavigation();
  useViewportFill(view.name);
  const [ready, setReady] = useState(false);
  // 老用户第一次打开新版时，本地库要把正文从书目里搬出去，这一次会多等几秒。
  const [upgrading, setUpgrading] = useState(false);
  const [importProgress, setImportProgress] =
    useState<ImportProgress | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<BookMeta | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [thoughtTarget, setThoughtTarget] = useState<BookNote | null>(null);
  const [thoughtDraft, setThoughtDraft] = useState("");
  const [toast, setToast] = useState<{
    id: number;
    message: string;
    undo?: () => void;
    /** 正在退场。提示条要滑下去再消失，不能一到时间就凭空没了。 */
    leaving?: boolean;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number | null>(null);
  const toastIdRef = useRef(0);
  const storageErrorRef = useRef(0);

  /** 让提示条走完退场动画再卸掉。 */
  const hideToast = useCallback(() => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast((current) => (current ? { ...current, leaving: true } : null));
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, TOAST_EXIT_MS);
  }, []);

  const dismissToast = hideToast;

  const presentToast = useCallback(
    (message: string, undo: (() => void) | undefined, duration: number) => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      toastIdRef.current += 1;
      setToast({ id: toastIdRef.current, message, undo });
      toastTimerRef.current = window.setTimeout(hideToast, duration);
    },
    [hideToast]
  );

  const showToast = useCallback(
    (message: string) => presentToast(message, undefined, 2600),
    [presentToast]
  );

  /**
   * 删除这类操作不拦在前面问「确定吗」，改成先执行、再给一段撤销时间。
   * 常用操作快了一步，真误删也救得回来；确认框只留给删整本书那种不可逆的。
   */
  const showUndoToast = useCallback(
    (message: string, undo: () => void) => presentToast(message, undo, 5200),
    [presentToast]
  );

  const reportStorageError = useCallback(
    (operation: string, error: unknown) => {
      console.error(`[storage:${operation}]`, error);
      const now = Date.now();
      if (now - storageErrorRef.current < 4000) return;
      storageErrorRef.current = now;
      showToast("本地保存失败，请检查浏览器存储空间");
    },
    [showToast]
  );

  // ----------------------------------------------------------------------
  // 正文按需读。书库、主页、同步只碰书目；阅读器、播放器、单书笔记要整本书时，
  // 先把那一本的正文读进来再进页面，画面一次到位，不先出一个空页面再填字。
  // contents 给渲染用；contentRef 是同一份的同步镜像，给播放器这类在事件里取书的地方用
  // （state 要等下一次渲染才更新，刚读进来就要开播时等不起）。
  const [contents, setContents] = useState<ReadonlyMap<string, Chapter[]>>(() => new Map());
  const contentRef = useRef<ReadonlyMap<string, Chapter[]>>(contents);
  const commitContents = useCallback((next: Map<string, Chapter[]>) => {
    contentRef.current = next;
    setContents(next);
  }, []);
  const booksRef = useRef(books);
  useEffect(() => {
    booksRef.current = books;
  }, [books]);
  /** 正在听的那本、当前页面上的那本：内存再紧也不能把它们的正文挤掉，否则听书到下一段就断了。 */
  const pinnedContentRef = useRef(new Set<string>());

  const loadContent = useCallback(
    async (bookId: string): Promise<Chapter[] | null> => {
      const cached = contentRef.current.get(bookId);
      if (cached) return cached;
      const chapters = await getBookContent(bookId).catch(() => undefined);
      if (!chapters?.length) return null;
      const next = new Map(contentRef.current);
      next.set(bookId, chapters);
      // 最多留几本在内存里：长篇一本就是几十 MB 的对象。先进先出，正在用的那本刚刚才放进来。
      for (const id of next.keys()) {
        if (next.size <= CONTENT_CACHE_BOOKS) break;
        if (id !== bookId && !pinnedContentRef.current.has(id)) next.delete(id);
      }
      commitContents(next);
      return chapters;
    },
    [commitContents]
  );

  const dropContent = useCallback(
    (keep: (bookId: string) => boolean) => {
      const next = new Map([...contentRef.current].filter(([id]) => keep(id)));
      if (next.size !== contentRef.current.size) commitContents(next);
    },
    [commitContents]
  );

  /** 书目 + 已读进来的正文，拼成整本书。正文没读进来就是 undefined。 */
  const getFullBook = useCallback((bookId: string): Book | undefined => {
    const meta = booksRef.current.find((book) => book.id === bookId);
    const chapters = contentRef.current.get(bookId);
    return meta && chapters ? { ...meta, chapters } : undefined;
  }, []);

  // ----------------------------------------------------------------------
  // 云端同步:登录后自动跑,不登录时应用行为与原来完全一致。
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [syncConnected, setSyncConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncError, setSyncError] = useState("");
  const [lastSyncAt, setLastSyncAt] = useState(0);
  const syncControllerRef = useRef<AbortController | null>(null);
  const syncSettledRef = useRef<Promise<void> | null>(null);
  const settleSyncRef = useRef<(() => void) | null>(null);
  const syncReloadTimerRef = useRef<number | null>(null);
  /** 这一轮同步真正写进本地的数据类别；只重读这几类。 */
  const syncChangedRef = useRef(new Set<SyncAppliedKind>());
  // 同步把云端数据刷回本地时置位,让下面的「写操作后 30s debounce」跳过这一轮,
  // 免得「同步→重读→又排一个同步」空转。
  const syncQuietRef = useRef(false);

  /**
   * 同步把云端记录写进本地后,只重读变了的那几类。
   * 以前不管变了什么都把七张表整个重读、整个替换，每轮同步界面都要重来一遍。
   */
  const reloadFromStorage = useCallback(async (kinds: Set<SyncAppliedKind>) => {
    try {
      const has = (...names: SyncAppliedKind[]) => names.some((name) => kinds.has(name));
      const [storedBooks, storedNotes, storedChats, storedSettings, storedStats, storedSessions, storedMetadata] =
        await Promise.all([
          has("books", "positions", "patches") ? getAllBooks() : null,
          has("notes") ? getAllNotes() : null,
          has("chats") ? getAllChats() : null,
          has("settings") ? getSettings() : null,
          has("sessions") ? getStats() : null,
          has("sessions") ? getAllSessions() : null,
          has("patches") ? getAllBookMetadata() : null,
        ]);
      syncQuietRef.current = true;
      if (storedBooks) {
        setBooks((current) => {
          const incoming = new Map(storedBooks.map((book) => [book.id, book]));
          const retained = current.flatMap((book) => {
            const updated = incoming.get(book.id);
            incoming.delete(book.id);
            return updated ? [updated] : [];
          });
          return [...retained, ...incoming.values()];
        });
        // 远端删掉的书，内存里那份正文也别留着。
        const alive = new Set(storedBooks.map((book) => book.id));
        dropContent((id) => alive.has(id));
      }
      if (storedNotes) setNotes(storedNotes);
      if (storedChats) {
        chatsRef.current = storedChats;
        setChats(storedChats);
      }
      if (storedSettings) {
        if (view.name === "reader") pendingSyncedSettingsRef.current = storedSettings;
        else setSettings(storedSettings);
      }
      if (storedStats) setStats(storedStats);
      if (storedSessions) setSessions(storedSessions);
      if (storedMetadata) setBookMetadata(storedMetadata);
    } catch {
      // 重读失败不打断应用;下一轮同步或刷新还能拉回。
    }
  }, [dropContent, view.name]);

  useEffect(() => {
    if (view.name === "reader") return;
    const pending = pendingSyncedSettingsRef.current;
    if (!pending) return;
    pendingSyncedSettingsRef.current = null;
    setSettings(pending);
  }, [view.name]);

  const scheduleSyncReload = useCallback(
    (kind: SyncAppliedKind) => {
      syncChangedRef.current.add(kind);
      if (syncReloadTimerRef.current !== null) return;
      syncReloadTimerRef.current = window.setTimeout(() => {
        syncReloadTimerRef.current = null;
        const kinds = syncChangedRef.current;
        syncChangedRef.current = new Set();
        void reloadFromStorage(kinds);
      }, 400);
    },
    [reloadFromStorage]
  );

  const triggerSync = useCallback(
    async (manual = false) => {
      if (syncControllerRef.current) {
        if (manual) showToast("正在同步中…");
        return;
      }
      const controller = new AbortController();
      syncControllerRef.current = controller;
      syncSettledRef.current = new Promise<void>((resolve) => {
        settleSyncRef.current = resolve;
      });
      setSyncing(true);
      setSyncMessage("");
      setSyncError("");
      try {
        const run = () => runSync({
          signal: controller.signal,
          onProgress: setSyncMessage,
          onApplied: scheduleSyncReload,
        });
        const result =
          typeof navigator !== "undefined" && navigator.locks
            ? await navigator.locks.request(
                "moting-reader-sync",
                { mode: "exclusive", signal: controller.signal },
                run
              )
            : await run();
        setLastSyncAt(result.syncedAt);
        if (result.failedContent.length) {
          showToast(`${result.failedContent.length} 本书超出云端大小上限,未能同步`);
        } else if (result.skipped) {
          showToast(`${result.skipped} 条记录超出云端上限或数据异常,未能同步`);
        } else if (manual) {
          showToast(result.changed ? "同步完成" : "云端没有新变更");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof SyncError && error.status === 401) {
            setSyncConnected(false);
            setSyncError("同步登录已过期,请重新登录");
          } else {
            setSyncError(error instanceof Error ? error.message : "同步失败,请稍后重试");
          }
        }
      } finally {
        if (syncControllerRef.current === controller) syncControllerRef.current = null;
        const settle = settleSyncRef.current;
        settle?.();
        settleSyncRef.current = null;
        syncSettledRef.current = null;
        setSyncing(false);
      }
    },
    [scheduleSyncReload, showToast]
  );

  const handleSyncLogin = useCallback(
    async (username: string, password: string) => {
      setSyncError("");
      const controller = new AbortController();
      try {
        await loginSync(username, password, controller.signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : "登录失败,请重试";
        setSyncError(message);
        throw new Error(message);
      }
      setSyncConnected(true);
      void triggerSync(true);
    },
    [triggerSync]
  );

  const handleSyncLogout = useCallback(async () => {
    syncControllerRef.current?.abort();
    syncControllerRef.current = null;
    setSyncing(false);
    setSyncMessage("");
    const controller = new AbortController();
    await logoutSync(controller.signal).catch(() => undefined);
    setSyncConnected(false);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    },
    []
  );

  // 升级旧库的提示要在第一次读库之前就订阅上。
  useEffect(() => onStorageUpgrade(setUpgrading), []);

  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getAllBooks(),
      getAllNotes(),
      getAllChats(),
      getSettings(),
      getStats(),
      getAllSessions(),
      getAllBookMetadata(),
    ])
      .then(async ([
        storedBooks,
        storedNotes,
        storedChats,
        storedSettings,
        storedStats,
        storedSessions,
        storedMetadata,
      ]) => {
        if (cancelled) return;
        let metas = storedBooks;
        if (!metas.length) {
          const demo = createDemoBook();
          await saveBook(demo);
          metas = [metaOf(demo)];
        }
        booksRef.current = metas;
        // 冷启动落在阅读器、播放器或单书笔记时，先把那本书的正文读进来：
        // 第一帧就是整页，而不是先出一个空页面再把字填进去。
        const restored = viewRef.current;
        if (viewNeedsContent(restored)) await loadContent(restored.bookId);
        if (cancelled) return;
        setBooks(metas);
        setNotes(storedNotes);
        chatsRef.current = storedChats;
        setChats(storedChats);
        setSettings(storedSettings);
        setStats(storedStats);
        setSessions(storedSessions);
        setBookMetadata(storedMetadata);
      })
      .catch(() => {
        const demo = createDemoBook();
        commitContents(new Map([[demo.id, demo.chapters]]));
        booksRef.current = [metaOf(demo)];
        setBooks([metaOf(demo)]);
        setImportError("本地存储暂时不可用，当前内容只在本次打开期间保留");
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    // 开发时不注册：离线外壳按缓存优先取同源资源，而 dev 下的 URL 不带哈希，
    // 改完样式和脚本会一直读到旧版本。早期 dev 注册过的 SW 还要主动注销并清缓存，
    // 否则它会把旧模块一直供下去，刷新也没用。
    if ("serviceWorker" in navigator) {
      if (import.meta.env.DEV) {
        navigator.serviceWorker
          .getRegistrations()
          .then((registrations) =>
            registrations.forEach((registration) => registration.unregister())
          )
          .catch(() => undefined);
        if ("caches" in window) {
          window.caches
            .keys()
            .then((keys) => keys.forEach((key) => window.caches.delete(key)))
            .catch(() => undefined);
        }
      } else {
        navigator.serviceWorker.register("/sw.js").catch(() => undefined);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [commitContents, loadContent]);

  // AI 回答的排版不在首屏，开机闲下来先把代码取回来，第一次看 AI 回答就不会先闪「正在排版…」。
  // 取失败无所谓，真用到时还会再取。
  useEffect(() => {
    if (!ready) return;
    const prefetch = () => {
      void import("./ai-markdown")
        .then((module) => {
          aiMarkdownModule = module;
        })
        .catch(() => undefined);
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: Window["requestIdleCallback"];
      cancelIdleCallback?: Window["cancelIdleCallback"];
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      const id = idleWindow.requestIdleCallback(prefetch, { timeout: 4000 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(prefetch, 1500);
    return () => window.clearTimeout(timer);
  }, [ready]);

  // 启动时读同步会话;已登录的设备开机就同步一轮。
  useEffect(() => {
    const controller = new AbortController();
    getSyncState()
      .then((state) => {
        if (!controller.signal.aborted) setLastSyncAt(state.pushedAt);
      })
      .catch(() => undefined);
    getSyncSession(controller.signal)
      .then(({ connected, enabled }) => {
        if (controller.signal.aborted) return;
        setSyncEnabled(enabled);
        setSyncConnected(connected);
        if (connected) void triggerSync();
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [triggerSync]);

  // 登录后每 5 分钟同步一轮;切到后台时补一次,手机息屏前也能把进度推上去。
  useEffect(() => {
    if (!syncConnected) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void triggerSync();
    }, 5 * 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void triggerSync();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [syncConnected, triggerSync]);

  // 写操作后 30s debounce 同步:读书进度、划线、改设置等让数据变化时,
  // 推迟到「安静」满 30 秒再同步——读到哪里都实时写本地,但不会每翻一页都打云端。
  // 一次真正的写最多换来一轮空同步,空同步不再改这些 state,链路自然停下。
  useEffect(() => {
    if (!syncConnected) return;
    if (syncQuietRef.current) {
      syncQuietRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => void triggerSync(), 30_000);
    return () => window.clearTimeout(timer);
  }, [books, notes, chats, settings, sessions, syncConnected, triggerSync]);

  // 配色只在读到真实设置之后才动。之前挂载那一刻就按默认设置把书架刷成「霜白」，
  // 设置读出来再翻成用户的颜色——每次打开都闪一次。首帧的颜色由 layout 里的
  // 开机脚本按上次记下的配色提前套好，这里记下这次的，供下次开机用。
  useEffect(() => {
    if (!ready) return;
    const root = document.documentElement;
    root.dataset.readerTheme = settings.theme;
    root.dataset.shell = settings.shellTheme;
    rememberTheme(settings.shellTheme, settings.theme);
  }, [ready, settings.theme, settings.shellTheme]);

  /** 改书目里的几个字段：内存立刻改，库里只写这几个字段（见 updateBookMeta）。 */
  const patchBookMeta = useCallback(
    (bookId: string, changes: Partial<Omit<BookMeta, "id">>) => {
      setBooks((current) =>
        current
          .map((book) => (book.id === bookId ? { ...book, ...changes } : book))
      );
      void updateBookMeta(bookId, changes).catch((error) => reportStorageError("book", error));
    },
    [reportStorageError]
  );

  // 听书每读一句就回调一次。内存里立刻更新（高亮要跟上），
  // 落盘攒到 20 秒一次、只写书目里的听书位置，停止/切后台时补写。
  const pendingListeningRef = useRef(new Map<string, BookPosition>());
  const flushTimerRef = useRef<number | null>(null);

  const pendingReadingProgressRef = useRef(
    new Map<
      string,
      { position: BookPosition; lastOpenedAt: number; savedAt: number }
    >()
  );
  const readingUiProgressRef = useRef(new Map<string, number>());
  /** 书架进度节流窗口里被压下的最后一次，到点补上。 */
  const readingUiTimerRef = useRef(new Map<string, number>());
  const readingProgressTimerRef = useRef<number | null>(null);
  const flushReadingProgress = useCallback(async () => {
    if (readingProgressTimerRef.current !== null) {
      window.clearTimeout(readingProgressTimerRef.current);
      readingProgressTimerRef.current = null;
    }
    const entries = [...pendingReadingProgressRef.current.entries()].map(
      ([bookId, value]) => ({ bookId, ...value })
    );
    pendingReadingProgressRef.current.clear();
    if (!entries.length) return;
    try {
      await saveReadingPositions(entries);
      const byBookId = new Map(entries.map((entry) => [entry.bookId, entry]));
      setBooks((current) =>
        current
          .map((book) => {
            const entry = byBookId.get(book.id);
            return entry
              ? {
                  ...book,
                  readingPosition: entry.position,
                  lastOpenedAt: Math.max(book.lastOpenedAt, entry.lastOpenedAt),
                  updatedAt: entry.savedAt,
                }
              : book;
          })
      );
    } catch (error) {
      for (const entry of entries) {
        const current = pendingReadingProgressRef.current.get(entry.bookId);
        if (!current || current.savedAt < entry.savedAt) {
          pendingReadingProgressRef.current.set(entry.bookId, entry);
        }
      }
      reportStorageError("reading-position", error);
    }
  }, [reportStorageError]);

  const scheduleReadingProgressFlush = useCallback(() => {
    if (readingProgressTimerRef.current !== null) return;
    readingProgressTimerRef.current = window.setTimeout(() => {
      readingProgressTimerRef.current = null;
      void flushReadingProgress();
    }, 2500);
  }, [flushReadingProgress]);

  // 正在读书/听书时，后台的资料补全这类要在主线程解码图片的活儿一律不跑。
  const readingBookId =
    view.name === "reader" || view.name === "player" ? view.bookId : "";

  const bookMetadataRef = useRef(bookMetadata);
  useEffect(() => {
    bookMetadataRef.current = bookMetadata;
  }, [bookMetadata]);

  /** 补全结果只落在补丁记录里，内存里的 books 要手动跟上——不能走 updateBook，那会把整本书重写一遍。 */
  const applyPatchToBooks = useCallback((patch: BookMetadataPatch) => {
    setBooks((current) =>
      current.map((book) =>
        book.id === patch.bookId
          ? {
              ...book,
              title: patch.applied?.title ?? patch.original?.title ?? book.title,
              author: patch.applied?.author ?? patch.original?.author ?? book.author,
              coverDataUrl:
                patch.applied?.coverDataUrl ??
                patch.original?.coverDataUrl ??
                book.coverDataUrl,
            }
          : book
      )
    );
  }, []);

  const commitMetadataPatch = useCallback(
    async (patch: BookMetadataPatch) => {
      await saveBookMetadata(patch).catch((error) => {
        reportStorageError("book-metadata", error);
        throw error;
      });
      setBookMetadata((current) => [
        ...current.filter((item) => item.bookId !== patch.bookId),
        patch,
      ]);
      applyPatchToBooks(patch);
    },
    [applyPatchToBooks, reportStorageError]
  );

  const buildMetadataPatch = useCallback(
    async (book: BookMeta, signal: AbortSignal): Promise<BookMetadataPatch | null> => {
      const base: BookMetadataPatch = {
        bookId: book.id,
        source: BOOK_METADATA_SOURCE,
        query: lookupQuery(book).title,
        fetchedAt: Date.now(),
        candidates: [],
        applied: null,
        original: null,
        appliedBy: null,
      };
      let candidates: BookMetadataCandidate[];
      try {
        candidates = (await lookupBookMetadata(book, signal)).candidates;
      } catch (error) {
        if (signal.aborted) return null;
        // 失败也记一笔：否则每次开机都会把同一批书重查一遍。
        return {
          ...base,
          failedAt: Date.now(),
          failedReason:
            error instanceof BookMetadataError ? error.message : "书籍资料查询失败",
        };
      }
      const decision = decideAutoApply(book, candidates);
      if (!decision) return { ...base, candidates };

      const coverDataUrl =
        decision.wantCover && decision.candidate.coverUrl
          ? await fetchCoverDataUrl(decision.candidate.coverUrl, signal)
          : null;
      if (signal.aborted) return null;

      const applied: AppliedBookMetadata = { volumeId: decision.candidate.volumeId };
      if (decision.title) applied.title = decision.title;
      if (decision.author) applied.author = decision.author;
      if (coverDataUrl) applied.coverDataUrl = coverDataUrl;
      // 查到了候选却一个字段都没真补上，就当没套用，省得界面显示「已套用」但看不出差别。
      if (!applied.title && !applied.author && !applied.coverDataUrl) {
        return { ...base, candidates };
      }
      return {
        ...base,
        candidates,
        applied,
        appliedBy: "auto",
        original: {
          title: book.title,
          author: book.author,
          coverDataUrl: book.coverDataUrl,
        },
      };
    },
    []
  );

  /**
   * 导入时的书名作者经常是脏的：解析不到标题就拿文件名顶上，作者直接写「未知作者」。
   * 开机后在后台按本去 Google Books 查一次，只补明确缺失的字段（规则见 book-metadata.ts）。
   *
   * 跟上面的插图补量守同一条纪律：正在读书/听书、或正在导入时一律不跑——
   * 取封面要在主线程解码再重编码图片，那是实打实会掉帧的活儿。
   */
  const metadataCheckedRef = useRef(new Set<string>());
  const metadataBusyRef = useRef(false);
  useEffect(() => {
    if (!ready || readingBookId || importProgress || metadataBusyRef.current) return;
    let cancelled = false;
    const controller = new AbortController();
    metadataBusyRef.current = true;

    const fillMetadata = async () => {
      try {
        for (const patch of bookMetadataRef.current) {
          metadataCheckedRef.current.add(patch.bookId);
        }
        for (const book of booksRef.current) {
          if (cancelled) return;
          if (metadataCheckedRef.current.has(book.id)) continue;
          metadataCheckedRef.current.add(book.id);
          if (!needsMetadataLookup(book)) continue;
          const patch = await buildMetadataPatch(book, controller.signal);
          if (cancelled || !patch) return;
          await commitMetadataPatch(patch).catch(() => undefined);
        }
      } finally {
        if (!cancelled) metadataBusyRef.current = false;
      }
    };

    let idleId: number | null = null;
    let timeoutId: number | null = null;
    const idleWindow = window as Window & {
      requestIdleCallback?: Window["requestIdleCallback"];
      cancelIdleCallback?: Window["cancelIdleCallback"];
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleId = idleWindow.requestIdleCallback(() => void fillMetadata(), { timeout: 4000 });
    } else {
      timeoutId = window.setTimeout(() => void fillMetadata(), 1200);
    }
    return () => {
      cancelled = true;
      controller.abort();
      if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      metadataBusyRef.current = false;
    };
  }, [
    ready,
    readingBookId,
    importProgress,
    books.length,
    buildMetadataPatch,
    commitMetadataPatch,
  ]);

  const [metadataBusy, setMetadataBusy] = useState(false);

  /** 用户在「书籍资料」里手选的，比后台那条规则宽：他自己认了，书名作者封面一起换。 */
  const chooseMetadataCandidate = useCallback(
    async (book: BookMeta, candidate: BookMetadataCandidate) => {
      const existing = bookMetadataRef.current.find((item) => item.bookId === book.id);
      const original = existing?.original ?? {
        title: book.title,
        author: book.author,
        coverDataUrl: book.coverDataUrl,
      };
      setMetadataBusy(true);
      try {
        const applied: AppliedBookMetadata = { volumeId: candidate.volumeId };
        const title = cleanTitleText(candidate.title);
        if (title) applied.title = title;
        const author = formatAuthors(candidate.authors);
        if (author) applied.author = author;
        if (candidate.coverUrl) {
          const cover = await fetchCoverDataUrl(candidate.coverUrl);
          if (cover) applied.coverDataUrl = cover;
        }
        await commitMetadataPatch({
          bookId: book.id,
          source: BOOK_METADATA_SOURCE,
          query: existing?.query ?? lookupQuery(book).title,
          fetchedAt: existing?.fetchedAt ?? Date.now(),
          candidates: existing?.candidates ?? [candidate],
          applied,
          original,
          appliedBy: "user",
        });
        showToast("已套用线上书籍资料");
      } catch {
        // commitMetadataPatch 已经弹过存储失败的提示，这里不再重复。
      } finally {
        setMetadataBusy(false);
      }
    },
    [commitMetadataPatch, showToast]
  );

  const revertMetadata = useCallback(
    async (book: BookMeta) => {
      const existing = bookMetadataRef.current.find((item) => item.bookId === book.id);
      if (!existing?.original) return;
      setMetadataBusy(true);
      try {
        await commitMetadataPatch({ ...existing, applied: null, appliedBy: null });
        showToast("已还原成导入时的资料");
      } catch {
        // 同上。
      } finally {
        setMetadataBusy(false);
      }
    },
    [commitMetadataPatch, showToast]
  );

  const refreshMetadata = useCallback(
    async (book: BookMeta) => {
      setMetadataBusy(true);
      try {
        const existing = bookMetadataRef.current.find((item) => item.bookId === book.id);
        // 先退回原样再查，否则拿已经被替换过的书名去查，等于拿结果再查一次结果。
        const source: BookMeta = existing?.original
          ? { ...book, ...existing.original }
          : book;
        const patch = await buildMetadataPatch(source, new AbortController().signal);
        if (!patch) return;
        await removeBookMetadata(book.id).catch(() => undefined);
        metadataCheckedRef.current.add(book.id);
        await commitMetadataPatch(
          existing?.original ? { ...patch, original: existing.original } : patch
        );
      } catch {
        // 同上。
      } finally {
        setMetadataBusy(false);
      }
    },
    [buildMetadataPatch, commitMetadataPatch]
  );

  /** 把攒着的听书位置写进书目；只写这两个字段，不碰正文。 */
  const writeListeningProgress = useCallback(() => {
    const pending = [...pendingListeningRef.current];
    pendingListeningRef.current.clear();
    for (const [bookId, position] of pending) {
      void updateBookMeta(bookId, { listeningPosition: position, updatedAt: position.updatedAt })
        .catch((error) => reportStorageError("listening-position", error));
    }
  }, [reportStorageError]);

  const flushListeningProgress = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    writeListeningProgress();
  }, [writeListeningProgress]);

  const updateListeningProgress = useCallback(
    (bookId: string, position: BookPosition) => {
      pendingListeningRef.current.set(bookId, position);
      setBooks((current) =>
        current.map((book) =>
          book.id === bookId
            ? { ...book, listeningPosition: position, updatedAt: position.updatedAt }
            : book
        )
      );
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          writeListeningProgress();
        }, 20000);
      }
    },
    [writeListeningProgress]
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        flushListeningProgress();
        void flushReadingProgress();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    const onPageHide = () => {
      flushListeningProgress();
      void flushReadingProgress();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      flushListeningProgress();
      void flushReadingProgress();
    };
  }, [flushListeningProgress, flushReadingProgress]);

  const appUpdate = useAppUpdate();
  const player = useSpeechPlayer({
    getBook: getFullBook,
    settings,
    onProgress: updateListeningProgress,
  });

  // 一停下来就把攒着的听书进度补写掉，别等那 20 秒。
  useEffect(() => {
    if (!player.isPlaying) flushListeningProgress();
  }, [player.isPlaying, flushListeningProgress]);

  const activeBook = player.location
    ? books.find((book) => book.id === player.location?.bookId)
    : undefined;
  // 迷你条上那一句：正在听的那本正文一直钉在内存里（pinnedContentRef），直接从里面取。
  // 摊平一章只是把段落里的句子接成一列，每句换一次才重算一回，不值得再缓存。
  const speakingChapter = activeBook
    ? contents.get(activeBook.id)?.[player.location?.chapterIndex ?? -1]
    : undefined;
  const speakingLine = speakingChapter
    ? flattenChapter(speakingChapter)[player.location?.sentenceIndex ?? -1]?.text ?? ""
    : "";
  const selectedMeta = viewNeedsContent(view)
    ? books.find((book) => book.id === view.bookId)
    : undefined;
  const playingBookId = player.location?.bookId ?? "";
  const viewBookId = viewNeedsContent(view) ? view.bookId : "";
  useEffect(() => {
    pinnedContentRef.current = new Set([playingBookId, viewBookId].filter(Boolean));
  }, [playingBookId, viewBookId]);
  // 整本书：书目 + 已经读进来的正文。正文还没到就是 undefined，那一页先不画。
  const selectedBook = useMemo<Book | undefined>(() => {
    const chapters = selectedMeta ? contents.get(selectedMeta.id) : undefined;
    return selectedMeta && chapters ? { ...selectedMeta, chapters } : undefined;
  }, [selectedMeta, contents]);

  // 返回、前进、冷启动恢复都可能落到一本正文还没读进来的书上：补读，读不出来就退回去。
  useEffect(() => {
    if (!ready || !viewNeedsContent(view) || contentRef.current.has(view.bookId)) return;
    if (!booksRef.current.some((book) => book.id === view.bookId)) return;
    let cancelled = false;
    void loadContent(view.bookId).then((chapters) => {
      if (cancelled || chapters) return;
      showToast("这本书的正文读不出来了");
      replaceView({ name: view.name === "player" ? "listen" : view.name === "book-notes" ? "notes" : "library" });
    });
    return () => {
      cancelled = true;
    };
  }, [ready, view, loadContent, replaceView, showToast]);

  // 套用资料之后 books 会换一份新对象，弹层里必须跟着拿最新的那本，否则改完还显示旧书名。
  const metadataTarget = metadataBook
    ? books.find((book) => book.id === metadataBook.id)
    : undefined;
  const metadataPatch = metadataTarget
    ? bookMetadata.find((patch) => patch.bookId === metadataTarget.id)
    : undefined;

  // 冷启动恢复出来的视图可能指着一本已经删掉的书。下钻页拿不到书就会一路掉进
  // 最后那个兜底分支、显示成笔记页，所以书加载完之后校一次，不对就退回所属板块。
  useEffect(() => {
    if (!ready || !viewNeedsContent(view)) return;
    if (books.some((book) => book.id === view.bookId)) return;
    replaceView({
      name:
        view.name === "player"
          ? "listen"
          : view.name === "book-notes"
            ? "notes"
            : "library",
    });
  }, [ready, books, view, replaceView]);
  const selectedBookId = selectedMeta?.id ?? "";
  const selectedBookNotes = useMemo(
    () => (selectedBookId ? notes.filter((note) => note.bookId === selectedBookId) : []),
    [notes, selectedBookId]
  );
  const selectedBookChat = useMemo(
    () => (selectedBookId ? chats.find((c) => c.bookId === selectedBookId) : undefined),
    [chats, selectedBookId]
  );

  const updateChat = useCallback((bookId: string, turns: AiChatTurn[]) => {
    const existing = chatsRef.current.find((item) => item.bookId === bookId);
    const chat: BookAiChat = {
      bookId,
      turns: mergeChatTurns(existing?.turns ?? [], turns),
      updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1),
    };
    const idx = chatsRef.current.findIndex((item) => item.bookId === bookId);
    const next = [...chatsRef.current];
    if (idx === -1) next.push(chat);
    else next[idx] = chat;
    chatsRef.current = next;
    setChats(next);
    void saveChat(chat).catch((error) => reportStorageError("chat", error));
  }, [reportStorageError]);

  const changeSettings = (next: ReaderSettings) => {
    pendingSyncedSettingsRef.current = null;
    setSettings(next);
    void saveSettings(next).catch((error) => reportStorageError("settings", error));
  };

  const isReading = view.name === "reader";

  const persistSession = useCallback((session: ReadingSession) => {
    setSessions((current) => {
      const idx = current.findIndex((item) => item.id === session.id);
      if (idx === -1) return [session, ...current];
      const next = [...current];
      next[idx] = session;
      return next;
    });
    void saveSession(session).catch((error) => reportStorageError("session", error));
  }, [reportStorageError]);

  // 在放就按听算（锁屏后台也算），否则看是不是开着阅读器。两者都不是就不记。
  const listeningBook = player.isPlaying ? activeBook : undefined;
  const readingSessionTarget = listeningBook
    ? {
        bookId: listeningBook.id,
        bookTitle: listeningBook.title,
        kind: "listen" as const,
        percent: listeningBook.listeningPosition?.percent ?? 0,
      }
    : isReading && selectedBook
      ? {
          bookId: selectedBook.id,
          bookTitle: selectedBook.title,
          kind: "read" as const,
          percent: selectedBook.readingPosition?.percent ?? 0,
        }
      : null;
  useReadingSession(readingSessionTarget, player.isPlaying, persistSession);

  // PWA 全屏时 iOS 用 theme-color 给状态栏那条填色。写死一个值的话，
  // 换书架或翻开书后状态栏和页面就裂成两块颜色，看着像没做全屏。
  useLayoutEffect(() => {
    if (!ready) return;
    // The reader unmount and the root background must change in the same paint.
    document.documentElement.toggleAttribute("data-in-reader", isReading);
  }, [ready, isReading]);

  useEffect(() => {
    // 设置读出来之前别动：首帧的底色和状态栏颜色由开机脚本按上次的配色套好了。
    if (!ready) return;
    const root = document.documentElement;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]'
    );
    const apply = () => {
      if (!meta) return;
      const color = getComputedStyle(root)
        .getPropertyValue(isReading ? "--reader-background" : "--paper")
        .trim();
      if (!color) return;
      // Keep browser chrome stable: never clear a valid color just to force a repaint.
      if (meta.content !== color) meta.content = color;
    };
    apply();
    // 只在页面重新可见时补一次；隐藏时不用管，切回来那一下才是状态栏被刷掉的时机。
    const onVisible = () => {
      if (document.visibilityState === "visible") apply();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", apply);
    window.addEventListener("focus", apply);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", apply);
      window.removeEventListener("focus", apply);
    };
  }, [ready, isReading, settings.theme, settings.shellTheme]);

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setImportError("");
    let failed = false;

    for (const file of files) {
      setImportFileName(file.name);
      setImportProgress({
        stage: "reading",
        label: "准备导入",
        percent: 1,
      });
      try {
        if (file.size > MAX_BOOK_FILE_BYTES) throw new Error(MAX_BOOK_FILE_ERROR);
        const { parseBookFile } = await loadParsers();
        const { book, images } = await parseBookFile(file, setImportProgress);
        setImportProgress({
          stage: "saving",
          label: "正在保存到本地书架",
          percent: 94,
        });
        await saveImportedBook(book, images);
        setBooks((current) => [metaOf(book), ...current]);
        setImportProgress({
          stage: "saving",
          label: "导入完成",
          percent: 100,
        });
      } catch (error) {
        failed = true;
        setImportError(
          error instanceof Error ? error.message : "导入失败，请检查文件"
        );
        break;
      }
    }

    setImportProgress(null);
    if (!failed) setImportFileName("");
  };

  const handleOnlineImport = async (file: File, sourceId: string, onProgress: (label: string) => void) => {
    if (books.some((book) => book.onlineSourceId === sourceId)) return;
    if (file.size > MAX_BOOK_FILE_BYTES) throw new Error(MAX_BOOK_FILE_ERROR);
    const { parseBookFile } = await loadParsers();
    const { book, images } = await parseBookFile(file, (progress) => onProgress(progress.label));
    book.onlineSourceId = sourceId;
    onProgress("正在保存到本地书库…");
    await saveImportedBook(book, images);
    setBooks((current) => [metaOf(book), ...current]);
  };

  /** 连点，或者点了 A 马上又点 B：只认最后一次，前面那次读完正文也不跳。 */
  const openTokenRef = useRef(0);

  /** 先把这本书的正文读进来，再进页面；页面第一帧就是完整的。 */
  const withContent = async (bookId: string): Promise<Book | null> => {
    const token = ++openTokenRef.current;
    const chapters = await loadContent(bookId);
    if (token !== openTokenRef.current) return null;
    const meta = booksRef.current.find((book) => book.id === bookId);
    if (!chapters || !meta) {
      showToast("这本书的正文读不出来了");
      return null;
    }
    return { ...meta, chapters };
  };

  const openReader = async (meta: BookMeta, position?: BookPosition) => {
    const book = await withContent(meta.id);
    if (!book) return;
    const now = Date.now();
    const nextPosition =
      position ??
      pendingReadingProgressRef.current.get(book.id)?.position ??
      book.readingPosition ??
      initialPosition(book);
    patchBookMeta(book.id, { readingPosition: nextPosition, lastOpenedAt: now, updatedAt: now });
    navigate({ name: "reader", bookId: book.id });
  };

  const openPlayer = async (meta: BookMeta, startPlaying = false) => {
    const book = await withContent(meta.id);
    if (!book) return;
    navigate({ name: "player", bookId: book.id });
    if (startPlaying) {
      player.start(
        book.id,
        book.listeningPosition ?? book.readingPosition ?? initialPosition(book)
      );
    }
  };

  const openBookNotes = async (meta: BookMeta) => {
    const book = await withContent(meta.id);
    if (book) navigate({ name: "book-notes", bookId: book.id });
  };

  const addListeningMark = async (
    book: BookMeta,
    position: BookPosition,
    excerpt: string
  ) => {
    const existing = notes.find(
      (note) =>
        note.bookId === book.id &&
        note.sentenceId === position.sentenceId &&
        note.kind === "listening-mark"
    );
    if (existing) {
      showToast("这一句已经标记过了");
      return;
    }
    const note: BookNote = {
      id: makeId("note"),
      bookId: book.id,
      chapterId: position.chapterId,
      sentenceId: position.sentenceId,
      kind: "listening-mark",
      excerpt,
      createdAt: Date.now(),
    };
    await saveNote(note).catch((error) => {
      reportStorageError("note", error);
      throw error;
    });
    setNotes((current) => [note, ...current]);
    showToast("已标记当前听书位置");
  };

  /** 跨句选中会拆成每句一条划线，返回第一条给弹层继续操作（同组的其余条随它一起改）。 */
  const createHighlights = async (
    book: Book,
    parts: HighlightPart[],
    color: HighlightColor,
    highlightStyle: HighlightStyle = "underline"
  ): Promise<BookNote | null> => {
    const groupId = makeId("mark");
    const base = Date.now();
    const created = parts.map((part, index) => {
      const position = positionFor(
        book,
        findSentence(book, part.sentenceId)?.chapterIndex ?? 0,
        part.sentenceIndex
      );
      return {
        id: makeId("note"),
        bookId: book.id,
        chapterId: position.chapterId,
        sentenceId: part.sentenceId,
        kind: "highlight" as const,
        excerpt: part.text,
        // 同组按 index 递增，之后靠它还原成阅读顺序（Date.now() 在一次循环里是同一个值）。
        createdAt: base + index,
        start: part.start,
        end: part.end,
        color,
        highlightStyle,
        groupId,
      } satisfies BookNote;
    });
    if (!created.length) return null;

    try {
      await writeNotes(created);
    } catch (error) {
      reportStorageError("note", error);
      return null;
    }

    setNotes((current) => [...created, ...current]);
    return created[0];
  };

  /** 改色、写想法都要落到整组上，否则跨句划线会变成半蓝半黄。 */
  const updateNote = async (note: BookNote): Promise<boolean> => {
    const group = groupKey(note);
    const touchedAt = Date.now();
    const patch = (item: BookNote): BookNote => ({
      ...item,
      color: note.color,
      highlightStyle: note.highlightStyle ?? "underline",
      thought: note.thought,
      // 同步 LWW 靠它识别「这条划线改过了」;不更新的话另一台设备永远赢不过去。
      updatedAt: touchedAt,
    });
    try {
      await writeNotes(notes.filter((item) => groupKey(item) === group).map(patch));
    } catch (error) {
      reportStorageError("note", error);
      return false;
    }
    setNotes((current) =>
      current.map((item) => (groupKey(item) === group ? patch(item) : item))
    );
    return true;
  };

  const handleReadProgress = useCallback(
    (book: BookMeta, position: BookPosition) => {
      const now = Date.now();
      const nextPosition = { ...position, updatedAt: now };
      pendingReadingProgressRef.current.set(book.id, {
        position: nextPosition,
        lastOpenedAt: now,
        savedAt: now,
      });
      // 进度落盘可以更慢，但界面上的百分比不能等到落盘才动；按半秒节流，
      // 既保住书架上的实时反馈，也不让长文每句都重排整个应用。
      // 节流窗口里的最后一次必须补上：以前直接丢掉，两次进度挨得近时，
      // 书架上的进度就停在前一次，一直等到下一次滑动才对。
      // 每次调用都会清掉上一次的补发计时，所以这里闭包里的永远是最新的位置。
      const applyToShelf = () => {
        readingUiProgressRef.current.set(book.id, Date.now());
        setBooks((current) =>
          current.map((item) =>
            item.id === book.id
              ? {
                  ...item,
                  readingPosition: nextPosition,
                  lastOpenedAt: now,
                  updatedAt: now,
                }
              : item
          )
        );
      };
      const trailing = readingUiTimerRef.current.get(book.id);
      if (trailing) window.clearTimeout(trailing);
      readingUiTimerRef.current.delete(book.id);
      const sinceLast = now - (readingUiProgressRef.current.get(book.id) ?? 0);
      if (sinceLast >= 500) {
        applyToShelf();
      } else {
        readingUiTimerRef.current.set(
          book.id,
          window.setTimeout(() => {
            readingUiTimerRef.current.delete(book.id);
            applyToShelf();
          }, 500 - sinceLast)
        );
      }
      scheduleReadingProgressFlush();
    },
    [scheduleReadingProgressFlush]
  );

  const confirmDeleteBook = async () => {
    if (!deleteTarget) return;
    if (player.location?.bookId === deleteTarget.id) player.stop();
    pendingReadingProgressRef.current.delete(deleteTarget.id);
    readingUiProgressRef.current.delete(deleteTarget.id);
    window.clearTimeout(readingUiTimerRef.current.get(deleteTarget.id));
    readingUiTimerRef.current.delete(deleteTarget.id);
    try {
      await removeBook(deleteTarget.id);
    } catch (error) {
      reportStorageError("delete-book", error);
      return;
    }
    setBooks((current) =>
      current.filter((book) => book.id !== deleteTarget.id)
    );
    dropContent((id) => id !== deleteTarget.id);
    setNotes((current) =>
      current.filter((note) => note.bookId !== deleteTarget.id)
    );
    const remainingChats = chatsRef.current.filter((chat) => chat.bookId !== deleteTarget.id);
    chatsRef.current = remainingChats;
    setChats(remainingChats);
    setDeleteTarget(null);
    showToast("书籍及相关标记已删除");
  };

  const restoreNotes = async (removed: BookNote[]) => {
    // 撤销也是一次修改:删除墓碑可能已经推上云端,恢复的这份必须比它新才能赢回来。
    const touchedAt = Date.now();
    const restored = removed.map((note) => ({ ...note, updatedAt: touchedAt }));
    try {
      await writeNotes(restored);
    } catch (error) {
      reportStorageError("restore-note", error);
      showToast("撤销失败，这条标记没能恢复");
      return;
    }
    // 排序跟从库里读出来时保持一致，撤销后位置不会莫名其妙变。
    setNotes((current) =>
      [...current, ...restored].sort((a, b) => b.createdAt - a.createdAt)
    );
  };

  const deleteBookNote = async (note: BookNote): Promise<boolean> => {
    const group = groupKey(note);
    const doomed = notes.filter((item) => groupKey(item) === group);
    try {
      await writeNotes([], doomed.map((item) => item.id));
    } catch (error) {
      reportStorageError("delete-note", error);
      return false;
    }
    setNotes((current) =>
      current.filter((item) => groupKey(item) !== group)
    );
    showUndoToast(
      doomed.some((item) => item.kind === "listening-mark")
        ? "已删除标记"
        : "已删除划线",
      () => void restoreNotes(doomed)
    );
    return true;
  };

  const openNote = async (note: BookNote) => {
    const meta = books.find((item) => item.id === note.bookId);
    const book = meta ? await withContent(meta.id) : null;
    const found = book ? findSentence(book, note.sentenceId) : null;
    if (!meta || !book || !found) {
      showToast("这条标记对应的正文已经不存在");
      return;
    }
    await openReader(meta, positionFor(book, found.chapterIndex, found.sentenceIndex));
  };

  const clearEverything = async () => {
    if (syncControllerRef.current) {
      syncControllerRef.current.abort();
      await syncSettledRef.current;
    }
    player.stop();
    try {
      await clearLibrary();
    } catch (error) {
      reportStorageError("clear-library", error);
      return;
    }
    pendingReadingProgressRef.current.clear();
    readingUiProgressRef.current.clear();
    if (readingProgressTimerRef.current !== null) {
      window.clearTimeout(readingProgressTimerRef.current);
      readingProgressTimerRef.current = null;
    }
    pendingListeningRef.current.clear();
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const demo = createDemoBook();
    try {
      await saveBook(demo);
    } catch (error) {
      reportStorageError("save-demo", error);
    }
    commitContents(new Map());
    setBooks([metaOf(demo)]);
    setNotes([]);
    chatsRef.current = [];
    setChats([]);
    setBookMetadata([]);
    setMetadataBook(null);
    setSettings(DEFAULT_SETTINGS);
    pendingSyncedSettingsRef.current = null;
    setStats(DEFAULT_STATS);
    setSessions([]);
    setConfirmClear(false);
    selectTab("home");
    showToast(
      syncConnected
        ? "本地已清空;云端仍保留,下次同步会恢复回来"
        : "本地书库已清空，已保留一份使用指南"
    );
  };

  const activeMainView: MainView = backgroundView;

  // 详情页打开时保留真正的来处；可能从任意 Tab 进入同一本书。
  const frameSuspended = view.name === "reader" || view.name === "player" || view.name === "settings";
  const tabSuspended = view.name === "book-notes" || view.name === "history" || view.name === "store" || view.name === "find";

  if (!ready) {
    // 书目读出来之前只有底色，颜色由 layout 里的开机脚本按上次的配色提前套好。
    // 书目几十毫秒就读完，不再摆「正在打开你的书架」那种闪屏：
    // 它让每次打开都多闪一个跟正文不一样的画面（Apple 的启动规范也明确不要这么做）。
    return (
      <main className="app-shell app-shell--booting" aria-busy="true">
        {upgrading ? (
          <p className="app-booting__note">正在整理本地书库，只需要这一次…</p>
        ) : null}
      </main>
    );
  }

  return (
    <main className="app-shell">
      {view.name === "reader" && selectedBook ? (
        <ReaderScreen
          key={selectedBook.id}
          book={selectedBook}
          notes={selectedBookNotes}
          settings={settings}
          currentSentenceId={
            player.location?.bookId === selectedBook.id
              ? player.currentSentenceId
              : ""
          }
          speakingChapterIndex={
            player.location?.bookId === selectedBook.id
              ? player.location.chapterIndex
              : -1
          }
          chatTurns={selectedBookChat?.turns ?? []}
          onChatChange={(turns) => updateChat(selectedBook.id, turns)}
          onBack={() => goBack({ name: "library" })}
          onProgress={(position) => handleReadProgress(selectedBook, position)}
          onStartListening={(position) => {
            player.start(selectedBook.id, position);
            navigate({ name: "player", bookId: selectedBook.id });
          }}
          onHighlight={(parts, color, style) =>
            createHighlights(selectedBook, parts, color, style)
          }
          onUpdateNote={updateNote}
          onDeleteNote={deleteBookNote}
          onSettingsChange={changeSettings}
          onToast={showToast}
        />
      ) : null}
      {view.name === "player" && selectedBook ? (
        <PlayerScreen
          book={selectedBook}
          settings={settings}
          player={player}
          onBack={() => goBack({ name: "listen" })}
          onOpenReader={(position) => void openReader(selectedBook, position)}
          onAddNote={(position, excerpt) =>
            addListeningMark(selectedBook, position, excerpt)
          }
          onSettingsChange={changeSettings}
        />
      ) : null}
      {view.name === "settings" ? (
        <SettingsScreen
          section={view.section}
          settings={settings}
          voices={player.voices}
          books={books}
          sync={{
            enabled: syncEnabled,
            connected: syncConnected,
            syncing,
            message: syncMessage,
            error: syncError,
            lastSyncAt,
          }}
          onChange={changeSettings}
          onClear={() => setConfirmClear(true)}
          onSyncLogin={handleSyncLogin}
          onSyncLogout={() => void handleSyncLogout()}
          onSyncNow={() => void triggerSync(true)}
          update={appUpdate}
          onOpen={(section) => navigate({ name: "settings", section })}
          onBack={() => goBack(view.section ? { name: "settings" } : { name: "home" })}
        />
      ) : null}
        <div
          className={`app-frame${view.name === "find" ? " is-bare" : ""}${frameSuspended ? " is-suspended" : ""}`}
          aria-hidden={frameSuspended}
          inert={frameSuspended}
        >
          {/* 在线找书是一段专心的事：手机上底栏收起（is-bare），结果区一直铺到屏幕底。 */}
          <div className="desktop-brand">
            <BearMark className="app-mark" />
            <div>
              <strong>墨听</strong>
              <small>阅读，也聆听</small>
            </div>
          </div>

          <div className="bottom-bar">
            <BottomNavigation
              active={activeMainView}
              onChange={selectTab}
            />
          </div>

          <section className="app-content">
            <RetainedTab name="home" active={!tabSuspended && backgroundView === "home"} foreground={!frameSuspended}>
              <HomeScreen
                books={books}
                stats={stats}
                sessions={sessions}
                onOpenReader={(book) => openReader(book)}
                onPlay={(book) => openPlayer(book, true)}
                onOpenPlayer={(book) => openPlayer(book, false)}
                onImport={() => fileInputRef.current?.click()}
                onOpenHistory={() => navigate({ name: "history" })}
                onOpenSettings={() => navigate({ name: "settings" })}
                onOpenLibrary={() => selectTab("library")}
                onOpenStore={(bookId) =>
                  navigate(bookId ? { name: "store", bookId } : { name: "store" })
                }
                onSearchStore={(query) => navigate({ name: "store", query })}
              />
            </RetainedTab>
            <RetainedTab name="library" active={!tabSuspended && backgroundView === "library"} foreground={!frameSuspended}>
              <LibraryScreen
                books={books}
                onImport={() => fileInputRef.current?.click()}
                onFind={(query) => navigate({ name: "find", query })}
                onOpen={(book) => openReader(book)}
                onPlay={(book) => openPlayer(book, true)}
                onOpenNotes={(book) => void openBookNotes(book)}
                onOpenMetadata={setMetadataBook}
                onDelete={setDeleteTarget}
              />
            </RetainedTab>
            <RetainedTab name="listen" active={!tabSuspended && backgroundView === "listen"} foreground={!frameSuspended}>
              <ListenScreen
                books={books}
                onPlay={(book) => openPlayer(book, true)}
                onOpenPlayer={(book) => openPlayer(book, false)}
              />
            </RetainedTab>
            <RetainedTab name="notes" active={!tabSuspended && backgroundView === "notes"} foreground={!frameSuspended}>
              <NotesScreen
                notes={notes}
                books={books}
                chats={chats}
                onOpenBook={(book) => void openBookNotes(book)}
                onOpenChat={setChatBook}
              />
            </RetainedTab>
            {view.name === "history" ? (
              <HistoryScreen sessions={sessions} onBack={() => goBack({ name: "home" })} />
            ) : view.name === "store" ? (
              <div className="screen">
                <Bookstore
                  key={view.query ?? ""}
                  books={books}
                  initialBookId={view.bookId ?? ""}
                  initialQuery={view.query ?? ""}
                  onBack={() => goBack({ name: "home" })}
                  onFindBook={(title, author) =>
                    navigate({ name: "find", query: bookSearchQuery(title, author) })
                  }
                />
              </div>
            ) : view.name === "find" ? (
              <OnlineLibrary
                key={view.query}
                initialQuery={view.query}
                books={books}
                onImport={handleOnlineImport}
                onOpen={(book) => openReader(book)}
                onBack={() => goBack({ name: "library" })}
                onToast={showToast}
              />
            ) : view.name === "book-notes" && selectedBook ? (
              <BookNotesScreen
                book={selectedBook}
                notes={selectedBookNotes}
                onBack={() => goBack({ name: "notes" })}
                onOpen={(note) => void openNote(note)}
                onDelete={deleteBookNote}
                onEditThought={(note) => {
                  setThoughtTarget(note);
                  setThoughtDraft(note.thought ?? "");
                }}
              />
            ) : null}
          </section>

          {activeBook ? (
            <MiniPlayer
              book={activeBook}
              chapterTitle={chapterLabel(
                activeBook.chapterOutline,
                player.location?.chapterIndex ?? 0
              )}
              line={speakingLine}
              isPlaying={player.isPlaying}
              isBuffering={player.isBuffering}
              onToggle={player.toggle}
              onOpen={() => navigate({ name: "player", bookId: activeBook.id })}
              onStop={player.stop}
            />
          ) : null}

          {/* 新版已经在后台存好，点一下重新载入就换上。只在书架这几页出，不打断阅读和听书；有别的提示条时先让它。 */}
          {appUpdate.status === "available" && !toast ? (
            <div className="toast" role="status">
              <span>新版本已就绪</span>
              <button type="button" className="toast__undo" onClick={appUpdate.apply}>
                更新
              </button>
            </div>
          ) : null}
        </div>

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        multiple
        accept=".epub,.pdf,.txt,.md,.markdown,application/epub+zip,application/pdf,text/plain,text/markdown"
        onChange={handleImport}
      />

      {importProgress ? (
        <div className="import-overlay" role="status" aria-live="polite">
          <section>
            <div className="import-icon">
              <FileText size={25} />
            </div>
            <small>正在导入</small>
            <h2>{importFileName}</h2>
            <p>{importProgress.label}</p>
            <ProgressBar value={importProgress.percent} />
            <span>{importProgress.percent}%</span>
          </section>
        </div>
      ) : null}

      {importError ? (
        <Modal title="这本书暂时无法导入" onClose={() => setImportError("")}>
          <div className="error-message">
            <FileText size={26} />
            <p>{importError}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setImportError("");
                fileInputRef.current?.click();
              }}
            >
              选择其他文件
            </button>
          </div>
        </Modal>
      ) : null}

      {metadataTarget ? (
        <BookMetadataSheet
          book={metadataTarget}
          patch={metadataPatch}
          busy={metadataBusy}
          onApply={(candidate) => void chooseMetadataCandidate(metadataTarget, candidate)}
          onRevert={() => void revertMetadata(metadataTarget)}
          onRefresh={() => void refreshMetadata(metadataTarget)}
          onClose={() => setMetadataBook(null)}
        />
      ) : null}

      {deleteTarget ? (
        <Modal title="删除这本书？" onClose={() => setDeleteTarget(null)}>
          <div className="confirm-dialog">
            <BookCover book={deleteTarget} size="medium" />
            <p>
              《{displayTitle(deleteTarget.title)}》的正文、阅读进度和全部标记都会从当前设备删除。
            </p>
            <div>
              <SheetCancelButton>取消</SheetCancelButton>
              <button
                type="button"
                className="danger-button"
                onClick={confirmDeleteBook}
              >
                确认删除
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {chatBook ? (
        <AiAskPanel
          text=""
          initialTurns={chats.find((c) => c.bookId === chatBook.id)?.turns ?? []}
          onTurnsChange={(turns) => updateChat(chatBook.id, turns)}
          book={chatBook}
          chapter={undefined}
          settings={settings}
          onClose={() => setChatBook(null)}
        />
      ) : null}

      {confirmClear ? (
        <Modal title="清空本地书库？" onClose={() => setConfirmClear(false)}>
          <div className="confirm-dialog">
            <p>
              所有导入书籍、阅读进度和标记都会删除。操作完成后只保留内置使用指南。
            </p>
            <div>
              <SheetCancelButton>取消</SheetCancelButton>
              <button
                type="button"
                className="danger-button"
                onClick={clearEverything}
              >
                清空书库
              </button>
            </div>
          </div>
        </Modal>
      ) : null}


      {thoughtTarget ? (
        <Modal title="写想法" onClose={() => setThoughtTarget(null)}>
          <div className="thought-editor">
            <blockquote>{thoughtTarget.excerpt}</blockquote>
            <textarea
              value={thoughtDraft}
              onChange={(event) => setThoughtDraft(event.target.value)}
              placeholder="写下此刻的想法"
              rows={5}
              autoFocus
            />
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                const text = thoughtDraft.trim();
                updateNote({
                  ...thoughtTarget,
                  thought: text ? text : undefined,
                });
                setThoughtTarget(null);
              }}
            >
              保存想法
            </button>
          </div>
        </Modal>
      ) : null}

      {toast ? (
        <div key={toast.id} className={`toast${toast.leaving ? " is-leaving" : ""}`}>
          <span>{toast.message}</span>
          {toast.undo ? (
            <button
              type="button"
              className="toast__undo"
              onClick={() => {
                const undo = toast.undo;
                dismissToast();
                undo?.();
              }}
            >
              撤销
            </button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
