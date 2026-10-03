"""英文书点词释义的浏览器回归（Chromium 移动端模拟，不是 iPhone 真机）。

Run against a running server: python tests/word-gloss-browser.py [base-url]
Requires the existing Playwright Python installation and Microsoft Edge
(or set BROWSER_PATH to a Chromium executable).

导入一本中英混排的 TXT，模拟手指点词，确认：英文词出释义卡、变形词还原原形、
连字符复合词整体查；而原有的单击行为一样不变——点空白切沉浸、中文段落照旧、
长按还是划线菜单、点已有划线还是划线菜单。释义卡开关不重渲染正文。
"""
import json
import os
import sys
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
OUT = Path(__file__).resolve().parents[1] / ".wrangler/word-gloss/output/playwright"
OUT.mkdir(parents=True, exist_ok=True)

BOOK = """Chapter 1

It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.

However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.

“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”

Mr. Bennet replied that he had not. The well-known house was taken by a young man of large fortune from the north of England.

这是一段中文注释，用来确认中文段落里单击照旧切换沉浸模式，即使里面夹着 iPhone 这样的英文词。
"""


def launch(p):
    executable = os.environ.get("BROWSER_PATH")
    options = {"executable_path": executable} if executable else {"channel": "msedge"}
    return p.chromium.launch(headless=True, **options)


def touch(cdp, kind, point=None):
    cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if point is None else [{**point, "id": 1}]})


def tap(cdp, point):
    touch(cdp, "touchStart", point)
    touch(cdp, "touchEnd")


def word_point(page, word, center=True):
    """正文里第一个 word 的位置；center=True 时先把它滚到屏幕中间。"""
    script = """([word, center]) => {
      for (const block of document.querySelectorAll('.reader-article .reader-block')) {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, i = node.data.indexOf(word);
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(node, i); range.setEnd(node, i + word.length);
          let box = range.getClientRects()[0];
          if (center) { window.scrollBy(0, box.top - innerHeight / 2); box = range.getClientRects()[0]; }
          return {x: box.left + box.width * 0.6, y: box.top + box.height / 2};
        }
      }
      return null;
    }"""
    point = page.evaluate(script, [word, center])
    assert point, word
    page.wait_for_timeout(250)
    return point


def blank_point(page):
    """第一段和第二段之间的段距。"""
    return page.evaluate("""() => {
      const [a, b] = [...document.querySelectorAll('.reader-article .reader-block')];
      const top = a.getBoundingClientRect(), bottom = b.getBoundingClientRect();
      return {x: innerWidth / 2, y: (top.bottom + bottom.top) / 2};
    }""")


def chrome_hidden(page):
    return "chrome-hidden" in (page.locator(".reader-shell").get_attribute("class") or "")


def body_renders(page):
    return page.evaluate("() => parseInt(document.querySelector('.reader-sentinel')?.dataset.bodyRenders || '0', 10)")


def gloss_text(page):
    card = page.locator(".word-gloss")
    expect(card).to_be_visible()
    return card.inner_text()


def open_book(page, book_file):
    page.goto(BASE)
    page.get_by_role("button", name="书库", exact=True).wait_for(timeout=60000)
    page.locator('input[type="file"]').set_input_files(book_file)
    page.wait_for_timeout(300)
    page.locator(".import-overlay").wait_for(state="detached", timeout=60000)
    page.get_by_role("button", name="书库", exact=True).click()
    page.get_by_role("button", name="阅读Chapter 1").click()
    page.locator(".reader-article").wait_for()
    page.wait_for_timeout(500)


