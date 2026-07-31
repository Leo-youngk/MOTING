"use client";

import {
  ArrowLeft,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  FileText,
  Headphones,
  Highlighter,
  Home,
  Library,
  List,
  MoreHorizontal,
  Pause,
  PencilLine,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Square,
  Trash2,
  Type,
  Upload,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSpeechPlayer, type SleepMode } from "../hooks/use-speech-player";
import {
  findSentence,
  flattenChapter,
  formatReadingTime,
  formatRemaining,
  initialPosition,
  makeId,
  nextChapterRange,
  positionFor,
} from "../lib/content";
import { createDemoBook } from "../lib/demo";
import { parseBookFile } from "../lib/parsers";
import {
  clearLibrary,
  getAllBooks,
  getAllNotes,
  getBookImage,
  getSettings,
  getStats,
  removeBook,
  removeNote,
  saveBook,
  saveBookImages,
  saveNote,
  saveSettings,
  saveStats,
} from "../lib/storage";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  dayKey,
  type AppView,
  type Book,
  type BookNote,
  type BookPosition,
  type HighlightColor,
  type ImportProgress,
  type MainView,
  type PlayerVoice,
  type ReaderSettings,
  type ReaderTheme,
  type ReadingStats,
} from "../lib/types";

type ReaderFont = ReaderSettings["fontFamily"];

/** 四款正文字体，全部走 iOS 自带系统字，label 用各自的字体渲染出来给用户比对。 */
const READER_FONTS: { value: ReaderFont; label: string; cssVar: string }[] = [
  { value: "serif", label: "宋体", cssVar: "var(--font-serif)" },
  { value: "sans", label: "黑体", cssVar: "var(--font-sans)" },
  { value: "kai", label: "楷体", cssVar: "var(--font-kai)" },
  { value: "yuan", label: "圆体", cssVar: "var(--font-yuan)" },
];

const READER_THEMES: { value: ReaderTheme; label: string }[] = [
  { value: "paper", label: "纸张" },
  { value: "white", label: "纯白" },
  { value: "night", label: "夜间" },
];

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
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`modal-sheet ${wide ? "modal-sheet--wide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-grabber" />
        <header>
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
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

const GOAL_CHOICES = [5, 10, 15, 20, 30, 45, 60];
const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function formatSpan(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} 时 ${rest} 分` : `${Math.floor(minutes / 60)} 时`;
}

/** 连续天数：今天还没读不算断，从昨天往回数。 */
function readingStreak(days: Record<string, number>, now: number): number {
  const cursor = new Date(now);
  if ((days[dayKey(now)] ?? 0) < 60) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while ((days[dayKey(cursor.getTime())] ?? 0) >= 60) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** 主页看板：一笔圆相当今日进度环，缺口留在右上，下面七道墨痕是这一周。 */
function ReadingBoard({
  stats,
  onGoalChange,
}: {
  stats: ReadingStats;
  onGoalChange: (minutes: number) => void;
}) {
  // 回到主页会重新挂载，所以每次进来都是当天的日期，不用再自己定时刷新。
  const [now] = useState(() => Date.now());
  const todaySeconds = stats.days[dayKey(now)] ?? 0;
  const goalSeconds = stats.goalMinutes * 60;
  const ratio = Math.min(1, todaySeconds / goalSeconds);
  const streak = readingStreak(stats.days, now);
  const total = Object.values(stats.days).reduce((sum, item) => sum + item, 0);

  const week = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(now);
    date.setDate(date.getDate() - (6 - offset));
    return {
      key: dayKey(date.getTime()),
      label: WEEKDAY_LABELS[date.getDay()],
      seconds: stats.days[dayKey(date.getTime())] ?? 0,
      isToday: offset === 6,
    };
  });
  const weekSeconds = week.reduce((sum, item) => sum + item.seconds, 0);

  // 圆相不闭合：环只画满周长的 88%，右上角那道缺口是刻意留白。
  const circumference = 2 * Math.PI * 46;
  const arc = circumference * 0.88;

  const caption =
    todaySeconds < 60
      ? "今日尚未落墨"
      : ratio < 1
        ? "已然入静，再坐片刻"
        : "今日功课已毕";

  return (
    <section className="zen-board">
      <div className="zen-board__ring">
        <svg viewBox="0 0 116 116" aria-hidden>
          <g transform="rotate(-23 58 58)">
            <circle
              className="zen-ring__track"
              cx="58"
              cy="58"
              r="46"
              strokeDasharray={`${arc} ${circumference}`}
            />
            <circle
              className="zen-ring__ink"
              cx="58"
              cy="58"
              r="46"
              strokeDasharray={`${arc * ratio} ${circumference}`}
            />
          </g>
        </svg>
        <div className="zen-ring__center">
          <strong>{Math.floor(todaySeconds / 60)}</strong>
          <small>分钟</small>
        </div>
      </div>

      <div className="zen-board__body">
        <p className="zen-board__caption">{caption}</p>
        <button
          type="button"
          className="zen-board__goal"
          onClick={() =>
            onGoalChange(
              GOAL_CHOICES[
                (GOAL_CHOICES.indexOf(stats.goalMinutes) + 1) %
                  GOAL_CHOICES.length
              ] ?? 20
            )
          }
        >
          每日 {stats.goalMinutes} 分钟 · 轻点调整
        </button>

        <div className="zen-week">
          {week.map((day) => (
            <div
              key={day.key}
              className={`zen-week__day ${day.isToday ? "is-today" : ""}`}
            >
              <span className="zen-week__stroke">
                <i
                  style={{
                    height: `${Math.max(
                      day.seconds ? 8 : 0,
                      Math.min(100, (day.seconds / goalSeconds) * 100)
                    )}%`,
                  }}
                />
              </span>
              <small>{day.label}</small>
            </div>
          ))}
        </div>

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

function HomeScreen({
  books,
  stats,
  onOpenReader,
  onPlay,
  onOpenPlayer,
  onImport,
  onGoalChange,
  onOpenSettings,
}: {
  books: Book[];
  stats: ReadingStats;
  onOpenReader: (book: Book) => void;
  onPlay: (book: Book) => void;
  onOpenPlayer: (book: Book) => void;
  onImport: () => void;
  onGoalChange: (minutes: number) => void;
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

          <ReadingBoard stats={stats} onGoalChange={onGoalChange} />
        </>
      )}
    </div>
  );
}

