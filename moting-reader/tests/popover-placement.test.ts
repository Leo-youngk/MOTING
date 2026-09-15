import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorFromRects,
  fillLineBoxes,
  placeForSelection,
  placePopover,
  type Rect,
} from "../lib/popover-placement.ts";

/** iPhone 15 Pro 的竖屏尺寸，加上刘海和 Home 指示条。 */
const IPHONE = { width: 393, height: 852 };
const INSETS = { top: 59, bottom: 34 };
/** 收敛成「划线 / 想法 / 复制 / 更多」之后量到的宽度量级。 */
const MENU = { width: 288, height: 48 };

test("横屏刘海和视觉视口左右偏移都计入菜单安全区", () => {
  const placement = placePopover({
    anchor: { top: 200, bottom: 221, left: 1, right: 20 },
    menu: MENU,
    viewport: { width: 844, height: 390 },
    insets: { top: 0, bottom: 21, left: 59, right: 59 },
  });
  assert.ok(placement.left >= 71);
  assert.ok(placement.left + MENU.width <= 844 - 71);
});

test("跨段选区不把段落空白当作行高涂满", () => {
  const rows = fillLineBoxes([
    { top: 200, bottom: 221, left: 20, right: 300 },
    { top: 330, bottom: 351, left: 20, right: 300 },
  ], 36);
  assert.equal(rows[0].bottom - rows[0].top, 36);
  assert.equal(rows[1].bottom - rows[1].top, 36);
  assert.ok(rows[1].top - rows[0].bottom > 90);
});

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, right: left + width, bottom: top + height };
}

