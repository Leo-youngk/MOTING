"use client";

import { useEffect, useLayoutEffect } from "react";

/** 状态栏再高也就这么多，超出这个值的差值一律当作量错了。 */
const STATUS_BAR_MAX = 80;

/**
 * standalone + black-translucent 下，iOS 把 innerHeight 少算一个状态栏高度：
 * 布局视口（连带 dvh／lvh／vh）比物理屏矮一截，`position: fixed; inset: 0` 的
 * 浮层只能铺到布局视口底，物理屏底部凭空露出一条 body 背景。CSS 拿不到物理屏高，
 * 只能用 `screen.height` 补——把差值写成 `--viewport-fill-bottom`，让贴底的浮层
 * 把底边往下探这么多。
 *
 * 这个差值不是一直有：刚从桌面图标打开时布局视口往往是满屏的，点几下、弹过一次键盘之后
 * 才缩成少一个状态栏（2026-09 真机截图：底栏离屏底 68pt = 设定的 14 + 状态栏 54）。
 * 所以不能只量一次，布局视口、可视视口一变、切回前台都要重量。
 *
 * 只在 standalone 补偿：普通浏览器里 `screen.height` 是整块显示器高，跟窗口高的
 * 差值毫无意义，补了反而把布局顶坏。
 */
function syncViewportFill() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  const raw = standalone
    ? Math.round(window.screen.height - window.innerHeight)
    : 0;
  // 差值本该只有一个状态栏那么高。量出更大的值说明这次测量赶上了别的状态
  // （横屏、分屏、启动过渡），宁可不补也不要凭空垫出一条死白。
  const fill = raw > 0 && raw <= STATUS_BAR_MAX ? raw : 0;
  document.documentElement.style.setProperty("--viewport-fill-bottom", `${fill}px`);
}

export function useViewportFill(route: string) {
  // A route can change the standalone layout viewport without a resize event.
  // Reconcile before painting the uncovered tab, so the bottom surface and bar
  // never use the previous reader viewport for one frame.
  useLayoutEffect(() => {
    syncViewportFill();
  }, [route]);

  useEffect(() => {
    const viewport = window.visualViewport;
    window.addEventListener("resize", syncViewportFill);
    window.addEventListener("orientationchange", syncViewportFill);
    window.addEventListener("pageshow", syncViewportFill);
    document.addEventListener("visibilitychange", syncViewportFill);
    viewport?.addEventListener("resize", syncViewportFill);

    return () => {
      window.removeEventListener("resize", syncViewportFill);
      window.removeEventListener("orientationchange", syncViewportFill);
      window.removeEventListener("pageshow", syncViewportFill);
      document.removeEventListener("visibilitychange", syncViewportFill);
      viewport?.removeEventListener("resize", syncViewportFill);
      document.documentElement.style.removeProperty("--viewport-fill-bottom");
    };
  }, []);
}
