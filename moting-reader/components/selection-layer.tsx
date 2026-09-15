"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { SelectionHandle } from "../hooks/use-text-selection";
import type { Rect } from "../lib/popover-placement";

/** 手柄那颗圆球的直径。 */
const KNOB = 11;
/**
 * 手柄的触控宽度和竖向余量。可点区域必须做到 44 点上下，
 * 原来只有 30×21，而且圆球画在盒子外面——用户瞄着球按，按了个空。
 * 视觉上仍是一条细线加一颗球，撑开的部分全透明。
 */
const TOUCH_WIDTH = 44;
const TOUCH_PAD = 12;
/**
 * 触控盒子往各自的外侧偏多少。
 *
 * 初选往往只有一两个字，两个手柄相距不到 20px；盒子若都以锚点居中，
 * 44px 的触控区会几乎完全重叠，用户想捏哪头全凭运气。让起点的盒子偏左、
 * 终点的偏右，既消掉重叠，也正好对上「往左拉起点、往右拉终点」的直觉。
 */
const OUTWARD = 0.75;

function rectStyle(rect: Rect): CSSProperties {
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${Math.max(0, rect.right - rect.left)}px`,
    height: `${Math.max(0, rect.bottom - rect.top)}px`,
  };
}

function handleStyle(
  handle: SelectionHandle,
  which: "start" | "end"
): CSSProperties {
  const anchorX = which === "start" ? TOUCH_WIDTH * OUTWARD : TOUCH_WIDTH * (1 - OUTWARD);
  return {
    left: `${handle.x - anchorX}px`,
    top: `${handle.top - TOUCH_PAD}px`,
    width: `${TOUCH_WIDTH}px`,
    height: `${handle.height + TOUCH_PAD * 2}px`,
    // 竖线和圆球画在真正的端点上，不是盒子中线——盒子是偏的。
    ["--anchor-x" as string]: `${anchorX}px`,
    ["--line-h" as string]: `${handle.height}px`,
    ["--pad" as string]: `${TOUCH_PAD}px`,
    ["--knob" as string]: `${KNOB}px`,
  };
}

/**
 * 自定义选区的那一层：底色块 + 两个可拖的手柄。
 *
 * 全部按视口坐标 fixed 定位，位置由 useTextSelection 每次重新量出来，
 * 所以滚动、转屏、改字号之后这层会跟着走，不会糊在旧位置上。
 */
export function SelectionLayer({
  rects,
  handles,
  onHandleDown,
}: {
  rects: Rect[];
  handles: { start: SelectionHandle; end: SelectionHandle } | null;
  onHandleDown: (which: "start" | "end", event: ReactPointerEvent) => void;
}) {
  if (!rects.length) return null;

  return (
    <div className="selection-layer">
      <div className="selection-layer__fill" aria-hidden>
        {rects.map((rect, index) => (
          <span
            key={`${rect.top}-${rect.left}-${index}`}
            className="selection-layer__rect"
            style={rectStyle(rect)}
          />
        ))}
      </div>

      {handles ? (
        <>
          <button
            type="button"
            className="selection-handle selection-handle--start"
            style={handleStyle(handles.start, "start")}
            aria-label="调整选区起点"
            onPointerDown={(event) => onHandleDown("start", event)}
          />
          <button
            type="button"
            className="selection-handle selection-handle--end"
            style={handleStyle(handles.end, "end")}
            aria-label="调整选区终点"
            onPointerDown={(event) => onHandleDown("end", event)}
          />
        </>
      ) : null}
    </div>
  );
}
