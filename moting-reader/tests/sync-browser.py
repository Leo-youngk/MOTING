"""两台设备(两个 Playwright context)经真实同步后端互相同步。

Usage: python tests/sync-browser.py [http://127.0.0.1:5173]
Requires `npm run dev`(本地 miniflare 的 D1/R2,先执行
`npx wrangler d1 execute moting-sync --local --file worker/sync-schema.sql`),
.dev.vars 里配好 SYNC_USERNAME / SYNC_PASSWORD,以及装了 Edge 的 Playwright。

覆盖同步的核心承诺:
1. 首轮:设备A独有的书(含正文、封面)、651 条划线(跨 push 分批、跨 pull 分页)、阅读位置,
   完整出现在设备B。
2. 第二轮:A 在首轮之后新增一条、删除一条划线,B 再同步后同样增删——
   这一步守住「首轮之后本地改动还能继续上传」。
"""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / ".wrangler" / "sync-tests"
OUTPUT.mkdir(parents=True, exist_ok=True)

DEV_VARS = dict(
    line.split("=", 1) for line in (ROOT / ".dev.vars").read_text(encoding="utf-8").splitlines() if "=" in line
)
USERNAME = DEV_VARS["SYNC_USERNAME"].strip()
PASSWORD = DEV_VARS["SYNC_PASSWORD"].strip()

RUN = str(int(time.time()))  # 每次运行换一套编号,R2 里残留的旧对象不会让上传撞 409。
BOOK_ID = f"seed-book-{RUN}"
BULK_NOTES = 650
# 1x1 PNG,只用来验证封面走 R2 往返。
COVER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
NOW = int(time.time() * 1000)

SEED_BOOK = {
    "id": BOOK_ID, "title": f"设备A独有书{RUN}", "author": "A作者", "format": "txt",
    "accent": "#8a8f98", "status": "ready", "createdAt": NOW - 60_000,
    "updatedAt": NOW - 60_000, "lastOpenedAt": NOW - 60_000,
    "sentenceCount": 1, "characterCount": 6, "coverDataUrl": COVER,
    "chapters": [{"id": "c1", "title": "第一章", "order": 0, "sentenceCount": 1, "characterCount": 6,
        "paragraphs": [{"id": "p1", "order": 0, "kind": "text",
            "sentences": [{"id": "s1", "text": "同步测试正文", "speakableText": "同步测试正文", "order": 0}]}]}],
}


def note(note_id, created_at):
    return {
        "id": note_id, "bookId": BOOK_ID, "chapterId": "c1", "sentenceId": "s1",
        "kind": "highlight", "excerpt": "同步测试正文", "createdAt": created_at,
        "updatedAt": created_at, "start": 0, "end": 6, "color": "yellow",
    }


SEED_NOTES = [note(f"n-{RUN}-{i}", NOW - 50_000 + i) for i in range(BULK_NOTES + 1)]
POSITION = {"position": {"chapterId": "c1", "sentenceId": "s1"}, "lastOpenedAt": NOW - 40_000, "savedAt": NOW - 40_000}

OPEN_DB = "const db = await new Promise((res, rej) => { const r = indexedDB.open('moting-reader'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });"


def seed(page):
    page.evaluate(
        "async ([book, notes, position]) => {" + OPEN_DB + """
            await new Promise((res, rej) => { const t = db.transaction(['books','notes','settings'], 'readwrite');
                t.objectStore('books').put(book);
                const ns = t.objectStore('notes'); notes.forEach(n => ns.put(n));
                t.objectStore('settings').put(position, 'reading-position:' + book.id);
                t.oncomplete = res; t.onerror = () => rej(t.error); });
            db.close();
        }""",
        [SEED_BOOK, SEED_NOTES, POSITION],
    )


def second_round_edits(page, added, removed_id):
    """模拟用户在首轮同步之后新增一条划线、删除一条划线(删除要落墓碑,跟 writeNotes 一致)。"""
    page.evaluate(
        "async ([added, removedId]) => {" + OPEN_DB + """
            await new Promise((res, rej) => { const t = db.transaction(['notes','settings'], 'readwrite');
                const ns = t.objectStore('notes'); ns.put(added); ns.delete(removedId);
                const ss = t.objectStore('settings'); const rq = ss.get('sync:state');
                rq.onsuccess = () => { const state = rq.result;
                    state.tombstones.notes[removedId] = Date.now(); ss.put(state, 'sync:state'); };
                t.oncomplete = res; t.onerror = () => rej(t.error); });
            db.close();
        }""",
        [added, removed_id],
    )


