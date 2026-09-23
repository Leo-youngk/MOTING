"""笔记页的两层结构(先书、后笔记)与书城封面直连,在 iPhone 视口下验证。

Usage: python tests/notes-browser.py [http://127.0.0.1:5173]
Requires `npm run dev` 和装了 Edge 的 Playwright。截图写到 .wrangler/notes-tests/。

检查:
1. 笔记 tab 只列有笔记的书,按最近一条笔记排序;跨句划线只算一条;搜索能按书名过滤。
2. 点进一本书:按章节分段、按在书里的先后排(不是按创建时间);跨句划线合成一段;返回回到书单。
3. 书城封面直接从微信读书图床加载,不经 Worker 转发。
"""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
OUTPUT = Path(__file__).resolve().parents[1] / ".wrangler" / "notes-tests"
OUTPUT.mkdir(parents=True, exist_ok=True)
NOW = int(time.time() * 1000)


def sentence(sid, text, order):
    return {"id": sid, "text": text, "speakableText": text, "order": order}


def chapter(cid, title, order, sentences):
    return {"id": cid, "title": title, "order": order, "sentenceCount": len(sentences),
            "characterCount": sum(len(s["text"]) for s in sentences),
            "paragraphs": [{"id": f"{cid}-p", "order": 0, "kind": "text", "sentences": sentences}]}


def book(book_id, title, author, chapters, created_at):
    return {"id": book_id, "title": title, "author": author, "format": "txt", "accent": "#7a8290",
            "status": "ready", "createdAt": created_at, "updatedAt": created_at, "lastOpenedAt": created_at,
            "sentenceCount": 4, "characterCount": 40, "chapters": chapters}


def note(note_id, book_id, chapter_id, sentence_id, excerpt, created_at, **extra):
    return {"id": note_id, "bookId": book_id, "chapterId": chapter_id, "sentenceId": sentence_id,
            "kind": "highlight", "excerpt": excerpt, "createdAt": created_at, "updatedAt": created_at,
            "start": 0, "end": len(excerpt), "color": "yellow", **extra}


BOOK_X = book("ui-book-x", "长河", "甲作者", [
    chapter("x1", "第一章 源头", 0, [sentence("x1s1", "句一。", 0), sentence("x1s2", "句二。", 1)]),
    chapter("x2", "第二章 入海", 1, [sentence("x2s1", "句三。", 0), sentence("x2s2", "句四。", 1)]),
], NOW - 90_000)
BOOK_Y = book("ui-book-y", "短歌", "乙作者", [chapter("y1", "序", 0, [sentence("y1s1", "短句。", 0)])], NOW - 90_000)
BOOK_Z = book("ui-book-z", "没有笔记的书", "丙作者", [chapter("z1", "一", 0, [sentence("z1s1", "空。", 0)])], NOW - 90_000)

NOTES = [
    # 故意倒着创建:第二章的先划,第一章的后划。书内页面必须按书里的先后排回来。
    note("nx-late-chapter", "ui-book-x", "x2", "x2s2", "句四。", NOW - 80_000),
    note("nx-mid", "ui-book-x", "x2", "x2s1", "句三。", NOW - 70_000, thought="这一句值得再想想"),
    # 一次跨两句的划线,库里是两条记录,共用 groupId。
    note("nx-g1", "ui-book-x", "x1", "x1s1", "句一。", NOW - 60_000, groupId="gx"),
    note("nx-g2", "ui-book-x", "x1", "x1s2", "句二。", NOW - 59_999, groupId="gx"),
    note("ny-1", "ui-book-y", "y1", "y1s1", "短句。", NOW - 10_000),
]

OPEN_DB = "const db = await new Promise((res, rej) => { const r = indexedDB.open('moting-reader'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });"


def seed(page):
    page.evaluate(
        "async ([books, notes]) => {" + OPEN_DB + """
            await new Promise((res, rej) => { const t = db.transaction(['books','contents','notes'], 'readwrite');
                // 书目和正文分两张表写,照 storage.putBook。
                books.forEach(b => { const { chapters, ...meta } = b;
                    t.objectStore('books').put({ ...meta, chapterOutline: chapters.map(c => ({ id: c.id, title: c.title, sentenceCount: c.sentenceCount, characterCount: c.characterCount })) });
                    t.objectStore('contents').put({ bookId: b.id, chapters }); });
                const ns = t.objectStore('notes'); notes.forEach(n => ns.put(n));
                t.oncomplete = res; t.onerror = () => rej(t.error); });
            db.close();
        }""",
        [[BOOK_X, BOOK_Y, BOOK_Z], NOTES],
    )


