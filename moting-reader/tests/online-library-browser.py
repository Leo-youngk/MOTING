"""iPhone viewport integration tests; all upstream responses are explicit fixtures.

Usage: python tests/online-library-browser.py [http://localhost:5173]
Requires a running app and Playwright with Edge installed.
"""
import io
import json
import sys
import zipfile
from pathlib import Path
from urllib.parse import quote
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
OUTPUT = Path(__file__).resolve().parents[1] / ".wrangler" / "online-library-tests"
OUTPUT.mkdir(parents=True, exist_ok=True)


def epub_fixture():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        archive.writestr("content.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">online-test-fixture</dc:identifier><dc:title>在线导入测试</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>')
        archive.writestr("nav.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>')
        archive.writestr("chapter.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>这是一段明确标注的自动化测试正文。验证在线下载后实际解析与本地入库。</p></body></html>')
    return output.getvalue()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2, service_workers="block")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    # Exercise the real Worker route before mocking upstream-facing UI responses.
    result = page.evaluate("""async () => { const r = await fetch('/api/zlibrary/session', {method:'POST',headers:{'content-type':'application/json'},body:'{}'}); return {status:r.status, data:await r.json()}; }""")
    assert result == {"status": 200, "data": {"connected": False}}, result

    state = {"connected": False, "mode": "normal", "downloads": 0, "searches": [], "pending": []}
    book = {"id": "17", "hash": "aabbcc", "title": "在线导入测试", "author": "测试作者", "extension": "epub", "language": "中文", "year": "2026", "bytes": 2048, "size": "2 KB", "cover": ""}

    def route_api(route):
        action = route.request.url.rsplit("/", 1)[-1]
        body = route.request.post_data_json
        if action == "session":
            route.fulfill(json={"connected": state["connected"]})
        elif action == "login":
            if body["password"] == "wrong":
                route.fulfill(status=401, json={"error": "邮箱或密码不正确，请重新输入"})
            else:
                state["connected"] = True
                route.fulfill(json={"connected": True})
        elif action == "logout":
            state["connected"] = False
            route.fulfill(json={"connected": False})
        elif action == "search":
            state["searches"].append(body)
            if state["mode"] == "offline":
                route.fulfill(status=503, json={"error": "暂时连接不上 zh.z-lib.gd，请稍后重试"})
            elif state["mode"] == "auth":
                route.fulfill(status=401, json={"error": "请先登录 Z-Library"})
            elif state["mode"] == "empty":
                route.fulfill(json={"books": [], "page": 1, "hasMore": False})
            else:
                second = {**book, "id": "18", "title": "第二本测试书"}
                oversized = {**book, "id": "19", "title": "大文件测试", "bytes": 90 * 1024 * 1024, "size": "90 MB"}
                route.fulfill(json={"books": [book, oversized] if body["page"] == 1 else [book, second], "page": body["page"], "hasMore": body["page"] == 1})
        elif action == "download":
            state["downloads"] += 1
            if state["mode"] == "pending":
                state["pending"].append(route)
            elif state["mode"] == "broken":
                route.abort("failed")
            elif state["mode"] == "html":
                route.fulfill(body="<html>Login required</html>", headers={"content-type": "application/octet-stream", "x-book-filename": quote("测试.txt")})
            else:
                route.fulfill(body=epub_fixture(), headers={"content-type": "application/epub+zip", "x-book-filename": quote("在线导入测试.epub")})

    page.route("**/api/zlibrary/*", route_api)
    page.get_by_role("button", name="书库", exact=True).click()
    # 书库不空时「在线找书」收在右上角「+」里。
    page.get_by_role("button", name="添加书籍", exact=True).click()
    page.get_by_role("button", name="在线找书", exact=True).click()
    expect(page.get_by_placeholder("搜索书名或作者")).to_be_visible()
    # 找书页：手机上底栏收起，没有格式标签和说明行，整页正好一屏不滚。
    expect(page.locator(".bottom-bar")).to_be_hidden()
    expect(page.locator(".online-formats, .online-feedback")).to_have_count(0)
    assert page.evaluate("document.documentElement.scrollHeight <= window.innerHeight")
    page.get_by_role("button", name="登录", exact=True).click()
    page.get_by_label("邮箱", exact=True).fill("test@example.org")
    page.get_by_label("密码", exact=True).fill("wrong")
    page.get_by_role("button", name="登录并继续").click()
    expect(page.get_by_role("alert")).to_contain_text("邮箱或密码")
    expect(page.get_by_label("密码", exact=True)).to_have_value("")
    page.get_by_label("密码", exact=True).fill("fixture-password")
    page.get_by_role("button", name="登录并继续").click()
    # 登录成功后账号面板收起：右上角的钮换成「Z-Library 账号」，提示条报已连接。
    expect(page.get_by_role("button", name="Z-Library 账号")).to_be_visible()
    expect(page.get_by_text("已连接 Z-Library", exact=True)).to_be_visible()
    page.get_by_label("在线搜索书名或作者").fill("测试 & 作者")
    page.get_by_role("button", name="搜索", exact=True).click()
    expect(page.get_by_role("heading", name="在线导入测试", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="超过 50 MB")).to_be_disabled()
    page.get_by_role("button", name="更多结果").click()
    expect(page.locator(".online-card")).to_have_count(3)
    assert state["searches"][-1]["page"] == 2
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.locator(".online-results").evaluate("el => el.scrollTop = 0")
    page.screenshot(path=str(OUTPUT / "iphone-search.png"), full_page=True)
    stable_height = page.locator(".online-results").evaluate("el => el.clientHeight")
    state["mode"] = "pending"
    page.get_by_role("button", name="加入书库", exact=True).first.click()
    expect(page.get_by_role("button", name="取消", exact=True)).to_be_visible()
    page.get_by_role("button", name="取消", exact=True).click()
    expect(page.get_by_text("已取消下载", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="加入书库", exact=True).first).to_be_enabled()
    for pending in state["pending"]:
        pending.abort()
    state["mode"] = "broken"
    page.get_by_role("button", name="加入书库", exact=True).first.click()
    expect(page.locator(".toast")).to_contain_text("网络不可用")
    state["mode"] = "html"
    page.get_by_role("button", name="加入书库", exact=True).first.click()
    expect(page.locator(".toast")).to_contain_text("网页而非书籍")
    state["mode"] = "normal"
    page.get_by_role("button", name="加入书库", exact=True).first.click()
    expect(page.get_by_role("button", name="打开阅读")).to_be_visible(timeout=20000)
    page.reload()
    page.wait_for_load_state("networkidle")
    # 刷新后回到的还是在线找书（底栏收着），直接再搜一次。
    expect(page.get_by_label("在线搜索书名或作者")).to_be_visible()
    page.get_by_label("在线搜索书名或作者").fill("测试")
    page.get_by_role("button", name="搜索", exact=True).click()
    expect(page.get_by_role("button", name="打开阅读")).to_be_visible()
    page.get_by_role("button", name="打开阅读").click()
    expect(page.get_by_text("这是一段明确标注的自动化测试正文。", exact=False).first).to_be_visible()
    # Verify the EPUB was actually persisted, with exactly one online source record.
    saved = page.evaluate("""() => new Promise((resolve, reject) => {const r=indexedDB.open('moting-reader');r.onsuccess=()=>{const db=r.result;const t=db.transaction(['books','contents']);const q=t.objectStore('books').getAll();const c=t.objectStore('contents').getAll();t.oncomplete=()=>{const len=(id)=>c.result.find(x=>x.bookId===id)?.chapters?.length??0;resolve(q.result.filter(b=>b.onlineSourceId).map(b=>({title:b.title,source:b.onlineSourceId,chapters:len(b.id)})));db.close()};t.onerror=()=>reject(t.error)}})""")
    assert saved == [{"title": "在线导入测试", "source": "zlibrary:17:aabbcc", "chapters": 1}], saved
    # Cold start restores the reader; go back to its library parent while keeping the same database.
    page.reload()
    page.wait_for_load_state("networkidle")
    page.evaluate("history.back()")
    expect(page.get_by_role("button", name="添加书籍", exact=True)).to_be_visible()
    page.get_by_role("button", name="添加书籍", exact=True).click()
    page.get_by_role("button", name="在线找书", exact=True).click()
    page.get_by_label("在线搜索书名或作者").fill("不存在")
    state["mode"] = "empty"
    page.get_by_role("button", name="搜索", exact=True).click()
    expect(page.get_by_role("heading", name="没有找到匹配的书")).to_be_visible()
    assert page.locator(".online-results").evaluate("el => el.clientHeight") == stable_height
    state["mode"] = "offline"
    page.get_by_role("button", name="搜索", exact=True).click()
    expect(page.get_by_role("alert")).to_contain_text("连接不上")
    state["mode"] = "auth"
    page.get_by_role("button", name="搜索", exact=True).click()
    expect(page.get_by_label("邮箱", exact=True)).to_be_visible()
    for width in (375, 390, 430):
        page.set_viewport_size({"width": width, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), width
    page.screenshot(path=str(OUTPUT / "iphone-login-error.png"), full_page=True)
    assert errors == [], errors
    print(json.dumps({"passed": True, "epub_persisted": saved, "downloads": state["downloads"], "widths": [375, 390, 430], "page_errors": errors}, ensure_ascii=True))
    browser.close()
