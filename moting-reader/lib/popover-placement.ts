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
  insets: { top: number; bottom: number; left?: number; right?: number };
  /** 左右和上下都至少留这么多，默认 12。 */
  margin?: number;
  /** 菜单和选区之间的空隙，默认 10。 */
  gap?: number;
  /** 优先摆哪一侧。那一侧放得下就用它，放不下仍按下面的通用规则来。 */
  prefer?: "above" | "below";
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
  const fitsAbove = roomAbove >= input.menu.height;
  const fitsBelow = roomBelow >= input.menu.height;
  const side: Placement["side"] =
    input.prefer === "below" && fitsBelow
      ? "below"
      : input.prefer === "above" && fitsAbove
        ? "above"
        : fitsAbove
          ? "above"
          : fitsBelow
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
  const safeLeft = margin + (input.insets.left ?? 0);
  const maxLeft = Math.max(safeLeft, input.viewport.width - (input.insets.right ?? 0) - margin - input.menu.width);
  const left = Math.min(Math.max(anchorCenter - input.menu.width / 2, safeLeft), maxLeft);

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

/**
 * 给一整片选区摆菜单。
 *
 * 不能只拿选区顶端当锚点：顶端上方放不下时会翻到下方，而「下方」是相对顶端那一行说的，
 * 菜单正好压在选中的第二、三行正文上。所以翻到下方时改用选区底端重新摆一次。
 */
export function placeForSelection(input: {
  rects: Rect[];
  /** 整片选区的并集，一行都不可见时拿它兜底。 */
  union: Rect;
  menu: { width: number; height: number };
  viewport: { width: number; height: number };
  insets: PlacementInput["insets"];
}): Placement {
  const shared = {
    menu: input.menu,
    viewport: input.viewport,
    insets: input.insets,
  };

  const top = anchorFromRects(input.rects, input.union, input.viewport, input.insets);
  const above = placePopover({ anchor: top, ...shared });
  if (above.side === "above") return above;

  const bottom = anchorFromRects(
    [...input.rects].reverse(),
    input.union,
    input.viewport,
    input.insets
  );
  return placePopover({ anchor: bottom, prefer: "below", ...shared });
}

/**
 * 把选区矩形补成整行，并把同一行的碎片合成一条。
 *
 * getClientRects() 给的是字形盒：行高 1.9 时字形只占约 21px，而一行占 36px。
 * 直接照着画出来是一条条横杠、行与行之间留着黑缝，真机上一眼就能看出不对，
 * 跟系统选区那种连续色块完全不是一回事。
 *
 * 行距按相邻行的实际间隔算，这样正文和标题各自不同的行高都能补对；
 * 只有一行时没有邻居可参照，才退回传进来的行高。
 */
export function fillLineBoxes(rects: Rect[], fallbackLineHeight: number): Rect[] {
  if (!rects.length) return [];

  const rows: Rect[][] = [];
  for (const rect of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const row = rows[rows.length - 1];
    // 同一行的碎片 top 几乎相同，跨行才另起一组。
    if (row && Math.abs(row[0].top - rect.top) <= 2) row.push(rect);
    else rows.push([rect]);
  }

  const merged = rows.map((row) => ({
    top: Math.min(...row.map((item) => item.top)),
    bottom: Math.max(...row.map((item) => item.bottom)),
    left: Math.min(...row.map((item) => item.left)),
    right: Math.max(...row.map((item) => item.right)),
  }));

  return merged.map((row, index) => {
    const next = merged[index + 1];
    const previous = merged[index - 1];
    const spacing = next
      ? next.top - row.top
      : previous
        ? row.top - previous.top
        : fallbackLineHeight;
    // 段间距和章标题间距不能算作行高，否则两行之间的大片留白也会被涂满。
    const lineHeight = fallbackLineHeight > 0
      ? Math.min(spacing, Math.max(fallbackLineHeight, row.bottom - row.top))
      : Math.min(spacing, (row.bottom - row.top) * 1.8);
    const pad = Math.max(0, (lineHeight - (row.bottom - row.top)) / 2);
    return { ...row, top: row.top - pad, bottom: row.bottom + pad };
  });
}
