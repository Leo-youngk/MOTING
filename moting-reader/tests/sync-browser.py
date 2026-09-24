"""三台设备(三个 Playwright context)经真实同步后端互相同步。

Usage: python tests/sync-browser.py [http://127.0.0.1:5173]
Requires `npm run dev`(本地 miniflare 的 D1/R2,先执行
`npx wrangler d1 execute moting-sync --local --file worker/sync-schema.sql`),
.dev.vars 里配好 SYNC_USERNAME / SYNC_PASSWORD,以及装了 Edge 的 Playwright。

覆盖同步的核心承诺:
1. 首轮:设备A独有的书(含正文、封面)、651 条划线(跨 push 分批、跨 pull 分页)、阅读位置,
   完整出现在设备B。
2. 第二轮:A 在首轮之后新增一条、删除一条划线,B 再同步后同样增删——
   守住「首轮之后本地改动还能继续上传」。
3. 旧版本升级:A 按旧协议同步过(数据版本 0),本地有没带修改时间的设置、早期统计、
   比上次同步还早的听书进度。升级后 A 整体补传一轮,B 全部收到。
4. 续传:正文已在云端的书(上次传到一半被打断),再同步时不重发正文。
5. 删书:A 删掉一本书后,全新设备C首次同步不会拿到这本书留下的孤儿划线,B 也跟着删干净。
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
DOOMED_ID = f"doomed-book-{RUN}"
RESUME_ID = f"resume-book-{RUN}"
BULK_NOTES = 650
# 1x1 PNG,只用来验证封面走 R2 往返。
COVER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
NOW = int(time.time() * 1000)


def make_book(book_id, title, created_at, cover=None):
    book = {
        "id": book_id, "title": title, "author": "A作者", "format": "txt",
        "accent": "#8a8f98", "status": "ready", "createdAt": created_at,
        "updatedAt": created_at, "lastOpenedAt": created_at,
        "sentenceCount": 1, "characterCount": 6,
        "chapters": [{"id": "c1", "title": "第一章", "order": 0, "sentenceCount": 1, "characterCount": 6,
            "paragraphs": [{"id": "p1", "order": 0, "kind": "text",
                "sentences": [{"id": "s1", "text": "同步测试正文", "speakableText": "同步测试正文", "order": 0}]}]}],
    }
    if cover:
        book["coverDataUrl"] = cover
    return book


SEED_BOOK = make_book(BOOK_ID, f"设备A独有书{RUN}", NOW - 60_000, COVER)
DOOMED_BOOK = make_book(DOOMED_ID, f"要删的书{RUN}", NOW - 60_000)


def note(note_id, created_at, book_id=BOOK_ID):
    return {
        "id": note_id, "bookId": book_id, "chapterId": "c1", "sentenceId": "s1",
        "kind": "highlight", "excerpt": "同步测试正文", "createdAt": created_at,
        "updatedAt": created_at, "start": 0, "end": 6, "color": "yellow",
    }


SEED_NOTES = [note(f"n-{RUN}-{i}", NOW - 50_000 + i) for i in range(BULK_NOTES + 1)]
DOOMED_NOTES = [note(f"d-{RUN}-{i}", NOW - 50_000 + i, DOOMED_ID) for i in range(2)]
POSITION = {"position": {"chapterId": "c1", "sentenceId": "s1"}, "lastOpenedAt": NOW - 40_000, "savedAt": NOW - 40_000}

OPEN_DB = "const db = await new Promise((res, rej) => { const r = indexedDB.open('moting-reader'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });"
# 本地库里书目和正文分两张表(books / contents),照 storage.putBook 的写法拆开写。
PUT_BOOK = """const putBook = (t, b) => { const { chapters, ...meta } = b;
    t.objectStore('books').put({ ...meta, chapterOutline: chapters.map(c => ({ id: c.id, title: c.title, sentenceCount: c.sentenceCount, characterCount: c.characterCount })) });
    t.objectStore('contents').put({ bookId: b.id, chapters }); };"""


def seed(page):
    page.evaluate(
        "async ([books, notes, position, bookId]) => {" + OPEN_DB + PUT_BOOK + """
            await new Promise((res, rej) => { const t = db.transaction(['books','contents','notes','settings'], 'readwrite');
                books.forEach(b => putBook(t, b));
                const ns = t.objectStore('notes'); notes.forEach(n => ns.put(n));
                t.objectStore('settings').put(position, 'reading-position:' + bookId);
                t.oncomplete = res; t.onerror = () => rej(t.error); });
            db.close();
        }""",
        [[SEED_BOOK, DOOMED_BOOK], SEED_NOTES + DOOMED_NOTES, POSITION, BOOK_ID],
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


def make_legacy(page, listening):
    """把 A 退回「按旧协议同步过」的样子:数据版本 0、设置没有修改时间、有早期统计,
    听书进度的时间早于上次同步——这些在旧协议下全都永远传不上去。"""
    page.evaluate(
        "async ([bookId, listening]) => {" + OPEN_DB + """
            await new Promise((res, rej) => { const t = db.transaction(['books','settings'], 'readwrite');
                const ss = t.objectStore('settings');
                const rq = ss.get('reader');
                rq.onsuccess = () => ss.put({ ...(rq.result ?? {}), aiModel: 'e2e-legacy-model' }, 'reader');
                ss.delete('reader-mtime');
                ss.put({ days: { '2025-01-02': 1234 } }, 'stats');
                const st = ss.get('sync:state');
                st.onsuccess = () => { const state = st.result; delete state.schema; ss.put(state, 'sync:state'); };
                const bs = t.objectStore('books'); const br = bs.get(bookId);
                br.onsuccess = () => bs.put({ ...br.result, listeningPosition: listening });
                t.oncomplete = res; t.onerror = () => rej(t.error); });
            db.close();
        }""",
        [BOOK_ID, listening],
    )


def add_book(page, book):
    page.evaluate(
        "async (book) => {" + OPEN_DB + PUT_BOOK + """
            await new Promise((res, rej) => { const t = db.transaction(['books','contents'], 'readwrite');
                putBook(t, book); t.oncomplete = res; t.onerror = () => rej(t.error); });
            db.close();
        }""",
        book,
    )


def remove_book(page, book_id):
    """照 storage.removeBook 的做法删书:书、它的划线和位置都删掉,只给书落墓碑。"""
    page.evaluate(
        "async (bookId) => {" + OPEN_DB + """
            await new Promise((res, rej) => { const t = db.transaction(['books','contents','notes','settings'], 'readwrite');
                t.objectStore('books').delete(bookId);
                t.objectStore('contents').delete(bookId);
                const cursor = t.objectStore('notes').index('bookId').openCursor(IDBKeyRange.only(bookId));
                cursor.onsuccess = () => { const c = cursor.result; if (c) { c.delete(); c.continue(); } };
                const ss = t.objectStore('settings');
                ss.delete('reading-position:' + bookId);
                const st = ss.get('sync:state');
                st.onsuccess = () => { const state = st.result;
                    state.tombstones.books[bookId] = Date.now(); ss.put(state, 'sync:state'); };
                t.oncomplete = res; t.onerror = () => rej(t.error); });
            db.close();
        }""",
        book_id,
    )


def idb_state(page):
    return page.evaluate(
        "async ([bookId, doomedId, resumeId]) => {" + OPEN_DB + """
            const read = (store) => new Promise((res) => { const rq = db.transaction(store).objectStore(store).getAll(); rq.onsuccess = () => res(rq.result); });
            const get = (store, key) => new Promise((res) => { const rq = db.transaction(store).objectStore(store).get(key); rq.onsuccess = () => res(rq.result); });
            const books = await read('books');
            const contents = await read('contents');
            const allNotes = await read('notes');
            const book = books.find(b => b.id === bookId);
            const resume = books.find(b => b.id === resumeId);
            const chaptersOf = (id) => contents.find(c => c.bookId === id)?.chapters?.length ?? 0;
            const notes = allNotes.filter(n => n.bookId === bookId).map(n => n.id);
            const position = await get('settings', 'reading-position:' + bookId);
            const reader = await get('settings', 'reader');
            const stats = await get('settings', 'stats');
            const sync = await get('settings', 'sync:state');
            db.close();
            return { hasBook: !!book, chapters: book ? chaptersOf(bookId) : 0, cover: book?.coverDataUrl ?? null,
                     notes, position: position ?? null, pushedAt: sync?.pushedAt ?? 0, pullCursor: sync?.pullCursor ?? 0,
                     schema: sync?.schema ?? 0, aiModel: reader?.aiModel ?? null, statsDays: stats?.days ?? {},
                     listening: book?.listeningPosition ?? null,
                     resumeChapters: resume ? chaptersOf(resumeId) : 0, resumeCover: resume?.coverDataUrl ?? null,
                     doomedBook: books.some(b => b.id === doomedId),
                     doomedNotes: allNotes.filter(n => n.bookId === doomedId).length,
                     demoBooks: books.filter(b => b.format === 'demo').length };
        }""",
        [BOOK_ID, DOOMED_ID, RESUME_ID],
    )


def open_settings(page):
    page.get_by_role("button", name="主页").click()
    page.get_by_role("button", name="设置").click()
    # 设置首页是一列入口，同步在「云端同步」那一页里。
    page.locator(".settings-link", has_text="云端同步").click()


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
    raise AssertionError(f"sync did not finish; errors on page: {page.locator('.settings-error').all_inner_texts()}")


def sync_now(page):
    before = idb_state(page)["pushedAt"]
    page.get_by_role("button", name="立即同步").click()
    return wait_synced(page, before)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    errors = []
    contexts = [browser.new_context(viewport={"width": 390, "height": 844}) for _ in range(3)]
    for ctx in contexts:
        ctx.on("weberror", lambda e, _c=errors: errors.append(str(e.error)))
    ctx_a, ctx_b, ctx_c = contexts

    # 1. 首轮:A 上传,B 拉取。
    page_a = ctx_a.new_page()
    page_a.goto(BASE)
    page_a.wait_for_load_state("networkidle")
    seed(page_a)
    login(page_a)
    a_first = wait_synced(page_a, 0)

    page_b = ctx_b.new_page()
    login(page_b)
    b_first = wait_synced(page_b, 0)

    # 2. 第二轮:A 在首轮之后增删各一条,B 再同步。
    added = note(f"n-{RUN}-late", int(time.time() * 1000))
    removed_id = SEED_NOTES[0]["id"]
    second_round_edits(page_a, added, removed_id)
    a_second = sync_now(page_a)
    b_second = sync_now(page_b)

    # 3. 旧版本升级补传。听书进度的时间早于 A 上次同步,旧协议下不会被捡到。
    listening = {"chapterId": "c1", "chapterIndex": 0, "sentenceId": "s1", "sentenceIndex": 0,
                 "percent": 37, "updatedAt": a_second["pushedAt"] - 5_000}
    make_legacy(page_a, listening)
    a_upgraded = sync_now(page_a)
    b_upgraded = sync_now(page_b)

    # 4. 续传:新书的正文先传上去(模拟上次传完正文就被打断),再同步不应重发正文。
    add_book(page_a, make_book(RESUME_ID, f"续传书{RUN}", int(time.time() * 1000), COVER))
    page_a.evaluate(
        "async ([id, chapters]) => { await fetch(`/api/sync/book/${id}/content`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chapters) }); }",
        [RESUME_ID, SEED_BOOK["chapters"]],
    )
    content_posts = []
    page_a.on("request", lambda r: content_posts.append(r.url) if r.method == "POST" and r.url.endswith(f"/book/{RESUME_ID}/content") else None)
    sync_now(page_a)
    b_resumed = sync_now(page_b)

    # 5. 删书:A 删掉一本,B 跟着删;全新设备 C 不能拿到它的孤儿划线。
    remove_book(page_a, DOOMED_ID)
    sync_now(page_a)
    b_after_delete = sync_now(page_b)
    page_c = ctx_c.new_page()
    login(page_c)
    c_fresh = wait_synced(page_c, 0)

    checks = {
        "first_round_book_with_body": b_first["hasBook"] and b_first["chapters"] > 0,
        "first_round_cover_via_r2": (b_first["cover"] or "").startswith("data:image/png"),
        "first_round_all_notes": len(b_first["notes"]) == BULK_NOTES + 1,
        "first_round_position": (b_first["position"] or {}).get("savedAt") == POSITION["savedAt"],
        "second_round_added_note": added["id"] in b_second["notes"],
        "second_round_deleted_note": removed_id not in b_second["notes"],
        "second_round_note_count": len(b_second["notes"]) == BULK_NOTES + 1,
        "a_cursor_advances": a_second["pullCursor"] >= a_first["pullCursor"] > 0,
        "upgrade_schema_bumped": a_upgraded["schema"] == 2,
        "upgrade_legacy_settings_reach_b": b_upgraded["aiModel"] == "e2e-legacy-model",
        "upgrade_legacy_stats_reach_b": b_upgraded["statsDays"].get("2025-01-02") == 1234,
        "upgrade_listening_reaches_b": (b_upgraded["listening"] or {}).get("percent") == 37,
        "resume_no_content_resend": len(content_posts) == 0,
        "resume_book_reaches_b": b_resumed["resumeChapters"] > 0 and (b_resumed["resumeCover"] or "").startswith("data:image/png"),
        "delete_propagates_to_b": not b_after_delete["doomedBook"] and b_after_delete["doomedNotes"] == 0,
        "fresh_device_no_orphans": not c_fresh["doomedBook"] and c_fresh["doomedNotes"] == 0,
        "fresh_device_gets_everything_else": len(c_fresh["notes"]) == BULK_NOTES + 1 and c_fresh["aiModel"] == "e2e-legacy-model",
        # 示例书只留本机:每台设备只有自己那一本。
        "demo_book_stays_local": b_after_delete["demoBooks"] == 1 and c_fresh["demoBooks"] == 1,
        "no_page_errors": not errors,
    }
    # 回到书库看界面上真的有这本书。冷启动会回到上次停的设置页，先一路返回到有底栏的地方。
    page_b.goto(BASE)
    page_b.wait_for_load_state("networkidle")
    for _ in range(3):
        if page_b.locator(".bottom-nav").count():
            break
        page_b.get_by_role("button", name="返回").first.click()
        page_b.wait_for_timeout(300)
    page_b.get_by_role("button", name="书库", exact=True).click()
    page_b.get_by_placeholder("搜索书名或作者").fill(SEED_BOOK["title"])
    try:
        expect(page_b.get_by_alt_text(f"{SEED_BOOK['title']}封面")).to_be_visible(timeout=10000)
        checks["library_shows_book"] = True
    except AssertionError:
        checks["library_shows_book"] = False
    page_b.screenshot(path=str(OUTPUT / "device-b-received.png"))

    print(json.dumps({"passed": all(checks.values()), "checks": checks,
                      "content_posts": content_posts, "page_errors": errors}, ensure_ascii=False))
    browser.close()
    sys.exit(0 if all(checks.values()) else 1)
