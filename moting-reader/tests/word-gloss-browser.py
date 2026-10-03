"""英文模式（点词释义、问 AI 英文提问）的浏览器回归（Chromium 移动端模拟，不是 iPhone 真机）。

Run against a running server: python tests/word-gloss-browser.py [base-url]
Requires the existing Playwright Python installation and Microsoft Edge
(or set BROWSER_PATH to a Chromium executable).

导入一本中英混排的 TXT，模拟手指点词，确认：
- 英文模式默认关：点英文词跟以前一样只切沉浸，问 AI 还是原来那三个提问；
- 在「主题与设置」里打开后：英文词出释义卡、变形词还原原形、连字符复合词整体查；
  原有的单击行为不变——点空白切沉浸、中文段落照旧、长按和点已有划线还是划线菜单；
  释义卡开关不重渲染正文；刷新后开关还记得；问 AI 换成翻译、拆句的提问；
- 英文句子之间的空格在正文里保留着。
"""
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
OUT = Path(__file__).resolve().parents[1] / ".wrangler/word-gloss/output/playwright"
OUT.mkdir(parents=True, exist_ok=True)

DIALOGUE = "“Is he married or single?” “Oh! Single, my dear, to be sure!” She was pleased; he was not."

BOOK = f"""Chapter 1

It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.

However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.

“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”

Mr. Bennet replied that he had not. The well-known house was taken by a young man of large fortune from the north of England.

{DIALOGUE}

这是一段中文注释，用来确认中文段落里单击照旧切换沉浸模式，即使里面夹着 iPhone 这样的英文词。
"""

ENGLISH_STARTERS = ["翻译成中文", "拆解句子结构", "这段在说什么"]
DEFAULT_STARTERS = ["这段在说什么", "举个例子", "和前后文什么关系"]


def launch(p):
    executable = os.environ.get("BROWSER_PATH")
    options = {"executable_path": executable} if executable else {"channel": "msedge"}
    return p.chromium.launch(headless=True, **options)


def touch(cdp, kind, point=None):
    cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if point is None else [{**point, "id": 1}]})


def tap(cdp, point):
    touch(cdp, "touchStart", point)
    touch(cdp, "touchEnd")


def long_press(page, cdp, point):
    touch(cdp, "touchStart", point)
    page.wait_for_timeout(550)
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


def settled_renders(page):
    """
    滚动停下后会先后存两次阅读进度（实测约 0.4s、1.6s），那两下的正文重渲染是正常的；
    等计数连续 1.8s 不变再开始数。
    """
    count, still = body_renders(page), 0
    for _ in range(40):
        page.wait_for_timeout(300)
        latest = body_renders(page)
        still = still + 1 if latest == count else 0
        count = latest
        if still >= 6:
            break
    return count


def gloss_text(page):
    card = page.locator(".word-gloss")
    expect(card).to_be_visible()
    return card.inner_text()


def set_ai_config(page):
    """问 AI 的建议提问只在配过模型时出现；这里只看按钮，不真的发请求。"""
    page.evaluate("""() => new Promise((resolve, reject) => {
      const open = indexedDB.open('moting-reader');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('settings', 'readwrite'), store = tx.objectStore('settings');
        const read = store.get('reader');
        read.onsuccess = () => store.put({...(read.result || {}), aiBaseUrl: 'https://example.invalid/v1', aiModel: 'test-model'}, 'reader');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    })""")


def reload_to_shelf(page):
    """应用会记住所在页面，刷新前清掉，保证每次都从书架点进去（设置存在 IndexedDB，不受影响）。"""
    page.evaluate(
        "() => { for (const k of Object.keys(localStorage)) "
        "if (k.startsWith('moting:')) localStorage.removeItem(k); }"
    )
    page.reload()
    page.get_by_role("button", name="书库", exact=True).wait_for(timeout=60000)


def open_book(page):
    page.get_by_role("button", name="书库", exact=True).click()
    page.get_by_role("button", name="阅读Chapter 1").click()
    page.locator(".reader-article").wait_for()
    page.wait_for_timeout(500)


