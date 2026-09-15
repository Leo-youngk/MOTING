/** 视口坐标系里的一个矩形，字段跟 DOMRect 对得上，方便直接传进来。 */
export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlacementInput {
  /** 选区（或已有划线）的锚点矩形。 */
  anchor: Rect;
  /** 菜单量出来的实际尺寸，不是估的。 */
  menu: { width: number; height: number };
  viewport: { width: number; height: number };
  /** 刘海、Home 指示条、键盘占掉的高度。 */
  insets: { top: number; bottom: number };
  /** 左右和上下都至少留这么多，默认 12。 */
  margin?: number;
  /** 菜单和选区之间的空隙，默认 10。 */
  gap?: number;
}

export interface Placement {
  left: number;
  top: number;
  side: "above" | "below";
  /** 尖角相对菜单左边缘的位置。菜单被挤到边上之后，它跟菜单中心不再重合。 */
  arrowLeft: number;
}

/** 尖角再怎么挪也不能戳到圆角外面去。 */
const ARROW_EDGE_PADDING = 16;

/**
 * 算出划线菜单该摆在哪。
 *
 * 规则按优先级：先试选区上方，放不下翻到下方，两边都放不下就选空间大的那边并夹进安全区。
 * 横向一律夹在安全边距内——这里是老版本的破绽：以前按固定半宽 104px 夹，
 * 而菜单实际有 400 上下，靠边的选区会把菜单挤出屏幕外接近 100px。
 */
export function placePopover(input: PlacementInput): Placement {
  const margin = input.margin ?? 12;
  const gap = input.gap ?? 10;

  const safeTop = input.insets.top + margin;
  const safeBottom = input.viewport.height - input.insets.bottom - margin;

  const roomAbove = input.anchor.top - gap - safeTop;
  const roomBelow = safeBottom - (input.anchor.bottom + gap);
  const side: Placement["side"] =
    roomAbove >= input.menu.height
      ? "above"
      : roomBelow >= input.menu.height
        ? "below"
        : roomAbove >= roomBelow
          ? "above"
          : "below";

  const rawTop =
    side === "above"
      ? input.anchor.top - gap - input.menu.height
      : input.anchor.bottom + gap;
  // 安全区本身比菜单还矮时（键盘顶上来的横屏），至少保证顶边可见、别往上跑。
  const maxTop = Math.max(safeTop, safeBottom - input.menu.height);
  const top = Math.min(Math.max(rawTop, safeTop), maxTop);

  const anchorCenter = (input.anchor.left + input.anchor.right) / 2;
  const maxLeft = Math.max(margin, input.viewport.width - margin - input.menu.width);
  const left = Math.min(Math.max(anchorCenter - input.menu.width / 2, margin), maxLeft);

  const arrowLeft = Math.min(
    Math.max(anchorCenter - left, ARROW_EDGE_PADDING),
    Math.max(ARROW_EDGE_PADDING, input.menu.width - ARROW_EDGE_PADDING)
  );

  return { left, top, side, arrowLeft };
}

/**
 * 跨行选区该拿哪一行当锚点。
 *
 * 选区并集的上边缘可能已经滚出屏幕（从上一屏拉下来的长选区），照它摆菜单会飞到
 * 可视区外面。所以优先取第一段落在安全区里的行；一行都不在就退回并集，
 * 由 placePopover 去夹。
 */
export function anchorFromRects(
  rects: Rect[],
  union: Rect,
  viewport: { height: number },
  insets: { top: number; bottom: number }
): Rect {
  const safeTop = insets.top;
  const safeBottom = viewport.height - insets.bottom;
  const visible = rects.find(
    (rect) => rect.bottom > safeTop && rect.top < safeBottom
  );
  return visible ?? union;
}
