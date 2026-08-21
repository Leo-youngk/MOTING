"use client";

import { useEffect } from "react";

/** 小于这个高度的视口变化算地址栏收合，不算键盘。 */
const KEYBOARD_THRESHOLD = 30;

/**
 * 把软键盘挡住的高度写成 `--keyboard-inset` 挂在 <html> 上。
 *
 * iOS 弹键盘只缩视觉视口，布局视口和 dvh 都纹丝不动，`position: fixed; inset: 0`
 * 的浮层底边照样躲在键盘下面——只能自己量。
 */
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    // 旧 WebKit 没有这个 API，那就退回原来被键盘挡住的行为。
    if (!viewport) return;

    const root = document.documentElement;
    let frame = 0;

    const sync = () => {
      frame = 0;
      const raw = window.innerHeight - viewport.height - viewport.offsetTop;
      const inset = raw > KEYBOARD_THRESHOLD ? Math.round(raw) : 0;
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      root.toggleAttribute("data-keyboard-open", inset > 0);
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(sync);
    };

    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    sync();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      root.style.removeProperty("--keyboard-inset");
      root.removeAttribute("data-keyboard-open");
    };
  }, []);
}
