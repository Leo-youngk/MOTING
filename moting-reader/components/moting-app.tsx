"use client";

import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  FileText,
  Gauge,
  Headphones,
  Highlighter,
  Home,
  Layers,
  Library,
  List,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  PencilLine,
  Play,
  Plus,
  Search,
  Sparkles,
  Square,
  Trash2,
  Type,
  Upload,
  UserRound,
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
import { createPortal } from "react-dom";
import { useAppNavigation } from "../hooks/use-app-navigation";
import { useKeyboardInset } from "../hooks/use-keyboard-inset";
import { useViewportFill } from "../hooks/use-viewport-fill";
import { useSpeechPlayer, type SleepMode } from "../hooks/use-speech-player";
import { AiRequestError, fetchAiModels, streamAiChat } from "../lib/ai";
import {
  findSentence,
  flattenChapter,
  formatReadingTime,
  formatRemaining,
  imageSize,
  initialPosition,
  makeId,
  estimatePagination,
  nextChapterRange,
  pageAt,
  positionFor,
  remainingCharacters,
  withImageSizes,
} from "../lib/content";
import { createDemoBook } from "../lib/demo";
import { MAX_BOOK_FILE_BYTES, MAX_BOOK_FILE_ERROR } from "../lib/file-limits";
import { springTo } from "../lib/motion";
import {
  clearLibrary,
  getAllBooks,
  getAllChats,
  getAllNotes,
  getAllSessions,
  getBookImage,
  getSettings,
  getStats,
  saveSession,
  removeBook,
  writeNotes,
  saveBook,
  saveImportedBook,
  saveReadingPositions,
  saveChat,
  saveNote,
  saveSettings,
} from "../lib/storage";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  dayKey,
  type AiChatTurn,
  type Book,
  type BookAiChat,
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
} from "../lib/types";
import {
  dailyBookEntries,
  dailySeconds,
  groupEntriesByMonth,
  readingStreak,
  totalSeconds,
} from "../lib/reading-stats";
import { useReadingSession } from "../hooks/use-reading-session";
import { useSafeInsets, type SafeInsets } from "../hooks/use-safe-insets";
import { useTextSelection } from "../hooks/use-text-selection";
import { SelectionLayer } from "./selection-layer";
import {
  placeForSelection,
  type Placement,
  type Rect,
} from "../lib/popover-placement";
import { EDGE_VOICES } from "../lib/edge-voices";

const OnlineLibrary = lazy(() =>
  import("./online-library").then(({ OnlineLibrary: Component }) => ({
    default: Component,
  }))
);
const LazyAiMarkdown = lazy(() =>
  import("./ai-markdown").then(({ AiMarkdown: Component }) => ({
    default: Component,
  }))
);

function AiMarkdown({ content }: { content: string }) {
  return (
    <Suspense fallback={<span className="ai-markdown-loading">正在排版…</span>}>
      <LazyAiMarkdown content={content} />
    </Suspense>
  );
}

type ReaderFont = ReaderSettings["fontFamily"];

/** 四款正文字体，全部走 iOS 自带系统字，label 用各自的字体渲染出来给用户比对。 */
const READER_FONTS: { value: ReaderFont; label: string; cssVar: string }[] = [
  { value: "serif", label: "宋体", cssVar: "var(--font-serif)" },
  { value: "sans", label: "黑体", cssVar: "var(--font-sans)" },
  { value: "kai", label: "楷体", cssVar: "var(--font-kai)" },
  { value: "yuan", label: "圆体", cssVar: "var(--font-yuan)" },
];

const READER_THEMES: { value: ReaderTheme; label: string }[] = [
  { value: "original", label: "原版" },
  { value: "quiet", label: "夜间" },
  { value: "paper", label: "纸张" },
  { value: "bold", label: "高对比" },
  { value: "calm", label: "暖棕" },
  { value: "focus", label: "米黄" },
];

/** 主题瓦片与阅读页共用的 1:1 色板（取自 Apple Books 真机取样）。 */
const READER_THEME_SWATCH: Record<ReaderTheme, { bg: string; ink: string }> = {
  original: { bg: "#ffffff", ink: "#000000" },
  paper: { bg: "#f5f5f5", ink: "#000000" },
  bold: { bg: "#ffffff", ink: "#000000" },
  calm: { bg: "#efe0c9", ink: "#3a3428" },
  focus: { bg: "#f6f3ea", ink: "#1d1d1f" },
  quiet: { bg: "#414045", ink: "#e8e6e1" },
};

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
  { id: "library", label: "书库", icon: Library },
  { id: "listen", label: "听书", icon: Headphones },
  { id: "notes", label: "笔记", icon: Highlighter },
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

function formatStorageSize(characters: number): string {
  const bytes = characters * 2;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function BookCover({
  book,
  size = "medium",
}: {
  book: Book;
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
          <strong>{book.title}</strong>
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
            <Icon size={21} strokeWidth={selected ? 2.2 : 1.7} />
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

// 浮层叠着开时，只有最外层那一次负责记录和还原滚动位置。
let scrollLockCount = 0;
let lockedScrollY = 0;
// 关闭浮层的同一个事件里如果发生了跳转（比如点目录），跳转后的滚动位置才是
// 用户想要的，不能被这里的"还原到开浮层前的位置"覆盖掉。跳转代码负责调用
// suppressScrollRestore() 声明"这次关闭不要还原"。
let suppressNextScrollRestore = false;

function suppressScrollRestore() {
  suppressNextScrollRestore = true;
}

// 浮层是 position: fixed，挡不住底下的 body 一起被拖动——尤其是弹键盘的时候，
// 背景页面跟着 focus 一起窜，整个 UI 看着在晃。开着的时候把 body 锁死，关掉再还原。
// iOS standalone 下 overflow: hidden 拦不住 focus 触发的整页上推，只有 position: fixed 拦得住。
function useScrollLock() {
  useEffect(() => {
    if (scrollLockCount++ === 0) {
      lockedScrollY = window.scrollY;
      document.body.style.top = `${-lockedScrollY}px`;
      document.body.classList.add("is-scroll-locked");
    }
    return () => {
      if (--scrollLockCount > 0) return;
      document.body.classList.remove("is-scroll-locked");
      document.body.style.top = "";
      if (suppressNextScrollRestore) {
        suppressNextScrollRestore = false;
      } else {
        window.scrollTo(0, lockedScrollY);
      }
    };
  }, []);
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  useScrollLock();
  useEscapeToClose(onClose);
  const drag = useSheetDrag(onClose);
  // 按下就关会误伤：手指落在面板边缘想滑动、稍微移出去一点就把面板关掉了。
  // 记住这一下是不是从遮罩上按下的，抬手仍在遮罩上才算「点空白关闭」。
  const fromBackdrop = useRef(false);

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        fromBackdrop.current = event.target === event.currentTarget;
      }}
      onPointerUp={(event) => {
        const outside =
          fromBackdrop.current && event.target === event.currentTarget;
        fromBackdrop.current = false;
        if (outside) onClose();
      }}
    >
      <section
        className={`modal-sheet ${wide ? "modal-sheet--wide" : ""} ${
          drag.dragging ? "is-dragging" : ""
        } ${className}`}
        style={drag.offset ? { transform: `translateY(${drag.offset}px)` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* 把手不再是装饰：真能拖下去关掉。touch-action 写在 CSS 里，
            必须在手指落下之前就生效，事后再改浏览器不认。 */}
        <div
          className="modal-grabber"
          role="presentation"
          onPointerDown={drag.onPointerDown}
        />
        <header onPointerDown={drag.onPointerDown}>
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>,
    document.body
  );
}

/** 开着的弹层栈。Esc 只关最上面那一层，不能一键掀掉所有层。 */
const openSheets: Array<() => void> = [];

function useEscapeToClose(onClose: () => void) {
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const close = () => closeRef.current();
    openSheets.push(close);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (openSheets[openSheets.length - 1] !== close) return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = openSheets.indexOf(close);
      if (at >= 0) openSheets.splice(at, 1);
    };
  }, []);
}

/** 往下拖到这么多像素就松手关闭，没到就弹回去。 */
const SHEET_DISMISS_PX = 96;

/**
 * 底部面板的下拉关闭。
 *
 * 只有把手和标题栏能拖——面板内容经常是可滚动的列表，整片都能拖会和滚动打架。
 */
function useSheetDrag(onClose: () => void) {
  const startRef = useRef<{ id: number; y: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (!event.isPrimary || startRef.current) return;
    startRef.current = { id: event.pointerId, y: event.clientY };
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 抓不到就算了，下面 document 上的监听照样能跟。
    }
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || event.pointerId !== start.id) return;
      event.preventDefault();
      // 只认往下拖；往上拖不该把面板拉出屏幕。
      setOffset(Math.max(0, event.clientY - start.y));
    };
    const onUp = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || event.pointerId !== start.id) return;
      const travelled = event.clientY - start.y;
      startRef.current = null;
      setDragging(false);
      setOffset(0);
      if (travelled > SHEET_DISMISS_PX) onClose();
    };
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, onClose]);

  return { offset, dragging, onPointerDown };
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

function LargeHeader({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ios-header">
      <h1>{title}</h1>
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
  book: Book;
  size: "large" | "medium";
  onOpen: (book: Book) => void;
  onPlay?: (book: Book) => void;
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
        <strong>{book.title}</strong>
        <small>{book.author}</small>
        <em>{formatRemaining(book, position)}</em>
      </button>
    </article>
  );
}

