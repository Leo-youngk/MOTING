import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorFromRects,
  placePopover,
  type Rect,
} from "../lib/popover-placement.ts";

/** iPhone 15 Pro 的竖屏尺寸，加上刘海和 Home 指示条。 */
const IPHONE = { width: 393, height: 852 };
const INSETS = { top: 59, bottom: 34 };
/** 收敛成「划线 / 想法 / 复制 / 更多」之后量到的宽度量级。 */
const MENU = { width: 288, height: 48 };

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
