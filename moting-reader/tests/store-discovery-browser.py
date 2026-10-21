"""推荐轮换的本地浏览器回归。

python tests/store-discovery-browser.py [http://127.0.0.1:5178]
使用仓库真实静态书目；详情接口和封面使用明确的测试夹具，不写生产数据。
检查移动端曝光、换批、共享快照、真实名次、反馈撤销、跨日和错误降级。
"""
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5178"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".wrangler" / "discovery-rotation-tests"
OUT.mkdir(parents=True, exist_ok=True)
CATALOGS = [json.loads(path.read_text(encoding="utf-8")) for path in (ROOT / "public/catalog").glob("*.json") if path.name != "index.json"]
BOOKS = {book["bookId"]: book for catalog in CATALOGS for book in catalog["books"]}
CHECKS = {}
ERRORS = []


def fixture_routes(page):
    # 测试只替代封面响应和书籍详情，不替代实际分类书目或推荐结果。
    page.route("https://cdn.weread.qq.com/**", lambda route: route.fulfill(
        content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140"><rect width="100" height="140" fill="#e5e8ee"/><text x="50" y="70" text-anchor="middle" fill="#46506a" font-size="12">TEST COVER</text></svg>'))
    page.route("https://*.image.myqcloud.com/**", lambda route: route.fulfill(
        content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140"><rect width="100" height="140" fill="#e5e8ee"/></svg>'))

    def detail(route):
        from urllib.parse import parse_qs, urlparse
        book_id = parse_qs(urlparse(route.request.url).query)["bookId"][0]
        route.fulfill(json={**BOOKS[book_id], "intro": "明确标注的浏览器测试详情夹具。", "ratingGood": None, "ratingFair": None, "ratingPoor": None})
    page.route("**/api/weread/book?*", detail)


def feed_ids(page):
    return page.locator(".home-store .store-card").evaluate_all("nodes => nodes.map(n => n.dataset.bookId)")


def feedback(page):
    return page.evaluate("JSON.parse(localStorage.getItem('moting:store-feedback:v1') || '{}')")


def assert_width(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "横向溢出"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    for width in [375, 390, 430]:
        context = browser.new_context(viewport={"width": width, "height": 844}, is_mobile=True,
            has_touch=True, device_scale_factor=2, service_workers="block", timezone_id="Asia/Shanghai")
        page = context.new_page()
        page.on("pageerror", lambda error: ERRORS.append(str(error)))
        fixture_routes(page)
        fixed = datetime(2026, 10, 21, 15, tzinfo=ZoneInfo("Asia/Shanghai"))
        page.clock.set_fixed_time(fixed)
        page.goto(BASE, wait_until="domcontentloaded")
        page.locator(".home-store .store-card").first.wait_for(timeout=90_000)
        page.locator(".home-store").scroll_into_view_if_needed()
        page.wait_for_timeout(1100)  # 验证实际 800ms 可见停留门槛。
        cards = page.locator(".home-store .store-card")
        visible_key = cards.first.get_attribute("data-discovery-key")
        hidden_key = cards.last.get_attribute("data-discovery-key")
        assert visible_key in feedback(page)
        assert hidden_key not in feedback(page), "横滑屏幕外的卡片不应记曝光"
        CHECKS[f"exposure_only_visible_{width}"] = True
        assert_width(page)

        page.locator(".home-store .home-row__track").evaluate("node => node.scrollLeft = node.scrollWidth")
        page.wait_for_timeout(1100)
        assert hidden_key in feedback(page), "横滑进入视野后应记录曝光"
        CHECKS[f"horizontal_exposure_{width}"] = True
        page.locator(".home-store .home-row__track").evaluate("node => node.scrollLeft = 0")

        previous = feed_ids(page)
        for _ in range(3):
            top = page.locator(".home-store__rank").evaluate("node => node.getBoundingClientRect().top")
            page.locator(".home-store").get_by_role("button", name="换一批", exact=True).click()
            current = feed_ids(page)
            assert len(current) == 8 and not set(previous) & set(current)
            after = page.locator(".home-store__rank").evaluate("node => node.getBoundingClientRect().top")
            assert abs(top - after) <= 1, "换批不能推动下方榜单"
            previous = current
        CHECKS[f"shuffle_without_duplicates_or_shift_{width}"] = True

        current = feed_ids(page)
        page.reload(wait_until="domcontentloaded")
        page.locator(".home-store .store-card").first.wait_for()
        assert feed_ids(page) == current
        CHECKS[f"same_day_reload_stable_{width}"] = True

        # 在新卡片可见满800ms前离开，保留但隐藏的主页不能记曝光。
        page.locator(".home-store").get_by_role("button", name="换一批", exact=True).click()
        current = feed_ids(page)
        home_keys = page.locator(".home-store .store-card").evaluate_all("nodes=>nodes.map(n=>n.dataset.discoveryKey)")
        page.locator(".home-store").get_by_role("button", name="查看全部", exact=True).click()
        store = page.get_by_role("region", name="书城", exact=True)
        store.wait_for()
        lane = store.locator(".store-lane").filter(has=page.get_by_role("heading", name="为你推荐", exact=True))
        expect(lane.locator(".store-card")).to_have_count(8)
        assert lane.locator(".store-card").evaluate_all("nodes => nodes.map(n => n.dataset.bookId)") == current
        CHECKS[f"home_store_share_batch_{width}"] = True
        visible_store_keys = store.locator(".store-card").evaluate_all("""nodes=>nodes.filter(n=>{
            const r=n.getBoundingClientRect(); return r.bottom>0 && r.top<innerHeight && r.left<innerWidth && r.right>0;
        }).map(n=>n.dataset.discoveryKey)""")
        unexposed = [key for key in home_keys if key not in feedback(page) and key not in visible_store_keys]
        assert unexposed
        page.wait_for_timeout(1100)
        assert all(key not in feedback(page) for key in unexposed), "隐藏主页不应记录曝光"
        CHECKS[f"hidden_home_not_exposed_{width}"] = True

        kinds = store.get_by_role("group", name="榜单类型")
        for kind in ["口碑榜", "热读榜", "小众口碑"]:
            kinds.get_by_role("button", name=kind, exact=True).click()
            assert kinds.get_by_role("button", name=kind, exact=True).get_attribute("aria-pressed") == "true"
            assert_width(page)
        CHECKS[f"ranking_views_{width}"] = True

        kinds.get_by_role("button", name="口碑榜", exact=True).click()
        grid = store.locator(".store-lane").first.locator(".store-grid")
        before = grid.locator(".store-card").evaluate_all("nodes => nodes.map(n => n.dataset.bookId)")
        store.get_by_role("button", name="换一组", exact=True).click()
        assert grid.locator(".store-card").evaluate_all("nodes => nodes.map(n => n.dataset.bookId)") != before
        more = store.get_by_role("button", name="看完整榜单", exact=False)
        more.click()
        assert grid.locator(".store-card__rank").first.inner_text() == "1"
        CHECKS[f"ranking_slice_and_full_rank_{width}"] = True

        lane.locator(".store-card").first.click()
        detail = page.get_by_role("region", name="书籍详情", exact=True)
        detail.wait_for()
        expect(detail.get_by_role("button", name="不感兴趣", exact=True)).to_be_visible()
        detail.get_by_role("button", name="不感兴趣", exact=True).click()
        assert any(item["hidden"] for item in feedback(page).values())
        persisted_ids = page.evaluate("JSON.parse(localStorage.getItem('moting:store-discovery:v2')).feed.books.map(b=>b.bookId)")
        assert current[0] not in persisted_ids
        detail.get_by_role("button", name="撤销不感兴趣", exact=True).click()
        assert not any(item["hidden"] for item in feedback(page).values())
        assert_width(page)
        CHECKS[f"feedback_hide_and_undo_{width}"] = True

        # 返回完整书城再回主页，验证批次和当前位置不会被进入详情重置。
        detail.get_by_role("button", name="书城", exact=True).click()
        page.get_by_role("region", name="书城", exact=True).get_by_role("button", name="主页", exact=True).click()
        page.locator(".home-store .store-card").first.wait_for()
        same_day = feed_ids(page)
        page.locator(".home-store").scroll_into_view_if_needed()
        y_before = page.evaluate("scrollY")
        page.get_by_role("button", name="设置", exact=True).click()
        page.get_by_role("button", name="返回", exact=True).click()
        assert feed_ids(page) == same_day
        assert abs(page.evaluate("scrollY") - y_before) <= 2
        CHECKS[f"settings_return_stable_{width}"] = True

        board_before = page.locator(".home-store__rank .store-row").evaluate_all("nodes=>nodes.map(n=>n.dataset.bookId)")
        page.locator(".home-store__rank").get_by_role("button", name="换个榜", exact=True).click()
        board_after = page.locator(".home-store__rank .store-row").evaluate_all("nodes=>nodes.map(n=>n.dataset.bookId)")
        assert board_before != board_after
        CHECKS[f"home_board_rotation_{width}"] = True

        page.clock.set_fixed_time(fixed + timedelta(days=1))
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_function("JSON.parse(localStorage.getItem('moting:store-discovery:v2')).feed.day === '2026-10-22'")
        assert feed_ids(page) != same_day
        CHECKS[f"next_day_changes_{width}"] = True
        page.locator(".home-store").scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / f"home-{width}.png"), full_page=True)
        if width == 390:
            for theme in ["cream", "black"]:
                page.evaluate("""async theme => {
                    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('moting-reader');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
                    await new Promise((resolve,reject)=>{const t=db.transaction('settings','readwrite');const s=t.objectStore('settings');const r=s.get('reader');
                        r.onsuccess=()=>s.put({...r.result,shellTheme:theme},'reader');t.oncomplete=resolve;t.onerror=()=>reject(t.error);});db.close();
                }""", theme)
                page.reload(wait_until="domcontentloaded")
                page.locator(".home-store .store-card").first.wait_for()
                assert page.locator("html").get_attribute("data-shell") == theme
                assert_width(page)
                page.locator(".home-store").scroll_into_view_if_needed()
                page.screenshot(path=str(OUT / f"home-390-{theme}.png"), full_page=True)
                CHECKS[f"theme_{theme}"] = True
        context.close()

    for mode in ["partial", "unavailable"]:
        context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
        page = context.new_page()
        fixture_routes(page)
        page.route("**/catalog/*.json", lambda route: route.fulfill(status=503, json={"error": "测试夹具：书目不可用"})
            if mode == "unavailable" or route.request.url.endswith("/novel.json") else route.continue_())
        page.goto(BASE, wait_until="domcontentloaded")
        if mode == "partial":
            page.locator(".home-store .store-card").first.wait_for()
            expect(page.locator(".home-store")).to_contain_text("部分分类")
        else:
            expect(page.locator(".home-store")).to_contain_text("书目暂时读不到")
            expect(page.locator(".home-store .store-card")).to_have_count(0)
        CHECKS[f"source_failure_{mode}"] = True
        context.close()
    browser.close()

CHECKS["no_page_errors"] = not ERRORS
report = {"passed": all(CHECKS.values()), "checks": CHECKS, "errors": ERRORS,
    "data": "real repository catalogs; detail and cover fixtures; no production writes"}
(OUT / "browser-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
assert report["passed"], report
