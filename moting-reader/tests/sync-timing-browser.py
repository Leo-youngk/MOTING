"""同步时机：离开前台只推、回到前台就拉、正开着的书被另一台设备读到别处时问要不要跳。

Usage: python tests/sync-timing-browser.py [http://localhost:5173]
前提同 tests/sync-browser.py：`npm run dev`（本地 miniflare 的 D1/R2，先执行
`npx wrangler d1 execute moting-sync --local --file worker/sync-schema.sql`），
.dev.vars 里配好 SYNC_USERNAME / SYNC_PASSWORD，装了 Edge 的 Playwright。

浏览器面板里 visibilityState 不会真的变，这里改写 document.visibilityState 再派发
visibilitychange，模拟 iPhone 上切走、切回来。真机上页面会被冻结，这点模拟不了。
"""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
ROOT = Path(__file__).resolve().parents[1]
DEV_VARS = dict(
    line.split("=", 1) for line in (ROOT / ".dev.vars").read_text(encoding="utf-8").splitlines() if "=" in line
)
USERNAME = DEV_VARS["SYNC_USERNAME"].strip()
PASSWORD = DEV_VARS["SYNC_PASSWORD"].strip()

RUN = str(int(time.time()))
BOOK_ID = f"timing-book-{RUN}"
NOW = int(time.time() * 1000)
LINE = "同步时机测试用的一句话，长一点才能把一章撑得足够高。"


def make_book():
    chapters = []
    for c in range(3):
        paragraphs = []
        for p in range(30):
            sentences = [{"id": f"s{c}-{p}-{i}", "text": LINE, "speakableText": LINE, "order": i} for i in range(3)]
            paragraphs.append({"id": f"p{c}-{p}", "order": p, "kind": "text", "sentences": sentences})
        chapters.append({"id": f"c{c}", "title": f"第{c + 1}章", "order": c, "sentenceCount": 90,
                         "characterCount": 90 * len(LINE), "paragraphs": paragraphs})
    return {"id": BOOK_ID, "title": f"同步时机{RUN}", "author": "测试", "format": "txt", "accent": "#8a8f98",
            "status": "ready", "createdAt": NOW - 60_000, "updatedAt": NOW - 60_000, "lastOpenedAt": NOW - 60_000,
            "sentenceCount": 270, "characterCount": 270 * len(LINE), "chapters": chapters}


OPEN_DB = "const db = await new Promise((res, rej) => { const r = indexedDB.open('moting-reader'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });"
PUT_BOOK = """const putBook = (t, b) => { const { chapters, ...meta } = b;
    t.objectStore('books').put({ ...meta, chapterOutline: chapters.map(c => ({ id: c.id, title: c.title, sentenceCount: c.sentenceCount, characterCount: c.characterCount })) });
    t.objectStore('contents').put({ bookId: b.id, chapters }); };"""


def seed(page, book):
    page.evaluate("async (book) => {" + OPEN_DB + PUT_BOOK + """
        await new Promise((res, rej) => { const t = db.transaction(['books','contents'], 'readwrite');
            putBook(t, book); t.oncomplete = res; t.onerror = () => rej(t.error); });
        db.close(); }""", book)


def write_position(page, chapter, paragraph):
    """模拟在这台设备上读到了某处：直接写阅读位置，不经界面（界面写会顺带排一轮 30 秒后的同步）。"""
    sentence = f"s{chapter}-{paragraph}-0"
    position = {"chapterId": f"c{chapter}", "chapterIndex": chapter, "sentenceId": sentence,
                "sentenceIndex": paragraph * 3, "percent": round((chapter * 90 + paragraph * 3) / 270 * 100),
                "updatedAt": int(time.time() * 1000)}
    page.evaluate("async ([bookId, position]) => {" + OPEN_DB + """
        await new Promise((res, rej) => { const t = db.transaction('settings', 'readwrite');
            t.objectStore('settings').put({ position, lastOpenedAt: position.updatedAt, savedAt: position.updatedAt },
                'reading-position:' + bookId);
            t.oncomplete = res; t.onerror = () => rej(t.error); });
        db.close(); }""", [BOOK_ID, position])
    return sentence


def state(page):
    return page.evaluate("async (bookId) => {" + OPEN_DB + """
        const get = (key) => new Promise((res) => { const rq = db.transaction('settings').objectStore('settings').get(key); rq.onsuccess = () => res(rq.result); });
        const position = await get('reading-position:' + bookId);
        const sync = await get('sync:state');
        const hasBook = await new Promise((res) => { const rq = db.transaction('books').objectStore('books').get(bookId); rq.onsuccess = () => res(!!rq.result); });
        db.close();
        return { hasBook, sentence: position?.position?.sentenceId ?? null, savedAt: position?.savedAt ?? 0,
                 pushedAt: sync?.pushedAt ?? 0, pullCursor: sync?.pullCursor ?? 0 }; }""", BOOK_ID)


