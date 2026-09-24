import type { ReaderSettings, ReaderTheme } from "./types";

export type ReaderFont = ReaderSettings["fontFamily"];

/** 四款正文字体，全部走 iOS 自带系统字，label 用各自的字体渲染出来给用户比对。 */
export const READER_FONTS: { value: ReaderFont; label: string; cssVar: string }[] = [
  { value: "serif", label: "宋体", cssVar: "var(--font-serif)" },
  { value: "sans", label: "黑体", cssVar: "var(--font-sans)" },
  { value: "kai", label: "楷体", cssVar: "var(--font-kai)" },
  { value: "yuan", label: "圆体", cssVar: "var(--font-yuan)" },
];

export const READER_THEMES: { value: ReaderTheme; label: string }[] = [
  { value: "original", label: "原版" },
  { value: "quiet", label: "夜间" },
  { value: "paper", label: "纸张" },
  { value: "bold", label: "高对比" },
  { value: "calm", label: "暖棕" },
  { value: "focus", label: "米黄" },
];

/** 主题瓦片与阅读页共用的 1:1 色板（取自 Apple Books 真机取样）。 */
export const READER_THEME_SWATCH: Record<ReaderTheme, { bg: string; ink: string }> = {
  original: { bg: "#ffffff", ink: "#000000" },
  paper: { bg: "#f5f5f5", ink: "#000000" },
  bold: { bg: "#ffffff", ink: "#000000" },
  calm: { bg: "#efe0c9", ink: "#3a3428" },
  focus: { bg: "#f6f3ea", ink: "#1d1d1f" },
  quiet: { bg: "#414045", ink: "#e8e6e1" },
};