function LibraryScreen({
  books,
  onImport,
  onOpen,
  onPlay,
  onOpenNotes,
  onDelete,
}: {
  books: Book[];
  onImport: () => void;
  onOpen: (book: Book) => void;
  onPlay: (book: Book) => void;
  onOpenNotes: (book: Book) => void;
  onDelete: (book: Book) => void;
}) {
  const [query, setQuery] = useState("");
  const [sheetBook, setSheetBook] = useState<Book | null>(null);

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

function NotesScreen({
  notes,
  books,
  onOpenBook,
  onOpenNote,
  onEditThought,
  onDelete,
}: {
  notes: BookNote[];
  books: Book[];
  onOpenBook: (book: Book) => void;
  onOpenNote: (note: BookNote) => void;
  onEditThought: (note: BookNote) => void;
  onDelete: (note: BookNote) => void;
}) {
  const [filter, setFilter] = useState<"all" | "highlight" | "thought">("all");

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

  const groups = useMemo(() => {
    const visible = merged.filter((note) => {
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
  }, [books, filter, merged]);

  const highlights = merged.filter((note) => note.kind === "highlight").length;
  const thoughts = merged.filter((note) => note.thought).length;

  if (!notes.length) {
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

      {!groups.length ? (
        <EmptyState
          icon={<Highlighter size={26} />}
          title="这里还是空的"
          description="换个筛选看看，或者回到正文里划一段。"
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
                              : `ink-note__mark ink-note__mark--${note.color ?? "yellow"}`
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
  const visible = notes.filter((note) => {
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

      {!visible.length ? (
        <EmptyState
          icon={<Highlighter size={26} />}
          title="这里还是空的"
          description="换个筛选，或者回到正文里划一段。"
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
          {(["paper", "white", "night"] as const).map((theme) => (
            <button
              type="button"
              key={theme}
              className={settings.theme === theme ? "is-active" : ""}
              onClick={() => onChange({ ...settings, theme })}
            >
              {theme === "paper" ? "纸张" : theme === "white" ? "纯白" : "夜间"}
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
        className={`reader-mark reader-mark--${item.note.color ?? "yellow"} ${
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

function ReaderImage({ imageId, alt }: { imageId: string; alt: string }) {
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

  if (!url) return null;
  return (
    <figure className="reader-block is-image">
      <img src={url} alt={alt} loading="lazy" />
    </figure>
  );
}

type ReaderPopupState =
  | { kind: "selection"; anchor: DOMRect; parts: HighlightPart[]; text: string }
  | { kind: "mark"; anchor: DOMRect; note: BookNote };

/** 划词后浮在选区上方的操作条，交互对齐微信读书。 */
function ReaderPopover({
  popup,
  onHighlight,
  onCopy,
  onThought,
  onListen,
  onDelete,
}: {
  popup: ReaderPopupState;
  onHighlight: (color: HighlightColor) => void;
  onCopy: () => void;
  onThought: () => void;
  onListen: () => void;
  onDelete: () => void;
}) {
  const below = popup.anchor.top < 132;
  const center = popup.anchor.left + popup.anchor.width / 2;
  const style: CSSProperties = {
    left: `${Math.min(Math.max(center, 104), window.innerWidth - 104)}px`,
    top: below ? `${popup.anchor.bottom + 10}px` : `${popup.anchor.top - 10}px`,
  };

  return (
    <div
      className={`reader-popover ${below ? "is-below" : ""}`}
      style={style}
      role="dialog"
      aria-label="划线操作"
    >
      {popup.kind === "mark" ? (
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
      ) : null}

      <div className="reader-popover__actions">
        {popup.kind === "selection" ? (
          <button type="button" onClick={() => onHighlight("yellow")}>
            <Highlighter size={16} />
            划线
          </button>
        ) : null}
        <button type="button" onClick={onThought}>
          <PencilLine size={16} />
          {popup.kind === "mark" && popup.note.thought ? "改想法" : "想法"}
        </button>
        {popup.kind === "selection" ? (
          <>
            <button type="button" onClick={onCopy}>
              <Copy size={16} />
              复制
            </button>
            <button type="button" onClick={onListen}>
              <Headphones size={16} />
              从这里听
            </button>
          </>
        ) : (
          <button type="button" onClick={onDelete}>
            <Trash2 size={16} />
            删除
          </button>
        )}
      </div>
    </div>
  );
}

function ReaderScreen({
  book,
  notes,
  settings,
  currentSentenceId,
  onBack,
  onProgress,
  onStartListening,
  onHighlight,
  onUpdateNote,
  onDeleteNote,
  onSettingsChange,
}: {
  book: Book;
  notes: BookNote[];
  settings: ReaderSettings;
  currentSentenceId: string;
  onBack: () => void;
  onProgress: (position: BookPosition) => void;
  onStartListening: (position: BookPosition) => void;
  onHighlight: (
    parts: HighlightPart[],
    color: HighlightColor
  ) => Promise<BookNote | null>;
  onUpdateNote: (note: BookNote) => void;
  onDeleteNote: (note: BookNote) => void;
  onSettingsChange: (settings: ReaderSettings) => void;
}) {
  const initial = book.readingPosition ?? initialPosition(book);
  const [chapterIndex, setChapterIndex] = useState(initial.chapterIndex);
  const [showChapters, setShowChapters] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // 沉浸阅读：默认露出浮层控件，点空白处收起，只留正文。
  const [chromeVisible, setChromeVisible] = useState(true);
  const [popup, setPopup] = useState<ReaderPopupState | null>(null);
  const [thoughtDraft, setThoughtDraft] = useState<{
    note: BookNote;
    value: string;
  } | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const savedSentenceRef = useRef(initial.sentenceId);
  const paged = settings.readingMode === "page";
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageStep, setPageStep] = useState(0);
  // 连按翻页时 state 还没重渲染，只能靠 ref 记住已经翻到第几页。
  const pageIndexRef = useRef(0);
  const goToPage = (next: number) => {
    pageIndexRef.current = next;
    setPageIndex(next);
  };
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
  ]);

  useEffect(() => {
    if (paged) return;
    const targetId = book.readingPosition?.sentenceId;
    if (!targetId) return;
    const timer = setTimeout(() => {
      articleRef.current
        ?.querySelector<HTMLElement>(`[data-sentence-id="${targetId}"]`)
        ?.scrollIntoView({ block: "center" });
    }, 80);
    return () => clearTimeout(timer);
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
      onProgress(positionFor(book, chapterIndex, index));
    }, 320);
    return () => clearTimeout(timer);
  }, [paged, pageIndex, pageStep, pageCount, book, chapterIndex, onProgress]);

  useEffect(() => {
    if (paged) return;
    if (!articleRef.current || !("IntersectionObserver" in window)) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        const candidates = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) =>
              Math.abs(a.boundingClientRect.top - 150) -
              Math.abs(b.boundingClientRect.top - 150)
          );
        const element = candidates[0]?.target as HTMLElement | undefined;
        const index = Number(element?.dataset.sentenceIndex);
        // 连续滚动里视口内可能横跨两章，章节号只能从元素上读，不能用闭包里的。
        const chIndex = Number(element?.dataset.chapterIndex);
        const id = element?.dataset.sentenceId;
        if (!id || Number.isNaN(index) || Number.isNaN(chIndex)) return;
        setChapterIndex(chIndex);
        if (savedSentenceRef.current === id) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          savedSentenceRef.current = id;
          onProgress(positionFor(book, chIndex, index));
        }, 500);
      },
      { rootMargin: "-90px 0px -58% 0px", threshold: 0.15 }
    );
    articleRef.current
      .querySelectorAll("[data-sentence-id]")
      .forEach((element) => observer.observe(element));
    return () => {
      if (pending) clearTimeout(pending);
      observer.disconnect();
    };
  }, [book, onProgress, paged, range.start, range.end]);

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
  }, [paged, book.chapters.length, range]);

  // 换书或切换阅读模式时重新以当前章开窗，别把旧窗口带过去。
  useEffect(() => {
    const reset = { start: chapterIndex, end: chapterIndex };
    rangeRef.current = reset;
    setRange(reset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, paged]);

  const captureSelection = () => {
    const article = articleRef.current;
    const selection = window.getSelection();
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
      parts,
      text: parts.map((part) => part.text).join(""),
    });
    return true;
  };

  const openMarkPopup = (element: HTMLElement, note: BookNote) => {
    window.getSelection()?.removeAllRanges();
    setPopup({ kind: "mark", anchor: element.getBoundingClientRect(), note });
  };

  /** 同一次划线拆成的几条记录，拼回用户当时选中的那整段文字。 */
  const groupText = (note: BookNote) =>
    mergeNoteGroup(notes.filter((item) => groupKey(item) === groupKey(note)))
      .excerpt;

  const applyHighlight = async (color: HighlightColor) => {
    if (popup?.kind === "mark") {
      onUpdateNote({ ...popup.note, color });
      setPopup(null);
      return;
    }
    if (popup?.kind !== "selection") return;
    const created = await onHighlight(popup.parts, color);
    window.getSelection()?.removeAllRanges();
    setPopup(
      created ? { kind: "mark", anchor: popup.anchor, note: created } : null
    );
  };

  const handleArticleClick = (event: MouseEvent<HTMLElement>) => {
    // 刚翻过页就别再顺手把那一下当成选句子。
    if (turnedRef.current) {
      turnedRef.current = false;
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

  const changeChapter = (nextIndex: number, landing: "first" | "last" = "first") => {
    const safe = Math.max(0, Math.min(book.chapters.length - 1, nextIndex));
    setChapterIndex(safe);
    const position = positionFor(book, safe, 0);
    savedSentenceRef.current = position.sentenceId;
    onProgress(position);
    restoreRef.current = landing === "last" ? "last" : null;
    setPopup(null);
    goToPage(0);
    // 跳章是重新开窗，不是接章，所以这里不做锚点补偿，直接回到章首。
    anchorRef.current = null;
    rangeRef.current = { start: safe, end: safe };
    setRange({ start: safe, end: safe });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const turnPage = (delta: number) => {
    const next = pageIndexRef.current + delta;
    if (next < 0) {
      if (chapterIndex > 0) changeChapter(chapterIndex - 1, "last");
      return;
    }
    if (next >= pageCount) {
      if (chapterIndex < book.chapters.length - 1) changeChapter(chapterIndex + 1);
      return;
    }
    goToPage(next);
  };

  useEffect(() => {
    if (!paged) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") turnPage(1);
      else if (event.key === "ArrowLeft" || event.key === "PageUp") turnPage(-1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const turnedRef = useRef(false);

  // 选区可能是拖动系统选择手柄结束的，那一下不落在正文元素上，只能听 document。
  useEffect(() => {
    const onPointerUp = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest(".reader-popover")) {
        return;
      }
      window.setTimeout(captureSelection, 10);
    };
    document.addEventListener("pointerup", onPointerUp);
    return () => document.removeEventListener("pointerup", onPointerUp);
  });

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

  useEffect(() => {
    setPopup(null);
  }, [pageIndex]);

  // 浮条是 fixed 定位、锚点是划线那一刻的视口坐标，一滚就会飘到别的句子上面去。
  useEffect(() => {
    if (!popup) return;
    const onScroll = (event: Event) => {
      if ((event.target as HTMLElement | null)?.closest?.(".reader-popover")) {
        return;
      }
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
    swipeRef.current = { x: event.clientX, y: event.clientY };
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    // 正在划词就别把这一下当成翻页手势。
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (!paged || !start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
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

  const readerStyle = {
    "--reader-font-size": `${settings.fontSize}px`,
    "--reader-line-height": String(settings.lineHeight),
    "--reader-width": `${settings.contentWidth}px`,
  } as CSSProperties;

  const remainingPages = Math.max(0, pageCount - pageIndex - 1);
  const readPercent = Math.round(
    book.readingPosition?.percent ?? initial.percent ?? 0
  );

  return (
    <div
      className={`reader-shell reader-theme--${settings.theme} ${
        paged ? "is-paged" : "is-scroll"
      } ${chromeVisible ? "" : "chrome-hidden"}`}
      style={readerStyle}
    >
      <div className="reader-chrome reader-chrome--top">
        <button
          type="button"
          className="reader-chrome__chapter"
          onClick={() => setShowChapters(true)}
        >
          <span>{chapter?.title ?? "正文"}</span>
          <ChevronDown size={15} />
        </button>
        <span className="reader-chrome__remain">
          {paged ? `本章还剩 ${remainingPages} 页` : ""}
        </span>
        <button
          type="button"
          className="reader-chrome__close"
          aria-label="返回书架"
          onClick={onBack}
        >
          <X size={20} />
        </button>
      </div>

      <div
        className="reader-viewport"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
      >
        <article
          ref={articleRef}
          className={`reader-article is-font-${settings.fontFamily}`}
          style={
            paged
              ? { transform: `translateX(${-pageIndex * pageStep}px)` }
              : undefined
          }
          onClick={handleArticleClick}
        >
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
                <span>
                  {String(index + 1).padStart(2, "0")} /{" "}
                  {String(book.chapters.length).padStart(2, "0")}
                </span>
                <h1>{item.title}</h1>
                {index === 0 ? <p>{book.title}</p> : null}
              </div>

              {item.paragraphs.map((paragraph) => {
                if (paragraph.kind === "image") {
                  return (
                    <ReaderImage
                      key={paragraph.id}
                      imageId={paragraph.imageId ?? ""}
                      alt={paragraph.alt ?? ""}
                    />
                  );
                }

                const sentenceSpans = paragraph.sentences.map((sentence) => (
                  <span
                    key={sentence.id}
                    data-sentence-id={sentence.id}
                    data-sentence-index={indexById?.get(sentence.id)}
                    data-chapter-index={index}
                    className={
                      sentence.id === currentSentenceId ? "is-speaking" : ""
                    }
                  >
                    {renderSentence(
                      sentence.text,
                      marksBySentence.get(sentence.id) ?? []
                    )}
                  </span>
                ));

                if (paragraph.kind === "heading") {
                  // 章节名已经占了 h1，章内小标题从 h2 起排。
                  const Heading =
                    HEADING_TAGS[(paragraph.level ?? 3) - 1] ?? "h3";
                  return (
                    <Heading
                      key={paragraph.id}
                      className="reader-block is-heading"
                    >
                      {sentenceSpans}
                    </Heading>
                  );
                }
                if (paragraph.kind === "quote") {
                  return (
                    <blockquote
                      key={paragraph.id}
                      className="reader-block is-quote"
                    >
                      {sentenceSpans}
                    </blockquote>
                  );
                }
                return (
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

        {!paged && range.end >= book.chapters.length - 1 ? (
          <div className="reader-end">
            <span>全书完</span>
            <p>{book.title}</p>
          </div>
        ) : null}

        {paged ? null : (
          <div ref={endSentinelRef} className="reader-sentinel" aria-hidden />
        )}
        </article>
      </div>

      <div className="reader-chrome reader-chrome--bottom">
        <span className="reader-chrome__pos">
          {paged ? `${pageIndex + 1} / ${pageCount} 页` : `已读 ${readPercent}%`}
        </span>
        <button
          type="button"
          className="reader-chrome__menu"
          aria-label="阅读设置"
          onClick={() => setShowSettings(true)}
        >
          <SlidersHorizontal size={20} />
        </button>
      </div>

      {popup ? (
        <ReaderPopover
          popup={popup}
          onHighlight={applyHighlight}
          onCopy={() => {
            const text =
              popup.kind === "selection" ? popup.text : groupText(popup.note);
            navigator.clipboard?.writeText(text).catch(() => undefined);
            window.getSelection()?.removeAllRanges();
            setPopup(null);
          }}
          onListen={() => {
            const place =
              popup.kind === "selection"
                ? popup.parts[0]
                : findSentence(book, popup.note.sentenceId);
            window.getSelection()?.removeAllRanges();
            setPopup(null);
            if (!place) return;
            onStartListening(
              positionFor(book, place.chapterIndex, place.sentenceIndex)
            );
          }}
          onThought={async () => {
            const note =
              popup.kind === "mark"
                ? popup.note
                : await onHighlight(popup.parts, "yellow");
            window.getSelection()?.removeAllRanges();
            setPopup(null);
            if (note) setThoughtDraft({ note, value: note.thought ?? "" });
          }}
          onDelete={() => {
            if (popup.kind === "mark") onDeleteNote(popup.note);
            setPopup(null);
          }}
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
              onClick={() => {
                onUpdateNote({
                  ...thoughtDraft.note,
                  thought: thoughtDraft.value.trim() || undefined,
                });
                setThoughtDraft(null);
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
          className="modal-sheet--reader"
        >
          <div className="toc">
            <div className="toc__head">
              <div className="toc__cover">
                <BookCover book={book} size="small" />
              </div>
              <div className="toc__meta">
                <strong>{book.title}</strong>
                <span>{book.author}</span>
                <small>{`共 ${book.chapters.length} 章`}</small>
              </div>
            </div>
            <div className="toc__list">
              {book.chapters.map((item, index) => {
                const startPercent =
                  book.characterCount > 0
                    ? Math.round(
                        (book.chapters
                          .slice(0, index)
                          .reduce((sum, c) => sum + c.characterCount, 0) /
                          book.characterCount) *
                          100,
                      )
                    : 0;
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
                      {active ? <Check size={16} /> : `${startPercent}%`}
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
                    onSettingsChange({ ...settings, theme: opt.value })
                  }
                >
                  <span className="rset-theme__glyph">文</span>
                  <span className="rset-theme__label">{opt.label}</span>
                </button>
              ))}
            </div>

            <FontPicker
              value={settings.fontFamily}
              onChange={(fontFamily) =>
                onSettingsChange({ ...settings, fontFamily })
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
                    onSettingsChange({
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
                    onSettingsChange({
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
                  onSettingsChange({
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
                    onSettingsChange({ ...settings, readingMode: mode })
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
  location: {
    bookId: string;
    chapterIndex: number;
    sentenceIndex: number;
    sentenceId: string;
  } | null;
  currentSentenceId: string;
  error: string;
  sleepMode: SleepMode;
  start: (bookId: string, position?: BookPosition) => void;
  toggle: () => void;
  stop: () => void;
  skipSentences: (delta: number) => void;
  changeChapter: (delta: number) => void;
  setSleepMode: (mode: SleepMode) => void;
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
  const [showSleep, setShowSleep] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

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

  const toggle = () => {
    if (activeForBook && (player.isPlaying || player.isPaused)) player.toggle();
    else player.start(book.id, basePosition);
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
        <BookCover book={book} size="large" />
        <div className="player-title">
          <h1>{book.title}</h1>
          <p>{chapter?.title ?? "正文"}</p>
        </div>

        <button
          type="button"
          className="current-sentence"
          onClick={() => setShowTranscript(true)}
        >
          <span>{sentence?.text ?? "没有可朗读内容"}</span>
          <small>第 {basePosition.sentenceIndex + 1} 句</small>
        </button>

        <div className="player-progress">
          <ProgressBar value={basePosition.percent} />
          <div>
            <span>{basePosition.percent}%</span>
            <span>{formatReadingTime(book.characterCount)}</span>
          </div>
        </div>

        <div className="player-controls">
          <button
            type="button"
            aria-label="上一章"
            disabled={basePosition.chapterIndex === 0}
            onClick={() => {
              if (!activeForBook) player.start(book.id, basePosition);
              else player.changeChapter(-1);
            }}
          >
            <ChevronLeft size={24} />
            <small>章节</small>
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
            aria-label={playing ? "暂停" : "播放"}
            onClick={toggle}
          >
            {playing ? (
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
            aria-label="下一章"
            disabled={basePosition.chapterIndex >= book.chapters.length - 1}
            onClick={() => {
              if (!activeForBook) player.start(book.id, basePosition);
              else player.changeChapter(1);
            }}
          >
            <ChevronRight size={24} />
            <small>章节</small>
          </button>
        </div>

        {player.error && activeForBook ? (
          <p className="player-error">{player.error}</p>
        ) : null}

        <div className="player-options">
          <button type="button" onClick={() => setShowVoice(true)}>
            <span>{settings.speechRate.toFixed(1)}×</span>
            <small>倍速与声音</small>
          </button>
          <button type="button" onClick={() => setShowSleep(true)}>
            <Clock3 size={22} />
            <small>
              {player.sleepMode === "off"
                ? "定时关闭"
                : player.sleepMode === "chapter"
                  ? "本章结束"
                  : `${player.sleepMode} 分钟`}
            </small>
          </button>
          <button type="button" onClick={() => setShowChapters(true)}>
            <List size={23} />
            <small>章节列表</small>
          </button>
          <button
            type="button"
            onClick={() =>
              onAddNote(basePosition, sentence?.text ?? "听书标记")
            }
          >
            <Bookmark size={22} />
            <small>标记一下</small>
          </button>
        </div>

        <button
          type="button"
          className="view-current-text"
          onClick={() => setShowTranscript(true)}
        >
          查看当前文字
          <ChevronRight size={17} />
        </button>
        <p className="sync-status">
          已记录听书位置 · 第 {basePosition.sentenceIndex + 1} 句
        </p>
      </main>

      {showTranscript ? (
        <Modal
          title="当前文字"
          wide
          onClose={() => setShowTranscript(false)}
        >
          <div className="transcript">
            <p>{sentence?.text}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => onOpenReader(basePosition)}
            >
              打开完整正文
              <BookOpen size={17} />
            </button>
          </div>
        </Modal>
      ) : null}

      {showChapters ? (
        <Modal title="章节列表" onClose={() => setShowChapters(false)}>
          <div className="chapter-list">
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
        <Modal title="倍速与声音" onClose={() => setShowVoice(false)}>
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
              {player.voices.map((voice) => (
                <button
                  type="button"
                  key={voice.voiceURI}
                  className={
                    settings.voiceURI === voice.voiceURI ? "is-active" : ""
                  }
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
                  {settings.voiceURI === voice.voiceURI ? (
                    <Check size={18} />
                  ) : null}
                </button>
              ))}
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
  onToggle,
  onOpen,
  onStop,
}: {
  book: Book;
  chapterTitle: string;
  isPlaying: boolean;
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
        aria-label={isPlaying ? "暂停" : "继续"}
        onClick={onToggle}
      >
        {isPlaying ? (
          <Pause size={20} fill="currentColor" />
        ) : (
          <Play size={20} fill="currentColor" />
        )}
      </button>
      <button
        type="button"
        className="icon-button mini-player__stop"
        aria-label="停止"
        onClick={onStop}
      >
        <X size={18} />
      </button>
    </div>
  );
}

export default function MotingApp() {
  const [books, setBooks] = useState<Book[]>([]);
  const [notes, setNotes] = useState<BookNote[]>([]);
  const [settings, setSettings] =
    useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [stats, setStats] = useState<ReadingStats>(DEFAULT_STATS);
  const [view, setView] = useState<AppView>({ name: "home" });
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
  const [toast, setToast] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAllBooks(), getAllNotes(), getSettings(), getStats()])
      .then(async ([storedBooks, storedNotes, storedSettings, storedStats]) => {
        if (cancelled) return;
        if (!storedBooks.length) {
          const demo = createDemoBook();
          await saveBook(demo);
          storedBooks = [demo];
        }
        setBooks(storedBooks);
        setNotes(storedNotes);
        setSettings(storedSettings);
        setStats(storedStats);
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
    saveBook(updated).catch(() => undefined);
  }, []);

  // 听书每读一句就回调一次。以前这里直接把整本书 put 回 IndexedDB 并重排书库，
  // 长篇小说等于每几秒克隆上万个句子对象再重渲染整个列表，手机上是肉眼可见的卡顿。
  // 现在内存里立刻更新（高亮要跟上），落盘攒到 20 秒一次，停止/切后台时补写。
  const pendingBookRef = useRef<Book | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const booksRef = useRef(books);
  useEffect(() => {
    booksRef.current = books;
  }, [books]);

  const flushListeningProgress = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = pendingBookRef.current;
    pendingBookRef.current = null;
    if (pending) saveBook(pending).catch(() => undefined);
  }, []);

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
          if (pending) saveBook(pending).catch(() => undefined);
        }, 20000);
      }
    },
    []
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushListeningProgress();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushListeningProgress);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushListeningProgress);
      flushListeningProgress();
    };
  }, [flushListeningProgress]);

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
  const selectedBookNotes = useMemo(
    () =>
      selectedBook
        ? notes.filter((note) => note.bookId === selectedBook.id)
        : [],
    [notes, selectedBook]
  );

  const changeSettings = (next: ReaderSettings) => {
    setSettings(next);
    saveSettings(next).catch(() => undefined);
  };

  const updateStats = useCallback(
    (change: (current: ReadingStats) => ReadingStats) => {
      setStats((current) => {
        const next = change(current);
        saveStats(next).catch(() => undefined);
        return next;
      });
    },
    []
  );

  // 打开阅读器就开始记时，页面切到后台的那段不算。跨天时按落账时刻归档。
  const isReading = view.name === "reader";
  useEffect(() => {
    if (!isReading) return;
    let since = Date.now();
    const take = () => {
      const now = Date.now();
      const elapsed = Math.round((now - since) / 1000);
      since = now;
      // 后台标签页的定时器会被压到几分钟一次，超过一轮的量当作没在读。
      return elapsed > 0 && elapsed <= 90 ? elapsed : 0;
    };
    const record = (seconds: number) => {
      if (!seconds) return;
      updateStats((current) => {
        const key = dayKey(Date.now());
        return {
          ...current,
          days: { ...current.days, [key]: (current.days[key] ?? 0) + seconds },
        };
      });
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") record(take());
      else since = Date.now();
    }, 30000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") record(take());
      else since = Date.now();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      if (document.visibilityState === "visible") record(take());
    };
  }, [isReading, updateStats]);

  // PWA 全屏时 iOS 用 theme-color 给状态栏那条填色。写死一个值的话，
  // 换书架或翻开书后状态栏和页面就裂成两块颜色，看着像没做全屏。
  useEffect(() => {
    const root = document.documentElement;
    if (isReading) root.dataset.inReader = "";
    else delete root.dataset.inReader;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]'
    );
    if (meta) {
      const style = getComputedStyle(root);
      const color = style
        .getPropertyValue(isReading ? "--reader-background" : "--paper")
        .trim();
      if (color) meta.content = color;
    }
    return () => {
      delete root.dataset.inReader;
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
        const { book, images } = await parseBookFile(file, setImportProgress);
        setImportProgress({
          stage: "saving",
          label: "正在保存到本地书架",
          percent: 94,
        });
        await saveBookImages(images);
        await saveBook(book);
        setBooks((current) => [book, ...current]);
        setImportProgress({
          stage: "saving",
          label: "导入完成",
          percent: 100,
        });
        await new Promise((resolve) => setTimeout(resolve, 450));
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

  const openReader = (book: Book, position?: BookPosition) => {
    const nextPosition =
      position ?? book.readingPosition ?? initialPosition(book);
    const updated: Book = {
      ...book,
      readingPosition: nextPosition,
      lastOpenedAt: Date.now(),
      updatedAt: Date.now(),
    };
    updateBook(updated);
    setView({ name: "reader", bookId: book.id });
  };

  const openPlayer = (book: Book, startPlaying = false) => {
    setView({ name: "player", bookId: book.id });
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
    await saveNote(note).catch(() => undefined);
    setNotes((current) => [note, ...current]);
    showToast("已标记当前听书位置");
  };

  /** 跨句选中会拆成每句一条划线，返回第一条给弹层继续操作（同组的其余条随它一起改）。 */
  const createHighlights = async (
    book: Book,
    parts: HighlightPart[],
    color: HighlightColor
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
        groupId,
      } satisfies BookNote;
    });
    if (!created.length) return null;
    await Promise.all(created.map((note) => saveNote(note).catch(() => undefined)));
    setNotes((current) => [...created, ...current]);
    return created[0];
  };

  /** 改色、写想法都要落到整组上，否则跨句划线会变成半蓝半黄。 */
  const updateNote = (note: BookNote) => {
    const group = groupKey(note);
    const patch = (item: BookNote): BookNote => ({
      ...item,
      color: note.color,
      thought: note.thought,
    });
    notes
      .filter((item) => groupKey(item) === group)
      .forEach((item) => void saveNote(patch(item)).catch(() => undefined));
    setNotes((current) =>
      current.map((item) => (groupKey(item) === group ? patch(item) : item))
    );
  };

  const handleReadProgress = (book: Book, position: BookPosition) => {
    updateBook({
      ...book,
      readingPosition: position,
      lastOpenedAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  const confirmDeleteBook = async () => {
    if (!deleteTarget) return;
    if (player.location?.bookId === deleteTarget.id) player.stop();
    await removeBook(deleteTarget.id).catch(() => undefined);
    setBooks((current) =>
      current.filter((book) => book.id !== deleteTarget.id)
    );
    setNotes((current) =>
      current.filter((note) => note.bookId !== deleteTarget.id)
    );
    setDeleteTarget(null);
    showToast("书籍及相关标记已删除");
  };

  const deleteBookNote = async (note: BookNote) => {
    const group = groupKey(note);
    const doomed = notes.filter((item) => groupKey(item) === group);
    await Promise.all(
      doomed.map((item) => removeNote(item.id).catch(() => undefined))
    );
    setNotes((current) =>
      current.filter((item) => groupKey(item) !== group)
    );
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
    await clearLibrary().catch(() => undefined);
    const demo = createDemoBook();
    await saveBook(demo).catch(() => undefined);
    setBooks([demo]);
    setNotes([]);
    setSettings(DEFAULT_SETTINGS);
    setStats(DEFAULT_STATS);
    setConfirmClear(false);
    setShowSettings(false);
    setView({ name: "home" });
    showToast("本地书库已清空，已保留一份使用指南");
  };

  const activeMainView: MainView =
    view.name === "reader"
      ? "library"
      : view.name === "player"
        ? "listen"
        : view.name === "book-notes"
          ? "notes"
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
          book={selectedBook}
          notes={selectedBookNotes}
          settings={settings}
          currentSentenceId={
            player.location?.bookId === selectedBook.id
              ? player.currentSentenceId
              : ""
          }
          onBack={() => setView({ name: "home" })}
          onProgress={(position) => handleReadProgress(selectedBook, position)}
          onStartListening={(position) => {
            player.start(selectedBook.id, position);
            setView({ name: "player", bookId: selectedBook.id });
          }}
          onHighlight={(parts, color) =>
            createHighlights(selectedBook, parts, color)
          }
          onUpdateNote={updateNote}
          onDeleteNote={deleteBookNote}
          onSettingsChange={changeSettings}
        />
      ) : view.name === "player" && selectedBook ? (
        <PlayerScreen
          book={selectedBook}
          settings={settings}
          player={player}
          onBack={() => setView({ name: "listen" })}
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
              onChange={(name) => setView({ name })}
            />
            <button
              type="button"
              className="search-fab"
              aria-label="搜索"
              onClick={() => setView({ name: "library" })}
            >
              <Search size={22} />
            </button>
          </div>

          <section className="app-content">
            {view.name === "home" ? (
              <HomeScreen
                books={books}
                stats={stats}
                onOpenReader={(book) => openReader(book)}
                onPlay={(book) => openPlayer(book, true)}
                onOpenPlayer={(book) => openPlayer(book, false)}
                onImport={() => fileInputRef.current?.click()}
                onGoalChange={(goalMinutes) =>
                  updateStats((current) => ({ ...current, goalMinutes }))
                }
                onOpenSettings={() => setShowSettings(true)}
              />
            ) : view.name === "library" ? (
              <LibraryScreen
                books={books}
                onImport={() => fileInputRef.current?.click()}
                onOpen={(book) => openReader(book)}
                onPlay={(book) => openPlayer(book, true)}
                onOpenNotes={(book) =>
                  setView({ name: "book-notes", bookId: book.id })
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
                onBack={() => setView({ name: "library" })}
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
                onOpenBook={(book) =>
                  setView({ name: "book-notes", bookId: book.id })
                }
                onOpenNote={openNote}
                onDelete={deleteBookNote}
                onEditThought={(note) => {
                  setThoughtTarget(note);
                  setThoughtDraft(note.thought ?? "");
                }}
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
              onToggle={player.toggle}
              onOpen={() => setView({ name: "player", bookId: activeBook.id })}
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

      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
