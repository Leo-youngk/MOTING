"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/*
 * 底部弹层（iOS sheet）和它要用的滚动锁。
 * 主界面、在线找书、阅读器都用这一套：进出同一条动画、能拖下来关、Esc 只关最上面一层，
 * 开着的时候底下的页面钉住不动。
 */

// 浮层叠着开时，只有最外层那一次负责记录和还原滚动位置。
let scrollLockCount = 0;
let lockedScrollY = 0;
// 关闭浮层的同一个事件里如果发生了跳转（比如点目录），跳转后的滚动位置才是
// 用户想要的，不能被这里的"还原到开浮层前的位置"覆盖掉。而且锁着的时候 body 是
// position: fixed，这期间的滚动全都不算数，所以跳转的滚动得挪到解锁那一刻再做。
let scrollAfterUnlock: (() => void) | null = null;

export function scrollWhenUnlocked(scroll: () => void) {
  if (scrollLockCount > 0) scrollAfterUnlock = scroll;
  else scroll();
}

// 浮层是 position: fixed，挡不住底下的 body 一起被拖动——尤其是弹键盘的时候，
// 背景页面跟着 focus 一起窜，整个 UI 看着在晃。开着的时候把 body 锁死，关掉再还原。
// iOS standalone 下 overflow: hidden 拦不住 focus 触发的整页上推，只有 position: fixed 拦得住。
export function useScrollLock() {
  useEffect(() => {
    if (scrollLockCount++ === 0) {
      lockedScrollY = window.scrollY;
      document.body.style.top = `${-lockedScrollY}px`;
      document.body.classList.add("is-scroll-locked");
    }
    return () => {
      if (--scrollLockCount > 0) return;
      document.body.classList.remove("is-scroll-locked");
      document.body.style.top = "";
      const scroll = scrollAfterUnlock;
      scrollAfterUnlock = null;
      if (scroll) scroll();
      else window.scrollTo(0, lockedScrollY);
    };
  }, []);
}

/** 弹层里的按钮（比如「取消」）要走弹层自己的关闭：滑下去再卸掉。 */
const ModalCloseContext = createContext<() => void>(() => {});

export function SheetCancelButton({ children }: { children: ReactNode }) {
  const close = useContext(ModalCloseContext);
  return (
    <button type="button" className="secondary-button" onClick={close}>
      {children}
    </button>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  // 关闭先走退场动画（面板滑下去、遮罩淡掉），放完再真正卸掉。
  // 以前一关就啪地消失，跟滑上来的进场一对比，像是被硬拔掉的。
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const requestClose = useCallback(() => setClosing(true), []);
  useEffect(() => {
    if (!closing) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => onCloseRef.current(), reduced ? 0 : SHEET_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useScrollLock();
  useEscapeToClose(requestClose);
  const drag = useSheetDrag(requestClose);
  // 按下就关会误伤：手指落在面板边缘想滑动、稍微移出去一点就把面板关掉了。
  // 记住这一下是不是从遮罩上按下的，抬手仍在遮罩上才算「点空白关闭」。
  const fromBackdrop = useRef(false);

  return createPortal(
    <div
      className={`modal-backdrop${closing ? " is-closing" : ""}`}
      role="presentation"
      onPointerDown={(event) => {
        fromBackdrop.current = event.target === event.currentTarget;
      }}
      onPointerUp={(event) => {
        const outside =
          fromBackdrop.current && event.target === event.currentTarget;
        fromBackdrop.current = false;
        if (outside) requestClose();
      }}
    >
      <section
        className={`modal-sheet ${wide ? "modal-sheet--wide" : ""} ${
          drag.dragging ? "is-dragging" : ""
        } ${closing ? "is-closing" : ""} ${className}`}
        style={drag.offset ? { transform: `translateY(${drag.offset}px)` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* 把手不再是装饰：真能拖下去关掉。touch-action 写在 CSS 里，
            必须在手指落下之前就生效，事后再改浏览器不认。 */}
        <div
          className="modal-grabber"
          role="presentation"
          onPointerDown={drag.onPointerDown}
        />
        <header onPointerDown={drag.onPointerDown}>
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={requestClose}
          >
            <X size={20} />
          </button>
        </header>
        <ModalCloseContext.Provider value={requestClose}>{children}</ModalCloseContext.Provider>
      </section>
    </div>,
    document.body
  );
}

/** 开着的弹层栈。Esc 只关最上面那一层，不能一键掀掉所有层。 */
const openSheets: Array<() => void> = [];

export function useEscapeToClose(onClose: () => void) {
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const close = () => closeRef.current();
    openSheets.push(close);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (openSheets[openSheets.length - 1] !== close) return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = openSheets.indexOf(close);
      if (at >= 0) openSheets.splice(at, 1);
    };
  }, []);
}

/** 往下拖到这么多像素就松手关闭，没到就弹回去。 */
const SHEET_DISMISS_PX = 96;
/** 面板退场动画的时长，和 CSS 里 .modal-sheet.is-closing 对齐。 */
const SHEET_EXIT_MS = 300;

/**
 * 底部面板的下拉关闭。
 *
 * 只有把手和标题栏能拖——面板内容经常是可滚动的列表，整片都能拖会和滚动打架。
 */
function useSheetDrag(onClose: () => void) {
  const startRef = useRef<{ id: number; y: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (!event.isPrimary || startRef.current) return;
    startRef.current = { id: event.pointerId, y: event.clientY };
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 抓不到就算了，下面 document 上的监听照样能跟。
    }
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || event.pointerId !== start.id) return;
      event.preventDefault();
      // 只认往下拖；往上拖不该把面板拉出屏幕。
      setOffset(Math.max(0, event.clientY - start.y));
    };
    const onUp = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || event.pointerId !== start.id) return;
      const travelled = event.clientY - start.y;
      startRef.current = null;
      setDragging(false);
      // 拖过了阈值：面板停在手指松开的位置，由退场动画从这里接着滑下去，不先弹回原位。
      if (travelled > SHEET_DISMISS_PX) onClose();
      else setOffset(0);
    };
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, onClose]);

  return { offset, dragging, onPointerDown };
}
