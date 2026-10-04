"""真实本地 D1/R2 的进度确认回归。只允许 loopback，会写入隔离测试数据。
先初始化 schema 并应用 worker/migrations，再启动隔离 Vite 开发服务。
Usage: python tests/sync-progress-browser.py [http://127.0.0.1:5173]
"""
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173").rstrip("/")
if urlsplit(BASE).hostname not in ("127.0.0.1", "localhost", "::1"):
    raise ValueError("Regression tests require a loopback server")
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs" / "sync-progress"
OUT.mkdir(parents=True, exist_ok=True)
env = {}
for line in (ROOT / ".dev.vars").read_text(encoding="utf-8-sig").splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")

INIT = """async ({username,password,bookId})=>{
    window.storage=await import('/lib/storage.ts');window.sync=await import('/lib/sync.ts');
    await sync.loginSync(username,password,new AbortController().signal);
    window.bookId=bookId;
    window.pos=(sentence,at=Date.now())=>({chapterId:'test-chapter',chapterIndex:0,
      sentenceId:'test-'+sentence,sentenceIndex:sentence,percent:sentence*4,updatedAt:at});
    window.saveRead=(sentence,at=Date.now())=>storage.saveReadingPositions([
      {bookId,position:pos(sentence,at),savedAt:at,lastOpenedAt:at}],{local:true});
    window.full=()=>sync.runSync({signal:new AbortController().signal});
    window.fast=()=>sync.runProgressSync({signal:new AbortController().signal});
    window.read=async()=>((await storage.getAllReadingPositions()).find(e=>e.bookId===bookId))?.position?.sentenceIndex;
    window.listen=async()=>(await storage.getBookMeta(bookId))?.listeningPosition?.sentenceIndex;
    window.journal=async()=>(await storage.getProgressQueue()).find(e=>e.key===bookId&&e.kind==='positions');
}"""

