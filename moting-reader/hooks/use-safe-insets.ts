"use client";

import { useEffect, useState } from "react";

export interface SafeInsets {
  top: number;
  bottom: number;
}

const ZERO: SafeInsets = { top: 0, bottom: 0 };

/**
 * 量出刘海和底部被占掉的像素数。
 *
 * 不能直接读 `--safe-top` 之类的自定义属性：未注册的自定义属性 getPropertyValue
 * 拿回来的是没求值的 `env(...)` 字面量。插一个隐藏探针、让浏览器把 env() 算进
 * padding 里再读，才是稳的。底部还要把软键盘顶上来的高度并进去——菜单要躲的是
 * 「当前真正看不见的那一块」，不分它是 Home 指示条还是键盘。
 */
function measure(): SafeInsets {
  if (typeof document === "undefined") return ZERO;
  const probe = document.createElement("div");
  probe.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "width:0",
    "height:0",
    "visibility:hidden",
    "pointer-events:none",
    "padding-top:env(safe-area-inset-top,0px)",
    "padding-bottom:env(safe-area-inset-bottom,0px)",
  ].join(";");
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const top = Number.parseFloat(style.paddingTop) || 0;
  const safeBottom = Number.parseFloat(style.paddingBottom) || 0;
  probe.remove();

  const keyboard =
    Number.parseFloat(
      document.documentElement.style.getPropertyValue("--keyboard-inset")
    ) || 0;
  return { top, bottom: Math.max(safeBottom, keyboard) };
}

export function useSafeInsets(): SafeInsets {
  const [insets, setInsets] = useState<SafeInsets>(ZERO);

  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      const next = measure();
      setInsets((current) =>
        current.top === next.top && current.bottom === next.bottom
          ? current
          : next
      );
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(sync);
    };

    sync();
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    // 键盘只改视觉视口，window 的 resize 未必会来。
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, []);

  return insets;
}
