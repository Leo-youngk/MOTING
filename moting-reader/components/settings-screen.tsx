"use client";

import { RECORD_LABELS, type PushFailure } from "../lib/sync-record";

import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Eye,
  EyeOff,
  Gauge,
  Headphones,
  Library,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { AiRequestError, fetchAiModels } from "../lib/ai";
import { AI_PROVIDER_PRESETS, activeAiProvider, getAiProviders, withAiProviders } from "../lib/ai-providers";
import { resolvedEdgeVoiceURI } from "../lib/edge-voices";
import type { AppUpdateStatus } from "../hooks/use-app-update";
import {
  READER_FONTS,
  READER_THEMES,
  READER_THEME_SWATCH,
} from "../lib/reader-options";
import type {
  AiProvider,
  BookMeta,
  PlayerVoice,
  ReaderSettings,
  SettingsSection,
  SpeechReplacement,
} from "../lib/types";
import { Modal } from "./sheet";
import { SoftRange } from "./soft-range";
import "./settings-screen.css";
import type { QueuedProgress } from "../lib/sync-progress";

export interface SyncSummary {
  enabled: boolean;
  connected: boolean;
  syncing: boolean;
  message: string;
  error: string;
  lastSyncAt: number;
  checkingSession?: boolean;
  pendingProgress?: number;
  pendingResources?: number;
  blockedBooks?: Array<{ bookId: string; reason: string }>;
  recordFailures?: PushFailure[];
  pendingRecords?: number;
  lastCompleteAt?: number;
  blockedProgress?: number;
  conflicts?: QueuedProgress[];
  bookTitles?: Record<string, string>;
  onResolveConflict?: (id: string, useLocal: boolean) => Promise<void>;
}

const SPEED_PRESETS = [0.8, 1, 1.2, 1.5, 2];