function assertInsideScreen(
  placement: { left: number; top: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  insets: { top: number; bottom: number },
  margin = 12
) {
  assert.ok(placement.left >= margin - 0.01, `左边越界：${placement.left}`);
  assert.ok(
    placement.left + menu.width <= viewport.width - margin + 0.01,
    `右边越界：${placement.left + menu.width} > ${viewport.width - margin}`
  );
  assert.ok(
    placement.top >= insets.top + margin - 0.01,
    `顶到安全区里了：${placement.top}`
  );
  assert.ok(
    placement.top + menu.height <= viewport.height - insets.bottom - margin + 0.01,
    `底部越界：${placement.top + menu.height}`
  );
}

test("默认摆在选区上方", () => {
  const placement = placePopover({
    anchor: rect(120, 400, 100, 22),
    menu: MENU,
    viewport: IPHONE,
    insets: INSETS,
  });

  assert.equal(placement.side, "above");
  assert.equal(placement.top + MENU.height, 400 - 10);
  assertInsideScreen(placement, MENU, IPHONE, INSETS);
});

test("贴着顶部时翻到选区下方", () => {
  const placement = placePopover({
    anchor: rect(120, 80, 100, 22),
    menu: MENU,
    viewport: IPHONE,
    insets: INSETS,
  });

  assert.equal(placement.side, "below");
  assert.equal(placement.top, 80 + 22 + 10);
  assertInsideScreen(placement, MENU, IPHONE, INSETS);
});

test("屏幕四角的选区都不会把菜单挤出屏幕", () => {
  const corners: Array<[string, Rect]> = [
    ["左上", rect(2, 70, 40, 20)],
    ["右上", rect(IPHONE.width - 42, 70, 40, 20)],
    ["左下", rect(2, IPHONE.height - 80, 40, 20)],
    ["右下", rect(IPHONE.width - 42, IPHONE.height - 80, 40, 20)],
  ];

  for (const [name, anchor] of corners) {
    const placement = placePopover({
      anchor,
      menu: MENU,
      viewport: IPHONE,
      insets: INSETS,
    });
    assert.doesNotThrow(
      () => assertInsideScreen(placement, MENU, IPHONE, INSETS),
      `${name}角越界`
    );
  }
});

test("旧的固定半宽定位会越界，正是这次要修的那条", () => {
  // 老代码：left = clamp(选区中心, 104, 视口宽 - 104)，再 translateX(-50%)。
  // 菜单实际接近 400px 宽，靠左的选区会把左边缘推到屏幕外面。
  const legacyMenuWidth = 400;
  const center = 20;
  const legacyLeft = Math.min(Math.max(center, 104), IPHONE.width - 104) - legacyMenuWidth / 2;
  assert.ok(legacyLeft < 0, "先确认旧算法确实会越界，否则这条测试没有意义");

  const placement = placePopover({
    anchor: rect(4, 400, 32, 20),
    menu: { width: legacyMenuWidth, height: 48 },
    viewport: IPHONE,
    insets: INSETS,
  });
  assert.ok(placement.left >= 12);
});

test("菜单比屏幕还宽时夹到左边距，由样式去换紧凑排布", () => {
  const wide = { width: 460, height: 48 };
  const placement = placePopover({
    anchor: rect(200, 400, 40, 20),
    menu: wide,
    viewport: IPHONE,
    insets: INSETS,
  });

  assert.equal(placement.left, 12);
});

test("菜单被挤到边上后，尖角仍指着选区而不是菜单中心", () => {
  // 选区在屏幕中间偏左，菜单还没被夹，尖角就该正对选区中心。
  const anchor = rect(90, 400, 60, 20);
  const placement = placePopover({
    anchor,
    menu: MENU,
    viewport: IPHONE,
    insets: INSETS,
  });

  const anchorCenter = (anchor.left + anchor.right) / 2;
  assert.equal(placement.arrowLeft, anchorCenter - placement.left);
  assert.notEqual(
    placement.arrowLeft,
    MENU.width / 2,
    "被夹过之后尖角不该还停在菜单正中"
  );
});

test("选区贴到屏幕最左时尖角夹在圆角里，不戳到菜单外面", () => {
  const placement = placePopover({
    anchor: rect(4, 400, 32, 20),
    menu: MENU,
    viewport: IPHONE,
    insets: INSETS,
  });

  assert.equal(placement.left, 12, "菜单先被夹到左边距");
  assert.ok(
    placement.arrowLeft >= 16 && placement.arrowLeft <= MENU.width - 16,
    `尖角跑到圆角外面了：${placement.arrowLeft}`
  );
});

test("键盘顶起来之后仍然摆在可见区域内", () => {
  const withKeyboard = { top: 59, bottom: 336 };
  const placement = placePopover({
    anchor: rect(120, 470, 100, 22),
    menu: MENU,
    viewport: IPHONE,
    insets: withKeyboard,
  });

  assertInsideScreen(placement, MENU, IPHONE, withKeyboard);
});

test("横屏窄高度下也不会跑到安全区外", () => {
  const landscape = { width: 852, height: 393 };
  const landscapeInsets = { top: 0, bottom: 21 };
  for (const top of [4, 180, 360]) {
    const placement = placePopover({
      anchor: rect(700, top, 120, 20),
      menu: MENU,
      viewport: landscape,
      insets: landscapeInsets,
    });
    assertInsideScreen(placement, MENU, landscape, landscapeInsets);
  }
});

test("跨行选区锚定第一段可见的文字行", () => {
  const rects = [
    rect(120, -40, 200, 22), // 已经滚出屏幕上方
    rect(20, -12, 340, 22),
    rect(20, 120, 180, 22),
  ];
  const union = rect(20, -40, 340, 182);

  const anchor = anchorFromRects(rects, union, IPHONE, INSETS);
  assert.equal(anchor.top, 120, "要挑落在安全区里的那一行");
});

test("整段选区都不可见时退回并集，交给夹取兜底", () => {
  const rects = [rect(20, -200, 200, 22)];
  const union = rect(20, -200, 200, 22);
  const anchor = anchorFromRects(rects, union, IPHONE, INSETS);
  assert.deepEqual(anchor, union);

  const placement = placePopover({
    anchor,
    menu: MENU,
    viewport: IPHONE,
    insets: INSETS,
  });
  assertInsideScreen(placement, MENU, IPHONE, INSETS);
});

/** 行高 1.9、字号 19：字形盒约 21px，整行 36px。真机上量到的就是这个比例。 */
const GLYPH = 21;
const LINE = 36;

function lineRect(index: number, left: number, right: number): Rect {
  const top = 200 + index * LINE;
  return { top, bottom: top + GLYPH, left, right };
}

test("选区矩形补成整行，行与行之间不留缝", () => {
  const filled = fillLineBoxes(
    [lineRect(0, 40, 340), lineRect(1, 20, 350), lineRect(2, 20, 180)],
    LINE
  );

  assert.equal(filled.length, 3);
  for (let i = 1; i < filled.length; i++) {
    assert.ok(
      filled[i].top <= filled[i - 1].bottom + 0.01,
      `第 ${i} 行和上一行之间还有 ${filled[i].top - filled[i - 1].bottom}px 的缝`
    );
  }
  // 补完之后每行应该接近整行高，而不是只有字形那一条。
  for (const row of filled) {
    assert.ok(row.bottom - row.top >= LINE - 0.01, "行高没补满");
  }
});

test("同一行的碎片合并成一条，消掉亚像素缝", () => {
  const sameLine: Rect[] = [
    { top: 200, bottom: 221, left: 20, right: 140 },
    { top: 200.4, bottom: 221.4, left: 140.2, right: 300 },
  ];
  const filled = fillLineBoxes(sameLine, LINE);

  assert.equal(filled.length, 1, "同一行应该只剩一条");
  assert.equal(filled[0].left, 20);
  assert.equal(filled[0].right, 300);
});

test("单行选区没有邻行可参照，用传进来的行高补", () => {
  const filled = fillLineBoxes([lineRect(0, 40, 200)], LINE);
  assert.equal(filled.length, 1);
  assert.ok(Math.abs(filled[0].bottom - filled[0].top - LINE) < 0.01);
});

test("行高取不到时不补，也不该崩", () => {
  const raw = [lineRect(0, 40, 200)];
  const filled = fillLineBoxes(raw, 0);
  assert.equal(filled.length, 1);
  assert.equal(filled[0].bottom - filled[0].top, GLYPH);
  assert.deepEqual(fillLineBoxes([], LINE), []);
});

test("长选区翻到下方时，菜单摆在选区末尾之后，不压正文", () => {
  // 选区从屏幕很靠上开始、一直拉到中段：上方放不下菜单。
  const rects = Array.from({ length: 8 }, (_, i) => ({
    top: 70 + i * LINE,
    bottom: 70 + i * LINE + GLYPH,
    left: 20,
    right: 360,
  }));
  const union = { top: rects[0].top, bottom: rects[7].bottom, left: 20, right: 360 };

  const placement = placeForSelection({
    rects,
    union,
    menu: MENU,
    viewport: IPHONE,
    insets: INSETS,
  });

  assert.equal(placement.side, "below");
  assert.ok(
    placement.top >= rects[7].bottom,
    `菜单顶边 ${placement.top} 压在选区里了（选区末行底边 ${rects[7].bottom}）`
  );
});

test("上方放得下就照旧摆在选区上端", () => {
  const rects = [lineRect(0, 40, 340), lineRect(1, 20, 350)];
  const union = { top: rects[0].top, bottom: rects[1].bottom, left: 20, right: 350 };

  const placement = placeForSelection({
    rects,
    union,
    menu: MENU,
    viewport: IPHONE,
    insets: INSETS,
  });

  assert.equal(placement.side, "above");
  assert.ok(placement.top + MENU.height <= rects[0].top);
});