with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="msedge", headless=True)
    contexts = [browser.new_context() for _ in range(2)]
    pages = [context.new_page() for context in contexts]
    book_id = "progress-test-" + str(int(time.time() * 1000))
    for page in pages:
        page.goto(BASE + "/manifest.webmanifest")
        page.evaluate(INIT, {"username": env["SYNC_USERNAME"], "password": env["SYNC_PASSWORD"], "bookId": book_id})
    a, b = pages
    a.evaluate("""async()=>{
      const chapters=[{id:'test-chapter',title:'测试章节',order:0,sentenceCount:25,characterCount:125,
        paragraphs:[{id:'paragraph',kind:'text',order:0,sentences:Array.from({length:25},(_,i)=>
          ({id:'test-'+i,text:'同步测试句。',speakableText:'同步测试句。',order:i}))}]}];
      await storage.saveBook({id:bookId,title:'同步确认回归',author:'测试',format:'txt',accent:'#8a8f98',
        status:'ready',createdAt:Date.now(),updatedAt:Date.now(),lastOpenedAt:Date.now(),sentenceCount:25,characterCount:125,chapters});
      await saveRead(1);await full();
    }""")
    b.evaluate("full()")
    checks = {}

    # 捕获时间早于整轮水位，后来才写入；必须仍在 outbox 中。
    a.evaluate("""async()=>{
      window.captured=Date.now();await new Promise(r=>setTimeout(r,20));await full();
      await storage.saveReadingPositions([{bookId,position:pos(4,captured),savedAt:captured,lastOpenedAt:captured}]);
    }""")
    checks["late_write_queued"] = a.evaluate("async()=>(await journal()).pending")
    a.evaluate("full()")
    b.evaluate("fast()")
    checks["late_write_reaches_peer"] = b.evaluate("read()") == 4

    # 延迟的旧 API 写入不能覆盖已经应用的更晚听书位置。
    a.evaluate("window.old=pos(2,Date.now()-1000)")
    b.evaluate("async()=>{await storage.saveLocalListeningPosition(bookId,pos(8));await fast()}")
    a.evaluate("fast()")
    a.evaluate("async()=>{await storage.updateBookMeta(bookId,{listeningPosition:old,updatedAt:old.updatedAt});await full()}")
    checks["stale_listening_does_not_roll_back"] = a.evaluate("listen()") == 8

    # 网络返回旧确认之前，在同一设备继续阅读；旧确认不能清理新队列项。
    intercepted = []
    def replace_during_ack(route):
        body = route.request.post_data_json
        if any(row["key"] == book_id for row in body.get("positions", [])) and not intercepted:
            response = route.fetch()
            intercepted.append(body)
            a.evaluate("saveRead(6)")
            route.fulfill(response=response)
        else:
            route.continue_()
    a.route("**/api/sync/push", replace_during_ack)
    a.evaluate("saveRead(5)")
    a.evaluate("sync.pushPending(new AbortController().signal)")
    state = a.evaluate("journal()")
    checks["new_progress_survives_old_ack"] = state["pending"] and json.loads(state["data"])["position"]["sentenceIndex"] == 6
    original = intercepted[0]
    a.unroute("**/api/sync/push")
    # 重复网络请求必须幂等：同一 mutation 的确认版本保持不变。
    duplicate = a.evaluate("""async body=>{
      const one=await(await fetch('/api/sync/push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
      const two=await(await fetch('/api/sync/push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
      return [one.receipts.find(r=>r.key===bookId).record.serverAt,two.receipts.find(r=>r.key===bookId).record.serverAt];
    }""", original)
    checks["duplicate_mutation_is_idempotent"] = duplicate[0] == duplicate[1]
    a.evaluate("fast()")
    b.evaluate("fast()")
    checks["new_progress_eventually_reaches_peer"] = b.evaluate("read()") == 6

    # 回拨本机墙上时钟，不应使真正的新本地操作被拒绝。
    a.evaluate("""async()=>{
      const native=Date.now;Date.now=()=>native()-600000;
      try {await saveRead(7)} finally {Date.now=native}
      await fast();
    }""")
    b.evaluate("fast()")
    checks["clock_rollback_preserves_new_progress"] = a.evaluate("read()") == 7 and b.evaluate("read()") == 7

    # 同基线的并发修改被检测；时钟快的设备不能压掉显式选择的重读。
    a.evaluate("saveRead(8,Date.now()+600000)")
    b.evaluate("saveRead(2)")
    a.evaluate("fast()")
    b.evaluate("fast()")
    conflict = b.evaluate("journal()")
    checks["concurrent_candidates_preserved"] = bool(conflict.get("conflict")) and json.loads(conflict["conflict"]["data"])["position"]["sentenceIndex"] == 2
    b.evaluate("async()=>{const entry=await journal();await storage.resolveProgressConflict(entry.id,true);await fast()}")
    a.evaluate("fast()")
    checks["explicit_rereading_can_move_backwards"] = a.evaluate("read()") == 2 and b.evaluate("read()") == 2
    legacy_status = a.evaluate("""async()=>{
      return (await fetch('/api/sync/push',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({positions:[{key:bookId,data:JSON.stringify({position:pos(1),savedAt:Date.now(),lastOpenedAt:Date.now()}),updatedAt:Date.now()+10000}]})})).status;
    }""")
    checks["legacy_client_cannot_bypass_confirmation"] = legacy_status == 426

    # 离线后关闭页面、保留浏览器数据，再打开仍可补传。
    contexts[0].set_offline(True)
    a.evaluate("saveRead(9)")
    a.close()
    contexts[0].set_offline(False)
    a = contexts[0].new_page()
    a.goto(BASE + "/manifest.webmanifest")
    a.evaluate(INIT, {"username": env["SYNC_USERNAME"], "password": env["SYNC_PASSWORD"], "bookId": book_id})
    checks["offline_queue_survives_page_close"] = a.evaluate("async()=>(await journal()).pending")
    a.evaluate("fast()")
    b.evaluate("fast()")
    checks["offline_queue_reaches_peer_after_reopen"] = b.evaluate("read()") == 9

    # 卡住正文 HEAD。进度通道仍能拉取，最后诚实返回资源待重试。
    a.evaluate("""async()=>{
      const book=await storage.getBook(bookId);await storage.saveBook({...book,id:bookId+'-blocked',
        syncReadyAt:undefined,title:'正文失败回归',createdAt:Date.now(),updatedAt:Date.now()});
    }""")
    held = []
    a.route("**/api/sync/book/*-blocked/content", lambda route: held.append(route))
    a.evaluate("window.resourceSync=full();void 0")
    deadline = time.time() + 10
    while not held and time.time() < deadline:
        a.wait_for_timeout(50)
    assert held, "resource request never started"
    b.evaluate("async()=>{await saveRead(10);await fast()}")
    a.evaluate("fast()")
    checks["progress_not_blocked_by_resource_request"] = a.evaluate("read()") == 10
    held[0].fulfill(status=503, content_type="application/json", body='{"error":"isolated resource failure"}')
    result = a.evaluate("resourceSync")
    checks["resource_failure_reported_as_pending"] = result["pendingResources"] > 0

    # 旧版内嵌位置的设备时间更大，也不能盖过新的服务端确认。
    a.evaluate("""async()=>{
      const db=await new Promise((res,rej)=>{const r=indexedDB.open('moting-reader',6);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
      await new Promise((res,rej)=>{const t=db.transaction('books','readwrite');const s=t.objectStore('books');const r=s.get(bookId);
        r.onsuccess=()=>s.put({...r.result,readingPosition:pos(20,Date.now()+86400000)});t.oncomplete=res;t.onerror=()=>rej(t.error)});db.close();
    }""")
    b.evaluate("async()=>{await saveRead(11);await fast()}")
    a.evaluate("fast()")
    checks["embedded_legacy_position_cannot_revive"] = a.evaluate("async()=>((await storage.getAllBooks()).find(b=>b.id===bookId)).readingPosition.sentenceIndex") == 11

    # 单条损坏的队列记录显式报错，拉取和下一次真正阅读仍可继续。
    a.evaluate("""async()=>{
      const entry=await journal();const db=await new Promise(res=>{const r=indexedDB.open('moting-reader',6);r.onsuccess=()=>res(r.result)});
      await new Promise((res,rej)=>{const t=db.transaction('sync-progress','readwrite');t.objectStore('sync-progress').put(
        {...entry,data:JSON.stringify({position:{sentenceId:'broken'},savedAt:Date.now(),lastOpenedAt:Date.now()}),
          pending:true,mutationId:crypto.randomUUID()});t.oncomplete=res;t.onerror=()=>rej(t.error)});db.close();await fast();
    }""")
    checks["invalid_progress_is_reported"] = a.evaluate("async()=>Boolean((await journal()).rejection)")
    b.evaluate("async()=>{await saveRead(12);await fast()}")
    a.evaluate("fast()")
    checks["invalid_progress_does_not_block_pull"] = a.evaluate("read()") == 12
    a.evaluate("async()=>{await saveRead(13);await fast()}")
    b.evaluate("fast()")
    checks["new_reading_replaces_invalid_progress"] = b.evaluate("read()") == 13 and a.evaluate("async()=>!(await journal()).rejection && !(await journal()).pending")

    # 删除后迟到的本地保存不会重新创建位置或待传记录。
    checks["deleted_book_ignores_delayed_position"] = a.evaluate("""async()=>{
      const id=bookId+'-blocked';await storage.removeBook(id,{tombstone:false});
      const saved=await storage.saveReadingPositions([{bookId:id,position:pos(14),savedAt:Date.now(),lastOpenedAt:Date.now()}],{local:true});
      return saved.length===0 && !(await storage.getProgressQueue()).some(e=>e.key===id);
    }""")

    for context in contexts:
        context.close()
    browser.close()
    (OUT / "checks.json").write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(checks, ensure_ascii=False, indent=2))
    assert all(checks.values()), "sync progress regression failed"
