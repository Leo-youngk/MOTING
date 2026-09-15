"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { SelectionHandle } from "../hooks/use-text-selection";
import type { Rect } from "../lib/popover-placement";

/** 手柄那颗圆球的直径，画在选区两端的竖条上。 */
const KNOB = 11;

function rectStyle(rect: Rect): CSSProperties {
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${Math.max(0, rect.right - rect.left)}px`,
    height: `${Math.max(0, rect.bottom - rect.top)}px`,
  };
}

function handleStyle(handle: SelectionHandle): CSSProperties {
  return {
    left: `${handle.x}px`,
    top: `${handle.top}px`,
    height: `${handle.height}px`,
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
            style={{ ...handleStyle(handles.start), "--knob": `${KNOB}px` } as CSSProperties}
            aria-label="调整选区起点"
            onPointerDown={(event) => onHandleDown("start", event)}
          />
          <button
            type="button"
            className="selection-handle selection-handle--end"
            style={{ ...handleStyle(handles.end), "--knob": `${KNOB}px` } as CSSProperties}
            aria-label="调整选区终点"
            onPointerDown={(event) => onHandleDown("end", event)}
          />
        </>
      ) : null}
    </div>
  );
}
