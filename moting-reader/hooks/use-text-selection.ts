"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Rect } from "../lib/popover-placement";
import {
  comparePlaces,
  expandToWord,
  isEmptySelection,
  orderedSelection,
  selectionParts,
  selectionText,
  type SelectionPart,
  type SelectionPlace,
  type SelectionSentence,
  type TextSelection,
} from "../lib/text-selection";

/** 长按多久算「要选字」。比 iOS 自己的略长一点，免得快速点句子也被当成长按。 */
const LONG_PRESS_MS = 460;
/** 长按期间手指动过这么多像素就判定是在滚动，撤销这次长按。 */
const MOVE_TOLERANCE = 10;
/** 拖手柄到离边缘这么近就开始自动滚动。 */
const EDGE_SCROLL_ZONE = 72;
const EDGE_SCROLL_SPEED = 12;
/**
 * 手指和手柄锚点之间的偏移，在按下那一刻量一次，整段拖动沿用。
 *
 * 不能用一个固定的「往上抬 N 像素」：起点手柄的圆球在行上方、终点手柄的在行下方，
 * 同一个补偿对其中一个方向正好是反的，会整整偏掉一行。记住实际抓取位置才两边都准。
 */
interface GrabOffset {
  dx: number;
  dy: number;
}

export interface SelectionHandle {
  x: number;
  top: number;
  height: number;
}

interface SelectionGeometry {
  rects: Rect[];
  handles: { start: SelectionHandle; end: SelectionHandle } | null;
  anchor: Rect | null;
  parts: SelectionPart[];
  text: string;
}

const EMPTY_GEOMETRY: SelectionGeometry = {
  rects: [],
  handles: null,
  anchor: null,
  parts: [],
  text: "",
};

export interface CustomSelectionState {
  /** 这台设备/这个浏览器能不能走自定义选区。不能就退回系统选择。 */
  supported: boolean;
  active: boolean;
  dragging: boolean;
  parts: SelectionPart[];
  text: string;
  /** 画选区底色用的矩形，视口坐标。 */
  rects: Rect[];
  handles: { start: SelectionHandle; end: SelectionHandle } | null;
  /** 菜单的锚点矩形。拖动中为 null——拖的时候菜单要让开。 */
  anchor: Rect | null;
  clear: () => void;
  /**
   * 长按选中后浏览器补发的那个 click 要不要吞掉。返回 true 表示「这一下是长按的尾巴」，
   * 调用方直接 return。一次性，读完就复位。
   */
  consumeTapAfterSelect: () => boolean;
  beginHandleDrag: (which: "start" | "end", event: ReactPointerEvent) => void;
  viewportHandlers: {
    onPointerDown: (event: ReactPointerEvent) => void;
    onPointerMove: (event: ReactPointerEvent) => void;
    onPointerUp: (event: ReactPointerEvent) => void;
    onPointerCancel: (event: ReactPointerEvent) => void;
  };
}

interface CaretPoint {
  node: Node;
  offset: number;
}

type CaretDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (
    x: number,
    y: number
  ) => { offsetNode: Node; offset: number } | null;
};

function caretFromPoint(x: number, y: number): CaretPoint | null {
  if (typeof document === "undefined") return null;
  const doc = document as CaretDocument;
  // WebKit 只有前者，Firefox 只有后者，Chrome 两个都有。
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  return null;
}

function sentenceElementOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const element =
    node.nodeType === Node.TEXT_NODE
      ? node.parentElement
      : (node as HTMLElement);
  return element?.closest<HTMLElement>("[data-sentence-id]") ?? null;
}

/** 这个 DOM 位置在所属句子的纯文本里排第几个字符。划线的 mark 标签不影响计数。 */
function offsetInSentence(
  element: HTMLElement,
  node: Node,
  offset: number
): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  try {
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

/** 反过来：句内字符下标 → DOM 位置。 */
function caretInSentence(element: HTMLElement, offset: number): CaretPoint {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    last = text;
    if (seen + text.data.length >= offset) {
      return { node: text, offset: Math.max(0, offset - seen) };
    }
    seen += text.data.length;
  }
  return last
    ? { node: last, offset: last.data.length }
    : { node: element, offset: 0 };
}

