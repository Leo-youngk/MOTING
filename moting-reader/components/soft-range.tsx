"use client";

import type { CSSProperties, InputHTMLAttributes } from "react";

/**
 * 全站统一的滑杆：粉色走过的那段 + 浅色轨道 + 白边粉点。
 *
 * 不用浏览器原生样式：粉色调浅以后，Chromium 会把没走到的那段自动换成近黑色，
 * 跟页面完全不搭。走过的那段用 --fill 画，所以得按当前值算出来写进去。
 */
export function SoftRange({
  value,
  min,
  max,
  onValue,
  className = "",
  style,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "min" | "max" | "onChange"> & {
  value: number;
  min: number;
  max: number;
  onValue: (value: number) => void;
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      {...rest}
      type="range"
      min={min}
      max={max}
      value={value}
      className={`soft-range ${className}`.trim()}
      style={{ ...style, "--fill": `${Math.max(0, Math.min(100, fill))}%` } as CSSProperties}
      onChange={(event) => onValue(Number(event.target.value))}
    />
  );
}