def set_visibility(page, value):
    page.evaluate("""(value) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
        document.dispatchEvent(new Event('visibilitychange')); }""", value)


def login(page):
    page.get_by_role("button", name="主页").click()
    page.get_by_role("button", name="设置").click()
    page.locator(".settings-link", has_text="云端同步").click()
    form = page.locator(".sync-login")
    form.locator("input[type=text]").fill(USERNAME)
    form.locator("input[type=password]").fill(PASSWORD)
    form.get_by_role("button", name="登录并同步").click()


def wait_for(page, predicate, timeout_s=60):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        current = state(page)
        if predicate(current):
            return current
        page.wait_for_timeout(300)
    raise AssertionError(f"timed out; last state {state(page)}")


def back_to_library(page):
    for _ in range(3):
        if page.locator(".bottom-nav").is_visible():
            break
        page.get_by_role("button", name="返回").first.click()
        page.wait_for_timeout(300)
    page.get_by_role("button", name="书库", exact=True).click()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    errors = []
    checks = {}
    ctx_a = browser.new_context(viewport={"width": 390, "height": 844})
    ctx_b = browser.new_context(viewport={"width": 390, "height": 844})
    for ctx in (ctx_a, ctx_b):
        ctx.on("weberror", lambda e: errors.append(str(e.error)))

    page_a = ctx_a.new_page()
    page_a.goto(BASE)
    page_a.wait_for_load_state("networkidle")
    seed(page_a, make_book())
    login(page_a)
    wait_for(page_a, lambda s: s["pushedAt"] > 0)

    page_b = ctx_b.new_page()
    page_b.goto(BASE)
    page_b.wait_for_load_state("networkidle")
    login(page_b)
    wait_for(page_b, lambda s: s["pushedAt"] > 0 and s["hasBook"])

    # 1. 离开前台只推：B 读到第 2 章，切走。A 手动拉一轮就能拿到；B 的水位不动（只推不拉）。
    b_before = state(page_b)
    sentence_b = write_position(page_b, 1, 5)
    pushes = []
    page_b.on("request", lambda r: pushes.append(r.url.rsplit("/", 1)[-1]) if "/api/sync/" in r.url else None)
    set_visibility(page_b, "hidden")
    page_b.wait_for_timeout(2500)
    checks["leave_pushes_only"] = pushes == ["push"]
    checks["leave_keeps_watermark"] = state(page_b)["pushedAt"] == b_before["pushedAt"]
    page_a.get_by_role("button", name="立即同步").click()
    a_state = wait_for(page_a, lambda s: s["sentence"] == sentence_b, 30)
    checks["leave_push_reaches_other_device"] = a_state["sentence"] == sentence_b

    # 2. 回到前台就拉：A 开着这本书；B 又读到第 3 章并切走；A 切回来时不用等 5 分钟。
    back_to_library(page_a)
    page_a.get_by_placeholder("搜索书名或作者").fill(f"同步时机{RUN}")
    page_a.get_by_alt_text(f"同步时机{RUN}封面").first.click() if page_a.get_by_alt_text(f"同步时机{RUN}封面").count() \
        else page_a.locator("article button", has_text=f"同步时机{RUN}").first.click()
    page_a.locator(".reader-article").wait_for()
    page_a.wait_for_timeout(11_000)  # 刚同步完 10 秒内切回来不再拉，等过这段
    set_visibility(page_a, "hidden")
    page_a.wait_for_timeout(500)
    sentence_b2 = write_position(page_b, 2, 20)
    set_visibility(page_b, "visible")
    page_b.wait_for_timeout(300)
    set_visibility(page_b, "hidden")
    page_b.wait_for_timeout(2500)
    set_visibility(page_a, "visible")
    toast = page_a.locator(".toast", has_text="另一台设备读到了")
    try:
        expect(toast).to_be_visible(timeout=15000)
        checks["resume_pulls_and_asks"] = True
        checks["toast_names_chapter"] = "第3章" in toast.inner_text()
    except AssertionError:
        checks["resume_pulls_and_asks"] = False
        checks["toast_names_chapter"] = False

    # 3. 点「跳转」，正文落到 B 读到的那句，放在锚点线附近。
    if checks["resume_pulls_and_asks"]:
        toast.get_by_role("button", name="跳转").click()
        page_a.wait_for_timeout(2500)
        top = page_a.evaluate("(id) => document.querySelector(`[data-sentence-id=\"${id}\"]`)?.getBoundingClientRect().top ?? null", sentence_b2)
        checks["jump_lands_on_remote_sentence"] = top is not None and abs(top - 150) < 40
        checks["jump_top_px"] = top
    checks["no_page_errors"] = not errors

    passed = all(v for k, v in checks.items() if k != "jump_top_px")
    print(json.dumps({"passed": passed, "checks": checks, "errors": errors}, ensure_ascii=False))
    browser.close()
    sys.exit(0 if passed else 1)
