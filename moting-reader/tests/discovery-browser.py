"""Book discovery browser flow with explicit Open Library and Z-Library fixtures.

Usage: python tests/discovery-browser.py [http://127.0.0.1:5173]
Requires a running app and Playwright with Edge installed.
"""
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
OUTPUT = Path(__file__).resolve().parents[1] / ".wrangler" / "discovery-tests"
OUTPUT.mkdir(parents=True, exist_ok=True)

BOOKS = [
    {"workId": "OL123W", "title": "活着", "author": "余华", "year": 1993, "coverUrl": None, "sourceUrl": "https://openlibrary.org/works/OL123W"},
    {"workId": "OL124W", "title": "The Left Hand of Darkness", "author": "Ursula K. Le Guin", "year": 1969, "coverUrl": None, "sourceUrl": "https://openlibrary.org/works/OL124W"},
]

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2, service_workers="block")
    page = context.new_page()
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state("networkidle")

    # Verify the real Worker route rejects invalid inputs before using fixtures.
    route_status = page.evaluate("async () => (await fetch('/api/discovery/search?topic=unknown')).status")
    assert route_status == 400, route_status

    state = {"searches": [], "details": [], "online_queries": [], "mode": "normal"}

    def discovery_api(route):
        url = urlparse(route.request.url)
        params = parse_qs(url.query)
        if url.path.endswith("/search"):
            state["searches"].append(params)
            if state["mode"] == "error":
                route.fulfill(status=503, json={"error": "Open Library 请求较多，请稍后重试"})
            elif state["mode"] == "empty":
                route.fulfill(json={"books": [], "page": 1, "hasMore": False})
            else:
                page_number = int(params.get("page", ["1"])[0])
                books = BOOKS if page_number == 1 else [{**BOOKS[1], "workId": "OL125W", "title": "第二页的书"}]
                route.fulfill(json={"books": books, "page": page_number, "hasMore": page_number == 1})
        else:
            state["details"].append(params.get("id", [""])[0])
            route.fulfill(json={"description": "一段来自开放书目的测试简介。", "subjects": ["Fiction", "Literature"]})

    def online_api(route):
        action = route.request.url.rsplit("/", 1)[-1]
        if action == "session":
            route.fulfill(json={"connected": False})
        elif action == "search":
            data = route.request.post_data_json
            state["online_queries"].append(data["query"])
            route.fulfill(json={"books": [], "page": 1, "hasMore": False})
        else:
            route.fulfill(status=404, json={"error": "unexpected fixture request"})

    page.route("**/api/discovery/*", discovery_api)
    page.route("**/api/zlibrary/*", online_api)
    page.get_by_role("button", name="书库", exact=True).click()
    page.get_by_role("button", name="发现书籍", exact=True).click()
    expect(page.get_by_role("heading", name="发现下一本好书")).to_be_visible()
    expect(page.get_by_role("button", name="查看《活着》详情")).to_be_visible()
    assert state["searches"][0]["topic"] == ["literature"]
    assert state["searches"][0]["language"] == ["all"]

    page.get_by_label("书籍版本语言").select_option("zh")
    expect(page.get_by_role("button", name="查看《活着》详情")).to_be_visible()
    assert state["searches"][-1]["language"] == ["zh"]
    page.get_by_role("button", name="科幻", exact=True).click()
    assert state["searches"][-1]["topic"] == ["science_fiction"]
    page.get_by_role("button", name="再看一些").click()
    expect(page.get_by_role("button", name="查看《第二页的书》详情")).to_be_visible()
    assert state["searches"][-1]["page"] == ["2"]

    page.get_by_role("button", name="查看《活着》详情").click()
    expect(page.get_by_role("heading", name="活着", exact=True)).to_be_visible()
    expect(page.get_by_text("一段来自开放书目的测试简介。")).to_be_visible()
    assert state["details"][-1] == "OL123W"
    page.screenshot(path=str(OUTPUT / "iphone-detail.png"), full_page=True)
    page.get_by_role("button", name="找这本书").click()
    expect(page.get_by_label("在线搜索书名或作者")).to_have_value("活着")
    expect(page.get_by_role("heading", name="没有找到匹配的书")).to_be_visible()
    assert state["online_queries"] == ["活着"], state["online_queries"]

    page.get_by_role("button", name="发现书籍", exact=True).click()
    expect(page.get_by_role("button", name="查看《活着》详情")).to_be_visible()
    page.get_by_label("发现书籍搜索").fill("三体")
    page.get_by_role("search").get_by_role("button", name="搜索", exact=True).click()
    expect(page.get_by_role("button", name="查看《活着》详情")).to_be_visible()
    assert state["searches"][-1]["query"] == ["三体"]

    state["mode"] = "empty"
    page.get_by_role("button", name="悬疑", exact=True).click()
    expect(page.get_by_role("heading", name="这里还没有找到书")).to_be_visible()
    state["mode"] = "error"
    page.get_by_role("button", name="历史", exact=True).click()
    expect(page.get_by_role("alert")).to_contain_text("请求较多")
    state["mode"] = "normal"
    page.get_by_role("button", name="重试").click()
    expect(page.get_by_role("button", name="查看《活着》详情")).to_be_visible()

    for width in (375, 390, 430, 768):
        page.set_viewport_size({"width": width, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), width
    page.set_viewport_size({"width": 390, "height": 844})
    page.screenshot(path=str(OUTPUT / "iphone-discovery.png"), full_page=True)
    assert not page_errors, page_errors
    print(json.dumps({"passed": True, "worker_validation_status": route_status, "search_requests": len(state["searches"]), "details": state["details"], "online_queries": state["online_queries"], "widths": [375, 390, 430, 768], "page_errors": page_errors}, ensure_ascii=True))
    browser.close()