function HomeCard({
  book,
  meta,
  onOpen,
  onPlay,
}: {
  book: Book;
  meta: string;
  onOpen: (book: Book) => void;
  onPlay?: (book: Book) => void;
}) {
  return (
    <article
      className="home-card"
      style={{ "--book-accent": book.accent } as CSSProperties}
    >
      <button
        type="button"
        className="home-card__open"
        onClick={() => onOpen(book)}
      >
        <BookCover book={book} size="small" />
        <span className="home-card__meta">
          <strong>{book.title}</strong>
          <small>{book.author}</small>
          <em>{meta}</em>
        </span>
      </button>
      {onPlay ? (
        <button
          type="button"
          className="home-card__play"
          aria-label={`收听${book.title}`}
          onClick={() => onPlay(book)}
        >
          <Play size={16} fill="currentColor" />
        </button>
      ) : null}
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
            <span className="zen-log__book-name">{entry.bookTitle}</span>
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
                  <span className="zen-log__book-name">{entry.bookTitle}</span>
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
}: {
  books: Book[];
  stats: ReadingStats;
  sessions: ReadingSession[];
  onOpenReader: (book: Book) => void;
  onPlay: (book: Book) => void;
  onOpenPlayer: (book: Book) => void;
  onImport: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
}) {
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

  // 主行显示最近动过的那一侧，另一侧接在后面，两个位置差很远时也一眼看得到。
  const resumeMeta = ({ book, listenLed }: (typeof resuming)[number]) => {
    const read = book.readingPosition
      ? `读到 ${Math.round(book.readingPosition.percent ?? 0)}%`
      : "";
    const listen = book.listeningPosition
      ? formatRemaining(book, book.listeningPosition)
      : "";
    const ordered = listenLed ? [listen, read] : [read, listen];
    return ordered.filter(Boolean).join(" · ");
  };

  return (
    <div className="screen">
      <LargeHeader
        title="主页"
        actions={
          <button
            type="button"
            className="avatar-button"
            aria-label="设置"
            onClick={onOpenSettings}
          >
            <UserRound size={19} />
          </button>
        }
      />

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
              <h2 className="home-row__title">继续</h2>
              <div className="home-row__track">
                {resuming.map((entry) => (
                  <HomeCard
                    key={entry.book.id}
                    book={entry.book}
                    meta={resumeMeta(entry)}
                    onOpen={entry.listenLed ? onOpenPlayer : onOpenReader}
                    onPlay={entry.book.listeningPosition ? onPlay : undefined}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {untouched.length ? (
            <section className="home-row">
              <h2 className="home-row__title">从这里开始</h2>
              <div className="home-row__track">
                {untouched.map((book) => (
                  <HomeCard
                    key={book.id}
                    book={book}
                    meta={book.author}
                    onOpen={onOpenReader}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <ReadingBoard stats={stats} sessions={sessions} />
          <ReadingLog sessions={sessions} onOpenHistory={onOpenHistory} />
        </>
      )}
    </div>
  );
}

function LibraryScreen({
  books,
  onImport,
  onOnlineImport,
  onOpen,
  onPlay,
  onOpenNotes,
  onDelete,
}: {
  books: Book[];
  onImport: () => void;
  onOnlineImport: (file: File, sourceId: string, onProgress: (label: string) => void) => Promise<void>;
  onOpen: (book: Book) => void;
  onPlay: (book: Book) => void;
  onOpenNotes: (book: Book) => void;
  onDelete: (book: Book) => void;
}) {
  const [query, setQuery] = useState("");
  const [sheetBook, setSheetBook] = useState<Book | null>(null);
  const [online, setOnline] = useState(false);

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
            aria-label="导入书籍"
            onClick={onImport}
          >
            <Plus size={20} />
          </button>
        }
      />

      <div className="library-segments" role="group" aria-label="书库来源">
        <button type="button" aria-pressed={!online} onClick={() => setOnline(false)}>本地书库</button>
        <button type="button" aria-pressed={online} onClick={() => setOnline(true)}>在线找书</button>
      </div>

      {online ? (
        <Suspense fallback={<div className="online-loading">正在打开在线书库…</div>}>
          <OnlineLibrary books={books} onImport={onOnlineImport} onOpen={onOpen} />
        </Suspense>
      ) : <>
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
          description="导入的书会保存在这台设备上，不会上传。"
          action={
            <button type="button" className="primary-button" onClick={onImport}>
              <Upload size={17} />
              导入书籍
            </button>
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
              {filtered.map((book) => {
                const percent = Math.round(book.readingPosition?.percent ?? 0);
                const isNew = !book.readingPosition && !book.listeningPosition;
                const progressLabel = isNew
                  ? "未读"
                  : percent >= 99
                    ? "已读完"
                    : `已读 ${percent}%`;
                return (
                  <article className="grid-book" key={book.id}>
                    <button
                      type="button"
                      className="grid-book__cover"
                      onClick={() => onOpen(book)}
                    >
                      <BookCover book={book} size="large" />
                      {isNew ? <span className="grid-book__badge">新增</span> : null}
                    </button>
                    <div className="grid-book__footer">
                      <span className="grid-book__progress">{progressLabel}</span>
                      <button
                        type="button"
                        className="grid-book__more"
                        aria-label={`${book.title}的更多操作`}
                        onClick={() => setSheetBook(book)}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="no-results">没有匹配的书。</p>
          )}
        </>
      )}

      </>}

      {sheetBook ? (
        <Modal title={sheetBook.title} onClose={() => setSheetBook(null)}>
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

function ListenScreen({
  books,
  onPlay,
  onOpenPlayer,
}: {
  books: Book[];
  onPlay: (book: Book) => void;
  onOpenPlayer: (book: Book) => void;
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
            <h2 className="ios-section__title">
              {query ? "搜索结果" : "全部有声书"}
            </h2>
            <div className="ios-inset-list">
              {visible.map((book) => (
                <div className="ios-row ios-row--media" key={book.id}>
                  <button
                    type="button"
                    className="ios-row__main"
                    onClick={() => onOpenPlayer(book)}
                  >
                    <BookCover book={book} size="small" />
                    <span>
                      <strong>{book.title}</strong>
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

function NotesScreen({
  notes,
  books,
  chats,
  onOpenBook,
  onOpenNote,
  onEditThought,
  onDelete,
  onOpenChat,
}: {
  notes: BookNote[];
  books: Book[];
  chats: BookAiChat[];
  onOpenBook: (book: Book) => void;
  onOpenNote: (note: BookNote) => void;
  onEditThought: (note: BookNote) => void;
  onDelete: (note: BookNote) => void;
  onOpenChat: (book: Book) => void;
}) {
  const [filter, setFilter] = useState<"all" | "highlight" | "thought" | "chat">(
    "all"
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // 一次跨句划线在库里是多条记录，这里先合回一条，列表上才是用户划的那一整段。
  const merged = useMemo(() => {
    const buckets = new Map<string, BookNote[]>();
    notes.forEach((note) => {
      const key = groupKey(note);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(note);
      else buckets.set(key, [note]);
    });
    return Array.from(buckets.values()).map(mergeNoteGroup);
  }, [notes]);

  const countsByDay = useMemo(() => {
    const counts = new Map<string, number>();
    merged.forEach((note) => {
      const key = dayKey(note.createdAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [merged]);

  const groups = useMemo(() => {
    const visible = merged.filter((note) => {
      if (selectedDay && dayKey(note.createdAt) !== selectedDay) return false;
      if (filter === "highlight") return note.kind === "highlight";
      if (filter === "thought") return Boolean(note.thought);
      return true;
    });
    return books
      .map((book) => ({
        book,
        items: visible
          .filter((note) => note.bookId === book.id)
          .sort((a, b) => b.createdAt - a.createdAt),
      }))
      .filter((entry) => entry.items.length)
      .sort((a, b) => b.items[0].createdAt - a.items[0].createdAt);
  }, [books, filter, merged, selectedDay]);

  const highlights = merged.filter((note) => note.kind === "highlight").length;
  const thoughts = merged.filter((note) => note.thought).length;

  const chatGroups = useMemo(
    () =>
      chats
        .filter((chat) => chat.turns.length)
        .map((chat) => ({ chat, book: books.find((b) => b.id === chat.bookId) }))
        .filter(
          (entry): entry is { chat: BookAiChat; book: Book } => Boolean(entry.book)
        )
        .sort((a, b) => b.chat.updatedAt - a.chat.updatedAt),
    [chats, books]
  );

  if (!notes.length && !chats.length) {
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
      <LargeHeader title="笔记" />

      <p className="ink-summary">
        {highlights} 条划线
        {thoughts ? ` · ${thoughts} 条想法` : ""}
      </p>

      <div className="ios-segmented">
        {(
          [
            ["all", "全部"],
            ["highlight", "划线"],
            ["thought", "想法"],
            ["chat", "AI 对话"],
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

      {filter === "chat" ? (
        !chatGroups.length ? (
          <EmptyState
            icon={<Sparkles size={26} />}
            title="还没有 AI 对话"
            description="阅读时选中一段文字问 AI，聊天记录会按书保存在这里。"
          />
        ) : (
          <div className="ink-feed">
            {chatGroups.map(({ book, chat }) => {
              const last = chat.turns[chat.turns.length - 1];
              return (
                <button
                  type="button"
                  className="ink-group__head"
                  key={book.id}
                  onClick={() => onOpenChat(book)}
                >
                  <BookCover book={book} size="small" />
                  <span>
                    <strong>{book.title}</strong>
                    <small>{last?.content.slice(0, 30) || book.author}</small>
                  </span>
                  <em>{chat.turns.filter((t) => t.role === "user").length}</em>
                  <ChevronRight size={15} className="ios-row__chevron" />
                </button>
              );
            })}
          </div>
        )
      ) : (
        <>
          <NotesCalendar
            countsByDay={countsByDay}
            selected={selectedDay}
            onSelect={setSelectedDay}
          />

          {selectedDay ? (
            <button
              type="button"
              className="notes-day-chip"
              onClick={() => setSelectedDay(null)}
            >
              只看 {selectedDay.replace(/-/g, ".")}
              <X size={13} />
            </button>
          ) : null}

          {!groups.length ? (
            <EmptyState
              icon={<Highlighter size={26} />}
              title={selectedDay ? "这天没有笔记" : "这里还是空的"}
              description={
                selectedDay
                  ? "换一天看看，或者清除筛选看全部。"
                  : "换个筛选看看，或者回到正文里划一段。"
              }
            />
          ) : (
            <div className="ink-feed">
              {groups.map(({ book, items }) => (
            <section className="ink-group" key={book.id}>
              <button
                type="button"
                className="ink-group__head"
                onClick={() => onOpenBook(book)}
              >
                <BookCover book={book} size="small" />
                <span>
                  <strong>{book.title}</strong>
                  <small>{book.author}</small>
                </span>
                <em>{items.length}</em>
                <ChevronRight size={15} className="ios-row__chevron" />
              </button>

              {items.map((note) => {
                const chapter = book.chapters.find(
                  (item) => item.id === note.chapterId
                );
                const listening = note.kind === "listening-mark";
                return (
                  <article className="ink-note" key={note.id}>
                    <button
                      type="button"
                      className="ink-note__body"
                      onClick={() => onOpenNote(note)}
                    >
                      <span className="ink-note__meta">
                        {listening ? <Headphones size={11} /> : null}
                        <span className="ink-note__chapter">
                          {chapter?.title ?? "正文"}
                        </span>
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
                      {note.thought ? (
                        <span className="ink-note__thought">
                          {note.thought}
                        </span>
                      ) : null}
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
              })}
            </section>
          ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

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
  const [filter, setFilter] = useState<"all" | "thought" | "listening-mark">(
    "all"
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const countsByDay = useMemo(() => {
    const counts = new Map<string, number>();
    notes.forEach((note) => {
      const key = dayKey(note.createdAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [notes]);
  const visible = notes.filter((note) => {
    if (selectedDay && dayKey(note.createdAt) !== selectedDay) return false;
    if (filter === "thought") return Boolean(note.thought);
    if (filter === "listening-mark") return note.kind === "listening-mark";
    return true;
  });

  return (
    <div className="screen screen--book-notes">
      <header className="ios-nav-bar">
        <button type="button" className="ios-back" onClick={onBack}>
          <ChevronLeft size={22} />
          笔记
        </button>
        <span>{book.title}</span>
      </header>

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

      <NotesCalendar
        countsByDay={countsByDay}
        selected={selectedDay}
        onSelect={setSelectedDay}
      />

      {selectedDay ? (
        <button
          type="button"
          className="notes-day-chip"
          onClick={() => setSelectedDay(null)}
        >
          只看 {selectedDay.replace(/-/g, ".")}
          <X size={13} />
        </button>
      ) : null}

      {!visible.length ? (
        <EmptyState
          icon={<Highlighter size={26} />}
          title={selectedDay ? "这天没有笔记" : "这里还是空的"}
          description={
            selectedDay
              ? "换一天看看，或者清除筛选看全部。"
              : "换个筛选，或者回到正文里划一段。"
          }
        />
      ) : (
        <div className="note-feed">
          {visible.map((note) => {
            const chapter = book.chapters.find(
              (item) => item.id === note.chapterId
            );
            return (
              <article
                className={`note-card note-card--${note.color ?? "yellow"}`}
                key={note.id}
              >
                <button
                  type="button"
                  className="note-card__body"
                  onClick={() => onOpen(note)}
                >
                  <span className="note-card__chapter">
                    {note.kind === "listening-mark" ? (
                      <Headphones size={12} />
                    ) : (
                      <Highlighter size={12} />
                    )}
                    {chapter?.title ?? "正文"}
                  </span>
                  <p>{note.excerpt}</p>
                  {note.thought ? (
                    <span className="note-card__thought">{note.thought}</span>
                  ) : null}
                  <small>{formatDate(note.createdAt)}</small>
                </button>
                <div className="note-card__actions">
                  <button type="button" onClick={() => onEditThought(note)}>
                    <PencilLine size={14} />
                    {note.thought ? "改想法" : "写想法"}
                  </button>
                  <button type="button" onClick={() => onDelete(note)}>
                    <Trash2 size={14} />
                    删除
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** base URL 填完（失焦）就自动拉一次模型列表；拉不到就退回手填，不强求。内嵌在聊天面板里，不再是独立设置页。 */
function AiModelPicker({
  settings,
  onChange,
}: {
  settings: ReaderSettings;
  onChange: (settings: ReaderSettings) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl);
  const [apiKey, setApiKey] = useState(settings.aiApiKey);
  const modelControllerRef = useRef<AbortController | null>(null);
  const initialLoadRef = useRef(false);

  const loadModels = useCallback(async (nextBaseUrl = baseUrl, nextApiKey = apiKey) => {
    if (!nextBaseUrl.trim()) return;
    modelControllerRef.current?.abort();
    const controller = new AbortController();
    modelControllerRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const list = await fetchAiModels(nextBaseUrl, nextApiKey, controller.signal);
      if (controller.signal.aborted) return;
      setModels(list);
      if (!settings.aiModel && list[0]) {
        onChange({ ...settings, aiBaseUrl: nextBaseUrl, aiApiKey: nextApiKey, aiModel: list[0] });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof AiRequestError ? err.message : "获取模型列表失败");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [apiKey, baseUrl, onChange, settings]);

  // 面板一打开、地址之前就填过的话，不该等用户点进输入框再点出来才去拉列表。
  useEffect(() => {
    if (initialLoadRef.current || !baseUrl.trim()) return;
    initialLoadRef.current = true;
    const timer = window.setTimeout(() => void loadModels(), 0);
    return () => window.clearTimeout(timer);
  }, [baseUrl, loadModels]);
  useEffect(() => () => modelControllerRef.current?.abort(), []);

  const visible = query.trim()
    ? models.filter((model) =>
        model.toLowerCase().includes(query.trim().toLowerCase())
      )
    : models;

  // 拉不到列表就退回手填，但得让人看见是退回来的，别默默变成一个空输入框。
  const status = !settings.aiBaseUrl.trim()
    ? "填好接口地址后会自动拉取可用模型"
    : loading
      ? "正在拉取模型列表…"
      : error
        ? `拉不到模型列表（${error}），可以直接手填模型名`
        : models.length
          ? `${models.length} 个可用模型`
          : "这个接口没返回模型列表，直接手填模型名";

  return (
    <div className="ai-setup">
      <div className="ai-setup__group">
        <label className="ai-setup__field">
          <span>接口地址</span>
          <input
            type="text"
            inputMode="url"
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
            onBlur={() => {
              onChange({ ...settings, aiBaseUrl: baseUrl, aiApiKey: apiKey });
              void loadModels(baseUrl, apiKey);
            }}
          />
        </label>
        <label className="ai-setup__field">
          <span>API Key</span>
          <input
            type="password"
            value={apiKey}
            placeholder="sk-…"
            onChange={(event) => setApiKey(event.target.value)}
            onBlur={() => {
              onChange({ ...settings, aiBaseUrl: baseUrl, aiApiKey: apiKey });
              void loadModels(baseUrl, apiKey);
            }}
          />
        </label>
        <p className="ai-setup__note">
          OpenAI 兼容接口。请求经我们的 Worker 转发一次避开跨域，密钥只留在这台设备上。
        </p>
      </div>

      <div className="ai-setup__group">
        <div className="ai-setup__head">
          <h3>模型</h3>
          <button
            type="button"
            className="ai-setup__reload"
            disabled={loading || !baseUrl.trim()}
            onClick={() => void loadModels(baseUrl, apiKey)}
          >
            {loading ? (
              <LoaderCircle size={13} className="is-spinning" />
            ) : null}
            重新拉取
          </button>
        </div>
        <p
          className={`ai-setup__status${error ? " ai-setup__status--error" : ""}`}
        >
          {status}
        </p>

        {models.length ? (
          <>
            {models.length > 8 ? (
              <div className="ai-setup__search">
                <Search size={15} />
                <input
                  type="text"
                  value={query}
                  placeholder="筛选模型"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            ) : null}
            <div className="ai-setup__models">
              {visible.map((model) => (
                <button
                  type="button"
                  key={model}
                  className={`ai-setup__model${settings.aiModel === model ? " is-active" : ""}`}
                  onClick={() => onChange({ ...settings, aiModel: model })}
                >
                  <span>{model}</span>
                  {settings.aiModel === model ? <Check size={16} /> : null}
                </button>
              ))}
              {!visible.length ? (
                <p className="ai-setup__empty">没有匹配「{query}」的模型</p>
              ) : null}
            </div>
          </>
        ) : (
          <label className="ai-setup__field">
            <span>模型名</span>
            <input
              type="text"
              value={settings.aiModel}
              placeholder="gpt-4o-mini"
              onChange={(event) =>
                onChange({ ...settings, aiModel: event.target.value })
              }
            />
          </label>
        )}
      </div>

      <label className="ai-setup__switch">
        <span>
          <strong>深度思考</strong>
          <em>需模型支持，开启后回答里会带上思考过程</em>
        </span>
        <span className="ai-switch">
          <input
            type="checkbox"
            checked={settings.aiDeepThinking}
            onChange={(event) =>
              onChange({ ...settings, aiDeepThinking: event.target.checked })
            }
          />
          <span className="ai-switch__track">
            <span className="ai-switch__thumb" />
          </span>
        </span>
      </label>
    </div>
  );
}

function SettingsPanel({
  settings,
  voices,
  books,
  onChange,
  onClear,
}: {
  settings: ReaderSettings;
  voices: PlayerVoice[];
  books: Book[];
  onChange: (settings: ReaderSettings) => void;
  onClear: () => void;
}) {
  const totalCharacters = books.reduce(
    (sum, book) => sum + book.characterCount,
    0
  );

  return (
    <div className="settings-panel">
      <section className="settings-group">
        <div className="settings-group__title">
          <Home size={18} />
          <h2>书架外观</h2>
        </div>
        <p className="settings-hint">
          只影响主页和书库的底色，跟阅读器内的主题相互独立。
        </p>
        <div className="segmented-control">
          {(
            [
              ["white", "霜白"],
              ["cream", "宣纸"],
              ["black", "墨夜"],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={settings.shellTheme === value ? "is-active" : ""}
              onClick={() => onChange({ ...settings, shellTheme: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group__title">
          <Volume2 size={18} />
          <h2>默认朗读</h2>
        </div>
        <label className="settings-row settings-row--stack">
          <span>
            <strong>朗读音色</strong>
            <small>云端音色更自然，系统语音可离线使用</small>
          </span>
          <select
            value={settings.voiceURI}
            onChange={(event) =>
              onChange({ ...settings, voiceURI: event.target.value })
            }
          >
            <option value="">自动选择（云端晓晓）</option>
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} · {voice.lang}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-row settings-row--stack">
          <span>
            <strong>默认倍速</strong>
            <small>{settings.speechRate.toFixed(1)}×</small>
          </span>
          <input
            type="range"
            min="0.6"
            max="2"
            step="0.1"
            value={settings.speechRate}
            onChange={(event) =>
              onChange({
                ...settings,
                speechRate: Number(event.target.value),
              })
            }
          />
        </label>
      </section>

      <section className="settings-group">
        <div className="settings-group__title">
          <Type size={18} />
          <h2>默认排版</h2>
        </div>
        <div className="segmented-control">
          {READER_THEMES.map((opt) => (
            <button
              type="button"
              key={opt.value}
              className={settings.theme === opt.value ? "is-active" : ""}
              onClick={() => onChange({ ...settings, theme: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="settings-row settings-row--stack">
          <span>
            <strong>正文字体</strong>
            <small>四款 iOS 系统字体，阅读页里可随时切换</small>
          </span>
          <FontPicker
            value={settings.fontFamily}
            onChange={(fontFamily) => onChange({ ...settings, fontFamily })}
          />
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group__title">
          <Sparkles size={18} />
          <h2>AI 助手</h2>
        </div>
        <p className="settings-hint">
          划词问 AI 和整本书的对话都用这里配的模型。
        </p>
        <AiModelPicker settings={settings} onChange={onChange} />
      </section>

      <section className="settings-group">
        <div className="settings-group__title">
          <Download size={18} />
          <h2>本地书库</h2>
        </div>
        <div className="storage-summary">
          <div>
            <strong>{books.length}</strong>
            <span>本书</span>
          </div>
          <div>
            <strong>{formatStorageSize(totalCharacters)}</strong>
            <span>约占文本空间</span>
          </div>
        </div>
        <p className="privacy-note">
          书籍、进度和标记保存在当前浏览器中，不会由本项目上传。
        </p>
        <button type="button" className="danger-button" onClick={onClear}>
          <Trash2 size={17} />
          清空本地书库
        </button>
      </section>

      <p className="app-version">墨听阅读器 · 本地版 1.0</p>
    </div>
  );
}

const HEADING_TAGS = ["h2", "h2", "h3", "h4", "h5", "h6"] as const;

/** 连续滚动时最多同时挂在 DOM 里的章节数。整本全渲染的话上百章会有几万个句子 span。 */
const CHAPTER_WINDOW = 5;
/** 离顶／底还有这么多像素就把相邻章接上，留够缓冲才不会滑到白屏。 */
const CHAPTER_LOAD_MARGIN = 1200;

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
  const [url, setUrl] = useState("");

  useEffect(() => {
    let objectUrl = "";
    getBookImage(imageId)
      .then((image) => {
        if (!image) return;
        objectUrl = URL.createObjectURL(image.blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId]);

  // 图片是异步从本地库里取的。宽高提前写在 img 上，浏览器就按这个比例先把版面占住，
  // 图到了只是填进已经量好的位置，下方正文一个像素都不动。
  // alt 要等图片到位再给，否则空 img 会把 alt 文案当占位内容画出来。
  return (
    <figure className="reader-block is-image">
      {/* IndexedDB 返回的是 blob URL，不能交给 next/image 的远程优化器。 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url || undefined}
        alt={url ? alt : ""}
        width={width}
        height={height}
        loading="lazy"
      />
    </figure>
  );
});

interface ArticleBodyProps {
  paged: boolean;
  book: Book;
  chapter: Chapter;
  settings: ReaderSettings;
  visibleChapters: { chapter: Chapter; index: number }[];
  sentenceIndexByChapter: Map<number, Map<string, number>>;
  marksBySentence: Map<string, BookNote[]>;
  currentSentenceId: string;
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
  chapter,
  settings,
  visibleChapters,
  sentenceIndexByChapter,
  marksBySentence,
  currentSentenceId,
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

  return (
    <>
      {paged ? null : (
        <div ref={startSentinelRef} className="reader-sentinel" aria-hidden />
      )}

      {visibleChapters.map(({ chapter: item, index }) => {
        const indexById = sentenceIndexByChapter.get(index);
        return (
          <section
            key={item.id}
            className="reader-chapter"
            data-chapter-section={index}
          >
            <div className="reader-title">
              <h1>{item.title}</h1>
              <span className="reader-title__ornament" aria-hidden />
            </div>

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

              const sentenceSpans = paragraph.sentences.map((sentence) => (
                <span
                  key={sentence.id}
                  data-sentence-id={sentence.id}
                  data-sentence-index={indexById?.get(sentence.id)}
                  data-chapter-index={index}
                  className={[
                    sentence.id === currentSentenceId ? "is-speaking" : "",
                    askingIds.has(sentence.id) ? "is-asking" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {renderSentence(
                    sentence.text,
                    marksBySentence.get(sentence.id) ?? []
                  )}
                </span>
              ));

              // 批注挂在选区最后一句所在的段落后面：往下长不会推动正在读的这段。
              const inlineCard =
                inlineAsk &&
                paragraph.sentences.some((s) => s.id === inlineAsk.anchorId) ? (
                  <AiInlineAsk
                    text={inlineAsk.text}
                    book={book}
                    chapter={chapter}
                    settings={settings}
                    turns={chatTurns}
                    onTurnsChange={onChatChange}
                    onExpand={onInlineExpand}
                    onClose={onInlineClose}
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
                const Heading =
                  HEADING_TAGS[(paragraph.level ?? 3) - 1] ?? "h3";
                return withCard(
                  <Heading
                    key={paragraph.id}
                    className="reader-block is-heading"
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
                  >
                    {sentenceSpans}
                  </blockquote>
                );
              }
              return withCard(
                <p
                  key={paragraph.id}
                  className={`reader-block ${
                    paragraph.kind === "list" ? "is-list" : ""
                  }`}
                >
                  {sentenceSpans}
                </p>
              );
            })}
          </section>
        );
      })}

      {showEnd ? (
        <div className="reader-end">
          <span>全书完</span>
          <p>{book.title}</p>
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
      onPointerDown={(event) => {
        // 桌面按按钮时保留原生选区，避免 selectionchange 把菜单先卸载。
        if (event.pointerType === "mouse") event.preventDefault();
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

/** 认定滚动方向所需的最小位移，低于这个数的抖动和回弹不算。 */
const BAR_SCROLL_THRESHOLD = 12;
/** 顶部这一段内不收顶栏，免得刚往下拨一点顶栏就跑了。 */
const BAR_HIDE_AFTER = 48;

/** 起手提问：拿真实的书名和章节标题拼，只是把常问的几件事摆出来，不编造内容。 */
function starterPrompts(
  book: Book,
  chapter: Chapter | undefined,
  hasQuote: boolean
) {
  if (hasQuote) return ["这段在说什么", "举个例子", "和前后文什么关系"];
  const list = ["这本书主要在讲什么"];
  if (chapter) list.push(`讲讲《${chapter.title}》这一章`);
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
}: {
  book: Book;
  chapter: Chapter | undefined;
  settings: ReaderSettings;
  history: AiChatTurn[];
  signal: AbortSignal;
  /** 正文批注只是页边的一小块，长篇大论会把正文淹掉，所以额外要一句简短。 */
  brief?: boolean;
  onDelta: (delta: { content?: string; reasoning?: string }) => void;
}) {
  const toc = book.chapters.map((c, i) => `${i + 1}. ${c.title}`).join("\n");
  const chapterTitle = chapter?.title ?? "正文";
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
      deepThinking: settings.aiDeepThinking,
      signal,
      messages: [
        {
          role: "system",
          content: `你是《${book.title}》的阅读助手。\n全书目录：\n${toc}${chapterContext}\n\n请结合以上内容和对话上下文简洁作答，除非用户要求，不必逐句复述原文。\n如有需要可使用 Markdown 格式（标题、加粗、列表、代码块等）让回答更清晰，但不必为简短回答刻意加格式。${brief ? "\n这次回答显示在正文旁边的批注里，控制在 200 字以内，直接说结论，不要用标题。" : ""}`,
        },
        ...history.map((turn) => ({
          role: turn.role,
          content: turn.quote
            ? `引用原文：\n${turn.quote}\n\n${turn.content}`
            : turn.content,
        })),
      ],
    },
    onDelta
  );
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
  book: Book;
  chapter: Chapter | undefined;
  settings: ReaderSettings;
  onClose: () => void;
}) {
  const configured = Boolean(settings.aiBaseUrl && settings.aiModel);
  const [turns, setTurns] = useState<AiChatTurn[]>(initialTurns);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showReasoning, setShowReasoning] = useState(true);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const barHiddenRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const streamTextRef = useRef({ content: "", reasoning: "" });
  const streamFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);

  useScrollLock();
  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (streamFrameRef.current !== null) {
        window.cancelAnimationFrame(streamFrameRef.current);
      }
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    []
  );

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
  useEffect(() => {
    // 只滚消息区自己。scrollIntoView 会把所有可滚祖先一起滚，连带把整页拖走。
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  }, [turns]);

  const scheduleStreamRender = useCallback(() => {
    if (streamFrameRef.current !== null) return;
    streamFrameRef.current = window.requestAnimationFrame(() => {
      streamFrameRef.current = null;
      const { content, reasoning } = streamTextRef.current;
      setTurns((prev) => {
        if (!prev.length) return prev;
        const next = [...prev];
        next[next.length - 1] = { role: "assistant", content, reasoning };
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
  const ask = async (preset?: string) => {
    if (busy || !configured) return;
    const userText =
      (preset ?? question).trim() || (isFreshQuote ? "帮我讲讲这段话" : "");
    if (!userText) return;
    const userTurn: AiChatTurn = {
      role: "user",
      content: userText,
      ...(isFreshQuote ? { quote: text } : {}),
    };
    const history: AiChatTurn[] = [...turns, userTurn];
    setTurns([...history, { role: "assistant", content: "", reasoning: "" }]);
    setQuestion("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setBusy(true);
    setError("");
    const controller = new AbortController();
    controllerRef.current = controller;
    let content = "";
    let reasoning = "";
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
      setTurns([...history, { role: "assistant", content, reasoning }]);
      setBusy(false);
      onTurnsChange([...history, { role: "assistant", content, reasoning }]);
    }
  };

  return (
    <div
      className="ai-chat"
      ref={chatRef}
      role="dialog"
      aria-modal="true"
      aria-label="问 AI"
    >
      {/* 没有标题栏：内容一路铺到屏幕最顶，只留一枚浮在角上的关闭当退路，
          往下滚时连它也收掉。 */}
      <button
        type="button"
        className="ai-chat__close"
        aria-label="关闭"
        onClick={onClose}
      >
        <X size={20} />
      </button>

      <div
        className="ai-chat__scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          const last = lastScrollTopRef.current;
          // 抖动和回弹都会触发 scroll，走够一段才认方向。
          if (Math.abs(top - last) < BAR_SCROLL_THRESHOLD) return;
          lastScrollTopRef.current = top;
          const hidden = top > last && top > BAR_HIDE_AFTER;
          if (hidden === barHiddenRef.current) return;
          barHiddenRef.current = hidden;
          // 走 DOM 属性而不是 state：滚动中重渲染整个面板（一堆 Markdown）就是卡顿本身。
          chatRef.current?.toggleAttribute("data-immersive", hidden);
        }}
      >
        <div className="ai-chat__thread">
          {isFreshQuote ? (
            <section className="ai-chat__source">
              <span>正在讨论</span>
              <blockquote className="ai-ask__quote">{text}</blockquote>
            </section>
          ) : null}

          {!turns.length ? (
            <div className="ai-chat__intro">
              {isFreshQuote ? null : (
                <>
                  <strong>聊聊这本书</strong>
                  {/* 没配模型时下面那张提示卡已经把话说完了，别再来一句同义的。 */}
                  {configured ? (
                    <p>《{book.title}》里的观点、人物、细节，想到哪问到哪。</p>
                  ) : null}
                </>
              )}
              {configured ? (
                <div className="ai-chat__starters">
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
              ) : (
                <p className="ai-chat__unset">
                  <Layers size={15} />
                  还没配模型。去主页右上角的设置里，「AI 助手」那一栏填一次就好。
                </p>
              )}
            </div>
          ) : null}

          {turns.map((turn, index) =>
            turn.role === "user" ? (
              <div className="ai-ask__turn-user" key={index}>
                {turn.quote ? (
                  <blockquote className="ai-ask__quote ai-ask__quote--sent">
                    {turn.quote}
                  </blockquote>
                ) : null}
                <p className="ai-ask__question">{turn.content}</p>
              </div>
            ) : (
              <div className="ai-ask__turn-assistant" key={index}>
                {turn.reasoning ? (
                  <div className="ai-ask__reasoning">
                    <button
                      type="button"
                      className="ai-ask__reasoning-toggle"
                      onClick={() => setShowReasoning((value) => !value)}
                    >
                      <ChevronDown
                        size={14}
                        style={{
                          transform: showReasoning ? "rotate(0deg)" : "rotate(-90deg)",
                        }}
                      />
                      思考过程
                    </button>
                    {showReasoning ? <p className="ai-ask__reasoning-text">{turn.reasoning}</p> : null}
                  </div>
                ) : null}
                {turn.content || busy ? (
                  <div className="ai-ask__answer">
                    {turn.content ? <AiMarkdown content={turn.content} /> : null}
                    {busy && !turn.content && index === turns.length - 1 ? (
                      <span className="ai-chat__thinking" aria-label="正在思考">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {turn.content && !(busy && index === turns.length - 1) ? (
                  <button
                    type="button"
                    className="ai-ask__copy"
                    onClick={() => void copyAnswer(index, turn.content)}
                    aria-label={copiedIndex === index ? "已复制" : "复制回答"}
                  >
                    {copiedIndex === index ? (
                      <>
                        <Check size={14} />
                        已复制
                      </>
                    ) : (
                      <>
                        <Copy size={14} />
                        复制
                      </>
                    )}
                  </button>
                ) : null}
              </div>
            )
          )}
        </div>
      </div>

      {error ? <p className="ai-chat__error">{error}</p> : null}

      <div className="ai-chat__composer">
        {/* 单行输入条：文字和发送键并排。模型配置搬去主页设置之后，这里不再
            需要第二行，输入区高度直接砍掉一半。 */}
        <div
          className={`ai-chat__input${busy || canSend ? "" : " is-bare"}`}
        >
          <textarea
            ref={inputRef}
            rows={1}
            placeholder={isFreshQuote ? "留空就是让 AI 讲讲这段话" : "发消息或输入问题..."}
            value={question}
            onChange={(event) => {
              setQuestion(event.target.value);
              event.currentTarget.style.height = "auto";
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`;
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void ask();
              }
            }}
          />
          {/* 没东西可发就整个不渲染发送键，右侧的内缩由 is-bare 补齐。 */}
          {busy || canSend ? (
            <button
              type="button"
              className="ai-chat__send"
              onClick={() => {
                if (busy) controllerRef.current?.abort();
                else void ask();
              }}
              aria-label={busy ? "停止回答" : "发送"}
            >
              {busy ? <Square size={14} fill="currentColor" /> : <ArrowUp size={20} />}
            </button>
          ) : null}
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
  book: Book;
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
      { role: "user", content: userText, quote: text },
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
      });
    } catch (err) {
      if (err instanceof AiRequestError) setError(err.message);
      else if ((err as Error)?.name !== "AbortError") setError("请求失败，稍后再试");
    } finally {
      setBusy(false);
      // 这一轮照样进这本书的常驻对话，正文里的批注只是它的即时视图。
      onTurnsChange([...history, { role: "assistant", content, reasoning }]);
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
          {answer ? <AiMarkdown content={answer} /> : null}
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
        </div>
      ) : null}
    </aside>
  );
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
function latestPosition(book: Book): BookPosition | undefined {
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

  // 滚动模式是连续阅读：range 覆盖的这几章一起挂在 DOM 里，滑到边缘再往外接一章、
  // 从另一头摘掉一章。分页模式仍旧一次只排当前这一章。
  const [range, setRange] = useState({
    start: initial.chapterIndex,
    end: initial.chapterIndex,
  });
  const rangeRef = useRef(range);

  const visibleChapters = useMemo(() => {
    if (paged) return chapter ? [{ chapter, index: chapterIndex }] : [];
    return book.chapters
      .slice(range.start, range.end + 1)
      .map((item, offset) => ({ chapter: item, index: range.start + offset }));
  }, [paged, chapter, chapterIndex, book.chapters, range.start, range.end]);

  const sentenceIndexByChapter = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const { chapter: item, index } of visibleChapters) {
      const inner = new Map<string, number>();
      flattenChapter(item).forEach((sentence, i) => inner.set(sentence.id, i));
      map.set(index, inner);
    }
    return map;
  }, [visibleChapters]);
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
      progressRef.current(positionFor(bookRef.current, chapterIndex, index));
    }, 320);
    return () => clearTimeout(timer);
  }, [paged, pageIndex, pageStep, pageCount, chapterIndex]);

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
          const byLine = sentenceCrossing(hit, y);
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

    const schedule = () => {
      // 当场先量一份快照：卸载时（退出阅读器、切书）effect 清理跑在 DOM 拆掉之后，
      // 那时再量是量不到的，只能靠这份快照把最后这一下补写进去。
      const snapshot = measureAnchor();
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingSave = snapshot ? () => commitAnchor(snapshot) : null;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        pendingSave = null;
        // 正常路径按停下来那一刻重新量一次，比快照更准。
        saveAnchor();
      }, 400);
    };

    // observer 只当「跨章了」的触发器；真正决定存什么的是停下来那一刻的锚点线。
    const observer = new IntersectionObserver(schedule, {
      rootMargin: "-90px 0px -58% 0px",
      threshold: 0.15,
    });
    // 手指停住时未必有元素跨过观察带，那样 observer 不会再响，进度就停在半路。
    // 滚动本身才是「位置变了」最可靠的信号。
    window.addEventListener("scroll", schedule, { passive: true });
    articleRef.current
      .querySelectorAll("[data-sentence-id]")
      .forEach((element) => observer.observe(element));
    return () => {
      window.removeEventListener("scroll", schedule);
      // 卸载前如果还有没落盘的最新位置（防抖还没到），立即量一次存掉，
      // 不能让 clearTimeout 把用户刚读到的地方悄悄扔了。
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingSave?.();
      }
      observer.disconnect();
    };
    // 重挂观察器只该发生在被观察的句子元素本身换了的时候：换书，或者窗口挪了。
  }, [book.id, paged, range.start, range.end]);

  // 接章／摘章都会改变正文上方的高度，不补偿的话页面会当场跳一下。
  // 先记住视口里第一章的位置，重排后按它的位移把滚动条推回去。
  const anchorRef = useRef<{ index: number; top: number } | null>(null);
  const captureAnchor = () => {
    const sections = articleRef.current?.querySelectorAll<HTMLElement>(
      "[data-chapter-section]"
    );
    if (!sections) return;
    for (const section of sections) {
      const rect = section.getBoundingClientRect();
      if (rect.bottom > 0) {
        anchorRef.current = {
          index: Number(section.dataset.chapterSection),
          top: rect.top,
        };
        return;
      }
    }
  };

  useLayoutEffect(() => {
    rangeRef.current = range;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!anchor) return;
    const section = articleRef.current?.querySelector<HTMLElement>(
      `[data-chapter-section="${anchor.index}"]`
    );
    if (!section) return;
    const delta = section.getBoundingClientRect().top - anchor.top;
    if (delta) window.scrollBy(0, delta);
  }, [range]);

  // 换窗口之后才知道目标元素在哪，所以跳转的滚动必须等这次提交落地再做，而且得是瞬时的。
  // 在点击事件里同步发平滑滚动，动画是照着旧窗口的文档高度跑的；等它跑到一半，头部哨兵
  // 已经把上一章补了回来，补偿用的 scrollBy 又会按规范中止这段动画，最后停在半路。
  const pendingScrollRef = useRef<{
    selector: string;
    block: ScrollLogicalPosition;
  } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    pendingScrollRef.current = null;
    articleRef.current
      ?.querySelector<HTMLElement>(pending.selector)
      ?.scrollIntoView({ block: pending.block });
  }, [range]);

  // 跳章落地时目标章节的开头正好贴着视口顶部，头部哨兵这一下会"碰巧"进缓冲区，
  // 但这不是用户在往上翻，是刚跳过去的假象。哨兵观察器重新订阅后的第一次回调只是
  // 报告落地瞬间的状态，不是真的滚动触发，得跳过，否则会把跳转前一章接回来，
  // 看起来就像跳章跳错到了上一章。
  const justJumpedRef = useRef(false);

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
    const element = articleRef.current?.querySelector<HTMLElement>(selector);
    if (element) {
      element.scrollIntoView({ block: "center" });
      return;
    }
    // 朗读已经走到窗口之外的章去了，先按那一章重新开窗，落地后再滚过去。
    anchorRef.current = null;
    pendingScrollRef.current = { selector, block: "center" };
    const next = { start: speakingChapterIndex, end: speakingChapterIndex };
    rangeRef.current = next;
    setRange(next);
  };

  // 正文两端各放一个哨兵，进到缓冲区就接下一章。用 observer 而不是 scroll 事件，
  // 免得每次滚动都去读 scrollHeight 触发同步布局。
  const startSentinelRef = useRef<HTMLDivElement>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paged) return;
    const article = articleRef.current;
    const startEl = startSentinelRef.current;
    const endEl = endSentinelRef.current;
    if (!article || !startEl || !endEl) return;
    if (!("IntersectionObserver" in window)) return;
    const last = book.chapters.length - 1;

    const rectOf = (index: number) =>
      article
        .querySelector<HTMLElement>(`[data-chapter-section="${index}"]`)
        ?.getBoundingClientRect() ?? null;

    const observer = new IntersectionObserver(
      (entries) => {
        // 拖选期间保留当前章节 DOM，避免窗口裁剪删掉仍在选区里的起点。
        if (selectionActiveRef.current) return;
        if (justJumpedRef.current) {
          justJumpedRef.current = false;
          return;
        }
        const current = rangeRef.current;
        const hit = (target: Element) =>
          entries.some((entry) => entry.target === target && entry.isIntersecting);

        const next = nextChapterRange(current, {
          lastChapter: last,
          hitStart: hit(startEl),
          hitEnd: hit(endEl),
          firstBottom: rectOf(current.start)?.bottom ?? null,
          lastTop: rectOf(current.end)?.top ?? null,
          viewportHeight: window.innerHeight,
          margin: CHAPTER_LOAD_MARGIN,
          windowSize: CHAPTER_WINDOW,
        });
        if (next === current) return;
        captureAnchor();
        rangeRef.current = next;
        setRange(next);
      },
      { rootMargin: `${CHAPTER_LOAD_MARGIN}px 0px` }
    );
    observer.observe(startEl);
    observer.observe(endEl);
    return () => observer.disconnect();
  }, [paged, book.chapters.length, range, textSelection.active]);

  // 换书或切换阅读模式时重新以当前章开窗，别把旧窗口带过去。
  useEffect(() => {
    const reset = { start: chapterIndex, end: chapterIndex };
    rangeRef.current = reset;
    // 这里是在换书／切模式后同步重置窗口，避免旧章节窗口短暂残留。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRange(reset);
    justJumpedRef.current = false;
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
    // 跳章是重新开窗，不是接章，所以这里不做锚点补偿，直接回到章首。
    anchorRef.current = null;
    rangeRef.current = { start: safe, end: safe };
    setRange({ start: safe, end: safe });
    // 分页模式靠平移正文切页，不动滚动条。
    if (!paged) {
      pendingScrollRef.current = {
        selector: `[data-chapter-section="${safe}"]`,
        block: "start",
      };
      justJumpedRef.current = true;
      // 目录之类的浮层通常是"点了就关"，关闭动作会触发 useScrollLock 把滚动位置
      // 还原到开浮层前——但这里已经跳到新章节了，不能被那次还原覆盖回旧位置。
      if (scrollLockCount > 0) suppressScrollRestore();
    }
  }, [clearTextSelection, goToPage, onProgress, paged]);

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
      if (event.metaKey || event.ctrlKey || event.altKey) return;
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

  const readerStyle = {
    "--reader-font-size": `${settings.fontSize}px`,
    "--reader-line-height": String(settings.lineHeight),
    "--reader-width": `${settings.contentWidth}px`,
  } as CSSProperties;

  const remainingPages = Math.max(0, pageCount - pageIndex - 1);
  const readPercent = Math.round(
    book.readingPosition?.percent ?? initial.percent ?? 0
  );

  // 目录与页脚用的全书绝对页码：按当前排版估算，改字号／转窗会跟着重算。
  const pagination = useMemo(
    () =>
      estimatePagination(book, settings, {
        width: typeof window === "undefined" ? 390 : window.innerWidth,
        height: typeof window === "undefined" ? 844 : window.innerHeight,
      }),
    [book, settings]
  );
  const currentPage = pageAt(
    pagination,
    chapterIndex,
    book.readingPosition?.chapterIndex === chapterIndex
      ? book.readingPosition.sentenceIndex
      : 0,
    chapter?.sentenceCount ?? 0
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
          chapter={chapter}
          settings={settings}
          visibleChapters={visibleChapters}
          sentenceIndexByChapter={sentenceIndexByChapter}
          marksBySentence={marksBySentence}
          currentSentenceId={currentSentenceId}
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
                <strong>{book.title}</strong>
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
              {book.chapters.map((item, index) => {
                const active = index === chapterIndex;
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`toc__item ${active ? "is-active" : ""}`}
                    onClick={() => {
                      changeChapter(index);
                      setShowChapters(false);
                    }}
                  >
                    <span className="toc__title">{item.title}</span>
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
              <input
                className="rset-slider"
                type="range"
                min="1.4"
                max="2.4"
                step="0.1"
                value={settings.lineHeight}
                onChange={(event) =>
                  applySettings({
                    ...settings,
                    lineHeight: Number(event.target.value),
                  })
                }
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
  const [viewMode, setViewMode] = useState<"cover" | "text">("cover");

  const activeForBook = player.location?.bookId === book.id;
  const basePosition =
    activeForBook && player.location
      ? positionFor(
          book,
          player.location.chapterIndex,
          player.location.sentenceIndex
        )
      : book.listeningPosition ?? initialPosition(book);
  const chapter = book.chapters[basePosition.chapterIndex];
  const sentences = chapter ? flattenChapter(chapter) : [];
  const sentence = sentences[basePosition.sentenceIndex] ?? sentences[0];
  const playing = activeForBook && player.isPlaying;
  const remaining = remainingCharacters(book, basePosition);
  const elapsed = Math.max(0, book.characterCount - remaining);

  const toggle = () => {
    if (activeForBook && (player.isPlaying || player.isPaused)) player.toggle();
    else player.start(book.id, basePosition);
  };

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

  return (
    <div className="player-screen">
      <header className="player-header">
        <button
          type="button"
          className="icon-button"
          aria-label="返回听书"
          onClick={onBack}
        >
          <ArrowLeft size={21} />
        </button>
        <span>正在收听</span>
        <button
          type="button"
          className="icon-button"
          aria-label="停止播放"
          onClick={player.stop}
        >
          <Square size={17} />
        </button>
      </header>

      <main className="player-main">
        <div className="player-mode-pills">
          <button
            type="button"
            className={viewMode === "cover" ? "is-active" : ""}
            onClick={() => setViewMode("cover")}
          >
            封面
          </button>
          <button
            type="button"
            className={viewMode === "text" ? "is-active" : ""}
            onClick={() => setViewMode("text")}
          >
            文稿
          </button>
        </div>

        {viewMode === "cover" ? (
          <BookCover book={book} size="large" />
        ) : (
          <div className="player-transcript-inline">
            {sentences
              .slice(
                Math.max(0, basePosition.sentenceIndex - 1),
                basePosition.sentenceIndex + 2
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

        <div className="player-title">
          <h1>{book.title}</h1>
          <p>{chapter?.title ?? "正文"}</p>
        </div>

        <div className="player-icon-row">
          <button type="button" onClick={() => setShowSleep(true)}>
            <Clock3 size={20} />
            <small>
              {player.sleepMode === "off"
                ? "定时关闭"
                : player.sleepMode === "chapter"
                  ? "本章结束"
                  : `${player.sleepMode} 分钟`}
            </small>
          </button>
          <button type="button" onClick={openVoicePanel}>
            <Volume2 size={20} />
            <small>{player.pendingVoiceURI && activeForBook ? "切换中" : "音色"}</small>
          </button>
          <button type="button" onClick={openVoicePanel}>
            <Gauge size={20} />
            <small>{settings.speechRate.toFixed(1)}×</small>
          </button>
          <div className="player-icon-row__static" aria-label="已加入书架">
            <BookmarkCheck size={20} />
            <small>已加入</small>
          </div>
        </div>

        <div className="player-progress">
          <ProgressBar value={basePosition.percent} />
          <div>
            <span>{formatReadingTime(elapsed)}</span>
            <span>剩余{formatReadingTime(remaining)}</span>
          </div>
        </div>

        <div className="player-controls">
          <button
            type="button"
            className="player-controls__text"
            onClick={() => onOpenReader(basePosition)}
          >
            <BookOpen size={19} />
            <small>原文</small>
          </button>
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
              <LoaderCircle className="player-buffering-icon" size={31} />
            ) : playing ? (
              <Pause size={33} fill="currentColor" />
            ) : (
              <Play size={34} fill="currentColor" />
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
          <button
            type="button"
            className="player-controls__text"
            onClick={() => setShowChapters(true)}
          >
            <List size={19} />
            <small>{book.chapters.length} 章</small>
          </button>
        </div>

        {player.isBuffering && activeForBook ? (
          <p className="player-preparing">正在准备音频，很快就会开始…</p>
        ) : player.error && activeForBook ? (
          <p className="player-error">{player.error}</p>
        ) : null}

        <button
          type="button"
          className="view-current-text"
          onClick={() => onAddNote(basePosition, sentence?.text ?? "听书标记")}
        >
          <Bookmark size={15} />
          标记这一句
        </button>
        <p className="sync-status">
          已记录听书位置 · 第 {basePosition.sentenceIndex + 1} 句
        </p>
      </main>

      {showChapters ? (
        <Modal title="章节列表" onClose={() => setShowChapters(false)}>
          <div className="chapter-list" ref={chapterListRef}>
            {book.chapters.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={index === basePosition.chapterIndex ? "is-active" : ""}
                onClick={() => {
                  player.start(book.id, positionFor(book, index, 0));
                  setShowChapters(false);
                }}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{item.title}</strong>
                {index === basePosition.chapterIndex ? (
                  <Volume2 size={17} />
                ) : null}
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
              <input
                type="range"
                min="0.6"
                max="2"
                step="0.1"
                value={settings.speechRate}
                onChange={(event) =>
                  onSettingsChange({
                    ...settings,
                    speechRate: Number(event.target.value),
                  })
                }
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
              <button
                type="button"
                className={!settings.voiceURI ? "is-active" : ""}
                onClick={() =>
                  onSettingsChange({ ...settings, voiceURI: "" })
                }
              >
                <span>
                  <strong>自动选择</strong>
                  <small>默认使用云端自然人声</small>
                </span>
                {!settings.voiceURI ? <Check size={18} /> : null}
              </button>
              {player.voices.map((voice) => {
                const chosen = settings.voiceURI === voice.voiceURI;
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
  isPlaying,
  isBuffering,
  onToggle,
  onOpen,
  onStop,
}: {
  book: Book;
  chapterTitle: string;
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
          <strong>{book.title}</strong>
          <small>{chapterTitle}</small>
        </span>
      </button>
      <button
        type="button"
        className="icon-button"
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
  useViewportFill();
  const [books, setBooks] = useState<Book[]>([]);
  const [notes, setNotes] = useState<BookNote[]>([]);
  const [chats, setChats] = useState<BookAiChat[]>([]);
  // 从「笔记」Tab 的历史入口点开的书，跟 view 无关，纯弹层状态。
  const [chatBook, setChatBook] = useState<Book | null>(null);
  const [settings, setSettings] =
    useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [stats, setStats] = useState<ReadingStats>(DEFAULT_STATS);
  const [sessions, setSessions] = useState<ReadingSession[]>([]);
  // 导航接在 History API 上：返回回到来处、刷新/被系统回收后还在原地、
  // 系统返回手势也能用。切板块是平级移动，下钻才进历史栈。
  const { view, navigate, selectTab, replace: replaceView, goBack } =
    useAppNavigation();
  const [showSettings, setShowSettings] = useState(false);
  const [ready, setReady] = useState(false);
  const [importProgress, setImportProgress] =
    useState<ImportProgress | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [thoughtTarget, setThoughtTarget] = useState<BookNote | null>(null);
  const [thoughtDraft, setThoughtDraft] = useState("");
  const [toast, setToast] = useState<{
    message: string;
    undo?: () => void;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number | null>(null);
  const storageErrorRef = useRef(0);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ message });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 2600);
  }, []);

  /**
   * 删除这类操作不拦在前面问「确定吗」，改成先执行、再给一段撤销时间。
   * 常用操作快了一步，真误删也救得回来；确认框只留给删整本书那种不可逆的。
   */
  const showUndoToast = useCallback((message: string, undo: () => void) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ message, undo });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 5200);
  }, []);

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

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getAllBooks(),
      getAllNotes(),
      getAllChats(),
      getSettings(),
      getStats(),
      getAllSessions(),
    ])
      .then(async ([
        storedBooks,
        storedNotes,
        storedChats,
        storedSettings,
        storedStats,
        storedSessions,
      ]) => {
        if (cancelled) return;
        if (!storedBooks.length) {
          const demo = createDemoBook();
          await saveBook(demo);
          storedBooks = [demo];
        }
        setBooks(storedBooks);
        setNotes(storedNotes);
        setChats(storedChats);
        setSettings(storedSettings);
        setStats(storedStats);
        setSessions(storedSessions);
      })
      .catch(() => {
        const demo = createDemoBook();
        setBooks([demo]);
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
  }, []);

  useEffect(() => {
    document.documentElement.dataset.readerTheme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.shell = settings.shellTheme;
  }, [settings.shellTheme]);

  const updateBook = useCallback((updated: Book) => {
    setBooks((current) =>
      current
        .map((book) => (book.id === updated.id ? updated : book))
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    );
    void saveBook(updated).catch((error) => reportStorageError("book", error));
  }, [reportStorageError]);

  // 听书每读一句就回调一次。以前这里直接把整本书 put 回 IndexedDB 并重排书库，
  // 长篇小说等于每几秒克隆上万个句子对象再重渲染整个列表，手机上是肉眼可见的卡顿。
  // 现在内存里立刻更新（高亮要跟上），落盘攒到 20 秒一次，停止/切后台时补写。
  const pendingBookRef = useRef<Book | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const booksRef = useRef(books);
  useEffect(() => {
    booksRef.current = books;
  }, [books]);

  const pendingReadingProgressRef = useRef(
    new Map<
      string,
      { position: BookPosition; lastOpenedAt: number; savedAt: number }
    >()
  );
  const readingUiProgressRef = useRef(new Map<string, number>());
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
          .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
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

  // 这次改动之前导入的书没记插图尺寸，正文里就没法预留位置，图片一加载就把下文推走。
  // 开机后在后台按本补量一次，量到就写回书里，之后再打开这本书版面就是稳的。
  // 补量只在没开着书的时候做：正读着的书突然多出一批插图占位，同样会把正文推走。
  const sizedBooksRef = useRef(new Set<string>());
  const sizingRef = useRef(false);
  const readingBookId =
    view.name === "reader" || view.name === "player" ? view.bookId : "";
  useEffect(() => {
    if (readingBookId || sizingRef.current) return;
    let cancelled = false;
    sizingRef.current = true;
    const sizeImages = async () => {
      try {
        for (const book of booksRef.current) {
          if (sizedBooksRef.current.has(book.id)) continue;
          const sizes = new Map<string, { width: number; height: number }>();
          for (const chapter of book.chapters) {
            for (const paragraph of chapter.paragraphs) {
              const id = paragraph.imageId;
              if (paragraph.kind !== "image" || !id) continue;
              if (paragraph.imageHeight || sizes.has(id)) continue;
              const image = await getBookImage(id).catch(() => undefined);
              const size = image ? await imageSize(image.blob) : null;
              if (cancelled) return;
              if (size) sizes.set(id, size);
            }
          }
          sizedBooksRef.current.add(book.id);
          if (!sizes.size) continue;
          // 量图期间阅读进度可能已经写过一轮，要拿最新的那份来补，别把进度盖回去。
          const latest = booksRef.current.find((item) => item.id === book.id);
          if (latest) updateBook(withImageSizes(latest, sizes));
        }
      } finally {
        if (!cancelled) sizingRef.current = false;
      }
    };
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    const idleWindow = window as Window & {
      requestIdleCallback?: Window["requestIdleCallback"];
      cancelIdleCallback?: Window["cancelIdleCallback"];
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleId = idleWindow.requestIdleCallback(() => void sizeImages(), { timeout: 2000 });
    } else {
      timeoutId = window.setTimeout(() => void sizeImages(), 0);
    }
    return () => {
      cancelled = true;
      if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      sizingRef.current = false;
    };
  }, [books.length, readingBookId, updateBook]);

  const flushListeningProgress = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = pendingBookRef.current;
    pendingBookRef.current = null;
    if (pending) {
      void saveBook(pending).catch((error) => reportStorageError("listening-position", error));
    }
  }, [reportStorageError]);

  const updateListeningProgress = useCallback(
    (bookId: string, position: BookPosition) => {
      const target = booksRef.current.find((book) => book.id === bookId);
      if (!target) return;
      const updated: Book = {
        ...target,
        listeningPosition: position,
        updatedAt: Date.now(),
      };
      pendingBookRef.current = updated;
      setBooks((current) =>
        current.map((book) => (book.id === bookId ? updated : book))
      );
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          const pending = pendingBookRef.current;
          pendingBookRef.current = null;
          if (pending) {
            void saveBook(pending).catch((error) => reportStorageError("listening-position", error));
          }
        }, 20000);
      }
    },
    [reportStorageError]
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

  const player = useSpeechPlayer({
    books,
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
  const selectedBook =
    view.name === "reader" ||
    view.name === "player" ||
    view.name === "book-notes"
      ? books.find((book) => book.id === view.bookId)
      : undefined;

  // 冷启动恢复出来的视图可能指着一本已经删掉的书。下钻页拿不到书就会一路掉进
  // 最后那个兜底分支、显示成笔记页，所以书加载完之后校一次，不对就退回所属板块。
  useEffect(() => {
    if (!ready) return;
    if (
      view.name !== "reader" &&
      view.name !== "player" &&
      view.name !== "book-notes"
    ) {
      return;
    }
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
  const selectedBookNotes = useMemo(
    () =>
      selectedBook
        ? notes.filter((note) => note.bookId === selectedBook.id)
        : [],
    [notes, selectedBook]
  );
  const selectedBookChat = useMemo(
    () => (selectedBook ? chats.find((c) => c.bookId === selectedBook.id) : undefined),
    [chats, selectedBook]
  );

  const updateChat = useCallback((bookId: string, turns: AiChatTurn[]) => {
    const chat: BookAiChat = { bookId, turns, updatedAt: Date.now() };
    setChats((current) => {
      const idx = current.findIndex((c) => c.bookId === bookId);
      if (idx === -1) return [...current, chat];
      const next = [...current];
      next[idx] = chat;
      return next;
    });
    void saveChat(chat).catch((error) => reportStorageError("chat", error));
  }, [reportStorageError]);

  const changeSettings = (next: ReaderSettings) => {
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
  useEffect(() => {
    const root = document.documentElement;
    if (isReading) root.dataset.inReader = "";
    else delete root.dataset.inReader;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]'
    );
    const apply = () => {
      if (!meta) return;
      const color = getComputedStyle(root)
        .getPropertyValue(isReading ? "--reader-background" : "--paper")
        .trim();
      if (!color) return;
      // iOS 从后台切回来会把状态栏刷回 HTML 里那条写死的浅色，露出「白色挡块」。
      // 而 meta.content 还留着上次写进去的正确值，直接再赋一遍同样的字符串 iOS 不认、
      // 不重绘。先塞个不同的值逼它认一次改动，再写回真正的底色，才会重新填色。
      if (meta.content === color) meta.content = "";
      meta.content = color;
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
      delete root.dataset.inReader;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", apply);
      window.removeEventListener("focus", apply);
    };
  }, [isReading, settings.theme, settings.shellTheme]);

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
        const { parseBookFile } = await import("../lib/parsers");
        const { book, images } = await parseBookFile(file, setImportProgress);
        setImportProgress({
          stage: "saving",
          label: "正在保存到本地书架",
          percent: 94,
        });
        await saveImportedBook(book, images);
        setBooks((current) => [book, ...current]);
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
    const { parseBookFile } = await import("../lib/parsers");
    const { book, images } = await parseBookFile(file, (progress) => onProgress(progress.label));
    book.onlineSourceId = sourceId;
    onProgress("正在保存到本地书库…");
    await saveImportedBook(book, images);
    setBooks((current) => [book, ...current]);
  };

  const openReader = (book: Book, position?: BookPosition) => {
    const nextPosition =
      position ??
      pendingReadingProgressRef.current.get(book.id)?.position ??
      book.readingPosition ??
      initialPosition(book);
    const updated: Book = {
      ...book,
      readingPosition: nextPosition,
      lastOpenedAt: Date.now(),
      updatedAt: Date.now(),
    };
    updateBook(updated);
    navigate({ name: "reader", bookId: book.id });
  };

  const openPlayer = (book: Book, startPlaying = false) => {
    navigate({ name: "player", bookId: book.id });
    if (startPlaying) {
      player.start(
        book.id,
        book.listeningPosition ?? book.readingPosition ?? initialPosition(book)
      );
    }
  };

  const addListeningMark = async (
    book: Book,
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
    const patch = (item: BookNote): BookNote => ({
      ...item,
      color: note.color,
      highlightStyle: note.highlightStyle ?? "underline",
      thought: note.thought,
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
    (book: Book, position: BookPosition) => {
      const now = Date.now();
      const nextPosition = { ...position, updatedAt: now };
      pendingReadingProgressRef.current.set(book.id, {
        position: nextPosition,
        lastOpenedAt: now,
        savedAt: now,
      });
      // 进度落盘可以更慢，但界面上的百分比不能等到落盘才动；按半秒节流，
      // 既保住书架上的实时反馈，也不让长文每句都重排整个应用。
      const lastUiUpdate = readingUiProgressRef.current.get(book.id) ?? 0;
      if (now - lastUiUpdate >= 500) {
        readingUiProgressRef.current.set(book.id, now);
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
    try {
      await removeBook(deleteTarget.id);
    } catch (error) {
      reportStorageError("delete-book", error);
      return;
    }
    setBooks((current) =>
      current.filter((book) => book.id !== deleteTarget.id)
    );
    setNotes((current) =>
      current.filter((note) => note.bookId !== deleteTarget.id)
    );
    setChats((current) =>
      current.filter((chat) => chat.bookId !== deleteTarget.id)
    );
    setDeleteTarget(null);
    showToast("书籍及相关标记已删除");
  };

  const restoreNotes = async (restored: BookNote[]) => {
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

  const openNote = (note: BookNote) => {
    const book = books.find((item) => item.id === note.bookId);
    const found = book ? findSentence(book, note.sentenceId) : null;
    if (!book || !found) {
      showToast("这条标记对应的正文已经不存在");
      return;
    }
    const position = positionFor(
      book,
      found.chapterIndex,
      found.sentenceIndex
    );
    openReader(book, position);
  };

  const clearEverything = async () => {
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
    pendingBookRef.current = null;
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
    setBooks([demo]);
    setNotes([]);
    setSettings(DEFAULT_SETTINGS);
    setStats(DEFAULT_STATS);
    setSessions([]);
    setConfirmClear(false);
    setShowSettings(false);
    selectTab("home");
    showToast("本地书库已清空，已保留一份使用指南");
  };

  const activeMainView: MainView =
    view.name === "reader"
      ? "library"
      : view.name === "player"
        ? "listen"
        : view.name === "book-notes"
          ? "notes"
          : view.name === "history"
            ? "home"
            : view.name;

  if (!ready) {
    return (
      <main className="app-loading">
        <div className="app-mark">
          <BookOpen size={25} />
        </div>
        <h1>墨听</h1>
        <p>正在打开你的书架</p>
        <span />
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
      ) : view.name === "player" && selectedBook ? (
        <PlayerScreen
          book={selectedBook}
          settings={settings}
          player={player}
          onBack={() => goBack({ name: "listen" })}
          onOpenReader={(position) => openReader(selectedBook, position)}
          onAddNote={(position, excerpt) =>
            addListeningMark(selectedBook, position, excerpt)
          }
          onSettingsChange={changeSettings}
        />
      ) : (
        <div className="app-frame">
          <div className="desktop-brand">
            <div className="app-mark">
              <BookOpen size={22} />
            </div>
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
            {view.name === "home" ? (
              <HomeScreen
                books={books}
                stats={stats}
                sessions={sessions}
                onOpenReader={(book) => openReader(book)}
                onPlay={(book) => openPlayer(book, true)}
                onOpenPlayer={(book) => openPlayer(book, false)}
                onImport={() => fileInputRef.current?.click()}
                onOpenHistory={() => navigate({ name: "history" })}
                onOpenSettings={() => setShowSettings(true)}
              />
            ) : view.name === "history" ? (
              <HistoryScreen
                sessions={sessions}
                onBack={() => goBack({ name: "home" })}
              />
            ) : view.name === "library" ? (
              <LibraryScreen
                books={books}
                onImport={() => fileInputRef.current?.click()}
                onOnlineImport={handleOnlineImport}
                onOpen={(book) => openReader(book)}
                onPlay={(book) => openPlayer(book, true)}
                onOpenNotes={(book) =>
                  navigate({ name: "book-notes", bookId: book.id })
                }
                onDelete={setDeleteTarget}
              />
            ) : view.name === "listen" ? (
              <ListenScreen
                books={books}
                onPlay={(book) => openPlayer(book, true)}
                onOpenPlayer={(book) => openPlayer(book, false)}
              />
            ) : view.name === "book-notes" && selectedBook ? (
              <BookNotesScreen
                book={selectedBook}
                notes={selectedBookNotes}
                onBack={() => goBack({ name: "library" })}
                onOpen={openNote}
                onDelete={deleteBookNote}
                onEditThought={(note) => {
                  setThoughtTarget(note);
                  setThoughtDraft(note.thought ?? "");
                }}
              />
            ) : (
              <NotesScreen
                notes={notes}
                books={books}
                chats={chats}
                onOpenBook={(book) =>
                  navigate({ name: "book-notes", bookId: book.id })
                }
                onOpenNote={openNote}
                onDelete={deleteBookNote}
                onEditThought={(note) => {
                  setThoughtTarget(note);
                  setThoughtDraft(note.thought ?? "");
                }}
                onOpenChat={setChatBook}
              />
            )}
          </section>

          {activeBook && view.name !== "player" ? (
            <MiniPlayer
              book={activeBook}
              chapterTitle={
                activeBook.chapters[player.location?.chapterIndex ?? 0]?.title ??
                "正文"
              }
              isPlaying={player.isPlaying}
              isBuffering={player.isBuffering}
              onToggle={player.toggle}
              onOpen={() => navigate({ name: "player", bookId: activeBook.id })}
              onStop={player.stop}
            />
          ) : null}
        </div>
      )}

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

      {deleteTarget ? (
        <Modal title="删除这本书？" onClose={() => setDeleteTarget(null)}>
          <div className="confirm-dialog">
            <BookCover book={deleteTarget} size="medium" />
            <p>
              《{deleteTarget.title}》的正文、阅读进度和全部标记都会从当前设备删除。
            </p>
            <div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
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
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirmClear(false)}
              >
                取消
              </button>
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

      {showSettings ? (
        <Modal title="设置" wide onClose={() => setShowSettings(false)}>
          <SettingsPanel
            settings={settings}
            voices={player.voices}
            books={books}
            onChange={changeSettings}
            onClear={() => setConfirmClear(true)}
          />
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
        <div className="toast">
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
