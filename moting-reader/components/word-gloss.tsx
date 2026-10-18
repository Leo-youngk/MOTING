"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { SafeInsets } from "../hooks/use-safe-insets";
import { sentenceRange } from "../hooks/use-text-selection";
import { lookupWord, type WordGloss, type WordSpan } from "../lib/dictionary";
import { placePopover, type Placement, type Rect } from "../lib/popover-placement";

/** 点中的词：在哪一句、按哪几种切法去查（连字符复合词在前，单词在后）。 */
export interface GlossTarget {
  sentenceId: string;
  spans: WordSpan[];
  /** 词在句子中间。大写开头的多半是人名、地名，查到的普通词义要提醒一句。 */
  midSentence: boolean;
}

/** 同一个词再点一次是收起，换个词是换内容。 */
export function glossKey(target: GlossTarget): string {
  const word = target.spans[target.spans.length - 1];
  return `${target.sentenceId}:${word.start}-${word.end}`;
}

/**
 * 词典片已经在内存或 service worker 缓存里时，结果几毫秒就回来，直接出完整的卡；
 * 慢过这个（头一次取这一片）才先出「查询中」，免得每次点词都闪一下。
 */
const SLOW_LOOKUP_MS = 180;
/** 词离开原位这么远（手指在滑正文）就收起；章节窗口在原地补偿滚动时词不动，卡也不动。 */
const DRIFT_TOLERANCE = 24;

type Lookup =
  | { status: "pending" }
  | { status: "done"; span: WordSpan; gloss: WordGloss }
  | { status: "error"; span: WordSpan };

/** 复合词查得到就用复合词，否则用单词；都没收的，给单词那条「未收录」。 */
async function lookupTarget(
  target: GlossTarget
): Promise<{ span: WordSpan; gloss: WordGloss } | null> {
  let fallback: { span: WordSpan; gloss: WordGloss } | null = null;
  for (const span of target.spans) {
    const gloss = await lookupWord(span.token, { midSentence: target.midSentence });
    if (gloss?.lines.length) return { span, gloss };
    if (gloss) fallback = { span, gloss };
  }
  return fallback;
}

function sameRects(a: Rect[], b: Rect[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (rect, index) =>
        rect.top === b[index].top &&
        rect.left === b[index].left &&
        rect.right === b[index].right &&
        rect.bottom === b[index].bottom
    )
  );
}

/** 「vi. 去，走」：词性缩写压成浅色小字，扫一眼先看到中文。 */
function GlossLine({ line }: { line: string }) {
  const match = /^([a-z]+\.)\s*/.exec(line);
  if (!match) return <p>{line}</p>;
  return (
    <p>
      <span className="word-gloss__pos">{match[1]}</span>
      {line.slice(match[0].length)}
    </p>
  );
}

function GlossBody({ lookup, word }: { lookup: Lookup; word: string }) {
  if (lookup.status !== "done") {
    return (
      <>
        <p className="word-gloss__head">
          <strong lang="en">{word}</strong>
        </p>
        <p className="word-gloss__note">
          {lookup.status === "pending" ? "查询中…" : "词典没取到，联网后再点一次"}
        </p>
      </>
    );
  }
  const { gloss } = lookup;
  return (
    <>
      <p className="word-gloss__head">
        <strong lang="en">{gloss.word}</strong>
        {gloss.phonetic ? <span className="word-gloss__phonetic">/{gloss.phonetic}/</span> : null}
      </p>
      {gloss.note ? <p className="word-gloss__note">{gloss.note}</p> : null}
      {gloss.lines.length ? (
        gloss.lines.map((line, index) => <GlossLine key={index} line={line} />)
      ) : (
        <p className="word-gloss__note">词典里没有收这个词</p>
      )}
      {gloss.also ? (
        <div className="word-gloss__also">
          <p className="word-gloss__note">{gloss.also.title}</p>
          <GlossLine line={gloss.also.line} />
        </div>
      ) : null}
    </>
  );
}

