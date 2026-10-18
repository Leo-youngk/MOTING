// 听读同步的两处判断：开始听从哪一处起、正文跟着朗读时要不要挪、挪多少。
import type { BookPosition } from "./types.ts";

/** 听、读两个位置里后动过的那个；只有一个就用它。 */
export function newerPosition(
  reading: BookPosition | undefined,
  listening: BookPosition | undefined
): BookPosition | undefined {
  if (!reading) return listening;
  if (!listening) return reading;
  return listening.updatedAt > reading.updatedAt ? listening : reading;
}

/** 朗读句顶边离锚点线这么近，就当已经在线上。 */
const FOLLOW_SLACK = 60;
/** 朗读句底边越过视口这个比例就翻过去，像翻一页，不是每句都挪一下。 */
const FOLLOW_BOTTOM_RATIO = 0.75;

/**
 * 正文跟着朗读时，要把页面往下（或往上）挪多少像素。0 表示不动。
 *
 * 朗读句在锚点线上、或者整句落在「锚点线到屏幕四分之三」之间就不动；
 * 一出去就把它放回锚点线——跟阅读进度用同一条线，停下来存的进度正好就是朗读到的这句。
 * 已经在线上的长句哪怕底边出了屏也不再挪，否则会往回倒。
 */
export function followScrollDelta(
  top: number,
  bottom: number,
  viewportHeight: number,
  anchorTop: number
): number {
  if (Math.abs(top - anchorTop) <= FOLLOW_SLACK) return 0;
  if (top > anchorTop && bottom <= viewportHeight * FOLLOW_BOTTOM_RATIO) return 0;
  return Math.round(top - anchorTop);
}
