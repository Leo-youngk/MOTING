"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { fillLineBoxes, type Rect } from "../lib/popover-placement";
import {
  comparePlaces,
  expandToWord,
  isEmptySelection,
  orderedSelection,
  selectionParts,
  selectionText,
  snapSelectionOffset,
  type SelectionPart,
  type SelectionPlace,
  type SelectionSentence,
  type TextSelection,
} from "../lib/text-selection";

/** 长按多久算「要选字」。比 iOS 自己的略长一点，免得快速点句子也被当成长按。 */
const LONG_PRESS_MS = 460;
/**
 * 长按期间手指抖动超过这么多像素就撤销这次长按。
 * 真正的滚动由浏览器发的 pointercancel 兜住（onPointerCancel 会取消长按），
 * 这个阈值只管静止按住时的自然抖动，所以放宽到 14，免得手指微动就把长按掐了。
 */
const MOVE_TOLERANCE = 14;
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

/** 长按初选出来的完整词。接力拖动无论往哪边走，都不能把这个词截掉。 */
interface ExtensionBase {
  start: SelectionPlace;
  end: SelectionPlace;
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

/**
 * 按坐标取 caret，并保证落点是正文里的句子。
 *
 * 正文平时是 `user-select: none`——真机验证过，这是 WebKit 下唯一能真正压住
 * 原生选区、放大镜和系统菜单的开关，光靠脚本拦 selectstart 一点用没有。
 *
 * 它的代价是：个别 WebKit 版本在不可选元素上不肯把 caret 落到文本节点。
 * 真遇上就临时放开、同步量一次、立刻收回。整段过程不让出事件循环，
 * 用户来不及在这个缝里拉出原生选区。
 */
function caretInArticle(
  article: HTMLElement,
  x: number,
  y: number
): CaretPoint | null {
  const direct = caretFromPoint(x, y);
  if (sentenceElementOf(direct?.node ?? null)) return direct;

  const previousWebkit = article.style.getPropertyValue("-webkit-user-select");
  const previousStandard = article.style.getPropertyValue("user-select");
  const webkitPriority = article.style.getPropertyPriority("-webkit-user-select");
  const standardPriority = article.style.getPropertyPriority("user-select");
  article.style.setProperty("-webkit-user-select", "text", "important");
  article.style.setProperty("user-select", "text", "important");
  try {
    // 逼一次样式重算，否则量到的还是放开之前的状态。
    void article.offsetHeight;
    const retry = caretFromPoint(x, y);
    return sentenceElementOf(retry?.node ?? null) ? retry : direct;
  } finally {
    if (previousWebkit) {
      article.style.setProperty("-webkit-user-select", previousWebkit, webkitPriority);
    } else {
      article.style.removeProperty("-webkit-user-select");
    }
    if (previousStandard) {
      article.style.setProperty("user-select", previousStandard, standardPriority);
    } else {
      article.style.removeProperty("user-select");
    }
  }
}

/**
 * 长按落点取 caret。直接命中最好；按到行距、段间留白时 caretRangeFromPoint 会落空，
 * 用户就觉得「长按没反应」。这里按行高上下各探半行、一行，吸附到最近的文字行再取词。
 */
function caretNearby(
  article: HTMLElement,
  x: number,
  y: number
): CaretPoint | null {
  const direct = caretInArticle(article, x, y);
  if (sentenceElementOf(direct?.node ?? null)) return direct;

  const sample = article.querySelector<HTMLElement>("[data-sentence-id]");
  const lineHeight = sample
    ? Number.parseFloat(getComputedStyle(sample).lineHeight) || 0
    : 0;
  if (!lineHeight) return null;
  for (const dy of [-lineHeight / 2, lineHeight / 2, -lineHeight, lineHeight]) {
    const probe = caretInArticle(article, x, y + dy);
    if (sentenceElementOf(probe?.node ?? null)) return probe;
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
  const caret = caretInArticle(article, x, y);
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
 * 真机录屏验证过：只靠脚本 preventDefault 掉 selectstart 完全不管用，
 * iOS 的原生选区、放大镜和系统菜单照样全出来，还把我们的浮条盖掉，
 * 用户拖到的也是原生那一套。必须走 CSS 的 user-select: none。
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
  const dragPointerRef = useRef<number | null>(null);
  const dragPointRef = useRef<{ x: number; y: number } | null>(null);
  const moveHandleRef = useRef<((x: number, y: number) => void) | null>(null);
  const extensionBaseRef = useRef<ExtensionBase | null>(null);
  /** 正文句子快照缓存 + 失效标记。拖动时正文不动，缓存一直命中，measure 就不必每帧
   *  querySelectorAll 全部句子 + 逐个读 textContent（章节多时是 O(n) 的大头）。 */
  const sentencesCacheRef = useRef<SelectionSentence[] | null>(null);
  const cacheDirtyRef = useRef(true);

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
    dragPointerRef.current = null;
    dragPointRef.current = null;
    extensionBaseRef.current = null;
    justSelectedRef.current = false;
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

    const raw = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 || rect.height > 0)
      .map(toRect);
    if (!raw.length) {
      geometryRef.current = EMPTY_GEOMETRY;
      setGeometry(EMPTY_GEOMETRY);
      return;
    }
    // 句子快照走缓存：拖动时正文不动，命中缓存，省掉每帧 querySelectorAll + 读 textContent。
    let sentences = sentencesCacheRef.current;
    if (cacheDirtyRef.current || !sentences) {
      sentences = sentencesIn(article);
      sentencesCacheRef.current = sentences;
      cacheDirtyRef.current = false;
    }
    // 只有一行时没有邻行可参照，拿正文自己的行高兜底（O(1)，随字号实时读）。
    const sample = article.querySelector<HTMLElement>("[data-sentence-id]");
    const lineHeight = sample
      ? Number.parseFloat(getComputedStyle(sample).lineHeight) || 0
      : 0;
    const rects = fillLineBoxes(raw, lineHeight);

    // 选中的文字也在这里一并算出来：它跟屏幕位置一样，是从「句子 + 偏移」
    // 翻译出来的结果，放同一处算才不会两边对不上。
    const parts = selectionParts(current, sentences);
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
      // 首次选中不再排 rAF：下面的 useLayoutEffect 会在 paint 前同步量一次，
      // 高亮和手柄就在长按触发的那一帧立即出现，省掉同帧的第二次测量。
    },
    []
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
    window.visualViewport?.addEventListener("resize", onChange);
    window.visualViewport?.addEventListener("scroll", onChange);
    const observer = new ResizeObserver(onChange);
    if (articleRef.current) observer.observe(articleRef.current);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onChange, { capture: true });
      window.removeEventListener("resize", onChange);
      window.removeEventListener("orientationchange", onChange);
      window.visualViewport?.removeEventListener("resize", onChange);
      window.visualViewport?.removeEventListener("scroll", onChange);
    };
  }, [selection, scheduleMeasure, articleRef]);

  useEffect(
    () => () => {
      if (measureFrameRef.current) cancelAnimationFrame(measureFrameRef.current);
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
      if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
    },
    []
  );

  // 正文结构变化（接章、加减划线）时让句子快照缓存失效；拖动期间正文不动，
  // 缓存一直命中。只观察 childList/characterData：改字号是 CSS 变量、朗读高亮是改
  // 文本节点的 class，都不改 textContent，不该让缓存白白失效。
  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    cacheDirtyRef.current = true;
    const observer = new MutationObserver(() => {
      cacheDirtyRef.current = true;
    });
    observer.observe(article, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [articleRef, enabled]);

  /** CSS 禁用原生选择为主，事件拦截用于清理可能残留的正文原生选区。 */
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

  /**
   * 这条监听必须在手指按下前就挂好。浏览器会在一次触摸开始时决定是否接管滚动，
   * 长按成功后再改 touch-action 已经来不及；选区拖动期直接取消 touchmove，普通滑书时
   * draggingRef 为空，所以纵向滚动仍由浏览器原生处理。
   */
  useEffect(() => {
    if (!enabled) return;
    const preventScrollWhileSelecting = (event: TouchEvent) => {
      if (!draggingRef.current || event.touches.length !== 1) return;
      if (event.cancelable) event.preventDefault();
    };
    document.addEventListener("touchmove", preventScrollWhileSelecting, {
      capture: true,
      passive: false,
    });
    return () =>
      document.removeEventListener("touchmove", preventScrollWhileSelecting, {
        capture: true,
      });
  }, [enabled]);

  // 关掉自定义选区（切到桌面、退出阅读器）时别留下一个画在屏幕上的幽灵选区。
  // 没选区时直接返回，避免每次探测结果变化都空跑一轮 setState。
  useEffect(() => {
    if (enabled || !selectionRef.current) return;
    clear();
  }, [enabled, clear]);

  /**
   * 拖动的公共起点：把某根手指接管成「正在拖某一端」，长按选词接力和抓手柄
   * 两条路都走这里，状态只维护一份。
   *
   * grab 由调用方给：抓手柄要保「捏住的那一点」不能跳，按手柄位置和落点的差值算；
   * 长按接力没有手柄可捏，末尾就该贴着手指走，调用方传 {dx:0, dy:0}。
   */
  const startDrag = useCallback(
    (
      which: "start" | "end",
      pointerId: number,
      clientX: number,
      clientY: number,
      grab: GrabOffset,
      captureTarget: Element | null,
      mode: "handle" | "extend"
    ) => {
      const current = selectionRef.current;
      if (!current || draggingRef.current) return;
      cancelPress();

      const { start, end } = orderedSelection(current);
      // 抓手柄时固定另一端。长按后接力扩选要先保留完整初选词，等第一次越过词边界
      // 再按方向决定固定哪一端。
      extensionBaseRef.current = mode === "extend" ? { start, end } : null;
      const next: TextSelection = mode === "extend"
        ? current
        : which === "start"
          ? { anchor: end, focus: start }
          : { anchor: start, focus: end };
      selectionRef.current = next;
      setSelection(next);

      grabOffsetRef.current = grab;
      draggingRef.current = which;
      dragPointerRef.current = pointerId;
      dragPointRef.current = { x: clientX, y: clientY };
      justSelectedRef.current = true;
      setDragging(true);
      try {
        captureTarget?.setPointerCapture?.(pointerId);
      } catch {
        // 指针已经不在了就算了：拖动本来就靠 document 上的监听兜着，抓不到也能跟。
      }
    },
    [cancelPress]
  );

  const beginSelectionAt = useCallback(
    (x: number, y: number, pointerId: number, captureTarget: Element | null) => {
      const article = articleRef.current;
      if (!article) return;
      // 用 caretNearby：按到行距/留白也能吸附到最近的文字行，减少「长按没反应」。
      const caret = caretNearby(article, x, y);
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
      // 手指多半还按着：不等抬手，直接把这根手指接管成对末尾的拖动，长按选完词
      // 一路下滑就能连着扩大选区，不用先松手、再去精确按住那颗手柄球。
      startDrag("end", pointerId, x, y, { dx: 0, dy: 0 }, captureTarget, "extend");
    },
    [applySelection, articleRef, startDrag]
  );

  /** 手指拖到屏幕上下边缘时把页面顶一顶，否则跨屏选不动。 */
  const updateEdgeScroll = useCallback(
    (y: number) => {
      if (articleRef.current?.closest(".is-paged")) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight) - EDGE_SCROLL_ZONE;
      const speed =
        y < top + EDGE_SCROLL_ZONE
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
        const previous = window.scrollY;
        window.scrollBy(0, scrollSpeedRef.current);
        // 手指停在边缘时不会再触发 pointermove，仍需每帧重新定位移动端点。
        const point = dragPointRef.current;
        if (point) moveHandleRef.current?.(point.x, point.y);
        scheduleMeasure();
        if (window.scrollY === previous) {
          scrollFrameRef.current = 0;
          return;
        }
        scrollFrameRef.current = requestAnimationFrame(step);
      }
      scrollFrameRef.current = requestAnimationFrame(step);
    },
    [articleRef, scheduleMeasure, stopEdgeScroll]
  );

  const moveHandleTo = useCallback(
    (x: number, y: number) => {
      const article = articleRef.current;
      const current = selectionRef.current;
      if (!article || !current || !draggingRef.current) return;

      const grab = grabOffsetRef.current;
      const box = article.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewTop = viewport?.offsetTop ?? 0;
      const viewLeft = viewport?.offsetLeft ?? 0;
      const place = placeFromPoint(article,
        Math.max(Math.max(box.left, viewLeft) + 1, Math.min(x + grab.dx, Math.min(box.right, viewLeft + (viewport?.width ?? window.innerWidth)) - 1)),
        Math.max(viewTop + 1, Math.min(y + grab.dy, viewTop + (viewport?.height ?? window.innerHeight) - 1)));
      if (!place) return;
      const extensionBase = extensionBaseRef.current;
      let anchor = current.anchor;
      if (extensionBase) {
        if (comparePlaces(place, extensionBase.start) < 0) {
          anchor = extensionBase.end;
          draggingRef.current = "start";
        } else if (comparePlaces(place, extensionBase.end) > 0) {
          anchor = extensionBase.start;
          draggingRef.current = "end";
        } else {
          // 手指仍在初选词内部时保持整词选中，避免刚开始移动就闪成半个字。
          return;
        }
      }
      const element = sentenceElement(article, place.sentenceId);
      place.offset = snapSelectionOffset(element?.textContent ?? "", place.offset,
        comparePlaces(place, anchor) < 0 ? "start" : "end");

      // startDrag 已经选好不动的那一端，这里一路只改 focus。
      // 拖过头会让两端重合、选区变空，那一下直接不认。
      if (comparePlaces(place, anchor) === 0) return;

      const next: TextSelection = { anchor, focus: place };
      // 拖动期只更新 ref，不同步 setSelection：那会让每个 pointermove 都触发一次整屏渲染。
      // 几何由 rAF 里的 measure 统一提交（每帧最多一次 setState），正文又被 ArticleBody
      // 的 memo 挡在渲染之外。抬手时再把最终选区同步回 state。
      selectionRef.current = next;
      scheduleMeasure();
    },
    [articleRef, scheduleMeasure]
  );

  useEffect(() => {
    moveHandleRef.current = moveHandleTo;
  }, [moveHandleTo]);

  const beginHandleDrag = useCallback(
    (which: "start" | "end", event: ReactPointerEvent) => {
      if (!selectionRef.current || draggingRef.current) return;
      event.preventDefault();
      event.stopPropagation();

      // 手柄锚点是它所在那一行的竖直中点。记下它和手指的差值，
      // 整段拖动都按这个差值换算判定点，选中的字就跟手柄严丝合缝。
      const handle =
        which === "start"
          ? geometryRef.current.handles?.start
          : geometryRef.current.handles?.end;
      const grab: GrabOffset = handle
        ? {
            dx: handle.x - event.clientX,
            dy: handle.top + handle.height / 2 - event.clientY,
          }
        : { dx: 0, dy: 0 };

      startDrag(which, event.pointerId, event.clientX, event.clientY, grab, event.currentTarget, "handle");
    },
    [startDrag]
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerRef.current) return;
      event.preventDefault();
      dragPointRef.current = { x: event.clientX, y: event.clientY };
      moveHandleTo(event.clientX, event.clientY);
      updateEdgeScroll(event.clientY);
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerRef.current) return;
      draggingRef.current = null;
      dragPointerRef.current = null;
      dragPointRef.current = null;
      extensionBaseRef.current = null;
      setDragging(false);
      // 拖动期只动了 ref，这里把最终选区一次性提交回 state，菜单据此弹出。
      setSelection(selectionRef.current);
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
      if (!event.isPrimary || event.button !== 0) {
        cancelPress();
        return;
      }
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
      const { clientX: x, clientY: y, pointerId, currentTarget } = event;
      cancelPress();
      const timer = setTimeout(() => {
        pressRef.current = null;
        beginSelectionAt(x, y, pointerId, currentTarget);
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
