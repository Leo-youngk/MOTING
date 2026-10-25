"use client";

import { useEffect } from "react";

/** 地址栏收合也会缩小视觉视口，只有输入中且明显缩高时才按软键盘处理。 */
const KEYBOARD_THRESHOLD = 100;

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
      const focused = document.activeElement;
      const editing = focused instanceof HTMLElement &&
        focused.matches("input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]");
      // iOS 会把视觉视口向上平移以露出输入框。键盘是否打开看总缩高，
      // 浮层的上下边分别跟 offsetTop 和底部遮挡量走，不能只抬高底边。
      const shrunken = window.innerHeight - viewport.height > KEYBOARD_THRESHOLD;
      const unzoomed = Math.abs(viewport.scale - 1) < 0.05;
      // blur 比键盘退场早；等视口恢复后才撤掉避让，关闭时不会先掉到键盘下面。
      const open = unzoomed && shrunken &&
        (editing || root.hasAttribute("data-keyboard-open"));
      const inset = open
        ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
        : 0;
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      root.style.setProperty("--visual-viewport-top", `${open ? Math.max(0, Math.round(viewport.offsetTop)) : 0}px`);
      root.style.setProperty("--visual-viewport-height", `${Math.round(viewport.height)}px`);
      root.toggleAttribute("data-keyboard-open", open);
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(sync);
    };

    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    sync();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      root.style.removeProperty("--keyboard-inset");
      root.style.removeProperty("--visual-viewport-top");
      root.style.removeProperty("--visual-viewport-height");
      root.removeAttribute("data-keyboard-open");
    };
  }, []);
}
