"""读书 → 返回书库，书库不能整页重载（Chromium 手机视口，非 iPhone 真机）。

Run against a running server: python tests/reader-return-browser.py [base-url]
Requires the existing Playwright Python installation (set BROWSER_PATH to a Chromium executable if needed).

vinext 的 App Router 也监听 popstate，每次后退都去服务器取一遍 "/" 的 RSC，
取不到就 location.href 整页重载：书库先白屏，再重新开机。这里断网后分别点「返回书架」
和走浏览器后退（系统返回手势），检查：
1. 页面没有重载（打在 window 上的记号还在，也没有出现开机底色）。
2. 后退没有发 .rsc 请求。
3. 书库当场就在，阅读器已经退掉。
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

        assert not errors, errors
        browser.close()
    print("reader-return-browser: ok")


main()
