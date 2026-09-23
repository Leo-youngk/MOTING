"""老用户升级:v4 的本地库(正文存在书目记录里)打开新版后,原地拆成书目 + 正文两张表。

Usage: python tests/storage-migration-browser.py [http://localhost:5183] [副本目录]
Requires `npm run dev` 和装了 Edge 的 Playwright。给了副本目录(books.json / rest.json)时,
用那份真实规模的书库再跑一遍,并报告升级耗时。

检查:
1. 升级后 books 表里不再有 chapters,每本都有跟正文一致的 chapterOutline;contents 表里正文完整。
2. 划线、阅读位置、设置原样保留。
3. 书库照常显示,打开一本书能看到正文。
"""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5183").rstrip("/")
REPLICA = Path(sys.argv[2]) if len(sys.argv) > 2 else None
NOW = int(time.time() * 1000)


def sentence(sid, text, order):
    return {"id": sid, "text": text, "speakableText": text, "order": order}


def chapter(cid, title, order, sentences):
    return {"id": cid, "title": title, "order": order, "sentenceCount": len(sentences),
            "characterCount": sum(len(s["text"]) for s in sentences),
            "paragraphs": [{"id": f"{cid}-p", "order": 0, "kind": "text", "sentences": sentences}]}


def old_book(book_id, title, chapters):
    """v4 的书:正文就在书目记录里,也没有 chapterOutline。"""
    return {"id": book_id, "title": title, "author": "迁移测试", "format": "txt", "accent": "#7a8290",
            "status": "ready", "createdAt": NOW - 90_000, "updatedAt": NOW - 90_000, "lastOpenedAt": NOW - 90_000,
            "sentenceCount": sum(c["sentenceCount"] for c in chapters),
            "characterCount": sum(c["characterCount"] for c in chapters), "chapters": chapters}


SMALL_BOOKS = [
    old_book("mig-a", "迁移甲", [
        chapter("a1", "第一章 起", 0, [sentence("a1s1", "甲书第一句。", 0), sentence("a1s2", "甲书第二句。", 1)]),
        chapter("a2", "第二章 承", 1, [sentence("a2s1", "甲书第三句。", 0)]),
    ]),
    old_book("mig-b", "迁移乙", [chapter("b1", "序", 0, [sentence("b1s1", "乙书唯一的一句。", 0)])]),
]
SMALL_REST = {
    "notes": [{"id": "mig-note", "bookId": "mig-a", "chapterId": "a2", "sentenceId": "a2s1", "kind": "highlight",
               "excerpt": "甲书第三句。", "createdAt": NOW - 80_000, "updatedAt": NOW - 80_000, "color": "yellow"}],
    "positions": [{"bookId": "mig-a", "position": {"chapterId": "a2", "chapterIndex": 1, "sentenceId": "a2s1",
                   "sentenceIndex": 0, "percent": 66, "updatedAt": NOW - 70_000},
                   "lastOpenedAt": NOW - 70_000, "savedAt": NOW - 70_000}],
    "sessions": [], "chats": [], "patches": [],
    "settings": {"reader": {"shellTheme": "cream", "theme": "original", "fontFamily": "kai"}},
}

# 照 v4 的建表语句原样建一个旧库,再把整本书(带正文)写进 books 表。
MAKE_V4 = r"""
async ([books, rest]) => {
  await new Promise((res, rej) => { const d = indexedDB.deleteDatabase("moting-reader"); d.onsuccess = res; d.onerror = () => rej(d.error); d.onblocked = res; });
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open("moting-reader", 4);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("books", { keyPath: "id" });
      db.createObjectStore("notes", { keyPath: "id" }).createIndex("bookId", "bookId", { unique: false });
      db.createObjectStore("settings");
      db.createObjectStore("images", { keyPath: "id" }).createIndex("bookId", "bookId", { unique: false });
      db.createObjectStore("chats", { keyPath: "bookId" });
      db.createObjectStore("sessions", { keyPath: "id" }).createIndex("bookId", "bookId", { unique: false });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => {
    const t = db.transaction(["books", "notes", "settings", "sessions", "chats"], "readwrite");
    books.forEach((b) => t.objectStore("books").put(b));
    rest.notes.forEach((n) => t.objectStore("notes").put(n));
    rest.sessions.forEach((s) => t.objectStore("sessions").put(s));
    rest.chats.forEach((c) => t.objectStore("chats").put(c));
    const st = t.objectStore("settings");
    st.put(rest.settings.reader, "reader");
    rest.positions.forEach((p) => st.put({ position: p.position, lastOpenedAt: p.lastOpenedAt, savedAt: p.savedAt }, "reading-position:" + p.bookId));
    rest.patches.forEach((p) => st.put(p, "book-metadata:" + p.bookId));
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
  db.close();
  localStorage.setItem("moting:last-view", JSON.stringify({ name: "library" }));
  return books.length;
}
"""

