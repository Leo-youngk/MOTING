"use client";

import { useEffect } from "react";

/** 小于这个高度的视口变化算地址栏收合，不算键盘。 */
const KEYBOARD_THRESHOLD = 30;

/**
 * 把软键盘挡住的高度写成 `--keyboard-inset` 挂在 <html> 上。
 *
 * iOS 弹键盘只缩视觉视口，布局视口和 dvh 都纹丝不动，`position: fixed; inset: 0`
 * 的浮层底边照样躲在键盘下面——只能自己量。
 *
 * 主屏幕独立模式下 `visualViewport.height/offsetTop` 静止状态就跟 `innerHeight`
 * 对不上（差值约等于底部安全区高度），不是键盘。所以量的不是跟 innerHeight 的
 * 绝对差值，而是跟"静止基线"比多出来的部分；基线会跟着差值在阈值内漂移，
 * 也就顺带兼容了转屏后安全区变化。
 */
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    // 旧 WebKit 没有这个 API，那就退回原来被键盘挡住的行为。
    if (!viewport) return;

    const root = document.documentElement;
    let frame = 0;
    let baseline: number | null = null;

    const sync = () => {
      frame = 0;
      const raw = window.innerHeight - viewport.height - viewport.offsetTop;
      if (baseline === null) baseline = raw;
      const delta = raw - baseline;
      const inset = delta > KEYBOARD_THRESHOLD ? Math.round(delta) : 0;
      if (inset === 0) baseline = raw;
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
