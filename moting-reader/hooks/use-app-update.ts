"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 发版检查。页面本体由 service worker 缓存优先供给（public/sw.js），新版在后台取好存进缓存，
 * 但眼前这一页还是旧的。这里拿缓存那一版用到的 /assets/ 文件跟本页开机时加载的比：
 * 缓存里有本页没有的文件，就是新版已经就绪，重新载入一次就换上。
 *
 * - checking：正在取最新页面
 * - latest：缓存那一版就是本页
 * - available：新版已就绪
 * - offline：取不到最新页面，只能说缓存里没有更新的
 * - unsupported：开发环境 / 浏览器没有 service worker
 */
export type AppUpdateStatus = "checking" | "latest" | "available" | "offline" | "unsupported";

/** 本页开机时加载的外壳文件。之后按需加载的分片只会让这个集合变大，不影响「缓存里多出来的」判断。 */
function pageAssets(): Set<string> {
  const paths = [...document.querySelectorAll<HTMLLinkElement | HTMLScriptElement>("link[href], script[src]")]
    .map((element) => ("href" in element && element.href ? element.href : (element as HTMLScriptElement).src))
    .map((url) => new URL(url, location.href).pathname)
    .filter((path) => path.startsWith("/assets/"));
  return new Set(paths);
}

/** 从后台切回来时，距上次检查超过这么久才再查一次。iOS 的 PWA 切回前台不会重新载入页面。 */
const RESUME_CHECK_MS = 60_000;

export function useAppUpdate() {
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator && !import.meta.env.DEV;
  const [status, setStatus] = useState<AppUpdateStatus>("checking");
  const loadedRef = useRef<Set<string> | null>(null);
  const lastCheckRef = useRef(0);

  /** 请 service worker 去取一次最新页面，结果从 message 事件回来。 */
  const request = useCallback(() => {
    lastCheckRef.current = Date.now();
    navigator.serviceWorker.ready
      .then((registration) => registration.active?.postMessage({ type: "check-update" }))
      .catch(() => setStatus("offline"));
  }, []);

  const check = useCallback(() => {
    if (!supported) return;
    setStatus((current) => (current === "available" ? current : "checking"));
    request();
  }, [request, supported]);

  useEffect(() => {
    if (!supported) return;
    loadedRef.current = pageAssets();
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; assets?: string[]; offline?: boolean } | null;
      if (data?.type === "shell-expired") {
        // Missing old chunks must not reload underneath a reader, draft or modal.
        // Fetch a complete shell and let the existing update action activate it.
        setStatus("available");
        request();
        return;
      }
      if (data?.type !== "shell" || !Array.isArray(data.assets)) return;
      const loaded = loadedRef.current ?? pageAssets();
      const fresh = data.assets.some((path) => !loaded.has(path));
      setStatus(fresh ? "available" : data.offline ? "offline" : "latest");
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    navigator.serviceWorker.startMessages();
    request();
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheckRef.current > RESUME_CHECK_MS) request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [request, supported]);

  /** 重新载入：导航请求由 service worker 从缓存给出，缓存里已经是新版。 */
  const apply = useCallback(() => {
    location.reload();
  }, []);

  return { status: supported ? status : "unsupported", check, apply };
}
