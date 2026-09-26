"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppView, MainView } from "../lib/types";
import { pageScrollY, scrollWhenUnlocked } from "../components/sheet";

/** 冷启动要回到上次待的地方，位置存这里。 */
const VIEW_KEY = "moting:last-view";

/** 底部导航的板块。切板块是平级移动，跟原生 tab bar 一样不进历史栈。 */
const TAB_VIEWS = new Set<string>(["home", "library", "listen", "notes"]);

function isTab(view: AppView): boolean {
  return TAB_VIEWS.has(view.name);
}

/**
 * 下钻页面归属哪个板块。
 *
 * 两个用处：冷启动直接落在阅读器时，底下得先垫一层板块，系统返回手势才有地方去；
 * 以及历史栈为空时 goBack 的兜底。
 */
function parentOf(view: AppView): AppView {
  switch (view.name) {
    case "reader":
      return { name: "library" };
    case "player":
      return { name: "listen" };
    case "book-notes":
      return { name: "notes" };
    case "find":
      return { name: "library" };
    case "store":
      return { name: "home" };
    case "settings":
      return view.section ? { name: "settings" } : { name: "home" };
    case "history":
      return { name: "home" };
    default:
      return { name: "home" };
  }
}

function viewKey(view: AppView): string {
  if ("bookId" in view) return `${view.name}:${view.bookId}`;
  if (view.name === "settings" && view.section) return `settings:${view.section}`;
  return view.name;
}

/** 阅读器和播放器按阅读进度自己定位，别用列表页那套滚动记忆去冲掉它。 */
function keepsScroll(view: AppView): boolean {
  return view.name !== "reader" && view.name !== "player";
}

function readSaved(): AppView | null {
  try {
    const raw = window.localStorage.getItem(VIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppView;
    return parsed && typeof parsed.name === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export interface AppNavigation {
  view: AppView;
  /** 当前详情页下方仍保留的主 Tab。 */
  backgroundView: MainView;
  /** 下钻：进历史栈，返回时能回到来处。 */
  navigate: (next: AppView) => void;
  /** 切板块：平级移动，不进历史栈。 */
  selectTab: (name: MainView) => void;
  /** 原地替换，不留历史。 */
  replace: (next: AppView) => void;
  /** 回到来处；本会话没有来处（冷启动直接落进来）时退到 fallback。 */
  goBack: (fallback?: AppView) => void;
}

/**
 * 应用级导航。
 *
 * 在这之前整个 App 的导航就是一个 useState，于是：刷新或被 iOS 回收后重开必然回到
 * 主页、系统返回手势会直接退出应用、每个返回按钮都写死了目的地而不是回到来处。
 * 这里把视图状态接到 History API 上，三件事一起解决，顺带记住每个列表页的滚动位置。
 */
export function useAppNavigation(): AppNavigation {
  // SSR 阶段没有 localStorage，初值只能是主页；真正的恢复放到挂载后做，
  // 否则服务端和客户端首帧对不上会触发 hydration 报错。
  const [view, setView] = useState<AppView>({ name: "home" });
  const [backgroundView, setBackgroundView] = useState<MainView>("home");
  const viewRef = useRef<AppView>(view);
  const scrollsRef = useRef(new Map<string, number>());
  /** 本会话自己压进 history 的层数。为 0 时再 back 就退出应用了，得自己兜住。 */
  const depthRef = useRef(0);

  const remember = useCallback(() => {
    const current = viewRef.current;
    if (keepsScroll(current)) {
      scrollsRef.current.set(viewKey(current), pageScrollY());
    }
  }, []);

  const apply = useCallback((next: AppView) => {
    viewRef.current = next;
    setView(next);
    if (isTab(next)) setBackgroundView(next.name as MainView);
    try {
      window.localStorage.setItem(VIEW_KEY, JSON.stringify(next));
    } catch {
      // 隐私模式下写不进去，代价只是下次冷启动回主页，不影响这一次使用。
    }
  }, []);

  const navigate = useCallback(
    (next: AppView) => {
      remember();
      depthRef.current += 1;
      window.history.pushState({ view: next, depth: depthRef.current }, "");
      apply(next);
    },
    [apply, remember]
  );

  const replace = useCallback(
    (next: AppView) => {
      remember();
      window.history.replaceState({ view: next, depth: depthRef.current }, "");
      apply(next);
    },
    [apply, remember]
  );

  const selectTab = useCallback(
    (name: MainView) => {
      replace({ name });
    },
    [replace]
  );

  const goBack = useCallback(
    (fallback?: AppView) => {
      if (depthRef.current > 0) {
        // 统一走 popstate，系统手势和界面上的返回键才是同一套行为。
        window.history.back();
        return;
      }
      replace(fallback ?? parentOf(viewRef.current));
    },
    [replace]
  );

  // 滚动位置由应用自己管：阅读器要按「读到哪一句」定位，浏览器那套自动还原
  // 会在我们定位完之后再把旧的 scrollY 盖回来，刷新后就落在别处。
  useEffect(() => {
    if (!("scrollRestoration" in window.history)) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      remember();
      const state = event.state as { view?: AppView; depth?: number } | null;
      depthRef.current = state?.depth ?? 0;
      apply(state?.view ?? { name: "home" });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [apply, remember]);

  // 冷启动：回到上次待的地方。下钻页面底下先垫一层所属板块，
  // 这样刚进来就按系统返回手势也有地方可去，不会直接把应用退掉。
  //
  // 这一步只能在挂载后做：渲染期读 localStorage 会让服务端和客户端首帧对不上。
  // 项目里同类的 mount 同步（use-text-selection 的能力探测）也按这个写法豁免。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const saved = readSaved();
    if (!saved) {
      window.history.replaceState({ view: { name: "home" }, depth: 0 }, "");
      return;
    }
    if (isTab(saved)) {
      window.history.replaceState({ view: saved, depth: 0 }, "");
      apply(saved);
      return;
    }
    const parent = parentOf(saved);
    setBackgroundView(isTab(parent) ? (parent.name as MainView) : "home");
    window.history.replaceState({ view: parent, depth: 0 }, "");
    depthRef.current = 1;
    window.history.pushState({ view: saved, depth: 1 }, "");
    apply(saved);
  }, [apply]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 回到列表页时把上次滚到哪儿放回去；没记过就是新进来，从头开始。
  useLayoutEffect(() => {
    if (!keepsScroll(view)) return;
    const top = scrollsRef.current.get(viewKey(view)) ?? 0;
    scrollWhenUnlocked(() => window.scrollTo({ top, behavior: "instant" }));
  }, [view]);

  return { view, backgroundView, navigate, selectTab, replace, goBack };
}