READ_BACK = r"""
async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open("moting-reader"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = (store) => new Promise((res) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); });
  const get = (store, key) => new Promise((res) => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); });
  const books = await all("books");
  const contents = await all("contents");
  const notes = await all("notes");
  const reader = await get("settings", "reader");
  const positions = {};
  for (const b of books) positions[b.id] = (await get("settings", "reading-position:" + b.id))?.position?.sentenceId ?? null;
  const version = db.version;
  db.close();
  return {
    version,
    books: books.map((b) => ({ id: b.id, hasChapters: "chapters" in b,
      outline: (b.chapterOutline || []).map((c) => [c.id, c.title, c.sentenceCount, c.characterCount]) })),
    contents: contents.map((c) => ({ bookId: c.bookId,
      outline: c.chapters.map((ch) => [ch.id, ch.title, ch.sentenceCount, ch.characterCount]),
      sentences: c.chapters.reduce((n, ch) => n + ch.paragraphs.reduce((m, p) => m + p.sentences.length, 0), 0) })),
    noteIds: notes.map((n) => n.id).sort(),
    reader: { shellTheme: reader?.shellTheme, fontFamily: reader?.fontFamily },
    positions,
  };
}
"""


def run(books, rest, label, context_factory):
    context = context_factory()
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    # 先落在同源的静态文件上,应用还没跑,好把旧库原样建出来。
    page.goto(BASE + "/manifest.webmanifest")
    count = page.evaluate(MAKE_V4, [books, rest])
    started = time.time()
    page.goto(BASE + "/")
    page.wait_for_selector(".bottom-nav", timeout=180_000)
    upgrade_ms = int((time.time() - started) * 1000)
    state = page.evaluate(READ_BACK)

    expected = {b["id"]: [[c["id"], c["title"], c["sentenceCount"], c["characterCount"]] for c in b["chapters"]] for b in books}
    expected_sentences = {b["id"]: sum(len(p["sentences"]) for c in b["chapters"] for p in c["paragraphs"]) for b in books}
    contents = {c["bookId"]: c for c in state["contents"]}
    checks = {
        "db_version_5": state["version"] == 5,
        "books_have_no_chapters": all(not b["hasChapters"] for b in state["books"]),
        "outline_matches_content": all(b["outline"] == expected.get(b["id"]) for b in state["books"]),
        "contents_complete": all(
            contents.get(book_id, {}).get("outline") == outline and contents[book_id]["sentences"] == expected_sentences[book_id]
            for book_id, outline in expected.items()
        ),
        "book_count_kept": len(state["books"]) == count,
        "notes_kept": state["noteIds"] == sorted(n["id"] for n in rest["notes"]),
        "settings_kept": state["reader"]["shellTheme"] == rest["settings"]["reader"].get("shellTheme"),
        "positions_kept": all(state["positions"].get(p["bookId"]) == p["position"]["sentenceId"] for p in rest["positions"]),
    }

    # 书库里点开第一本,正文要出来。
    page.locator(".grid-book__cover").first.click()
    page.wait_for_selector(".reader-shell [data-sentence-id]", timeout=60_000)
    checks["reader_opens_with_text"] = page.locator(".reader-shell [data-sentence-id]").count() > 0
    checks["no_page_errors"] = not errors
    context.close()
    return {"label": label, "passed": all(checks.values()), "checks": checks, "upgrade_ms": upgrade_ms, "books": count, "errors": errors[:3]}


def main():
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        factory = lambda: browser.new_context(viewport={"width": 393, "height": 852}, is_mobile=True, has_touch=True)
        results.append(run(SMALL_BOOKS, SMALL_REST, "small", factory))
        if REPLICA:
            books = json.loads((REPLICA / "books.json").read_text(encoding="utf-8"))
            rest = json.loads((REPLICA / "rest.json").read_text(encoding="utf-8"))
            for book in books:
                book.pop("chapterOutline", None)
            results.append(run(books, rest, "replica", factory))
        browser.close()
    print(json.dumps({"passed": all(r["passed"] for r in results), "runs": results}, ensure_ascii=False))
    sys.exit(0 if all(r["passed"] for r in results) else 1)


main()
