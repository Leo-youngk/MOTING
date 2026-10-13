"use client";

import { Copy, KeyRound, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { KNOWLEDGE_API_PATH, requestKnowledgeKeys, type KnowledgeApiKey } from "../lib/knowledge-api";
import type { SyncSummary } from "./settings-screen";

function dateLabel(value: number): string { return new Date(value).toLocaleDateString("zh-CN"); }

export function KnowledgeAccessSettings({ sync, onOpenSync, onSyncNow }: {
  sync: SyncSummary;
  onOpenSync: () => void;
  onSyncNow: () => void;
}) {
  return <main className="settings-main">
    <section className="settings-section">
      <h2>让 Bot 读懂你的阅读</h2>
      <div className="settings-card settings-card--padded">
        <p className="settings-note">授权 Grok bot 读取你的划线摘录、想法和 AI 对话。密钥只授予读取权限，可随时撤销。</p>
        <p className="settings-note">接口读取云端已同步的内容，本地新增记录请先同步。</p>
        {sync.connected ? <>
          <div className="settings-actions">
            <button type="button" className="text-button" disabled={sync.syncing} onClick={onSyncNow}>
              <RefreshCw size={15} aria-hidden />{sync.syncing ? "同步中…" : "立即同步"}
            </button>
          </div>
          {sync.error ? <p className="settings-error" role="alert">{sync.error}</p> : null}
          {sync.lastSyncAt ? <p className="settings-note">上次检查云端：{new Date(sync.lastSyncAt).toLocaleString("zh-CN")}</p> : null}
        </> : <div className="settings-actions">
          <button type="button" className="primary-button" onClick={onOpenSync}>登录云端同步</button>
        </div>}
      </div>
    </section>
    {sync.connected ? <AccessKeyManager /> : <p className="settings-foot">{sync.enabled ? "登录同步账号后即可创建专用密钥。" : "这个部署尚未启用云端同步。"}</p>}
  </main>;
}

function AccessKeyManager() {
  const [keys, setKeys] = useState<KnowledgeApiKey[]>([]);
  const [checkedAt, setCheckedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("Grok bot");
  const [days, setDays] = useState(365);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = typeof window === "undefined" ? KNOWLEDGE_API_PATH : `${window.location.origin}${KNOWLEDGE_API_PATH}`;

  useEffect(() => {
    const controller = new AbortController();
    requestKnowledgeKeys<{ keys: KnowledgeApiKey[] }>("", undefined, controller.signal).then((data) => {
      if (!controller.signal.aborted) { setKeys(data.keys); setCheckedAt(Date.now()); setLoading(false); }
    }).catch((error: Error) => {
      if (!controller.signal.aborted) { setError(error.message); setLoading(false); }
    });
    return () => controller.abort();
  }, []);

  const refresh = async () => {
    setBusy(true); setError("");
    try { setKeys((await requestKnowledgeKeys<{ keys: KnowledgeApiKey[] }>()).keys); setCheckedAt(Date.now()); }
    catch (error) { setError(error instanceof Error ? error.message : "无法读取密钥，请重试"); }
    finally { setBusy(false); }
  };
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || token || !name.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await requestKnowledgeKeys<{ key: KnowledgeApiKey; token: string }>("", { name: name.trim(), expiresInDays: days });
      setToken(result.token);
      setCheckedAt(Date.now());
      setKeys((keys) => [result.key, ...keys]);
    } catch (error) { setError(error instanceof Error ? error.message : "创建失败，请重试"); }
    finally { setBusy(false); }
  };
  const revoke = async (key: KnowledgeApiKey) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await requestKnowledgeKeys(`/${key.id}/revoke`, {});
      setKeys((keys) => keys.map((item) => item.id === key.id ? { ...item, revokedAt: Date.now() } : item));
      if (token.startsWith(key.prefix)) setToken("");
      setNotice(`已撤销「${key.name}」，Bot 将无法再用它读取数据。`);
    } catch (error) { setError(error instanceof Error ? error.message : "撤销失败，请重试"); }
    finally { setBusy(false); }
  };
  const copy = async (value: string, label: string) => {
    setError("");
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label}已复制`);
    } catch { setError("无法使用剪贴板，请长按文本手动复制"); }
  };
  const instructions = `墨听只读 API\n基础地址：${base}\n鉴权：Authorization: Bearer <你的专用密钥>\n客户端标识：User-Agent: Moting-Grok-Bot/1.0\nOpenAPI：${base}/openapi.json\nGET /books：书名与作者\nGET /notes：划线和想法（thoughtsOnly=true 只读想法）\nGET /chats：对话目录\nGET /chats/{bookId}：分页读取原始提问、回答和引用\n列表支持 bookId、q、updatedSince、limit、cursor。遍历到 nextCursor=null，空页有游标也须继续，并保留筛选条件。跨句划线按 bookId、groupId 合并。只读取已同步数据；不要将密钥写到 URL 或日志。`;

  return <>
    <section className="settings-section">
      <h2>创建只读密钥</h2>
      <form className="settings-card settings-card--form" onSubmit={create}>
        <label className="settings-field"><span>名称</span><span className="settings-input">
          <input value={name} maxLength={60} autoComplete="off" disabled={busy || loading || Boolean(token)} onChange={(event) => setName(event.target.value)} />
        </span></label>
        <label className="settings-field"><span>有效期</span><span className="settings-input">
          <select value={days} disabled={busy || loading || Boolean(token)} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={30}>30 天</option><option value={90}>90 天</option><option value={365}>1 年</option>
          </select>
        </span></label>
        <button className="primary-button settings-submit" type="submit" disabled={busy || loading || Boolean(token) || !name.trim()}>
          {busy ? <LoaderCircle size={16} className="spin" aria-hidden /> : <KeyRound size={16} aria-hidden />} 创建密钥
        </button>
      </form>
      <p className="settings-foot">密钥允许读取划线、想法和 AI 对话，有效期内请妥善保管。最多可保留 10 个有效密钥。</p>
    </section>
    {token ? <section className="settings-section" aria-label="新建的密钥">
      <h2>保存这一次显示的密钥</h2>
      <div className="settings-card settings-card--padded">
        <p className="settings-note">离开此页后无法再次查看原文。复制后填入 Grok bot 的凭据设置。</p>
        <textarea className="knowledge-access-text" aria-label="新建的只读密钥" readOnly rows={3} value={token} spellCheck={false} autoCapitalize="off" />
        <div className="settings-actions">
          <button type="button" className="primary-button" onClick={() => void copy(token, "密钥")}><Copy size={15} aria-hidden />复制密钥</button>
          <button type="button" className="text-button" onClick={() => { setToken(""); setNotice(""); }}>已保存，收起密钥</button>
        </div>
      </div>
    </section> : null}
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    <p className="settings-status" role="status" aria-live="polite">{notice}</p>
    <section className="settings-section">
      <h2>已创建的密钥</h2>
      <div className="settings-card settings-card--padded">
        {loading ? <p className="settings-note"><LoaderCircle size={15} className="spin" aria-hidden /> 正在读取…</p> : keys.length ? keys.map((key) => {
          const status = key.revokedAt ? "已撤销" : key.expiresAt <= checkedAt ? "已到期" : "有效";
          return <div className="knowledge-access-key" key={key.id}>
            <div><strong>{key.name}</strong><small>{key.prefix}… · {status}</small>
              <small>{dateLabel(key.expiresAt)} 到期 · {key.lastUsedAt ? `最近使用 ${dateLabel(key.lastUsedAt)}` : "尚未使用"}</small></div>
            {status === "有效" ? <button type="button" className="text-button knowledge-access-revoke" disabled={busy} aria-label={`撤销 ${key.name}`} onClick={() => void revoke(key)}><Trash2 size={15} aria-hidden />撤销</button> : null}
          </div>;
        }) : <p className="settings-note">还没有密钥。</p>}
        <button type="button" className="text-button" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden />刷新列表</button>
      </div>
    </section>
    <section className="settings-section">
      <h2>接入 Grok bot</h2>
      <div className="settings-card settings-card--padded">
        <label className="settings-field"><span>基础地址</span><input className="knowledge-access-text" readOnly value={base} aria-label="API 基础地址" /></label>
        <div className="settings-actions">
          <button type="button" className="text-button" onClick={() => void copy(instructions, "接入说明")}><Copy size={15} aria-hidden />复制接入说明</button>
          <a className="text-button" href={`${base}/openapi.json`} target="_blank" rel="noreferrer">OpenAPI 文档</a>
        </div>
      </div>
    </section>
  </>;
}
