"""Continuous-reading scroll checks in an isolated Chromium profile (not iPhone hardware).

Run against a running server: python tests/reader-scroll-browser.py [base-url]
Requires the existing Playwright Python installation and Microsoft Edge
(or set BROWSER_PATH to a Chromium executable).

iOS Safari 的两个特性在桌面浏览器里默认看不到，这里模拟出来：
- 没有 scroll anchoring：全局 overflow-anchor: none。
- 惯性滚动期间脚本发的 scrollBy / scrollTo 会被丢掉：手势和惯性期间把它们拦下来并计数。

在这两个条件下检查：
1. 目录跳章，章首落在正文上边距处（不被上方撑开的段落推走）。
2. 往上、往下甩动，每一帧正文都刚好移动了滚动量——没有整章地跳，也没有被占位撑开；
   手势期间脚本一次滚动都不发（真机上会掐断惯性）；停稳后调整窗口时正文纹丝不动。
"""
import os
import re
import random
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
WORDS = "春风又绿江南岸明月何时照我还山高水长人生如梦一樽还酹江月大江东去浪淘尽千古风流人物"


def make_book(path, chapters=40, paragraphs=18):
    rnd = random.Random(7)
    lines = []
    for c in range(1, chapters + 1):
        lines.append(f"# 第{c}章 滚动章节{c}\n")
        for p in range(paragraphs):
            length = rnd.randint(15, 45) if rnd.random() < 0.3 else rnd.randint(60, 260)
            text = f"【{c}-{p}】"
            while len(text) < length:
                start = rnd.randint(0, 29)
                text += WORDS[start:start + 8] + ("。" if rnd.random() < 0.3 else "，")
            lines.append(text + "。\n")
    path.write_text("\n".join(lines), encoding="utf-8")


EMULATE_IOS = """() => {
  const style = document.createElement('style');
  style.textContent = 'html, body, * { overflow-anchor: none !important; }';
  document.head.append(style);
  window.__momentum = false;
  window.__dropped = [];
  for (const [obj, name] of [[window, 'scrollBy'], [window, 'scrollTo'], [Element.prototype, 'scrollIntoView']]) {
    const original = obj[name];
    obj[name] = function (...args) {
      if (window.__momentum) { window.__dropped.push(name); return; }
      return original.apply(this, args);
    };
  }
}"""

PROBE = """() => {
  const el = document.elementFromPoint(innerWidth / 2, 300)?.closest('.reader-block, .reader-title');
  if (!el) return null;
  if (!el.id) el.id = 'probe-' + Math.random().toString(36).slice(2);
  return { id: el.id, top: el.getBoundingClientRect().top, y: scrollY };
}"""

TOP_OF = "(id) => [document.getElementById(id)?.getBoundingClientRect().top ?? null, scrollY]"


def open_book(page, book):
    page.goto(BASE)
    page.evaluate(
        "() => { for (const k of Object.keys(localStorage)) "
        "if (k.startsWith('moting:')) localStorage.removeItem(k); }"
    )
    page.reload()
    page.get_by_role("button", name="书库", exact=True).click()
    page.locator('input[type="file"]').first.set_input_files(str(book))
    page.locator("article button", has_text="滚动章节1").first.wait_for(timeout=60000)
    page.locator("article button", has_text="滚动章节1").first.click()
    page.locator(".reader-article").wait_for()
    page.evaluate(EMULATE_IOS)
    page.wait_for_timeout(800)


def toc_jump(page, chapter_no):
    page.get_by_role("button", name="阅读菜单").click()
    page.get_by_role("menu").get_by_text("目录").click()
    page.locator(".toc__list").wait_for()
    page.wait_for_timeout(400)
    page.locator(".toc__title").filter(has_text=re.compile(f"滚动章节{chapter_no}$")).first.click()
    page.wait_for_timeout(1500)


def check_toc_jump(page, chapter_no):
    toc_jump(page, chapter_no)
    top, padding = page.evaluate(
        """(i) => [
          document.querySelector(`[data-chapter-section="${i}"]`).getBoundingClientRect().top,
          parseFloat(getComputedStyle(document.querySelector('.reader-article')).paddingTop),
        ]""",
        chapter_no - 1,
    )
    assert abs(top - padding) <= 2, f"跳到第 {chapter_no} 章，章首落在 {top}px，应为 {padding}px"


def fling(page, direction, gestures=6):
    """手指 12 帧 × 250px，松手后惯性按 0.92 衰减，每帧都有 scroll 事件。"""
    jumps, settle_moves = [], []

    def frame(dy):
        probe = page.evaluate(PROBE)
        page.mouse.wheel(0, direction * dy)
        page.wait_for_timeout(16)
        if not probe:
            return True
        now, y = page.evaluate(TOP_OF, probe["id"])
        if y == probe["y"]:
            return False  # 撞到文档顶／底：iOS 回弹，惯性结束
        drift = None if now is None else round(now - probe["top"] + (y - probe["y"]))
        if drift is None or abs(drift) > 2:
            jumps.append(drift)
        return True

    for _ in range(gestures):
        page.evaluate("() => { window.__momentum = true; }")
        going = True
        for _ in range(12):
            going = going and frame(250)
        velocity = 250 * 0.92
        while going and velocity > 2:
            going = frame(round(velocity))
            velocity *= 0.92
        page.evaluate("() => { window.__momentum = false; }")
        before = page.evaluate(PROBE)
        page.wait_for_timeout(900)
        if before:
            now, _ = page.evaluate(TOP_OF, before["id"])
            if now is None or abs(now - before["top"]) > 1:
                settle_moves.append(now if now is None else now - before["top"])

    dropped = page.evaluate("() => window.__dropped.splice(0)")
    return jumps, dropped, settle_moves


def main():
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        book = Path(tmp) / "scroll-test.txt"
        make_book(book)
        executable = os.environ.get("BROWSER_PATH")
        launch = {"executable_path": executable} if executable else {"channel": "msedge"}
        browser = p.chromium.launch(headless=True, **launch)
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            is_mobile=True,
            has_touch=True,
            service_workers="block",
        )
        page = context.new_page()
        open_book(page, book)

        for chapter_no in (15, 6, 30):
            check_toc_jump(page, chapter_no)
        print("toc jump: ok", flush=True)

        toc_jump(page, 20)
        for name, direction in (("up", -1), ("down", 1)):
            jumps, dropped, settle_moves = fling(page, direction)
            assert not jumps, f"往{name}甩动时正文跳了 {len(jumps)} 帧：{jumps[:5]}"
            assert not dropped, f"往{name}甩动时脚本在惯性中滚动了 {len(dropped)} 次：{dropped[:5]}"
            assert not settle_moves, f"往{name}甩动停稳后正文被挪动：{settle_moves}"
            print(f"fling {name}: ok", flush=True)

        browser.close()


if __name__ == "__main__":
    main()
