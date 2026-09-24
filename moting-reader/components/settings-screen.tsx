"use client";

import {
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
import { resolvedEdgeVoiceURI } from "../lib/edge-voices";
import type { AppUpdateStatus } from "../hooks/use-app-update";
import {
  READER_FONTS,
  READER_THEMES,
  READER_THEME_SWATCH,
} from "../lib/reader-options";
import type {
  BookMeta,
  PlayerVoice,
  ReaderSettings,
  SettingsSection,
} from "../lib/types";
import { Modal } from "./sheet";
import { SoftRange } from "./soft-range";
import "./settings-screen.css";

export interface SyncSummary {
  enabled: boolean;
  connected: boolean;
  syncing: boolean;
  message: string;
  error: string;
  lastSyncAt: number;
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
        <PageBar title="朗读音色" subtitle="听书默认用这个声音" onBack={onBack} />
        <main className="settings-main">
          <Section foot="断网或云端暂时不可用时，会自动改用手机自带的朗读声音，播放页上会提示。">
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
              value={aiReady ? settings.aiModel : "未配置"}
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
              foot="每条记录单独比时间，新的留下；任何一台设备的数据都不会被整库覆盖。"
            >
              <div className="settings-card settings-card--padded" aria-live="polite">
                <p className="settings-status">
                  {sync.syncing ? (
                    <>
                      <LoaderCircle size={15} className="spin" aria-hidden />
                      {sync.message || "正在同步…"}
                    </>
                  ) : sync.lastSyncAt ? (
                    `上次同步 ${formatSyncTime(sync.lastSyncAt)}`
                  ) : (
                    "尚未同步"
                  )}
                </p>
                {sync.error ? (
                  <p role="alert" className="settings-error">
                    {sync.error}
                  </p>
                ) : null}
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
          </>
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
  settings,
  onChange,
  onBack,
}: {
  settings: ReaderSettings;
  onChange: (settings: ReaderSettings) => void;
  onBack: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl);
  const [apiKey, setApiKey] = useState(settings.aiApiKey);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState<"main" | "fallback" | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const initialLoadRef = useRef(false);
  // 列表是异步回来的，回来时要拿最新的设置去补默认模型，不能用发请求那一刻的旧值。
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const loadModels = useCallback(
    async (nextBaseUrl: string, nextApiKey: string) => {
      if (!nextBaseUrl.trim()) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setError("");
      try {
        const list = await fetchAiModels(nextBaseUrl, nextApiKey, controller.signal);
        if (controller.signal.aborted) return;
        setModels(list);
        // 还没选过主模型：先用列表第一个，填完地址就能直接用，想换再点进去挑。
        const current = settingsRef.current;
        if (!current.aiModel && list[0]) onChange({ ...current, aiModel: list[0] });
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof AiRequestError ? err.message : "获取模型列表失败");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [onChange]
  );

  // 地址之前就填过的话，一进来就去拉列表，不用等再点一下输入框。
  useEffect(() => {
    if (initialLoadRef.current || !settings.aiBaseUrl.trim()) return;
    initialLoadRef.current = true;
    const timer = window.setTimeout(
      () => void loadModels(settings.aiBaseUrl, settings.aiApiKey),
      0
    );
    return () => window.clearTimeout(timer);
  }, [loadModels, settings.aiBaseUrl, settings.aiApiKey]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const saveConnection = () => {
    if (baseUrl === settings.aiBaseUrl && apiKey === settings.aiApiKey) return;
    onChange({ ...settings, aiBaseUrl: baseUrl.trim(), aiApiKey: apiKey.trim() });
    void loadModels(baseUrl, apiKey);
  };

  // 拉不到列表就退回手填，但得让人看见是退回来的，别默默变成一个空输入框。
  const status = !settings.aiBaseUrl.trim()
    ? "填写接口后可获取模型列表。"
    : loading
      ? "正在获取模型列表…"
      : error
        ? `拿不到模型列表（${error}），可以直接手填模型名。`
        : models.length
          ? `接口返回了 ${models.length} 个模型，点模型那一栏就能挑。`
          : "这个接口没返回模型列表，直接手填模型名。";

  return (
    <div className="settings-screen">
      <PageBar title="AI 助手" subtitle="用于划词提问和书内对话" onBack={onBack} />
      <main className="settings-main">
        <Section title="连接设置">
          <div className="settings-card settings-card--form">
            <label className="settings-field">
              <span>接口地址</span>
              <span className="settings-input">
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => setBaseUrl(event.target.value)}
                  onBlur={saveConnection}
                />
              </span>
            </label>
            <label className="settings-field">
              <span>API Key</span>
              <span className="settings-input">
                <input
                  type={showKey ? "text" : "password"}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={apiKey}
                  placeholder="输入 API Key"
                  onChange={(event) => setApiKey(event.target.value)}
                  onBlur={saveConnection}
                />
                <button
                  type="button"
                  className="settings-input__icon"
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                  onClick={() => setShowKey((value) => !value)}
                >
                  {showKey ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </span>
            </label>
          </div>
        </Section>

        <Section
          title="模型"
          foot={
            <>
              {settings.aiFallbackModel && settings.aiFallbackModel === settings.aiModel ? (
                <p className="settings-error">备用模型和主模型是同一个，等于没设。</p>
              ) : null}
            </>
          }
        >
          <div className="settings-card settings-card--form">
            <div className="settings-field">
              <span>主模型</span>
              <button
                type="button"
                className={`settings-input settings-input--button${settings.aiModel ? "" : " is-empty"}`}
                onClick={() => setPicking("main")}
              >
                <span>{settings.aiModel || "填写模型名称"}</span>
                {loading ? <LoaderCircle size={16} className="spin" aria-hidden /> : null}
              </button>
            </div>
            <div className="settings-field">
              <span>备用模型</span>
              <button
                type="button"
                className={`settings-input settings-input--button${settings.aiFallbackModel ? "" : " is-empty"}`}
                onClick={() => setPicking("fallback")}
              >
                <span>{settings.aiFallbackModel || "选填"}</span>
              </button>
            </div>
            <p className="settings-card__note">主模型繁忙时自动切换，使用同一接口。</p>
          </div>
        </Section>

        <Section
          title="回答偏好"
          foot={
            <>
              <p className={error ? "settings-error" : undefined}>{status}</p>
              <p>修改自动保存。请求经墨听的 Worker 转发一次避开跨域，密钥只存在这台设备上。</p>
            </>
          }
        >
          <label className="settings-card settings-toggle">
            <span>
              <strong>深度思考</strong>
              <em>需模型支持，开启后回答里带上思考过程</em>
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
        </Section>
      </main>

      {picking ? (
        <ModelPicker
          title={picking === "main" ? "主模型" : "备用模型"}
          value={picking === "main" ? settings.aiModel : settings.aiFallbackModel}
          models={models}
          loading={loading}
          status={status}
          allowNone={picking === "fallback"}
          onReload={() => void loadModels(settings.aiBaseUrl, settings.aiApiKey)}
          canReload={Boolean(settings.aiBaseUrl.trim()) && !loading}
          onPick={(model) => {
            onChange(
              picking === "main"
                ? { ...settings, aiModel: model }
                : { ...settings, aiFallbackModel: model }
            );
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </div>
  );
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