/**
 * 英文书里点一个词弹出的释义卡：词底下垫一层淡底，上方（放不下就下方）一个深色小气泡，
 * 跟划线浮条同一种材质。卡上没有按钮，点哪儿都是收起。
 *
 * 跟正文的关系只有「量位置」：词的位置按句子 id + 句内偏移每次重新量，卡和底色都是
 * fixed 浮层，不往正文里插任何东西——连续阅读那套「滑动中不许改视口上方的 DOM」不受影响。
 */
export function WordGlossCard({
  target,
  articleRef,
  insets,
  onClose,
}: {
  target: GlossTarget;
  articleRef: RefObject<HTMLElement | null>;
  insets: SafeInsets;
  onClose: () => void;
}) {
  const [lookup, setLookup] = useState<Lookup>({ status: "pending" });
  const [slow, setSlow] = useState(false);
  const [rects, setRects] = useState<Rect[]>([]);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // target 换了由调用方按 glossKey 重建组件，这里只管查这一个词。
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => setSlow(true), SLOW_LOOKUP_MS);
    lookupTarget(target).then(
      (result) => {
        window.clearTimeout(timer);
        if (cancelled) return;
        // 章节号、名字缩写这种不算词：当没点到，收起。
        if (result) setLookup({ status: "done", ...result });
        else onCloseRef.current();
      },
      () => {
        window.clearTimeout(timer);
        if (!cancelled) {
          setLookup({ status: "error", span: target.spans[target.spans.length - 1] });
        }
      }
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [target]);

  // 查到之前先给点中的单词垫底色；查到复合词就换成整个复合词。
  const span = lookup.status === "pending" ? target.spans[target.spans.length - 1] : lookup.span;

  // 量词在屏幕上的位置。正文一动（滚动、转屏、改字号）就重量；
  // 词被章节窗口摘掉、或者跟着手指滑走了，卡就收起。
  useLayoutEffect(() => {
    let origin: number | null = null;
    const measure = () => {
      const article = articleRef.current;
      const range = article && sentenceRange(article, target.sentenceId, span.start, span.end);
      const next = Array.from(range?.getClientRects() ?? [])
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }));
      if (!next.length) {
        onCloseRef.current();
        return;
      }
      origin ??= next[0].top;
      const offscreen =
        next[0].bottom < insets.top || next[0].top > window.innerHeight - insets.bottom;
      if (offscreen || Math.abs(next[0].top - origin) > DRIFT_TOLERANCE) {
        onCloseRef.current();
        return;
      }
      setRects((current) => (sameRects(current, next) ? current : next));
    };
    measure();

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [articleRef, target.sentenceId, span.start, span.end, insets]);

  const visible = lookup.status !== "pending" || slow;

  // 卡的大小跟内容走（查询中 → 释义），量出真实尺寸再摆，第一帧先藏着，免得闪。
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !rects.length) return;
    const update = () => {
      const box = card.getBoundingClientRect();
      const next = placePopover({
        anchor: rects[0],
        menu: { width: box.width, height: box.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        insets,
      });
      setPlacement((current) =>
        current &&
        current.left === next.left &&
        current.top === next.top &&
        current.side === next.side &&
        current.arrowLeft === next.arrowLeft
          ? current
          : next
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(card);
    return () => observer.disconnect();
  }, [rects, insets, visible]);

  const style: CSSProperties = placement
    ? {
        left: `${placement.left}px`,
        top: `${placement.top}px`,
        ["--arrow-left" as string]: `${placement.arrowLeft}px`,
      }
    : { left: "0px", top: "0px", visibility: "hidden" };

  return (
    <>
      <div className="word-gloss-mark" aria-hidden>
        {rects.map((rect, index) => (
          <span
            key={index}
            style={{
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.right - rect.left}px`,
              height: `${rect.bottom - rect.top}px`,
            }}
          />
        ))}
      </div>
      {visible && rects.length ? (
        <div
          ref={cardRef}
          className={`reader-popover word-gloss ${placement?.side === "below" ? "is-below" : ""}`}
          style={style}
          role="dialog"
          aria-label="单词释义"
          onClick={() => onCloseRef.current()}
        >
          <GlossBody lookup={lookup} word={target.spans[target.spans.length - 1].token} />
        </div>
      ) : null}
    </>
  );
}