function formatStorageSize(characters: number): string {
  const bytes = characters * 2;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 上次同步开始的本机时刻(毫秒)。 */
function formatSyncTime(syncedAt: number): string {
  const date = new Date(syncedAt);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return sameDay ? `今天 ${clock}` : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

/** 顶栏：返回、居中的标题（可带一行小字），右边留给小熊或别的按钮。 */
function PageBar({
  title,
  subtitle,
  onBack,
  trailing,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  trailing?: ReactNode;
}) {
  return (
    <header className="page-bar">
      <button type="button" className="page-bar__back" aria-label="返回" onClick={onBack}>
        <ChevronLeft size={26} />
      </button>
      <div className="page-bar__title">
        <strong>{title}</strong>
        {subtitle ? <small>{subtitle}</small> : null}
      </div>
      <div className="page-bar__trailing">{trailing}</div>
    </header>
  );
}

const UPDATE_LABEL: Record<AppUpdateStatus, string> = {
  checking: "检查中…",
  latest: "已是最新",
  available: "点此更新",
  offline: "离线，稍后再查",
  unsupported: "开发版",
};

/** 设置首页的一行：图标、名字（可带一行说明）、当前值、右箭头，点进二级页。 */
function LinkRow({
  icon,
  label,
  detail,
  value,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="settings-link" onClick={onClick}>
      <span className="settings-link__icon" aria-hidden>
        {icon}
      </span>
      <span className="settings-link__label">
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      <span className="settings-link__value">{value}</span>
      <ChevronRight size={18} className="settings-link__chevron" aria-hidden />
    </button>
  );
}

/** 二级页里的一个选项：选中的那个后面打勾。 */
function OptionRow({
  selected,
  label,
  detail,
  leading,
  labelStyle,
  onClick,
}: {
  selected: boolean;
  label: string;
  detail?: string;
  leading?: ReactNode;
  labelStyle?: CSSProperties;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`settings-option${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      {leading}
      <span className="settings-option__label">
        <strong style={labelStyle}>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      {selected ? <Check size={18} className="settings-option__check" aria-hidden /> : null}
    </button>
  );
}

function Section({
  title,
  foot,
  children,
}: {
  title?: string;
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      {title ? <h2>{title}</h2> : null}
      {children}
      {foot ? <div className="settings-foot">{foot}</div> : null}
    </section>
  );
}

/**
 * 读音纠正：多音字、人名、生僻词读错了就在这里告诉它怎么读。只改送去合成的文字，
 * 正文、高亮和位置都不受影响。「读作」留空表示这几个字不读（比如书里夹的广告词）。
 */
function SpeechReplacementEditor({
  rules,
  onChange,
}: {
  rules: SpeechReplacement[];
  onChange: (rules: SpeechReplacement[]) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const source = from.trim();
  const target = to.trim();

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!source || source === target) return;
    onChange([...rules.filter((rule) => rule.from !== source), { from: source, to: target }]);
    setFrom("");
    setTo("");
  };

  return (
    <div className="settings-card">
      {rules.map((rule) => (
        <div className="speech-rule" key={rule.from}>
          <span className="speech-rule__text">
            <strong>{rule.from}</strong>
            <ArrowRight size={16} aria-hidden />
            <span className={rule.to ? "" : "is-muted"}>{rule.to || "不读"}</span>
          </span>
          <button
            type="button"
            className="speech-rule__remove"
            aria-label={`删除「${rule.from}」的读法`}
            onClick={() => onChange(rules.filter((item) => item.from !== rule.from))}
          >
            <Trash2 size={18} />
          </button>
        </div>
      ))}
      <form className="speech-rule-form" onSubmit={add}>
        <span className="settings-input">
          <input
            type="text"
            aria-label="原文"
            placeholder="原文，如：行长"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </span>
        <ArrowRight size={16} aria-hidden className="speech-rule-form__arrow" />
        <span className="settings-input">
          <input
            type="text"
            aria-label="读作"
            placeholder="读作，如：航长"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </span>
        <button type="submit" disabled={!source || source === target}>
          添加
        </button>
      </form>
    </div>
  );
}

export function SettingsScreen({
  section,
  settings,
  voices,
  books,
  sync,
  onChange,
  onClear,
  onSyncLogin,
  onSyncLogout,
  onSyncNow,
  update,
  onOpen,
  onBack,
}: {
  section?: SettingsSection;
  settings: ReaderSettings;
  voices: PlayerVoice[];
  books: BookMeta[];
  sync: SyncSummary;
  onChange: (settings: ReaderSettings) => void;
  onClear: () => void;
  onSyncLogin: (username: string, password: string) => Promise<void>;
  onSyncLogout: () => void;
  onSyncNow: () => void;
  update: { status: AppUpdateStatus; check: () => void; apply: () => void };
  onOpen: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  const chosenVoice = resolvedEdgeVoiceURI(settings.voiceURI);
  const voiceName =
    voices.find((voice) => voice.voiceURI === chosenVoice)?.name.split(" · ")[0] ?? "云健";
  const themeName =
    READER_THEMES.find((theme) => theme.value === settings.theme)?.label ?? "原版";
  const fontName =
    READER_FONTS.find((font) => font.value === settings.fontFamily)?.label ?? "宋体";
  const aiReady = Boolean(settings.aiBaseUrl.trim() && settings.aiModel.trim());
  const syncValue = !sync.enabled
    ? "未启用"
    : sync.connected
      ? sync.syncing
        ? "同步中"
        : "已登录"
      : "未登录";

  if (section === "voice") {
    return (
      <div className="settings-screen">
        <PageBar title="朗读音色" subtitle="听书用的声音和读法" onBack={onBack} />
        <main className="settings-main">
          <Section foot="断网或云端暂时不可用时，会先用手机自带的声音接着读，云端恢复后自动换回来。">
            <div className="settings-card">
              {voices.map((voice) => (
                <OptionRow
                  key={voice.voiceURI}
                  selected={chosenVoice === voice.voiceURI}
                  label={voice.name}
                  detail={voice.lang}
                  onClick={() => onChange({ ...settings, voiceURI: voice.voiceURI })}
                />
              ))}
            </div>
          </Section>
          <Section
            title="读音纠正"
            foot="多音字、人名读错了，在这里告诉它怎么读，比如「行长」读作「航长」。只改朗读，不改正文；读作留空就跳过不读。"
          >
            <SpeechReplacementEditor
              rules={settings.speechReplacements ?? []}
              onChange={(speechReplacements) => onChange({ ...settings, speechReplacements })}
            />
          </Section>
        </main>
      </div>
    );
  }

  if (section === "speed") {
    return (
      <div className="settings-screen">
        <PageBar title="默认倍速" subtitle="听书时也能随时调" onBack={onBack} />
        <main className="settings-main">
          <Section foot="拖动调到任意倍速，或者点下面的常用档位。">
            <div className="settings-card settings-speed">
              <strong className="settings-speed__value">{settings.speechRate.toFixed(1)}×</strong>
              <SoftRange
                min={0.6}
                max={2}
                step={0.1}
                value={settings.speechRate}
                aria-label="默认倍速"
                onValue={(speechRate) => onChange({ ...settings, speechRate })}
              />
              <div className="settings-speed__ends" aria-hidden>
                <span>0.6×</span>
                <span>2.0×</span>
              </div>
              <div className="settings-chips">
                {SPEED_PRESETS.map((rate) => (
                  <button
                    type="button"
                    key={rate}
                    className={Math.abs(settings.speechRate - rate) < 0.05 ? "is-active" : ""}
                    onClick={() => onChange({ ...settings, speechRate: rate })}
                  >
                    {rate.toFixed(1)}×
                  </button>
                ))}
              </div>
            </div>
          </Section>
        </main>
      </div>
    );
  }

  if (section === "theme") {
    return (
      <div className="settings-screen">
        <PageBar title="阅读主题" subtitle="打开书时默认用的纸张" onBack={onBack} />
        <main className="settings-main">
          <Section foot="阅读页里「主题与设置」也能随时换，换了会记住。">
            <div className="settings-card">
              {READER_THEMES.map((theme) => (
                <OptionRow
                  key={theme.value}
                  selected={settings.theme === theme.value}
                  label={theme.label}
                  leading={
                    <span
                      className="settings-swatch"
                      style={{
                        background: READER_THEME_SWATCH[theme.value].bg,
                        color: READER_THEME_SWATCH[theme.value].ink,
                      }}
                      aria-hidden
                    >
                      文
                    </span>
                  }
                  onClick={() => onChange({ ...settings, theme: theme.value })}
                />
              ))}
            </div>
          </Section>
        </main>
      </div>
    );
  }

  if (section === "font") {
    return (
      <div className="settings-screen">
        <PageBar title="正文字体" subtitle="阅读页里也能随时换" onBack={onBack} />
        <main className="settings-main">
          <Section foot="四款都是 iPhone 自带的系统字，不用下载。">
            <div className="settings-card">
              {READER_FONTS.map((font) => (
                <OptionRow
                  key={font.value}
                  selected={settings.fontFamily === font.value}
                  label={font.label}
                  detail="读书就是和古今中外的人对话"
                  labelStyle={{ fontFamily: font.cssVar }}
                  onClick={() => onChange({ ...settings, fontFamily: font.value })}
                />
              ))}
            </div>
          </Section>
        </main>
      </div>
    );
  }

  if (section === "ai") {
    return <AiSettingsPage settings={settings} onChange={onChange} onBack={onBack} />;
  }

  if (section === "sync") {
    return (
      <SyncPage
        sync={sync}
        onBack={onBack}
        onSyncLogin={onSyncLogin}
        onSyncLogout={onSyncLogout}
        onSyncNow={onSyncNow}
      />
    );
  }

  if (section === "library") {
    const totalCharacters = books.reduce((sum, book) => sum + book.characterCount, 0);
    return (
      <div className="settings-screen">
        <PageBar title="本地书库" subtitle="这台设备上存的书" onBack={onBack} />
        <main className="settings-main">
          <Section
            foot={
              sync.connected
                ? "已开启云端同步：清空只影响这台设备，云端数据保留，下次同步会恢复回来。"
                : "书籍、进度和标记保存在当前浏览器里，不会由墨听上传。"
            }
          >
            <div className="settings-card settings-stats">
              <div>
                <strong>{books.length}</strong>
                <span>本书</span>
              </div>
              <div>
                <strong>{formatStorageSize(totalCharacters)}</strong>
                <span>约占文本空间</span>
              </div>
            </div>
          </Section>
          <Section>
            <div className="settings-card">
              <button type="button" className="settings-danger" onClick={onClear}>
                <Trash2 size={18} />
                清空本地书库
              </button>
            </div>
          </Section>
        </main>
      </div>
    );
  }

  return (
    <div className="settings-screen">
      <PageBar
        title="设置"
        onBack={onBack}
        trailing={
          <span className="page-bar__mark" aria-hidden>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/bear-mark.png" alt="" width={40} height={40} />
          </span>
        }
      />
      <main className="settings-main">
        <Section title="外观" foot={<p className="settings-foot__center">书架外观与阅读主题分别设置</p>}>
          <div className="settings-segmented" role="group" aria-label="书架外观">
            {(
              [
                ["white", "软白"],
                ["cream", "宣纸"],
                ["black", "墨夜"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={settings.shellTheme === value ? "is-active" : ""}
                aria-pressed={settings.shellTheme === value}
                onClick={() => onChange({ ...settings, shellTheme: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="阅读与听书">
          <div className="settings-card">
            <LinkRow
              icon={<Headphones size={24} strokeWidth={1.7} />}
              label="朗读音色"
              detail={
                settings.speechReplacements?.length
                  ? `读音纠正 ${settings.speechReplacements.length} 条`
                  : undefined
              }
              value={voiceName}
              onClick={() => onOpen("voice")}
            />
            <LinkRow
              icon={<Gauge size={24} strokeWidth={1.7} />}
              label="默认倍速"
              value={`${settings.speechRate.toFixed(1)}×`}
              onClick={() => onOpen("speed")}
            />
            <LinkRow
              icon={<BookOpen size={24} strokeWidth={1.7} />}
              label="阅读主题"
              value={themeName}
              onClick={() => onOpen("theme")}
            />
            <LinkRow
              icon={<span className="settings-link__glyph">Aa</span>}
              label="正文字体"
              value={fontName}
              onClick={() => onOpen("font")}
            />
          </div>
        </Section>

        <Section foot="打开后，在阅读页划词点「从这里听」会留在正文里，底栏多一个暂停键。手指一滑正文就不再跟，点右下角的小圆点接着跟。">
          <label className="settings-card settings-toggle">
            <span>
              <strong>听读同步</strong>
              <em>听书时正文跟着朗读翻动，听到哪里阅读进度就记到哪里</em>
            </span>
            <span className="ai-switch">
              <input
                type="checkbox"
                checked={settings.followSpeech}
                onChange={(event) =>
                  onChange({ ...settings, followSpeech: event.target.checked })
                }
              />
              <span className="ai-switch__track">
                <span className="ai-switch__thumb" />
              </span>
            </span>
          </label>
        </Section>

        <Section
          title="助手与数据"
          foot={
            <>
              <p>
                {sync.connected
                  ? "已登录：书籍、进度和划线会在设备间自动合并。"
                  : "未登录时，书籍与进度保存在本机。"}
              </p>
              <p className="settings-foot__center">墨听阅读器 · 1.0</p>
            </>
          }
        >
          <div className="settings-card">
            <LinkRow
              icon={<Sparkles size={24} strokeWidth={1.7} />}
              label="AI 助手"
              detail="模型与接口配置"
              value={aiReady ? `${activeAiProvider(settings)?.name} · ${settings.aiModel}` : "未配置"}
              onClick={() => onOpen("ai")}
            />
            <LinkRow
              icon={<Cloud size={24} strokeWidth={1.7} />}
              label="云端同步"
              value={syncValue}
              onClick={() => onOpen("sync")}
            />
            <LinkRow
              icon={<Library size={24} strokeWidth={1.7} />}
              label="本地书库"
              value={`${books.length} 本书`}
              onClick={() => onOpen("library")}
            />
            <LinkRow
              icon={<RefreshCw size={24} strokeWidth={1.7} />}
              label={update.status === "available" ? "更新到新版本" : "检查更新"}
              value={UPDATE_LABEL[update.status]}
              onClick={update.status === "available" ? update.apply : update.check}
            />
            {/* 临时的诊断页：在主屏幕打开的 PWA 里验证锁屏连续听书，定下播放方案后删掉。 */}
            <LinkRow
              icon={<Headphones size={24} strokeWidth={1.7} />}
              label="后台听书测试"
              detail="锁屏连续播放诊断"
              value=""
              onClick={() => window.location.assign("/mms-probe.html")}
            />
          </div>
        </Section>
      </main>
    </div>
  );
}

function SyncPage({
  sync,
  onBack,
  onSyncLogin,
  onSyncLogout,
  onSyncNow,
}: {
  sync: SyncSummary;
  onBack: () => void;
  onSyncLogin: (username: string, password: string) => Promise<void>;
  onSyncLogout: () => void;
  onSyncNow: () => void;
}) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !user.trim() || !pass) return;
    setBusy(true);
    try {
      await onSyncLogin(user.trim(), pass);
      setPass("");
    } catch {
      // 错误已由 onSyncLogin 写进 sync.error，这里只负责展示。
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-screen">
      <PageBar title="云端同步" subtitle="书籍、进度和划线在设备间合并" onBack={onBack} />
      <main className="settings-main">
        {!sync.enabled ? (
          <Section>
            <div className="settings-card settings-card--padded">
              <p className="settings-note">这个部署没有开启同步，数据只存在本机。</p>
            </div>
          </Section>
        ) : sync.connected ? (
          <>
            <Section
              title="状态"
              foot="进度收到云端确认后才清理待上传项；并发位置保留供你选择。"
            >
              <div className="settings-card settings-card--padded" aria-live="polite">
                <p className="settings-status">
                  {sync.syncing ? (
                    <>
                      <LoaderCircle size={15} className="spin" aria-hidden />
                      {sync.message || "正在同步…"}
                    </>
                  ) : sync.lastSyncAt ? (
                    `上次检查云端 ${formatSyncTime(sync.lastSyncAt)}`
                  ) : (
                    "尚未同步"
                  )}
                </p>
                {sync.error ? (
                  <p role="alert" className="settings-error">
                    {sync.error}
                  </p>
                ) : null}
                {!sync.syncing && sync.message ? <p className="settings-note">{sync.message}</p> : null}
                {sync.lastCompleteAt ? <p className="settings-note">上次全部同步 {formatSyncTime(sync.lastCompleteAt)}</p> : null}
                {sync.recordFailures?.length ? (
                  <div role="status">
                    <p className="settings-error">{sync.recordFailures.length} 条记录尚未同步，本机内容已保留</p>
                    {sync.recordFailures.map((failure) => (
                      <p className="settings-note" key={`${failure.kind}:${failure.key}`}>
                        {RECORD_LABELS[failure.kind]} · {sync.bookTitles?.[failure.key] ?? failure.key.slice(0, 8)}
                        {failure.bytes > 0 ? ` · ${(failure.bytes / 1024 / 1024).toFixed(2)} MB` : ""}
                        {`：${failure.reason}。${failure.retryable ? "稍后自动重试" : "修改对应记录后自动重试，也可点击立即同步"}`}
                      </p>
                    ))}
                  </div>
                ) : null}
                {(sync.pendingRecords ?? 0) > (sync.recordFailures?.length ?? 0) ? <p className="settings-note">{sync.pendingRecords} 条记录待同步</p> : null}
                {sync.pendingProgress ? <p className="settings-note">{sync.pendingProgress} 条进度待上传</p> : null}
                {sync.blockedProgress ? <p role="alert" className="settings-error">{sync.blockedProgress} 条进度内容异常；打开对应书籍重新定位后可恢复同步</p> : null}
                {sync.blockedBooks?.map((entry) => <p className="settings-error" key={entry.bookId}>
                  {sync.bookTitles?.[entry.bookId] ?? "书籍正文"}：{entry.reason}。本机正文保留，可点击立即同步重试。
                </p>)}
                {sync.pendingResources ? <p className="settings-note">进度独立同步；{sync.pendingResources} 项书籍资源尚未同步</p> : null}
                <div className="settings-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={sync.syncing}
                    onClick={onSyncNow}
                  >
                    <RefreshCw size={15} />
                    {sync.syncing ? "同步中…" : "立即同步"}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={sync.syncing || busy}
                    onClick={onSyncLogout}
                  >
                    退出同步
                  </button>
                </div>
              </div>
            </Section>
            {sync.conflicts?.map((entry) => {
              const local = JSON.parse(entry.conflict!.data);
              const remote = JSON.parse(entry.data);
              const label = (value: typeof local) => {
                const position = entry.kind === "positions" ? value.position : value;
                return `第 ${position.chapterIndex + 1} 章 · ${Math.round(position.percent)}%`;
              };
              return <Section key={entry.id} title={`${sync.bookTitles?.[entry.key] ?? "书籍"} · ${entry.kind === "positions" ? "阅读" : "听书"}`}>
                <div className="settings-card settings-card--padded">
                  <p className="settings-note">两台设备修改了位置，当前保留云端位置，本机候选仍可恢复。</p>
                  <p className="settings-note">本机：{label(local)}；云端：{label(remote)}</p>
                  <div className="settings-actions">
                    <button type="button" className="primary-button" onClick={() => void sync.onResolveConflict?.(entry.id, true)}>使用本机位置</button>
                    <button type="button" className="text-button" onClick={() => void sync.onResolveConflict?.(entry.id, false)}>保留云端位置</button>
                  </div>
                </div>
              </Section>;
            })}
          </>
        ) : sync.checkingSession ? (
          <Section title="连接状态">
            <div className="settings-card settings-card--padded" aria-live="polite">
              <p className="settings-note">正在恢复同步连接，本机进度已保留。</p>
              {sync.error ? <p role="alert" className="settings-error">{sync.error}</p> : null}
              <button type="button" className="primary-button" onClick={onSyncNow}>重试连接</button>
            </div>
          </Section>
        ) : (
          <Section title="登录" foot="不登录也照常用，只是数据只存在这台设备上。">
            <form className="settings-card settings-card--form sync-login" onSubmit={submit}>
              <label className="settings-field">
                <span>用户名</span>
                <span className="settings-input">
                  <input
                    type="text"
                    autoComplete="username"
                    value={user}
                    maxLength={256}
                    disabled={busy}
                    onChange={(event) => setUser(event.target.value)}
                  />
                </span>
              </label>
              <label className="settings-field">
                <span>密码</span>
                <span className="settings-input">
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={pass}
                    maxLength={256}
                    disabled={busy}
                    onChange={(event) => setPass(event.target.value)}
                  />
                </span>
              </label>
              {sync.error ? (
                <p role="alert" className="settings-error">
                  {sync.error}
                </p>
              ) : null}
              <button
                type="submit"
                className="primary-button settings-submit"
                disabled={busy || !user.trim() || !pass}
              >
                {busy ? "正在登录…" : "登录并同步"}
              </button>
            </form>
          </Section>
        )}
      </main>
    </div>
  );
}

/**
 * AI 助手：连接设置、主备模型、回答偏好三块。
 *
 * 模型名可以手填，也可以从接口返回的列表里挑——列表在接口地址填好后自动拉，
 * 拉不到就明说，退回手填。地址和密钥在离开输入框时保存，其余一改就存。
 */
function AiSettingsPage({
  settings, onChange, onBack,
}: {
  settings: ReaderSettings;
  onChange: (settings: ReaderSettings) => void;
  onBack: () => void;
}) {
  const providers = getAiProviders(settings);
  const active = activeAiProvider(settings);
  const [editingId, setEditingId] = useState(active?.id ?? "");
  const [adding, setAdding] = useState(false);
  const editing = providers.find(provider => provider.id === editingId) ?? active;
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const commit = (next: ReaderSettings) => {
    settingsRef.current = next;
    onChange(next);
  };
  const updateProvider = (id: string, patch: Partial<AiProvider>) => {
    const current = settingsRef.current;
    commit(withAiProviders(current, getAiProviders(current).map(provider =>
      provider.id === id ? { ...provider, ...patch } : provider)));
  };

  return (
    <div className="settings-screen">
      <PageBar title="AI 助手" subtitle="用于划词提问和书内对话" onBack={onBack} />
      <main className="settings-main">
        <Section title="服务商" foot={<p>每家服务商单独保存配置，点名称编辑，点「使用」切换。</p>}>
          <div className="settings-card">
            {providers.map(provider => (
              <div className="ai-provider-row" key={provider.id}>
                <button type="button" className="ai-provider-row__edit"
                  aria-pressed={editing?.id === provider.id} onClick={() => setEditingId(provider.id)}>
                  <strong>{provider.name}</strong>
                  <small>{provider.model || "尚未选择模型"}</small>
                </button>
                <button type="button" className="text-button" aria-label={`使用 ${provider.name}`}
                  disabled={active?.id === provider.id}
                  onClick={() => {
                    const current = settingsRef.current;
                    commit(withAiProviders(current, getAiProviders(current), provider.id));
                    setEditingId(provider.id);
                  }}>
                  {active?.id === provider.id ? "当前使用" : "使用"}
                </button>
              </div>
            ))}
            <button type="button" className="settings-option" onClick={() => setAdding(true)}>
              添加服务商
            </button>
          </div>
        </Section>

        {editing ? <AiProviderEditor key={editing.id} provider={editing}
          onUpdate={patch => updateProvider(editing.id, patch)}
          onDelete={() => {
            const current = settingsRef.current;
            commit(withAiProviders(current, getAiProviders(current).filter(provider => provider.id !== editing.id)));
          }} /> : null}

        {providers.length > 1 ? (
          <Section title="跨服务商备用" foot={<p>主服务商繁忙、限流或连接失败时，改用所选服务商的主模型。只在回答开始前切换。</p>}>
            <div className="settings-card settings-card--form">
              <label className="settings-field">
                <span>备用服务商</span>
                <select className="settings-input" aria-label="备用服务商"
                  value={settings.aiFallbackProviderId === active?.id ? "" : settings.aiFallbackProviderId || ""}
                  onChange={event => commit({ ...settingsRef.current, aiFallbackProviderId: event.target.value })}>
                  <option value="">不启用</option>
                  {providers.filter(provider => provider.id !== active?.id).map(provider => (
                    <option key={provider.id} value={provider.id} disabled={!provider.baseUrl.trim() || !provider.model.trim()}>
                      {provider.name}{provider.model ? ` · ${provider.model}` : "（请先配置模型）"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Section>
        ) : null}

        <Section title="回答偏好" foot={<>
          <p>修改自动保存。开启同步后，配置和密钥会随设置同步到你的其他设备。</p>
          <p>使用 OpenAI 兼容接口，请求经墨听转发；转发日志不记录密钥和对话。</p>
        </>}>
          <label className="settings-card settings-toggle">
            <span><strong>深度思考</strong><em>需服务商和模型支持</em></span>
            <span className="ai-switch">
              <input type="checkbox" checked={settings.aiDeepThinking}
                onChange={event => commit({ ...settingsRef.current, aiDeepThinking: event.target.checked })} />
              <span className="ai-switch__track"><span className="ai-switch__thumb" /></span>
            </span>
          </label>
        </Section>
      </main>
      {adding ? (
        <Modal title="添加服务商" onClose={() => setAdding(false)}>
          <div className="settings-card">
            {AI_PROVIDER_PRESETS.map(preset => (
              <OptionRow key={preset.name} selected={false} label={preset.name} onClick={() => {
                const provider: AiProvider = { ...preset, id: crypto.randomUUID(), apiKey: "", model: "", fallbackModel: "" };
                const current = settingsRef.current;
                commit(withAiProviders(current, [...getAiProviders(current), provider]));
                setEditingId(provider.id);
                setAdding(false);
              }} />
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function AiProviderEditor({ provider, onUpdate, onDelete }: {
  provider: AiProvider;
  onUpdate: (patch: Partial<AiProvider>) => void;
  onDelete: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState<"main" | "fallback" | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const loadModels = useCallback(async (baseUrl: string, apiKey: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setModels([]);
    setError("");
    setLoading(Boolean(baseUrl.trim()));
    if (!baseUrl.trim()) return;
    try {
      const list = await fetchAiModels(baseUrl, apiKey, controller.signal);
      if (!controller.signal.aborted) setModels(list);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof AiRequestError ? err.message : "获取模型列表失败");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadModels(provider.baseUrl, provider.apiKey), 0);
    return () => { window.clearTimeout(timer); controllerRef.current?.abort(); };
  }, [loadModels, provider.baseUrl, provider.apiKey]);

  const status = !provider.baseUrl.trim() ? "填写接口后可获取模型列表。" : loading ? "正在获取模型列表…"
    : error ? `拿不到模型列表（${error}），可以直接手填模型名。`
      : models.length ? `接口返回了 ${models.length} 个模型。` : "可直接手填模型名。";

  return <>
    <Section title={`配置 · ${provider.name}`}>
      <div className="settings-card settings-card--form">
        <label className="settings-field"><span>名称</span><span className="settings-input">
          <input key={provider.name} defaultValue={provider.name} maxLength={80}
            onBlur={event => onUpdate({ name: event.target.value.trim() || provider.name })} />
        </span></label>
        <label className="settings-field"><span>接口地址</span><span className="settings-input">
          <input key={provider.baseUrl} defaultValue={provider.baseUrl} type="text" inputMode="url"
            autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="https://api.example.com/v1"
            onBlur={event => onUpdate({ baseUrl: event.target.value.trim().replace(/\/+$/, "") })} />
        </span></label>
        <label className="settings-field"><span>API Key</span><span className="settings-input">
          <input key={provider.apiKey} defaultValue={provider.apiKey} type={showKey ? "text" : "password"}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="输入 API Key"
            onBlur={event => onUpdate({ apiKey: event.target.value.trim() })} />
          <button type="button" className="settings-input__icon" aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
            onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={20} /> : <Eye size={20} />}</button>
        </span></label>
      </div>
    </Section>
    <Section title="模型" foot={<p className={error ? "settings-error" : undefined} role="status">{status}</p>}>
      <div className="settings-card settings-card--form">
        <div className="settings-field"><span>主模型</span>
          <button type="button" className={`settings-input settings-input--button${provider.model ? "" : " is-empty"}`}
            onClick={() => setPicking("main")}><span>{provider.model || "填写模型名称"}</span>
            {loading ? <LoaderCircle size={16} className="spin" aria-hidden /> : null}</button>
        </div>
        <div className="settings-field"><span>同服务商备用模型</span>
          <button type="button" className={`settings-input settings-input--button${provider.fallbackModel ? "" : " is-empty"}`}
            onClick={() => setPicking("fallback")}><span>{provider.fallbackModel || "选填"}</span></button>
        </div>
        <p className="settings-card__note">未选择跨服务商备用时，主模型繁忙会改用这个模型。</p>
      </div>
    </Section>
    <button type="button" className="settings-danger" onClick={onDelete}><Trash2 size={18} />删除此服务商</button>
    {picking ? <ModelPicker title={picking === "main" ? "主模型" : "备用模型"}
      value={picking === "main" ? provider.model : provider.fallbackModel}
      models={models} loading={loading} status={status} allowNone={picking === "fallback"}
      canReload={Boolean(provider.baseUrl.trim()) && !loading}
      onReload={() => void loadModels(provider.baseUrl, provider.apiKey)}
      onPick={model => onUpdate(picking === "main" ? { model } : { fallbackModel: model })}
      onClose={() => setPicking(null)} /> : null}
  </>;
}

/** 选模型：上面手填，下面是接口返回的列表（多了可以筛）。 */
function ModelPicker({
  title,
  value,
  models,
  loading,
  status,
  allowNone,
  canReload,
  onReload,
  onPick,
  onClose,
}: {
  title: string;
  value: string;
  models: string[];
  loading: boolean;
  status: string;
  allowNone: boolean;
  canReload: boolean;
  onReload: () => void;
  onPick: (model: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [query, setQuery] = useState("");
  const visible = query.trim()
    ? models.filter((model) => model.toLowerCase().includes(query.trim().toLowerCase()))
    : models;

  return (
    <Modal title={title} onClose={onClose}>
      <div className="model-picker">
        <form
          className="model-picker__manual"
          onSubmit={(event) => {
            event.preventDefault();
            onPick(draft.trim());
            onClose();
          }}
        >
          <span className="settings-input">
            <input
              type="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={draft}
              placeholder={allowNone ? "不填就不用备用模型" : "填写模型名称"}
              aria-label={`手动填写${title}`}
              onChange={(event) => setDraft(event.target.value)}
            />
          </span>
          <button type="submit" className="primary-button">
            用这个
          </button>
        </form>

        <div className="model-picker__head">
          <p>{status}</p>
          <button type="button" className="text-button" disabled={!canReload} onClick={onReload}>
            {loading ? <LoaderCircle size={13} className="spin" aria-hidden /> : null}
            重新获取
          </button>
        </div>

        {models.length > 8 ? (
          <label className="settings-input model-picker__search">
            <Search size={16} aria-hidden />
            <input
              type="text"
              value={query}
              placeholder="筛选模型"
              aria-label="筛选模型"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        ) : null}

        {models.length || allowNone ? (
          <div className="settings-card model-picker__list">
            {allowNone ? (
              <OptionRow
                selected={!value}
                label="不用备用模型"
                onClick={() => {
                  onPick("");
                  onClose();
                }}
              />
            ) : null}
            {visible.map((model) => (
              <OptionRow
                key={model}
                selected={value === model}
                label={model}
                onClick={() => {
                  onPick(model);
                  onClose();
                }}
              />
            ))}
            {models.length && !visible.length ? (
              <p className="model-picker__empty">没有匹配「{query}」的模型</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