with tempfile.TemporaryDirectory() as folder, sync_playwright() as p:
    book_file = str(Path(folder) / "word-gloss.txt")
    Path(book_file).write_text(BOOK, encoding="utf-8")
    browser = launch(p)
    reports = []
    for width in [375, 430]:
        context = browser.new_context(viewport={"width": width, "height": 844}, is_mobile=True, has_touch=True, service_workers="block")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        cdp = context.new_cdp_session(page)
        open_book(page, book_file)

        # 点词出卡，再点同一个词收起；开关释义卡都不重渲染正文。
        renders = body_renders(page)
        tap(cdp, word_point(page, "acknowledged"))
        text = gloss_text(page)
        assert "公认" in text and "acknowledge 的过去式" in text, text
        page.screenshot(path=str(OUT / f"gloss-{width}.png"))
        tap(cdp, word_point(page, "acknowledged", center=False))
        expect(page.locator(".word-gloss")).to_have_count(0)
        assert body_renders(page) == renders, "开关释义卡重渲染了正文"

        # 换词直接换内容：变形还原、连字符复合词、疑似人名。
        tap(cdp, word_point(page, "fortune"))
        assert "财富" in gloss_text(page)
        tap(cdp, word_point(page, "taken"))
        assert "take 的过去分词" in gloss_text(page)
        tap(cdp, word_point(page, "well-known"))
        text = gloss_text(page)
        assert "well-known" in text and "众所周知" in text, text
        tap(cdp, word_point(page, "Netherfield"))
        text = gloss_text(page)
        assert "没有收" in text and "人名" in text, text

        # 卡开着时点空白只收卡；再点空白才切沉浸。
        page.evaluate("scrollTo(0, 0)")
        page.wait_for_timeout(250)
        tap(cdp, word_point(page, "fortune", center=False))
        gloss_text(page)
        hidden = chrome_hidden(page)
        tap(cdp, blank_point(page))
        expect(page.locator(".word-gloss")).to_have_count(0)
        assert chrome_hidden(page) == hidden, "收释义卡时顺手切了沉浸"
        tap(cdp, blank_point(page))
        page.wait_for_timeout(150)
        assert chrome_hidden(page) != hidden, "点空白不再切沉浸了"
        tap(cdp, blank_point(page))
        page.wait_for_timeout(150)

        # 中文段落（哪怕点在里面的英文词上）照旧切沉浸，不出卡。
        hidden = chrome_hidden(page)
        tap(cdp, word_point(page, "iPhone"))
        page.wait_for_timeout(300)
        expect(page.locator(".word-gloss")).to_have_count(0)
        assert chrome_hidden(page) != hidden, "中文段落单击不再切沉浸"
        tap(cdp, word_point(page, "中文注释", center=False))
        page.wait_for_timeout(150)

        # 长按英文词还是划线菜单；划好线后点它还是划线菜单，不是释义卡。
        page.evaluate("scrollTo(0, 0)")
        page.wait_for_timeout(250)
        point = word_point(page, "truth", center=False)
        touch(cdp, "touchStart", point)
        page.wait_for_timeout(550)
        touch(cdp, "touchEnd")
        expect(page.get_by_role("dialog", name="划线操作")).to_be_visible()
        expect(page.locator(".word-gloss")).to_have_count(0)
        page.get_by_role("button", name="划线", exact=True).click()
        expect(page.locator(".reader-mark")).to_have_count(1)
        tap(cdp, blank_point(page))
        page.wait_for_timeout(150)
        tap(cdp, word_point(page, "truth", center=False))
        expect(page.get_by_role("dialog", name="划线操作")).to_be_visible()
        expect(page.locator(".word-gloss")).to_have_count(0)
        page.get_by_role("button", name="删除", exact=True).click()
        expect(page.locator(".reader-mark")).to_have_count(0)

        # 手指一滑正文，卡就收起。
        tap(cdp, word_point(page, "daughters", center=False))
        gloss_text(page)
        start = word_point(page, "possession", center=False)
        touch(cdp, "touchStart", start)
        for step in range(1, 8):
            touch(cdp, "touchMove", {"x": start["x"], "y": start["y"] - step * 20})
            page.wait_for_timeout(16)
        touch(cdp, "touchEnd")
        page.wait_for_timeout(300)
        assert page.evaluate("scrollY") > 20, "没滑动起来"
        expect(page.locator(".word-gloss")).to_have_count(0)

        assert not errors, errors
        reports.append({"width": width, "errors": errors})
        context.close()
    browser.close()
    print(json.dumps({"passed": True, "results": reports}, ensure_ascii=False), flush=True)