def set_shell(page, theme):
    page.evaluate(
        "async (theme) => {" + OPEN_DB + """
            await new Promise((res, rej) => { const t = db.transaction('settings', 'readwrite');
                const ss = t.objectStore('settings'); const rq = ss.get('reader');
                rq.onsuccess = () => ss.put({ ...(rq.result ?? {}), shellTheme: theme }, 'reader');
                t.oncomplete = res; t.onerror = () => rej(t.error); });
            db.close();
        }""",
        theme,
    )


def open_notes(page):
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.locator(".bottom-nav").get_by_role("button", name="笔记").click()
    page.wait_for_timeout(300)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    errors = []
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
    ctx.on("weberror", lambda e: errors.append(str(e.error)))
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    seed(page)

    checks = {}
    open_notes(page)
    rows = page.locator(".notes-book-row")
    rows.first.wait_for()
    # 书封组件里也有 strong/em,只取文字列里的。
    titles = page.locator(".notes-book-row .ios-row__main > span > strong").all_inner_texts()
    metas = page.locator(".notes-book-row .ios-row__main > span > em").all_inner_texts()
    checks["list_only_books_with_notes_latest_first"] = titles == ["短歌", "长河"]
    checks["cross_sentence_counted_once"] = metas[1] == "3 条笔记 · 1 条想法" if len(metas) > 1 else False
    checks["summary"] = page.locator(".ink-summary").inner_text() == "2 本书 · 4 条笔记"
    page.screenshot(path=str(OUTPUT / "notes-list-white.png"))

    page.get_by_placeholder("搜索书名或作者").fill("甲作者")
    checks["search_filters_books"] = page.locator(".notes-book-row").count() == 1
    page.get_by_placeholder("搜索书名或作者").fill("")

    page.locator(".notes-book-row", has_text="长河").click()
    page.wait_for_timeout(300)
    chapters = page.locator(".ink-chapter__title").all_inner_texts()
    excerpts = page.locator(".ink-chapter .ink-note__text").all_inner_texts()
    checks["book_page_hero"] = "长河" in page.locator(".book-notes-hero").inner_text()
    checks["sections_in_book_order"] = chapters == ["第一章 源头", "第二章 入海"]
    checks["notes_in_reading_order_and_group_merged"] = excerpts == ["句一。句二。", "句三。", "句四。"]
    checks["thought_shown"] = page.get_by_text("这一句值得再想想").count() == 1
    page.screenshot(path=str(OUTPUT / "book-notes-white.png"), full_page=True)

    page.locator(".ios-segmented").get_by_role("button", name="想法", exact=True).click()
    checks["thought_filter"] = page.locator(".ink-chapter .ink-note__text").all_inner_texts() == ["句三。"]
    page.locator(".ios-back").click()
    page.wait_for_timeout(300)
    checks["back_returns_to_book_list"] = page.locator(".notes-book-row").count() == 2

    page.locator(".ios-segmented").get_by_role("button", name="AI 对话", exact=True).click()
    checks["chat_tab_empty_state"] = page.get_by_text("还没有 AI 对话").count() == 1

    # 墨夜外壳下截一张,确认没有浅底浅字。
    set_shell(page, "black")
    open_notes(page)
    page.screenshot(path=str(OUTPUT / "notes-list-black.png"))
    page.locator(".notes-book-row", has_text="长河").click()
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUTPUT / "book-notes-black.png"), full_page=True)
    set_shell(page, "white")

    # 书城封面:主页「全部」进完整书城,等封面加载完看来源。
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.locator(".bottom-nav").get_by_role("button", name="主页").click()
    page.wait_for_timeout(4000)
    covers = page.evaluate(
        """() => Array.from(document.querySelectorAll('.store-cover img')).map(img => ({
            src: img.currentSrc || img.src, ok: img.complete && img.naturalWidth > 0, fallback: img.dataset.fallback === '1' }))"""
    )
    loaded = [c for c in covers if c["ok"]]
    checks["store_covers_present"] = len(covers) > 0
    checks["store_covers_direct_from_cdn"] = bool(loaded) and all(
        c["src"].startswith("https://cdn.weread.qq.com/") or ".image.myqcloud.com/" in c["src"] for c in loaded
    )
    page.screenshot(path=str(OUTPUT / "home-store.png"))

    checks["no_page_errors"] = not errors
    print(json.dumps({"passed": all(checks.values()), "checks": checks, "titles": titles, "metas": metas,
                      "chapters": chapters, "excerpts": excerpts,
                      "covers": {"total": len(covers), "loaded": len(loaded), "fallback": sum(c["fallback"] for c in covers),
                                 "sample": covers[:2]},
                      "errors": errors[:5]}, ensure_ascii=False))
    browser.close()
    sys.exit(0 if all(checks.values()) else 1)
