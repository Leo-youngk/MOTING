"""读书 → 返回书库，书库不能整页重载（Chromium 手机视口，非 iPhone 真机）。

Run against a running server: python tests/reader-return-browser.py [base-url]
Requires the existing Playwright Python installation (set BROWSER_PATH to a Chromium executable if needed).

vinext 的 App Router 也监听 popstate，每次后退都去服务器取一遍 "/" 的 RSC，
取不到就 location.href 整页重载：书库先白屏，再重新开机。这里断网后分别点「返回书架」
和走浏览器后退（系统返回手势），检查：
1. 页面没有重载（打在 window 上的记号还在，也没有出现开机底色）。
2. 后退没有发 .rsc 请求。
3. 书库当场就在，阅读器已经退掉。

顺带检查回到读到的地方：
4. 在阅读器里刷新（冷启动直接落进阅读器），第一帧正文就停在读到的那句，不先闪一帧章首。
5. 左右翻页时退出再进，停在同一页——页首常是上一页没说完的半句，不能退回上一页。
"""
import os
import random
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
WORDS = "滚滚长江东逝水浪花淘尽英雄是非成败转头空青山依旧在几度夕阳红白发渔樵江渚上惯看秋月春风"


def make_book(path, chapters=12, paragraphs=20):
    rnd = random.Random(3)
    lines = ["返回测试书\n"]
    for c in range(1, chapters + 1):
        lines.append(f"第{c}回 返回章节{c}\n")
        for _ in range(paragraphs):
            text = ""
            while len(text) < rnd.randint(80, 240):
                start = rnd.randint(0, len(WORDS) - 8)
                text += WORDS[start:start + 8] + ("。" if rnd.random() < 0.3 else "，")
            lines.append(text + "。\n")
    path.write_text("\n".join(lines), encoding="utf-8")


def open_reader(page):
    page.get_by_role("button", name="阅读返回测试书").click()
    page.locator(".reader-article").wait_for()
    page.wait_for_timeout(800)
    for _ in range(4):
        page.mouse.wheel(0, 700)
        page.wait_for_timeout(200)
    page.wait_for_timeout(600)


# 锚点附近那一句。正好点在行距里时往下探几个像素。
SENTENCE_AT = """() => {
  for (let y = 150; y < 230; y += 6) {
    const hit = document.elementFromPoint(innerWidth / 2, y)?.closest('[data-sentence-id]');
    if (hit) return hit.dataset.sentenceId;
  }
  return null;
}"""
SENTENCE_AT_ANCHOR = f"({SENTENCE_AT})"

# 每一帧记下锚点处是哪一句，直到开机底色退掉、正文出来。
WATCH_FIRST_FRAME = ("""() => {
  const seen = [];
  const tick = () => {
    if (document.querySelector('.reader-article')) {
      seen.push((%s)());
      if (seen.length >= 3) { window.__firstFrames = seen; return; }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}""" % SENTENCE_AT)


def check_reload_lands_in_place(page):
    for _ in range(20):
        page.mouse.wheel(0, 800)
        page.wait_for_timeout(120)
    page.wait_for_timeout(1500)
    saved = page.evaluate(SENTENCE_AT_ANCHOR)
    page.add_init_script(f"addEventListener('DOMContentLoaded', {WATCH_FIRST_FRAME})")
    page.reload()
    page.wait_for_function("() => window.__firstFrames", timeout=15000)
    frames = page.evaluate("() => window.__firstFrames")
    assert saved and frames[0] == saved, f"刷新后第一帧正文在 {frames[0]}，读到的是 {saved}（先闪了一帧别处）"


def page_label(page):
    return page.evaluate(
        "() => [...document.querySelectorAll('.reader-chrome *')]"
        ".map(e => e.textContent).find(t => /^\\d+\\/\\d+页$/.test(t)) ?? ''"
    )


def show_chrome(page):
    if page.locator(".chrome-hidden").count():
        page.mouse.click(195, 420)
        page.wait_for_timeout(400)


def check_paged_reopen(page):
    show_chrome(page)
    page.get_by_role("button", name="阅读菜单").click()
    page.get_by_role("menu").get_by_text("主题与设置").click()
    page.get_by_text("左右翻页", exact=True).click()
    page.keyboard.press("Escape")
    page.wait_for_timeout(800)
    for flips in (1, 2, 1, 3, 1, 2):
        for _ in range(flips):
            page.keyboard.press("ArrowRight")
            page.wait_for_timeout(250)
        page.wait_for_timeout(900)
        before = page_label(page)
        show_chrome(page)
        page.get_by_role("button", name="返回书架").click()
        page.get_by_role("button", name="阅读返回测试书").click()
        page.locator(".reader-article").wait_for()
        page.wait_for_timeout(1200)
        after = page_label(page)
        assert before and before == after, f"左右翻页：退出前在 {before}，再进来到了 {after}"


def check_return(page, context, go_back, label):
    rsc = []
    listener = lambda request: ".rsc" in request.url and rsc.append(request.url)
    page.on("request", listener)
    page.evaluate("() => { window.__notReloaded = true; }")
    context.set_offline(True)
    go_back()
    page.locator(".grid-book").first.wait_for(timeout=5000)
    page.wait_for_timeout(1500)
    alive = page.evaluate("() => window.__notReloaded === true")
    booting = page.locator(".app-shell--booting").count()
    reader = page.locator(".reader-article").count()
    context.set_offline(False)
    page.remove_listener("request", listener)
    assert alive, f"{label}：返回书库时整页重载了"
    assert not booting, f"{label}：返回后停在开机底色"
    assert not reader, f"{label}：阅读器没有退掉"
    assert not rsc, f"{label}：后退时去服务器取了 RSC：{rsc}"


def main():
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        book = Path(tmp) / "返回测试书.txt"
        make_book(book)
        browser = p.chromium.launch(executable_path=os.environ.get("BROWSER_PATH") or None)
        device = {k: v for k, v in p.devices["iPhone 13"].items() if k != "default_browser_type"}
        context = browser.new_context(**device)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(BASE)
        page.evaluate(
            "() => { for (const k of Object.keys(localStorage)) "
            "if (k.startsWith('moting:')) localStorage.removeItem(k); }"
        )
        page.reload()
        page.get_by_role("button", name="书库", exact=True).click()
        page.locator('input[type="file"]').first.set_input_files(str(book))
        page.get_by_role("button", name="阅读返回测试书").wait_for(timeout=60000)

        open_reader(page)
        check_return(page, context, lambda: page.get_by_role("button", name="返回书架").click(), "点返回书架")
        open_reader(page)
        check_return(page, context, lambda: page.go_back(), "系统返回手势")

        page.get_by_role("button", name="阅读返回测试书").click()
        page.locator(".reader-article").wait_for()
        check_reload_lands_in_place(page)
        check_paged_reopen(page)

        assert not errors, errors
        browser.close()
    print("reader-return-browser: ok")


main()
