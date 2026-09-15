"""Reader selection integration checks in isolated Chromium profiles (not iPhone hardware).

Run against a running server: python tests/reader-selection-browser.py [base-url]
Requires the existing Playwright Python installation and Microsoft Edge.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
OUT = Path(__file__).resolve().parents[1] / ".wrangler/reader-selection/output/playwright"
OUT.mkdir(parents=True, exist_ok=True)


def snapshot_notes(page):
    return page.evaluate("""() => new Promise((resolve, reject) => {
      const req = indexedDB.open('moting-reader');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction('notes');
        const read = tx.objectStore('notes').getAll();
        read.onsuccess = () => resolve(read.result);
        tx.oncomplete = () => db.close();
      };
    })""")


def snapshot_settings(page):
    return page.evaluate("""() => new Promise((resolve, reject) => {
      const req = indexedDB.open('moting-reader');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction('settings');
        const read = tx.objectStore('settings').get('reader');
        read.onsuccess = () => resolve(read.result);
        tx.oncomplete = () => db.close();
      };
    })""")


def open_reader(page):
    page.goto(BASE)
    # 阅读位置和所在板块现在都会被记住并恢复。这些用例假设每次都从书的开头、
    # 从书架点进去，所以先把记住的东西清掉，保证每次起点一致。
    page.evaluate(
        "() => { for (const k of Object.keys(localStorage)) "
        "if (k.startsWith('moting:')) localStorage.removeItem(k); }"
    )
    page.reload()
    page.get_by_role("button", name="书库", exact=True).wait_for(timeout=60000)
    # 明确切到书库再点书：首页那张「继续」卡片上还有播放按钮，落到哪个按钮上不稳定。
    page.get_by_role("button", name="书库", exact=True).click()
    page.locator("article button").first.click()
    page.locator(".reader-article").wait_for()
    print(page.locator("body").aria_snapshot()[:250], flush=True)


def point_on_text(page, paragraph=0, offset=2):
    return page.locator(".reader-block:not(.is-heading)").nth(paragraph).evaluate("""(el, offset) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      walker.nextNode(); const node = walker.currentNode;
      const r = document.createRange(); r.setStart(node, offset); r.setEnd(node, offset + 1);
      const b = r.getBoundingClientRect(); return {x:b.left + b.width / 2,y:b.top + b.height / 2};
    }""", offset)


def touch(cdp, kind, point=None):
    cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if point is None else [{**point, "id": 1}]})


def select_word(page, cdp, paragraph=0, offset=2):
    point = point_on_text(page, paragraph=paragraph, offset=offset)
    touch(cdp, "touchStart", point)
    page.wait_for_timeout(550)
    touch(cdp, "touchEnd")
    expect(page.get_by_role("button", name="调整选区终点")).to_be_visible()
    expect(page.get_by_role("dialog", name="划线操作")).to_be_visible()
    assert page.evaluate("getSelection().toString()") == ""


def menu_inside(page):
    b = page.get_by_role("dialog", name="划线操作").bounding_box()
    v = page.viewport_size
    assert b and b["x"] >= 11 and b["x"] + b["width"] <= v["width"] - 11, b
    assert b["y"] >= 11 and b["y"] + b["height"] <= v["height"] - 11, b


def body_renders(page):
    """ArticleBody 的渲染计数（写在起始哨兵的 data-body-renders 上）。memo 命中时不增。"""
    return page.evaluate("() => { const s = document.querySelector('.reader-sentinel'); return s ? parseInt(s.dataset.bodyRenders || '0', 10) : -1; }")


def tap(cdp, point):
    touch(cdp, "touchStart", point)
    touch(cdp, "touchEnd")


def nudge_handle(page, cdp):
    """把终点手柄在同一行内轻推几像素：纯选区变化、不触发滚动，用来隔离正文 memo 护栏。"""
    handle = page.get_by_role("button", name="调整选区终点")
    start = handle.evaluate("""el => {const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      return {x:r.left+parseFloat(s.getPropertyValue('--anchor-x')),y:r.top+r.height/2};} """)
    touch(cdp, "touchStart", start)
    for step in range(1, 5):
        touch(cdp, "touchMove", {"x": start["x"] + step * 3, "y": start["y"]})
    touch(cdp, "touchEnd")


def ordinary_scroll_still_works(page, cdp):
    """未进入选区时仍让浏览器原生滚动，不能为了划线把整页锁死。"""
    start = point_on_text(page, paragraph=1, offset=5)
    touch(cdp, "touchStart", start)
    for step in range(1, 7):
        touch(cdp, "touchMove", {"x": start["x"], "y": start["y"] - step * 20})
    touch(cdp, "touchEnd")
    page.wait_for_timeout(120)
    assert page.evaluate("scrollY") > 20, "普通阅读滑动被划线手势锁住了"
    page.evaluate("scrollTo(0, 0)")
    page.wait_for_timeout(100)


def continuous_upward_selection(page, cdp):
    """长按下段后不松手直接往上拖：正文不滚，初选词保留，并连续跨到上段。"""
    page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => {window.upwardSelection=text}}})")
    start = point_on_text(page, paragraph=1, offset=5)
    target = point_on_text(page, paragraph=0, offset=2)
    expected_tail = page.locator(".reader-block:not(.is-heading)").nth(1).evaluate("""(el, offset) => {
      const text = el.textContent || '';
      const segmenter = new Intl.Segmenter('zh', {granularity:'word'});
      const part = [...segmenter.segment(text)].find(item => offset >= item.index && offset < item.index + item.segment.length);
      return text.slice(0, part ? part.index + part.segment.length : offset + 1);
    }""", 5)
    initial_scroll = page.evaluate("scrollY")
    touch(cdp, "touchStart", start)
    page.wait_for_timeout(550)
    expect(page.locator(".selection-layer.is-dragging")).to_be_visible()
    for step in range(1, 11):
        touch(cdp, "touchMove", {
            "x": start["x"] + (target["x"] - start["x"]) * step / 10,
            "y": start["y"] + (target["y"] - start["y"]) * step / 10,
        })
        page.wait_for_timeout(24)
    touch(cdp, "touchEnd")
    expect(page.get_by_role("dialog", name="划线操作")).to_be_visible()
    assert abs(page.evaluate("scrollY") - initial_scroll) <= 1, "向上扩选时正文跟着滚了"
    assert page.locator(".selection-layer__rect").count() > 1, "向上扩选没有跨过段落"
    page.get_by_role("button", name="复制", exact=True).click()
    selected = page.evaluate("window.upwardSelection")
    assert selected.startswith("要求我们"), selected
    assert selected.endswith(expected_tail), {"selected": selected, "expected_tail": expected_tail}


def progress_pill_checks(page, cdp):
    """改动一回归：底部进度胶囊既不拦截长按，也不能被系统原生选中。"""
    info = page.evaluate("""() => {
      const pill = document.querySelector('.reader-chrome__pos');
      const btn = document.querySelector('.reader-chrome button');
      const cs = getComputedStyle(pill);
      const box = pill.getBoundingClientRect();
      return {
        pillPointer: cs.pointerEvents,
        pillSelect: cs.userSelect || cs.webkitUserSelect,
        btnPointer: btn ? getComputedStyle(btn).pointerEvents : null,
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
      };
    }""")
    assert info["pillPointer"] == "none", info
    assert info["pillSelect"] == "none", info
    assert info["btnPointer"] == "auto", info

    center = {"x": info["x"], "y": info["y"]}
    # 长按进度胶囊本身：修复前系统会用原生选择把「46%」抓走并弹系统菜单，
    # 这正是用户报的「划不到正文、反倒划到进度」。修复后胶囊不可选中，原生选择必须为空。
    touch(cdp, "touchStart", center)
    page.wait_for_timeout(550)
    touch(cdp, "touchEnd")
    page.wait_for_timeout(80)
    assert page.evaluate("getSelection().toString()") == "", "进度文字被原生选中了"

    # 清场：收起可能出现的自定义选区，别影响后续用 paragraph 0 的定位。
    tap(cdp, center); page.wait_for_timeout(50)
    tap(cdp, center); page.wait_for_timeout(50)
    page.evaluate("() => { window.getSelection().removeAllRanges(); window.scrollTo(0, 0); }")
    page.wait_for_timeout(200)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    reports = []
    for width in [375, 390, 430]:
        context = browser.new_context(viewport={"width": width, "height": 844}, is_mobile=True, has_touch=True, service_workers="block")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        cdp = context.new_cdp_session(page)
        open_reader(page)
        expect(page.locator(".reader-article")).to_have_class(__import__('re').compile("is-custom-select"))
        progress_pill_checks(page, cdp)
        continuous_upward_selection(page, cdp)
        renders_baseline = body_renders(page)
        select_word(page, cdp)
        menu_inside(page)
        assert body_renders(page) == renders_baseline, "选区变化触发了正文重渲染"
        page.get_by_role("button", name="更多", exact=True).click()
        menu_inside(page)
        page.get_by_role("button", name="返回上一层").click()
        # Denial must preserve the selected content for retry.
        page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:undefined})")
        page.get_by_role("button", name="复制", exact=True).click()
        expect(page.get_by_role("dialog", name="划线操作")).to_be_visible()
        page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => {window.copiedText=text}}})")
        page.get_by_role("button", name="复制", exact=True).click()
        expect(page.locator(".selection-layer")).to_have_count(0)
        assert page.evaluate("window.copiedText")
        select_word(page, cdp)
        # memo 护栏：在同一行内轻推终点手柄（纯选区变化、不滚动），正文子树不该重渲染。
        # 跨段拖动会滚动页面、触发进度保存→book 换引用，那是合法重渲染，不能归到选区头上。
        renders_before_nudge = body_renders(page)
        nudge_handle(page, cdp)
        assert body_renders(page) == renders_before_nudge, "拖动手柄（未滚动）时正文重渲染了"
        # Drag through a paragraph boundary using real browser touch events.
        handle = page.get_by_role("button", name="调整选区终点")
        start = handle.evaluate("""el => {const r=el.getBoundingClientRect(),s=getComputedStyle(el);
          return {x:r.left+parseFloat(s.getPropertyValue('--anchor-x')),y:r.top+r.height/2};} """)
        target = point_on_text(page, paragraph=1, offset=10)
        touch(cdp, "touchStart", start)
        for step in range(1, 9):
            touch(cdp, "touchMove", {"x":start["x"]+(target["x"]-start["x"])*step/8,"y":start["y"]+(target["y"]-start["y"])*step/8})
        touch(cdp, "touchEnd")
        expect(page.get_by_role("dialog", name="划线操作")).to_be_visible()
        menu_inside(page)
        page.screenshot(path=str(OUT / f"cross-paragraph-{width}.png"))
        mark_count_before = page.locator(".reader-mark").count()
        page.get_by_role("button", name="划线", exact=True).click()
        # 主按钮必须一次完成创建，不再先打开样式选择层。
        expect(page.locator(".reader-mark")).to_have_count(mark_count_before + 4)
        expect(page.get_by_role("button", name="下划线", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="马克笔", exact=True)).to_be_visible()
        menu_inside(page)
        page.screenshot(path=str(OUT / f"style-picker-{width}.png"))
        page.get_by_role("button", name="马克笔", exact=True).click()
        expect(page.locator(".reader-mark").first).to_be_visible()
        expect(page.locator(".reader-mark").first).to_have_class(__import__('re').compile("reader-mark--marker"))
        page.screenshot(path=str(OUT / f"marker-{width}.png"))
        page.locator(".reader-mark").first.click()
        page.get_by_role("button", name="蓝色", exact=True).click()
        page.wait_for_timeout(100)
        notes = snapshot_notes(page)
        assert len(notes) >= 2, notes
        assert all(note["color"] == "blue" for note in notes), notes
        assert all(note["highlightStyle"] == "marker" for note in notes), notes
        assert len({note["groupId"] for note in notes}) == 1, notes
        saved_settings = snapshot_settings(page)
        assert saved_settings["highlightColor"] == "blue", saved_settings
        assert saved_settings["highlightStyle"] == "marker", saved_settings
        # 刷新后仍记住上次外观；下一次点「划线」直接用蓝色马克笔创建。
        open_reader(page)
        expect(page.locator(".reader-mark").first).to_have_class(__import__('re').compile("reader-mark--marker"))
        select_word(page, cdp, paragraph=2, offset=2)
        previous_note_count = len(snapshot_notes(page))
        page.get_by_role("button", name="划线", exact=True).click()
        remembered_notes = snapshot_notes(page)
        assert len(remembered_notes) > previous_note_count, remembered_notes
        assert all(note["color"] == "blue" for note in remembered_notes), remembered_notes
        assert all(note["highlightStyle"] == "marker" for note in remembered_notes), remembered_notes
        # 当前弹层属于刚创建的第二组，删掉后继续验证原来的跨段划线。
        page.get_by_role("button", name="删除", exact=True).click()
        assert len(snapshot_notes(page)) == previous_note_count
        page.locator(".reader-mark").first.click()
        page.get_by_role("button", name="下划线", exact=True).click()
        expect(page.locator(".reader-mark").first).to_have_class(__import__('re').compile("reader-mark--underline"))
        assert all(note["highlightStyle"] == "underline" for note in snapshot_notes(page))
        page.locator(".reader-mark").first.click()
        page.get_by_role("button", name="马克笔", exact=True).click()
        expect(page.locator(".reader-mark").first).to_have_class(__import__('re').compile("reader-mark--marker"))
        assert all(note["highlightStyle"] == "marker" for note in snapshot_notes(page))
        page.locator(".reader-mark").first.click()
        page.get_by_role("button", name="想法", exact=True).click()
        page.get_by_placeholder("写点什么…").fill("跨段划线回归测试")
        page.get_by_role("button", name="保存想法").click()
        page.wait_for_timeout(100)
        assert any(n.get("thought") == "跨段划线回归测试" for n in snapshot_notes(page))
        open_reader(page)
        page.locator(".reader-mark").first.click()
        page.set_viewport_size({"width": 844, "height": 390})
        page.wait_for_timeout(100)
        # Native/mark menus close on scrolling caused by rotation; open it again if needed.
        if not page.locator(".reader-popover").count():
            page.locator(".reader-mark").first.click()
        menu_inside(page)
        page.get_by_role("button", name="删除", exact=True).click()
        expect(page.locator(".reader-mark")).to_have_count(0)
        assert snapshot_notes(page) == []
        ordinary_scroll_still_works(page, cdp)
        assert not errors, errors
        reports.append({"width":width,"cross_paragraph_parts":len(notes),"errors":errors})
        context.close()
    browser.close()
    print(json.dumps({"passed":True,"results":reports}, ensure_ascii=False), flush=True)