def set_english_mode(page, cdp, on):
    if chrome_hidden(page):
        tap(cdp, blank_point(page))
        page.wait_for_timeout(200)
    page.get_by_role("button", name="阅读菜单").click()
    page.get_by_role("menu").get_by_text("主题与设置").click()
    switch = page.get_by_role("checkbox", name=re.compile("英文模式"))
    switch.set_checked(on)
    expect(switch).to_be_checked(checked=on)
    page.keyboard.press("Escape")
    expect(page.locator(".modal-sheet--reader")).to_have_count(0)


def inline_starters(page, cdp, word):
    """长按选词 → 更多 → 问 AI，读出正文批注里的建议提问，再收起批注。"""
    long_press(page, cdp, word_point(page, word))
    page.get_by_role("button", name="更多", exact=True).click()
    page.get_by_role("button", name="问 AI", exact=True).click()
    starters = page.locator(".ai-inline__starter")
    expect(starters.first).to_be_visible()
    texts = starters.all_inner_texts()
    page.get_by_role("button", name="收起批注").click()
    expect(page.locator(".ai-inline")).to_have_count(0)
    return texts


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
        page.goto(BASE)
        page.get_by_role("button", name="书库", exact=True).wait_for(timeout=60000)
        set_ai_config(page)
        reload_to_shelf(page)
        page.locator('input[type="file"]').set_input_files(book_file)
        page.wait_for_timeout(300)
        page.locator(".import-overlay").wait_for(state="detached", timeout=60000)
        open_book(page)

        # 英文句子之间的空格留着：「Oh! Single」「pleased; he」不会连成一个词。
        paragraph = page.locator(".reader-block").filter(has_text="married or single").first
        assert paragraph.text_content() == DIALOGUE, paragraph.text_content()

        # 英文模式默认关：点英文词就是以前的切沉浸，问 AI 还是原来的提问。
        hidden = chrome_hidden(page)
        tap(cdp, word_point(page, "acknowledged", center=False))
        page.wait_for_timeout(300)
        expect(page.locator(".word-gloss")).to_have_count(0)
        assert chrome_hidden(page) != hidden, "英文模式关着时点英文词不再切沉浸"
        tap(cdp, blank_point(page))
        page.wait_for_timeout(150)
        assert inline_starters(page, cdp, "fortune") == DEFAULT_STARTERS

        set_english_mode(page, cdp, True)
        page.evaluate("scrollTo(0, 0)")
        page.wait_for_timeout(250)

        # 点词出卡，再点同一个词收起；开关释义卡都不重渲染正文。
        renders = settled_renders(page)
        tap(cdp, word_point(page, "acknowledged", center=False))
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
        long_press(page, cdp, word_point(page, "truth", center=False))
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

        # 英文模式下问 AI：英文句子换成翻译、拆句的提问。
        page.evaluate("scrollTo(0, 0)")
        page.wait_for_timeout(250)
        assert inline_starters(page, cdp, "fortune") == ENGLISH_STARTERS

        # 刷新之后英文模式还开着。
        reload_to_shelf(page)
        open_book(page)
        page.evaluate("scrollTo(0, 0)")
        page.wait_for_timeout(250)
        tap(cdp, word_point(page, "fortune", center=False))
        assert "财富" in gloss_text(page)
        tap(cdp, blank_point(page))
        expect(page.locator(".word-gloss")).to_have_count(0)

        # 关掉英文模式：点英文词、问 AI 都回到原来的样子。
        set_english_mode(page, cdp, False)
        page.evaluate("scrollTo(0, 0)")
        page.wait_for_timeout(250)
        hidden = chrome_hidden(page)
        tap(cdp, word_point(page, "fortune", center=False))
        page.wait_for_timeout(300)
        expect(page.locator(".word-gloss")).to_have_count(0)
        assert chrome_hidden(page) != hidden, "关掉英文模式后点英文词不再切沉浸"
        tap(cdp, blank_point(page))
        page.wait_for_timeout(150)
        assert inline_starters(page, cdp, "fortune") == DEFAULT_STARTERS

        assert not errors, errors
        reports.append({"width": width, "errors": errors})
        context.close()
    browser.close()
    print(json.dumps({"passed": True, "results": reports}, ensure_ascii=False), flush=True)