function placeOf(element: HTMLElement, offset: number): SelectionPlace {
  return {
    chapterIndex: Number(element.dataset.chapterIndex ?? 0),
    sentenceIndex: Number(element.dataset.sentenceIndex ?? 0),
    sentenceId: element.dataset.sentenceId ?? "",
    offset,
  };
}

function placeFromPoint(
  article: HTMLElement,
  x: number,
  y: number
): SelectionPlace | null {
  const caret = caretFromPoint(x, y);
  const element = sentenceElementOf(caret?.node ?? null);
  if (!caret || !element || !article.contains(element)) return null;
  return placeOf(element, offsetInSentence(element, caret.node, caret.offset));
}

function sentenceElement(
  article: HTMLElement,
  sentenceId: string
): HTMLElement | null {
  if (!sentenceId) return null;
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(sentenceId)
      : sentenceId.replace(/"/g, '\\"');
  return article.querySelector<HTMLElement>(`[data-sentence-id="${escaped}"]`);
}

function rangeFor(
  article: HTMLElement,
  selection: TextSelection
): Range | null {
  const { start, end } = orderedSelection(selection);
  const startElement = sentenceElement(article, start.sentenceId);
  const endElement = sentenceElement(article, end.sentenceId);
  // 章节窗口把这一段摘出去了就画不出来，但选区本身还留着。
  if (!startElement || !endElement) return null;

  const from = caretInSentence(startElement, start.offset);
  const to = caretInSentence(endElement, end.offset);
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range;
}

function toRect(rect: DOMRect): Rect {
  return {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
  };
}

function sentencesIn(article: HTMLElement): SelectionSentence[] {
  return Array.from(
    article.querySelectorAll<HTMLElement>("[data-sentence-id]")
  ).map((element) => ({
    chapterIndex: Number(element.dataset.chapterIndex ?? 0),
    sentenceIndex: Number(element.dataset.sentenceIndex ?? 0),
    sentenceId: element.dataset.sentenceId ?? "",
    text: element.textContent ?? "",
  }));
}

/**
 * iPhone 上的自定义正文选区。
 *
 * 之所以要自己做：主屏幕 PWA 里仍然是 WebKit 在管文字选择，长按就会弹出系统的
 * 「拷贝 / 查询 / 翻译」，跟墨听自己的划线浮条叠在一起打架。要让默认阅读流程里
 * 只出现一套菜单，只能把正文的 user-select 关掉，由应用自己画选区和手柄。
 *
 * 选区一律以「章 + 句 + 句内字符偏移」为准，屏幕坐标每次重新量。所以改字号、
 * 换字体、转屏之后选区还在原来那几个字上。
 *
 * 拿不到 caretFromPoint（老浏览器）或者是鼠标设备时返回 supported=false，
 * 调用方退回系统选择——桌面上原生选择本来就更好用，辅助阅读也需要它。
 */
export function useTextSelection(
  articleRef: { current: HTMLElement | null },
  options: { enabled: boolean }
): CustomSelectionState {
  const [supported, setSupported] = useState(false);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [geometry, setGeometry] = useState<SelectionGeometry>(EMPTY_GEOMETRY);

  const selectionRef = useRef<TextSelection | null>(null);
  const draggingRef = useRef<"start" | "end" | null>(null);
  const pressRef = useRef<{
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  /** 这次长按已经选出东西了，紧跟着的那个 click 要吞掉。 */
  const justSelectedRef = useRef(false);
  /** beginHandleDrag 要读当前手柄位置来算抓取偏移，渲染期不能读 state。 */
  const geometryRef = useRef<SelectionGeometry>(EMPTY_GEOMETRY);
  const grabOffsetRef = useRef<GrabOffset>({ dx: 0, dy: 0 });
  const measureFrameRef = useRef(0);
  const scrollFrameRef = useRef(0);
  const scrollSpeedRef = useRef(0);

  useEffect(() => {
    // 触摸设备 + 能按坐标找到字符，两个都满足才接管选择。
    const coarse =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    const doc = document as CaretDocument;
    const hasCaret =
      typeof doc.caretRangeFromPoint === "function" ||
      typeof doc.caretPositionFromPoint === "function";
    // 这是挂载后一次性的能力探测：SSR 阶段既没有 matchMedia 也没有 document，
    // 只能等到客户端再定。项目里同类的 mount 同步都按这个写法豁免。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(coarse && hasCaret);
  }, []);

  const enabled = options.enabled && supported;

  const cancelPress = useCallback(() => {
    if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  }, []);

  const stopEdgeScroll = useCallback(() => {
    scrollSpeedRef.current = 0;
    if (scrollFrameRef.current) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = 0;
    }
  }, []);

  const clear = useCallback(() => {
    cancelPress();
    stopEdgeScroll();
    draggingRef.current = null;
    selectionRef.current = null;
    setSelection(null);
    setDragging(false);
    geometryRef.current = EMPTY_GEOMETRY;
    setGeometry(EMPTY_GEOMETRY);
  }, [cancelPress, stopEdgeScroll]);

  /** 量一次选区的屏幕位置。选区本身不变，纯粹是把逻辑位置翻译成像素。 */
  const measure = useCallback(() => {
    const article = articleRef.current;
    const current = selectionRef.current;
    if (!article || !current || isEmptySelection(current)) {
      geometryRef.current = EMPTY_GEOMETRY;
      setGeometry(EMPTY_GEOMETRY);
      return;
    }
    const range = rangeFor(article, current);
    if (!range) {
      geometryRef.current = EMPTY_GEOMETRY;
      setGeometry(EMPTY_GEOMETRY);
      return;
    }

    const rects = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 || rect.height > 0)
      .map(toRect);
    if (!rects.length) {
      geometryRef.current = EMPTY_GEOMETRY;
      setGeometry(EMPTY_GEOMETRY);
      return;
    }

    // 选中的文字也在这里一并算出来：它跟屏幕位置一样，是从「句子 + 偏移」
    // 翻译出来的结果，放同一处算才不会两边对不上。
    const parts = selectionParts(current, sentencesIn(article));
    const first = rects[0];
    const last = rects[rects.length - 1];
    const next: SelectionGeometry = {
      rects,
      handles: {
        start: { x: first.left, top: first.top, height: first.bottom - first.top },
        end: { x: last.right, top: last.top, height: last.bottom - last.top },
      },
      anchor: toRect(range.getBoundingClientRect()),
      parts,
      text: selectionText(parts),
    };
    geometryRef.current = next;
    setGeometry(next);
  }, [articleRef]);

  const scheduleMeasure = useCallback(() => {
    if (measureFrameRef.current) return;
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = 0;
      measure();
    });
  }, [measure]);

  const applySelection = useCallback(
    (next: TextSelection | null) => {
      selectionRef.current = next;
      setSelection(next);
      // 量尺寸要等这一帧的 DOM 稳定，直接量会拿到上一次的排版。
      scheduleMeasure();
    },
    [scheduleMeasure]
  );

  // 滚动、转屏、改排版都会让像素位置变，但选中的字没变，重量一次就行。
  useLayoutEffect(() => {
    if (!selection) return;
    measure();
  }, [selection, measure]);

  useEffect(() => {
    if (!selection) return;
    const onChange = () => scheduleMeasure();
    window.addEventListener("scroll", onChange, { capture: true, passive: true });
    window.addEventListener("resize", onChange);
    window.addEventListener("orientationchange", onChange);
    return () => {
      window.removeEventListener("scroll", onChange, { capture: true });
      window.removeEventListener("resize", onChange);
      window.removeEventListener("orientationchange", onChange);
    };
  }, [selection, scheduleMeasure]);

  useEffect(
    () => () => {
      if (measureFrameRef.current) cancelAnimationFrame(measureFrameRef.current);
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
      if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
    },
    []
  );

  /**
   * 拦住原生选择的「启动」，而不是把正文设成不可选。
   *
   * 为什么不用 `user-select: none`：WebKit 下正文一旦不可选，`caretRangeFromPoint`
   * 就不再下探到文本节点，长按取词会整个失效——那是"划线完全没反应"，最坏的坏法。
   * 拦 selectstart 的最坏情况只是没拦住、多出一层系统菜单，功能本身还在。
   * 两害相权，选可降级的那个。
   */
  useEffect(() => {
    if (!enabled) return;
    const onSelectStart = (event: Event) => {
      const target = event.target;
      const article = articleRef.current;
      if (!article || !(target instanceof Node)) return;
      if (article.contains(target)) event.preventDefault();
    };
    const onSelectionChange = () => {
      const native = window.getSelection();
      const article = articleRef.current;
      if (!article || !native || native.isCollapsed || !native.rangeCount) return;
      // selectstart 没拦住的漏网选区：收掉，免得系统菜单和我们的浮条叠成两套。
      if (article.contains(native.getRangeAt(0).commonAncestorContainer)) {
        native.removeAllRanges();
      }
    };
    document.addEventListener("selectstart", onSelectStart);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectstart", onSelectStart);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [enabled, articleRef]);

  // 关掉自定义选区（切到桌面、退出阅读器）时别留下一个画在屏幕上的幽灵选区。
  // 没选区时直接返回，避免每次探测结果变化都空跑一轮 setState。
  useEffect(() => {
    if (enabled || !selectionRef.current) return;
    clear();
  }, [enabled, clear]);

  const beginSelectionAt = useCallback(
    (x: number, y: number) => {
      const article = articleRef.current;
      if (!article) return;
      const caret = caretFromPoint(x, y);
      const element = sentenceElementOf(caret?.node ?? null);
      if (!caret || !element || !article.contains(element)) return;

      const text = element.textContent ?? "";
      const at = offsetInSentence(element, caret.node, caret.offset);
      const word = expandToWord(text, at);
      if (word.end <= word.start) return;

      applySelection({
        anchor: placeOf(element, word.start),
        focus: placeOf(element, word.end),
      });
      // 手指还按着，抬手后浏览器必然再补一个 click。那一下属于这次长按，
      // 必须让正文的点击处理跳过——否则刚选出来的东西立刻被当成「点空白取消」清掉。
      justSelectedRef.current = true;
    },
    [applySelection, articleRef]
  );

  /** 手指拖到屏幕上下边缘时把页面顶一顶，否则跨屏选不动。 */
  const updateEdgeScroll = useCallback(
    (y: number) => {
      const bottom = window.innerHeight - EDGE_SCROLL_ZONE;
      const speed =
        y < EDGE_SCROLL_ZONE
          ? -EDGE_SCROLL_SPEED
          : y > bottom
            ? EDGE_SCROLL_SPEED
            : 0;
      scrollSpeedRef.current = speed;
      if (!speed) {
        stopEdgeScroll();
        return;
      }
      if (scrollFrameRef.current) return;

      function step() {
        if (!scrollSpeedRef.current) {
          scrollFrameRef.current = 0;
          return;
        }
        window.scrollBy(0, scrollSpeedRef.current);
        scheduleMeasure();
        scrollFrameRef.current = requestAnimationFrame(step);
      }
      scrollFrameRef.current = requestAnimationFrame(step);
    },
    [scheduleMeasure, stopEdgeScroll]
  );

  const moveHandleTo = useCallback(
    (x: number, y: number) => {
      const article = articleRef.current;
      const current = selectionRef.current;
      if (!article || !current || !draggingRef.current) return;

      const grab = grabOffsetRef.current;
      const place = placeFromPoint(article, x + grab.dx, y + grab.dy);
      if (!place) return;

      // beginHandleDrag 已经把不动的那一端规整成 anchor，这里一路只改 focus。
      // 拖过头会让两端重合、选区变空，那一下直接不认。
      if (comparePlaces(place, current.anchor) === 0) return;

      const next: TextSelection = { anchor: current.anchor, focus: place };
      selectionRef.current = next;
      setSelection(next);
      scheduleMeasure();
    },
    [articleRef, scheduleMeasure]
  );

  const beginHandleDrag = useCallback(
    (which: "start" | "end", event: ReactPointerEvent) => {
      const current = selectionRef.current;
      if (!current) return;
      event.preventDefault();
      event.stopPropagation();

      // 把 anchor 固定成不动的那一端，之后一路只改 focus。
      const { start, end } = orderedSelection(current);
      const next: TextSelection =
        which === "start"
          ? { anchor: end, focus: start }
          : { anchor: start, focus: end };
      selectionRef.current = next;
      setSelection(next);

      // 手柄锚点是它所在那一行的竖直中点。记下它和手指的差值，
      // 整段拖动都按这个差值换算判定点，选中的字就跟手柄严丝合缝。
      const handle =
        which === "start"
          ? geometryRef.current.handles?.start
          : geometryRef.current.handles?.end;
      grabOffsetRef.current = handle
        ? {
            dx: handle.x - event.clientX,
            dy: handle.top + handle.height / 2 - event.clientY,
          }
        : { dx: 0, dy: 0 };

      draggingRef.current = which;
      setDragging(true);
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // 指针已经不在了就算了：拖动本来就靠 document 上的监听兜着，抓不到也能跟。
      }
    },
    []
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      event.preventDefault();
      moveHandleTo(event.clientX, event.clientY);
      updateEdgeScroll(event.clientY);
    };
    const onUp = () => {
      draggingRef.current = null;
      setDragging(false);
      stopEdgeScroll();
      scheduleMeasure();
    };
    // 拖动期间要盖住整页，手指滑出正文也得继续跟。
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, moveHandleTo, scheduleMeasure, stopEdgeScroll, updateEdgeScroll]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!enabled || draggingRef.current) return;
      // 点在手柄或菜单上不算「点正文」。
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".selection-handle, .reader-popover")
      ) {
        return;
      }

      // 新手势开始，上一次长按留下的吞点击标记作废（比如那一下压根没跟 click）。
      justSelectedRef.current = false;
      const { clientX: x, clientY: y } = event;
      cancelPress();
      const timer = setTimeout(() => {
        pressRef.current = null;
        beginSelectionAt(x, y);
      }, LONG_PRESS_MS);
      pressRef.current = { x, y, timer };
    },
    [beginSelectionAt, cancelPress, enabled]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      // 手指已经开始滑了，这一下是滚动或翻页，不是长按。
      if (
        Math.abs(event.clientX - press.x) > MOVE_TOLERANCE ||
        Math.abs(event.clientY - press.y) > MOVE_TOLERANCE
      ) {
        cancelPress();
      }
    },
    [cancelPress]
  );

  const onPointerUp = useCallback(() => {
    cancelPress();
  }, [cancelPress]);

  const consumeTapAfterSelect = useCallback(() => {
    if (!justSelectedRef.current) return false;
    justSelectedRef.current = false;
    return true;
  }, []);

  return {
    supported,
    active: selection !== null && !isEmptySelection(selection),
    dragging,
    parts: geometry.parts,
    text: geometry.text,
    rects: geometry.rects,
    handles: geometry.handles,
    anchor: dragging ? null : geometry.anchor,
    clear,
    consumeTapAfterSelect,
    beginHandleDrag,
    viewportHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}
