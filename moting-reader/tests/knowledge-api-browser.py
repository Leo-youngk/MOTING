"""隔离本地真 D1/R2 + 手机设置页验收，不允许连接生产。

启动 Vite 前设置 MOTING_DEV_STATE 指向初始化过的临时 D1/R2 目录。
python tests/knowledge-api-browser.py http://127.0.0.1:5187
"""
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlencode, urlparse

from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5187"
assert urlparse(BASE).hostname in ("localhost", "127.0.0.1", "::1"), "only loopback services are allowed"
assert os.environ.get("MOTING_DEV_STATE"), "isolated D1/R2 state is required"
ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "outputs" / "knowledge-api"
OUTPUT.mkdir(parents=True, exist_ok=True)
variables = dict(line.split("=", 1) for line in (ROOT / ".dev.vars").read_text(encoding="utf-8").splitlines() if "=" in line and not line.lstrip().startswith("#"))
credentials = {"username": variables["SYNC_USERNAME"].strip().strip('"\''), "password": variables["SYNC_PASSWORD"].strip().strip('"\'')}
checks = {}


def check(label, value):
    assert value, label
    checks[label] = True


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    api = context.request
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name="设置", exact=True).click()
    page.get_by_role("button", name="AI 数据接口").click()
    expect(page.get_by_role("button", name="登录云端同步")).to_be_visible()
    check("未登录提示同步授权", True)

    response = api.post(BASE + "/api/sync/login", data=credentials)
    check("本地会话登录", response.status == 200)
    now = int(time.time() * 1000) - 1000
    book_id = "knowledge-http-test"
    book = {"id": book_id, "title": "接口测试书", "author": "测试作者", "format": "txt", "status": "ready", "accent": "#8a8f98", "createdAt": now,
            "updatedAt": now, "lastOpenedAt": now, "chapterOutline": [{"id": "chapter", "title": "接口第一章", "sentenceCount": 1, "characterCount": 10}], "characterCount": 10, "sentenceCount": 1}
    notes = [{"id": "knowledge-note-%03d" % i, "bookId": book_id, "chapterId": "chapter", "sentenceId": "s", "kind": "highlight", "excerpt": "接口摘录 %03d" % i,
              "thought": "接口想法" if i % 3 == 0 else "", "groupId": "group-%03d" % i, "createdAt": now + i, "updatedAt": now + i} for i in range(105)]
    content = "真正的长回答，不应截断。" * 70000
    chat = {"bookId": book_id, "turns": [{"id": "question", "role": "user", "content": "我的问题", "quote": "引用摘录"},
            {"id": "answer", "replyTo": "question", "role": "assistant", "content": content, "reasoning": "保存的思考"}], "updatedAt": now}
    chat_body = json.dumps(chat, ensure_ascii=False, separators=(",", ":"))
    blob_hash = hashlib.sha256(chat_body.encode()).hexdigest()
    blob_path = "/api/sync/record/chats/%s/%s" % (book_id, blob_hash)
    check("大对话写入隔离 R2", api.post(BASE + blob_path, data=chat_body.encode(), headers={"content-type": "application/json"}).status == 200)
    payload = {"books": [{"key": book_id, "data": json.dumps(book, ensure_ascii=False), "updatedAt": now}],
               "notes": [{"key": note["id"], "bookId": book_id, "data": json.dumps(note, ensure_ascii=False), "updatedAt": note["updatedAt"]} for note in notes],
               "chats": [{"key": book_id, "blob": {"hash": blob_hash, "bytes": len(chat_body.encode())}, "updatedAt": now}]}
    response = api.post(BASE + "/api/sync/push", data=payload)
    check("真实同步协议写入测试书和笔记", response.status == 200 and not response.json().get("issues"))

    page.reload()
    page.wait_for_load_state("networkidle")
    if not page.get_by_role("button", name="创建密钥", exact=True).count():
        if page.get_by_role("button", name="设置", exact=True).count():
            page.get_by_role("button", name="设置", exact=True).click()
        page.get_by_role("button", name="AI 数据接口").click()
    expect(page.get_by_role("button", name="创建密钥", exact=True)).to_be_enabled(timeout=30000)
    page.get_by_role("button", name="创建密钥", exact=True).click()
    secret_field = page.get_by_role("textbox", name="新建的只读密钥")
    expect(secret_field).to_be_visible()
    token = secret_field.input_value()
    check("手机界面创建专用密钥", token.startswith("moting_ro_"))
    page.get_by_role("button", name="复制密钥", exact=True).click()
    expect(page.get_by_role("status")).to_contain_text("密钥已复制")
    check("密钥复制反馈", True)
    page.get_by_role("button", name="已保存，收起密钥").click()
    expect(secret_field).to_have_count(0)
    check("保存后收起密钥原文", True)
    check("手机无横向溢出", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    page.evaluate("window.scrollTo({top:0, behavior:'instant'})")
    page.screenshot(path=str(OUTPUT / "settings-mobile.png"), full_page=True)
    page.get_by_role("button", name="复制接入说明").click()
    expect(page.get_by_role("status")).to_contain_text("接入说明已复制")
    check("接入说明复制反馈", True)

    headers = {"authorization": "Bearer " + token}

    def read(path, **params):
        query = urlencode(params)
        response = api.get(BASE + "/api/knowledge/v1" + path + ("?" + query if query else ""), headers=headers)
        assert response.status == 200, "data API HTTP status: %s" % response.status
        check("真实 HTTP 不缓存内容", response.headers.get("cache-control") == "no-store")
        return response.json()

    result = read("/books", bookId=book_id)
    check("HTTP 获取书名作者", result["data"][0]["title"] == "接口测试书" and result["data"][0]["author"] == "测试作者")
    received = []
    cursor = None
    while True:
        result = read("/notes", bookId=book_id, limit=40, **({"cursor": cursor} if cursor else {}))
        received.extend(result["data"])
        cursor = result["nextCursor"]
        if not cursor:
            break
    check("105 条笔记跨页无遗漏重复", len(received) == 105 and len({note["id"] for note in received}) == 105)
    check("章节和想法返回", received[0]["chapterTitle"] == "接口第一章" and received[0]["thought"] == "接口想法")
    result = read("/chats", bookId=book_id, q="真正的长回答")
    check("R2 对话关键词检索", len(result["data"]) == 1 and result["data"][0]["turnCount"] == 2)
    result = read("/chats/" + book_id, limit=1)
    check("真实 HTTP 引用返回", result["turns"][0]["quote"] == "引用摘录")
    second = read("/chats/" + book_id, limit=1, cursor=result["nextCursor"])
    check("真实 R2 长回答完整", second["turns"][0]["content"] == content and second["nextCursor"] is None)
    check("同步 Cookie 不能读取 Bot API", api.get(BASE + "/api/knowledge/v1/notes").status == 401)
    check("Bot API 禁止写入", api.post(BASE + "/api/knowledge/v1/notes", data={}, headers=headers).status == 405)

    keys = api.get(BASE + "/api/sync/access-keys").json()["keys"]
    check("密钥列表不含密钥原文", token not in json.dumps(keys) and "token_hash" not in json.dumps(keys))
    storage_data = page.evaluate("async () => { const s = await import('/lib/storage.ts'); return JSON.stringify({settings:await s.getSettings(), local:{...localStorage}, session:{...sessionStorage}}); }")
    check("密钥不存入浏览器持久设置", token not in storage_data)
    page.get_by_role("button", name="撤销 Grok bot", exact=True).click()
    expect(page.get_by_role("status")).to_contain_text("已撤销")
    check("手机界面撤销密钥立即生效", api.get(BASE + "/api/knowledge/v1/notes", headers=headers).status == 401)
    page.evaluate("window.scrollTo({top:0, behavior:'instant'})")
    page.screenshot(path=str(OUTPUT / "settings-revoked.png"), full_page=True)
    page.get_by_role("button", name="返回", exact=True).click()
    page.get_by_role("button", name="AI 数据接口").click()
    expect(page.get_by_role("textbox", name="新建的只读密钥")).to_have_count(0)
    check("离开重进不再展示密钥原文", True)
    check("页面无脚本异常", not errors)
    (OUTPUT / "browser-validation.json").write_text(json.dumps({"checks": checks, "page_errors": errors, "viewport": {"width": 390, "height": 844}, "r2_chat_bytes": len(chat_body.encode()), "production_data_written": False}, ensure_ascii=False, indent=2), encoding="utf-8")
    browser.close()

print(json.dumps({"passed": len(checks), "checks": checks}, ensure_ascii=False))