def idb_state(page):
    return page.evaluate(
        "async (bookId) => {" + OPEN_DB + """
            const read = (store) => new Promise((res) => { const rq = db.transaction(store).objectStore(store).getAll(); rq.onsuccess = () => res(rq.result); });
            const get = (store, key) => new Promise((res) => { const rq = db.transaction(store).objectStore(store).get(key); rq.onsuccess = () => res(rq.result); });
            const book = (await read('books')).find(b => b.id === bookId);
            const notes = (await read('notes')).filter(n => n.bookId === bookId).map(n => n.id);
            const position = await get('settings', 'reading-position:' + bookId);
            const sync = await get('settings', 'sync:state');
            db.close();
            return { hasBook: !!book, chapters: book?.chapters?.length ?? 0, cover: book?.coverDataUrl ?? null,
                     notes, position: position ?? null, pushedAt: sync?.pushedAt ?? 0, pullCursor: sync?.pullCursor ?? 0 };
        }""",
        BOOK_ID,
    )


def count_demo(page):
    return page.evaluate(
        "async () => {" + OPEN_DB + """
            const books = await new Promise((res) => { const rq = db.transaction('books').objectStore('books').getAll(); rq.onsuccess = () => res(rq.result); });
            db.close();
            return books.filter(b => b.format === 'demo').length;
        }"""
    )


def open_settings(page):
    page.get_by_role("button", name="主页").click()
    page.get_by_role("button", name="设置").click()


def login(page):
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    open_settings(page)
    form = page.locator(".sync-login")
    form.locator("input[type=text]").fill(USERNAME)
    form.locator("input[type=password]").fill(PASSWORD)
    form.get_by_role("button", name="登录并同步").click()


def wait_synced(page, previous_pushed_at, timeout_s=90):
    """一轮同步成功落盘的判据:sync:state.pushedAt 前进,且界面不再显示「同步中」。"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        state = idb_state(page)
        busy = page.get_by_role("button", name="同步中…").count()
        if state["pushedAt"] > previous_pushed_at and not busy:
            return state
        page.wait_for_timeout(500)
    raise AssertionError(f"sync did not finish; errors on page: {page.locator('.sync-error').all_inner_texts()}")


def sync_now(page):
    before = idb_state(page)["pushedAt"]
    page.get_by_role("button", name="立即同步").click()
    return wait_synced(page, before)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    errors = []
    ctx_a = browser.new_context(viewport={"width": 390, "height": 844})
    ctx_b = browser.new_context(viewport={"width": 390, "height": 844})
    for ctx in (ctx_a, ctx_b):
        ctx.on("weberror", lambda e, _c=errors: errors.append(str(e.error)))

    # 首轮:A 上传,B 拉取。
    page_a = ctx_a.new_page()
    page_a.goto(BASE)
    page_a.wait_for_load_state("networkidle")
    seed(page_a)
    login(page_a)
    a_first = wait_synced(page_a, 0)

    page_b = ctx_b.new_page()
    login(page_b)
    b_first = wait_synced(page_b, 0)

    # 第二轮:A 在首轮之后增删各一条,B 再同步。
    added = note(f"n-{RUN}-late", int(time.time() * 1000))
    removed_id = SEED_NOTES[0]["id"]
    second_round_edits(page_a, added, removed_id)
    a_second = sync_now(page_a)
    b_second = sync_now(page_b)

    checks = {
        "first_round_book_with_body": b_first["hasBook"] and b_first["chapters"] > 0,
        "first_round_cover_via_r2": b_first["cover"] is not None and b_first["cover"].startswith("data:image/png"),
        "first_round_all_notes": len(b_first["notes"]) == BULK_NOTES + 1,
        "first_round_position": (b_first["position"] or {}).get("savedAt") == POSITION["savedAt"],
        "second_round_added_note": added["id"] in b_second["notes"],
        "second_round_deleted_note": removed_id not in b_second["notes"],
        "second_round_note_count": len(b_second["notes"]) == BULK_NOTES + 1,
        "a_cursor_advances": a_second["pullCursor"] >= a_first["pullCursor"] > 0,
        "no_page_errors": not errors,
        # 示例书只留本机:B 本地只有自己那一本,A 的不会被拉过来。
        "demo_book_stays_local": count_demo(page_b) == 1,
    }
    page_b.goto(BASE)  # 关掉设置面板,回到书库看界面上真的有这本书。
    page_b.wait_for_load_state("networkidle")
    page_b.get_by_role("button", name="书库", exact=True).click()
    page_b.get_by_placeholder("搜索书名或作者").fill(SEED_BOOK["title"])
    try:
        expect(page_b.get_by_alt_text(f"{SEED_BOOK['title']}封面")).to_be_visible(timeout=10000)
        checks["library_shows_book"] = True
    except AssertionError:
        checks["library_shows_book"] = False
    page_b.screenshot(path=str(OUTPUT / "device-b-received.png"))

    print(json.dumps({"passed": all(checks.values()), "checks": checks,
                      "deviceB_first_notes": len(b_first["notes"]), "deviceB_second_notes": len(b_second["notes"]),
                      "page_errors": errors}, ensure_ascii=False))
    browser.close()
    sys.exit(0 if all(checks.values()) else 1)
