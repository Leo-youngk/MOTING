"use client";

import { useEffect } from "react";

/** 状态栏再高也就这么多，超出这个值的差值一律当作量错了。 */
const STATUS_BAR_MAX = 80;

/**
 * standalone + black-translucent 下，iOS 把 innerHeight 少算一个状态栏高度：
 * 布局视口（连带 dvh／lvh／vh）比物理屏矮一截，`position: fixed; inset: 0` 的
 * 浮层只能铺到布局视口底，物理屏底部凭空露出一条 body 背景。CSS 拿不到物理屏高，
 * 只能用 `screen.height` 补——把差值写成 `--viewport-fill-bottom`，让贴底的浮层
 * 把底边往下探这么多。iOS 弹键盘不缩布局视口，所以这个差值竖屏下恒定。
 *
 * 只在 standalone 补偿：普通浏览器里 `screen.height` 是整块显示器高，跟窗口高的
 * 差值毫无意义，补了反而把布局顶坏。
 */
export function useViewportFill() {
  useEffect(() => {
    const root = document.documentElement;

    const sync = () => {
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      const raw = standalone
        ? Math.round(window.screen.height - window.innerHeight)
        : 0;
      // 差值本该只有一个状态栏那么高。量出更大的值说明这次测量赶上了别的状态
      // （横屏、分屏、启动过渡），宁可不补也不要凭空垫出一条死白。
      const fill = raw > 0 && raw <= STATUS_BAR_MAX ? raw : 0;
      root.style.setProperty("--viewport-fill-bottom", `${fill}px`);
    };

    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);

    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      root.style.removeProperty("--viewport-fill-bottom");
    };
  }, []);
}
