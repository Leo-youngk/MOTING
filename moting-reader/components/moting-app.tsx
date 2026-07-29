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
  Download,
  FileText,
  Headphones,
  Library,
  List,
  Minus,
  Pause,
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
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSpeechPlayer, type SleepMode } from "../hooks/use-speech-player";
import {
  findSentence,
  flattenChapter,
  formatReadingTime,
  initialPosition,
  makeId,
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
  removeBook,
  removeNote,
  saveBook,
  saveBookImages,
  saveNote,
  saveSettings,
} from "../lib/storage";
import {
  DEFAULT_SETTINGS,
  type AppView,
  type Book,
  type BookNote,
  type BookPosition,
  type ImportProgress,
  type MainView,
  type PlayerVoice,
  type ReaderSettings,
} from "../lib/types";

const NAV_ITEMS: Array<{
  id: MainView;
  label: string;
  icon: typeof Library;
}> = [
  { id: "library", label: "书架", icon: Library },
  { id: "listen", label: "听书", icon: Headphones },
  { id: "notes", label: "笔记", icon: Bookmark },
  { id: "settings", label: "我的", icon: UserRound },
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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`modal-sheet ${wide ? "modal-sheet--wide" : ""}`}
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

function LibraryScreen({
  books,
  onImport,
  onOpen,
  onDelete,
}: {
  books: Book[];
  onImport: () => void;
  onOpen: (book: Book) => void;
  onDelete: (book: Book) => void;
}) {
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const filtered = books.filter((book) =>
    `${book.title} ${book.author}`.toLowerCase().includes(query.toLowerCase())
  );
  const current = books[0];

  return (
    <div className="screen screen--library">
      <header className="screen-header">
        <div>
          <p className="eyebrow">你的私人阅读空间</p>
          <h1>书架</h1>
          <p>继续你的阅读</p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="搜索书籍"
            onClick={() => setShowSearch((value) => !value)}
          >
            <Search size={21} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="导入书籍"
            onClick={onImport}
          >
            <Plus size={22} />
          </button>
        </div>
      </header>

      {showSearch ? (
        <label className="search-field">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索书名或作者"
          />
          {query ? (
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => setQuery("")}
            >
              <X size={17} />
            </button>
          ) : null}
        </label>
      ) : null}

      {!books.length ? (
        <EmptyState
          icon={<BookOpen size={29} />}
          title="书架还是空的"
          description="导入 EPUB、文字型 PDF、TXT 或 Markdown，开始阅读和听书。"
          action={
            <button type="button" className="primary-button" onClick={onImport}>
              <Upload size={18} />
              导入第一本书
            </button>
          }
        />
      ) : (
        <>
          {current && !query ? (
            <section className="continue-reading">
              <BookCover book={current} size="large" />
              <div className="continue-reading__content">
                <span className="section-kicker">正在阅读</span>
                <h2>{current.title}</h2>
                <p>{current.author}</p>
                <strong>{current.readingPosition?.percent ?? 0}%</strong>
                <ProgressBar value={current.readingPosition?.percent ?? 0} />
                <p className="chapter-line">
                  {current.chapters[
                    current.readingPosition?.chapterIndex ?? 0
                  ]?.title ?? "正文"}
                </p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => onOpen(current)}
                >
                  继续阅读
                  <ChevronRight size={18} />
                </button>
              </div>
            </section>
          ) : null}

          <section className="library-list-section">
            <div className="section-heading">
              <div>
                <span>{query ? "搜索结果" : "我的书籍"}</span>
                <small>{filtered.length} 本</small>
              </div>
              <button type="button" className="text-button" onClick={onImport}>
                <Upload size={16} />
                导入
              </button>
            </div>

            <div className="book-list">
              {filtered.map((book) => (
                <article className="book-row" key={book.id}>
                  <button
                    type="button"
                    className="book-row__main"
                    onClick={() => onOpen(book)}
                  >
                    <BookCover book={book} size="small" />
                    <span className="book-row__details">
                      <strong>{book.title}</strong>
                      <small>{book.author}</small>
                      <span>
                        {book.readingPosition?.percent ?? 0}% ·{" "}
                        {book.chapters[
                          book.readingPosition?.chapterIndex ?? 0
                        ]?.title ?? `${book.chapters.length} 章`}
                      </span>
                      <ProgressBar value={book.readingPosition?.percent ?? 0} />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-button book-row__menu"
                    aria-label={`删除${book.title}`}
                    onClick={() => onDelete(book)}
                  >
                    <Trash2 size={17} />
                  </button>
                </article>
              ))}
            </div>

            {!filtered.length ? (
              <p className="no-results">没有找到匹配的书籍。</p>
            ) : null}
          </section>
        </>
      )}
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
  const [filter, setFilter] = useState<"all" | "recent">("all");
  const listened = books
    .filter((book) => book.listeningPosition)
    .sort(
      (a, b) =>
        (b.listeningPosition?.updatedAt ?? 0) -
        (a.listeningPosition?.updatedAt ?? 0)
    );
  const current = listened[0] ?? books[0];
  const visible = (filter === "recent" ? listened : books).filter((book) =>
    `${book.title} ${book.author}`.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="screen screen--listen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">把书带进更多时间</p>
          <h1>听书</h1>
          <p>继续收听，或选择一本来听</p>
        </div>
      </header>

      <label className="search-field search-field--always">
        <Search size={18} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索可听书籍"
        />
        {query ? (
          <button type="button" onClick={() => setQuery("")}>
            <X size={17} />
          </button>
        ) : null}
      </label>

      {!books.length ? (
        <EmptyState
          icon={<Headphones size={29} />}
          title="还没有可以听的书"
          description="先到书架导入一本书，解析完成后会自动出现在这里。"
        />
      ) : (
        <>
          {current && !query ? (
            <section className="continue-listening">
              <button
                type="button"
                className="continue-listening__main"
                onClick={() => onOpenPlayer(current)}
              >
                <BookCover book={current} size="medium" />
                <span className="continue-listening__text">
                  <small>继续收听</small>
                  <strong>{current.title}</strong>
                  <span>
                    {current.chapters[
                      current.listeningPosition?.chapterIndex ?? 0
                    ]?.title ?? "正文"}
                    {" · "}
                    第 {(current.listeningPosition?.sentenceIndex ?? 0) + 1} 句
                  </span>
                  <ProgressBar
                    value={current.listeningPosition?.percent ?? 0}
                  />
                </span>
              </button>
              <button
                type="button"
                className="round-play-button"
                aria-label={`继续播放${current.title}`}
                onClick={() => onPlay(current)}
              >
                <Play size={24} fill="currentColor" />
              </button>
            </section>
          ) : null}

          <section className="listen-library">
            <div className="filter-tabs" aria-label="听书筛选">
              <button
                type="button"
                className={filter === "all" ? "is-active" : ""}
                onClick={() => setFilter("all")}
              >
                全部
              </button>
              <button
                type="button"
                className={filter === "recent" ? "is-active" : ""}
                onClick={() => setFilter("recent")}
              >
                最近
              </button>
            </div>

            <div className="section-heading">
              <div>
                <span>选择一本来听</span>
                <small>{visible.length} 本可听</small>
              </div>
            </div>

            <div className="audio-book-list">
              {visible.map((book) => (
                <article className="audio-book-row" key={book.id}>
                  <button
                    type="button"
                    className="audio-book-row__main"
                    onClick={() => onOpenPlayer(book)}
                  >
                    <BookCover book={book} size="small" />
                    <span>
                      <strong>{book.title}</strong>
                      <small>{book.author}</small>
                      <em>
                        <Play size={13} fill="currentColor" />
                        {book.listeningPosition
                          ? `已听 ${book.listeningPosition.percent}%`
                          : "可播放"}
                      </em>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="inline-play"
                    aria-label={`播放${book.title}`}
                    onClick={() => onPlay(book)}
                  >
                    <Play size={18} fill="currentColor" />
                  </button>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function NotesScreen({
  notes,
  books,
  onOpen,
  onDelete,
}: {
  notes: BookNote[];
  books: Book[];
  onOpen: (note: BookNote) => void;
  onDelete: (note: BookNote) => void;
}) {
  const [filter, setFilter] = useState<"all" | BookNote["kind"]>("all");
  const visible =
    filter === "all" ? notes : notes.filter((note) => note.kind === filter);

  return (
    <div className="screen screen--notes">
      <header className="screen-header">
        <div>
          <p className="eyebrow">把值得保留的句子留下</p>
          <h1>笔记</h1>
          <p>阅读书签与听书标记集中在这里</p>
        </div>
      </header>

      <div className="filter-tabs">
        <button
          type="button"
          className={filter === "all" ? "is-active" : ""}
          onClick={() => setFilter("all")}
        >
          全部
        </button>
        <button
          type="button"
          className={filter === "bookmark" ? "is-active" : ""}
          onClick={() => setFilter("bookmark")}
        >
          阅读书签
        </button>
        <button
          type="button"
          className={filter === "listening-mark" ? "is-active" : ""}
          onClick={() => setFilter("listening-mark")}
        >
          听书标记
        </button>
      </div>

      {!visible.length ? (
        <EmptyState
          icon={<Bookmark size={28} />}
          title="还没有标记"
          description="阅读时选中一句，或听书时点击标记，它会出现在这里。"
        />
      ) : (
        <div className="notes-list">
          {visible.map((note) => {
            const book = books.find((item) => item.id === note.bookId);
            if (!book) return null;
            const chapter = book.chapters.find(
              (item) => item.id === note.chapterId
            );
            return (
              <article className="note-row" key={note.id}>
                <button type="button" onClick={() => onOpen(note)}>
                  <span className="note-row__meta">
                    {note.kind === "bookmark" ? (
                      <Bookmark size={14} />
                    ) : (
                      <Headphones size={14} />
                    )}
                    {book.title} · {chapter?.title ?? "正文"}
                  </span>
                  <blockquote>{note.excerpt}</blockquote>
                  <small>{formatDate(note.createdAt)}</small>
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="删除标记"
                  onClick={() => onDelete(note)}
                >
                  <Trash2 size={16} />
                </button>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SettingsScreen({
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
    <div className="screen screen--settings">
      <header className="screen-header">
        <div>
          <p className="eyebrow">安静、稳定、属于你</p>
          <h1>我的</h1>
          <p>阅读与听书的默认设置</p>
        </div>
      </header>

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
        <div className="settings-row">
          <span>
            <strong>正文字体</strong>
            <small>中文阅读更推荐衬线字体</small>
          </span>
          <div className="compact-toggle">
            <button
              type="button"
              className={settings.fontFamily === "serif" ? "is-active" : ""}
              onClick={() => onChange({ ...settings, fontFamily: "serif" })}
            >
              宋体
            </button>
            <button
              type="button"
              className={settings.fontFamily === "sans" ? "is-active" : ""}
              onClick={() => onChange({ ...settings, fontFamily: "sans" })}
            >
              黑体
            </button>
          </div>
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

function ReaderScreen({
  book,
  settings,
  currentSentenceId,
  onBack,
  onProgress,
  onStartListening,
  onAddNote,
  onSettingsChange,
}: {
  book: Book;
  settings: ReaderSettings;
  currentSentenceId: string;
  onBack: () => void;
  onProgress: (position: BookPosition) => void;
  onStartListening: (position: BookPosition) => void;
  onAddNote: (position: BookPosition, excerpt: string) => void;
  onSettingsChange: (settings: ReaderSettings) => void;
}) {
  const initial = book.readingPosition ?? initialPosition(book);
  const [chapterIndex, setChapterIndex] = useState(initial.chapterIndex);
  const [selectedSentenceId, setSelectedSentenceId] = useState(
    initial.sentenceId
  );
  const [showChapters, setShowChapters] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const savedSentenceRef = useRef(initial.sentenceId);
  const chapter = book.chapters[chapterIndex];
  const sentences = useMemo(
    () => (chapter ? flattenChapter(chapter) : []),
    [chapter]
  );
  const sentenceIndexById = useMemo(() => {
    const map = new Map<string, number>();
    sentences.forEach((sentence, index) => map.set(sentence.id, index));
    return map;
  }, [sentences]);

  useEffect(() => {
    const targetId = book.readingPosition?.sentenceId;
    if (!targetId) return;
    const timer = setTimeout(() => {
      articleRef.current
        ?.querySelector<HTMLElement>(`[data-sentence-id="${targetId}"]`)
        ?.scrollIntoView({ block: "center" });
    }, 80);
    return () => clearTimeout(timer);
    // Only restore when entering a chapter, not after each persisted update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, chapterIndex]);

  useEffect(() => {
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
        const id = element?.dataset.sentenceId;
        if (!id || Number.isNaN(index) || savedSentenceRef.current === id) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          savedSentenceRef.current = id;
          onProgress(positionFor(book, chapterIndex, index));
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
  }, [book, chapterIndex, onProgress]);

  const chooseSentence = (sentenceId: string, sentenceIndex: number) => {
    setSelectedSentenceId(sentenceId);
    const position = positionFor(book, chapterIndex, sentenceIndex);
    savedSentenceRef.current = sentenceId;
    onProgress(position);
  };

  const handleArticleClick = (event: MouseEvent<HTMLElement>) => {
    // 划词时不要改选句子，否则刚拉出来的选区会被重新渲染打断。
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;

    const target = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-sentence-id]"
    );
    const sentenceId = target?.dataset.sentenceId;
    const sentenceIndex = Number(target?.dataset.sentenceIndex);
    if (!sentenceId || Number.isNaN(sentenceIndex)) return;
    chooseSentence(sentenceId, sentenceIndex);
  };

  const changeChapter = (nextIndex: number) => {
    const safe = Math.max(0, Math.min(book.chapters.length - 1, nextIndex));
    setChapterIndex(safe);
    const position = positionFor(book, safe, 0);
    setSelectedSentenceId(position.sentenceId);
    savedSentenceRef.current = position.sentenceId;
    onProgress(position);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const selectedIndex = sentences.findIndex(
    (sentence) => sentence.id === selectedSentenceId
  );
  const selected =
    selectedIndex >= 0 ? sentences[selectedIndex] : sentences[0];
  const readerStyle = {
    "--reader-font-size": `${settings.fontSize}px`,
    "--reader-line-height": String(settings.lineHeight),
    "--reader-width": `${settings.contentWidth}px`,
  } as CSSProperties;

  return (
    <div className={`reader-shell reader-theme--${settings.theme}`} style={readerStyle}>
      <header className="reader-header">
        <button
          type="button"
          className="icon-button"
          aria-label="返回书架"
          onClick={onBack}
        >
          <ArrowLeft size={21} />
        </button>
        <button
          type="button"
          className="reader-header__chapter"
          onClick={() => setShowChapters(true)}
        >
          <span>{chapter?.title ?? "正文"}</span>
          <ChevronDown size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="阅读设置"
          onClick={() => setShowSettings(true)}
        >
          <SlidersHorizontal size={20} />
        </button>
      </header>

      <article
        ref={articleRef}
        className={`reader-article ${
          settings.fontFamily === "serif" ? "is-serif" : "is-sans"
        }`}
        onClick={handleArticleClick}
      >
        <div className="reader-title">
          <span>
            {String(chapterIndex + 1).padStart(2, "0")} /{" "}
            {String(book.chapters.length).padStart(2, "0")}
          </span>
          <h1>{chapter?.title}</h1>
          <p>{book.title}</p>
        </div>

        {chapter?.paragraphs.map((paragraph) => {
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
              data-sentence-index={sentenceIndexById.get(sentence.id)}
              className={`${
                sentence.id === selectedSentenceId ? "is-selected" : ""
              } ${sentence.id === currentSentenceId ? "is-speaking" : ""}`}
            >
              {sentence.text}
            </span>
          ));

          if (paragraph.kind === "heading") {
            // 章节名已经占了 h1，章内小标题从 h2 起排。
            const Heading = HEADING_TAGS[(paragraph.level ?? 3) - 1] ?? "h3";
            return (
              <Heading key={paragraph.id} className="reader-block is-heading">
                {sentenceSpans}
              </Heading>
            );
          }
          if (paragraph.kind === "quote") {
            return (
              <blockquote key={paragraph.id} className="reader-block is-quote">
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

        <div className="reader-chapter-nav">
          <button
            type="button"
            disabled={chapterIndex === 0}
            onClick={() => changeChapter(chapterIndex - 1)}
          >
            <ChevronLeft size={18} />
            上一章
          </button>
          <span>{book.readingPosition?.percent ?? 0}%</span>
          <button
            type="button"
            disabled={chapterIndex >= book.chapters.length - 1}
            onClick={() => changeChapter(chapterIndex + 1)}
          >
            下一章
            <ChevronRight size={18} />
          </button>
        </div>
      </article>

      {selected ? (
        <div className="reader-selection-bar">
          <button
            type="button"
            onClick={() =>
              onStartListening(
                positionFor(book, chapterIndex, Math.max(selectedIndex, 0))
              )
            }
          >
            <Headphones size={18} />
            从这里听
          </button>
          <button
            type="button"
            onClick={() =>
              onAddNote(
                positionFor(book, chapterIndex, Math.max(selectedIndex, 0)),
                selected.text
              )
            }
          >
            <Bookmark size={18} />
            标记
          </button>
        </div>
      ) : null}

      {showChapters ? (
        <Modal title="章节目录" onClose={() => setShowChapters(false)}>
          <div className="chapter-list">
            {book.chapters.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={index === chapterIndex ? "is-active" : ""}
                onClick={() => {
                  changeChapter(index);
                  setShowChapters(false);
                }}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{item.title}</strong>
                {index === chapterIndex ? <Check size={17} /> : null}
              </button>
            ))}
          </div>
        </Modal>
      ) : null}

      {showSettings ? (
        <Modal title="阅读设置" onClose={() => setShowSettings(false)}>
          <div className="reader-settings">
            <div className="reader-settings__preview">
              阅读应该让工具安静下来，让文字重新成为中心。
            </div>
            <div className="reader-settings__row">
              <span>字号</span>
              <button
                type="button"
                onClick={() =>
                  onSettingsChange({
                    ...settings,
                    fontSize: Math.max(15, settings.fontSize - 1),
                  })
                }
              >
                <Minus size={17} />
              </button>
              <strong>{settings.fontSize}</strong>
              <button
                type="button"
                onClick={() =>
                  onSettingsChange({
                    ...settings,
                    fontSize: Math.min(28, settings.fontSize + 1),
                  })
                }
              >
                <Plus size={17} />
              </button>
            </div>
            <label className="reader-settings__slider">
              <span>行距</span>
              <input
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
              <strong>{settings.lineHeight.toFixed(1)}</strong>
            </label>
            <div className="segmented-control">
              {(["paper", "white", "night"] as const).map((theme) => (
                <button
                  type="button"
                  key={theme}
                  className={settings.theme === theme ? "is-active" : ""}
                  onClick={() => onSettingsChange({ ...settings, theme })}
                >
                  {theme === "paper"
                    ? "纸张"
                    : theme === "white"
                      ? "纯白"
                      : "夜间"}
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
  const [view, setView] = useState<AppView>({ name: "library" });
  const [ready, setReady] = useState(false);
  const [importProgress, setImportProgress] =
    useState<ImportProgress | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAllBooks(), getAllNotes(), getSettings()])
      .then(async ([storedBooks, storedNotes, storedSettings]) => {
        if (cancelled) return;
        if (!storedBooks.length) {
          const demo = createDemoBook();
          await saveBook(demo);
          storedBooks = [demo];
        }
        setBooks(storedBooks);
        setNotes(storedNotes);
        setSettings(storedSettings);
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
    // 改完样式和脚本会一直读到旧版本。
    if ("serviceWorker" in navigator && !import.meta.env.DEV) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.readerTheme = settings.theme;
  }, [settings.theme]);

  const updateBook = useCallback((updated: Book) => {
    setBooks((current) =>
      current
        .map((book) => (book.id === updated.id ? updated : book))
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    );
    saveBook(updated).catch(() => undefined);
  }, []);

  const updateListeningProgress = useCallback(
    (bookId: string, position: BookPosition) => {
      setBooks((current) => {
        const next = current.map((book) => {
          if (book.id !== bookId) return book;
          const updated: Book = {
            ...book,
            listeningPosition: position,
            lastOpenedAt: Date.now(),
            updatedAt: Date.now(),
          };
          saveBook(updated).catch(() => undefined);
          return updated;
        });
        return next.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
      });
    },
    []
  );

  const player = useSpeechPlayer({
    books,
    settings,
    onProgress: updateListeningProgress,
  });

  const activeBook = player.location
    ? books.find((book) => book.id === player.location?.bookId)
    : undefined;
  const selectedBook =
    view.name === "reader" || view.name === "player"
      ? books.find((book) => book.id === view.bookId)
      : undefined;

  const changeSettings = (next: ReaderSettings) => {
    setSettings(next);
    saveSettings(next).catch(() => undefined);
  };

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

  const addNote = async (
    book: Book,
    position: BookPosition,
    excerpt: string,
    kind: BookNote["kind"]
  ) => {
    const existing = notes.find(
      (note) =>
        note.bookId === book.id &&
        note.sentenceId === position.sentenceId &&
        note.kind === kind
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
      kind,
      excerpt,
      createdAt: Date.now(),
    };
    await saveNote(note).catch(() => undefined);
    setNotes((current) => [note, ...current]);
    showToast(kind === "bookmark" ? "已加入阅读书签" : "已标记当前听书位置");
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
    await removeNote(note.id).catch(() => undefined);
    setNotes((current) => current.filter((item) => item.id !== note.id));
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
    setConfirmClear(false);
    setView({ name: "library" });
    showToast("本地书库已清空，已保留一份使用指南");
  };

  const activeMainView: MainView =
    view.name === "reader"
      ? "library"
      : view.name === "player"
        ? "listen"
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
          settings={settings}
          currentSentenceId={
            player.location?.bookId === selectedBook.id
              ? player.currentSentenceId
              : ""
          }
          onBack={() => setView({ name: "library" })}
          onProgress={(position) => handleReadProgress(selectedBook, position)}
          onStartListening={(position) => {
            player.start(selectedBook.id, position);
            setView({ name: "player", bookId: selectedBook.id });
          }}
          onAddNote={(position, excerpt) =>
            addNote(selectedBook, position, excerpt, "bookmark")
          }
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
            addNote(selectedBook, position, excerpt, "listening-mark")
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

          <BottomNavigation
            active={activeMainView}
            onChange={(name) => setView({ name })}
          />

          <section className="app-content">
            {view.name === "library" ? (
              <LibraryScreen
                books={books}
                onImport={() => fileInputRef.current?.click()}
                onOpen={openReader}
                onDelete={setDeleteTarget}
              />
            ) : view.name === "listen" ? (
              <ListenScreen
                books={books}
                onPlay={(book) => openPlayer(book, true)}
                onOpenPlayer={(book) => openPlayer(book, false)}
              />
            ) : view.name === "notes" ? (
              <NotesScreen
                notes={notes}
                books={books}
                onOpen={openNote}
                onDelete={deleteBookNote}
              />
            ) : (
              <SettingsScreen
                settings={settings}
                voices={player.voices}
                books={books}
                onChange={changeSettings}
                onClear={() => setConfirmClear(true)}
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

      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
