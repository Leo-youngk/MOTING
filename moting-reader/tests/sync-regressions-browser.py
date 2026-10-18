"""同步调度回归；验证持续阅读和网络恢复。
只可连接已初始化、使用隔离存储的本地开发服务，会写入测试数据。
用法：python 本文件.py [http://127.0.0.1:5173]
依赖：Python Playwright、Edge、项目 tests 目录和本地 .dev.vars。
"""
import json
import pathlib
import sys
import time
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs" / "sync-regressions"
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173").rstrip("/")
address = urlsplit(BASE)
if address.scheme not in ("http", "https") or address.hostname not in ("127.0.0.1", "localhost", "::1"):
    raise ValueError("诊断仅允许 loopback 地址；禁止连接生产服务。")
OUT.mkdir(parents=True, exist_ok=True)
namespace = {'__file__': str(ROOT/'tests'/'sync-timing-browser.py'), '__name__': 'audit_helpers'}
helpers = (ROOT/'tests'/'sync-timing-browser.py').read_text(encoding='utf-8').split('with sync_playwright() as playwright:')[0]
exec(compile(helpers, namespace['__file__'], 'exec'), namespace)
book = namespace['make_book']()
book_id = book['id']


def get_state(page):
    return namespace['state'](page)


def wait_synced(page, previous):
    page.wait_for_function("""async before=>{
        const db=await new Promise(res=>{const r=indexedDB.open('moting-reader');r.onsuccess=()=>res(r.result)});
        const state=await new Promise(res=>{const r=db.transaction('settings').objectStore('settings').get('sync:state');r.onsuccess=()=>res(r.result)});
        db.close();return state?.pushedAt>before && ![...document.querySelectorAll('button')].some(b=>b.textContent==='同步中…');
    }""", arg=previous, timeout=40000)


with sync_playwright() as pw:
    browser=pw.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':390,'height':844})
    page=context.new_page()
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    namespace['seed'](page,book)
    namespace['login'](page)
    wait_synced(page,0)
    requests=[]
    page.on('request',lambda request:requests.append({'at_ms':int(time.time()*1000),'path':request.url.split('/api/sync/')[-1]}) if '/api/sync/' in request.url else None)
    report={}

    # Failure must not suppress a retry on a network recovery event.
    page.route('**/api/sync/pull',lambda route:route.fulfill(status=503,content_type='application/json',body='{"error":"isolated network outage"}'))
    page.get_by_role('button',name='立即同步').click()
    page.locator('.settings-error',has_text='isolated network outage').wait_for()
    page.get_by_role('button',name='立即同步').wait_for()
    page.unroute('**/api/sync/pull')
    before=len([r for r in requests if r['path']=='pull'])
    page.evaluate("window.dispatchEvent(new Event('online'))")
    page.wait_for_timeout(1500)
    after=len([r for r in requests if r['path']=='pull'])
    report['network_recovery']={'pulls_before_online':before,'pulls_after_online':after,
                                               'retried':after>before}
    previous=get_state(page)['pushedAt']
    page.get_by_role('button',name='立即同步').click()
    wait_synced(page,previous)
    namespace['back_to_library'](page)
    page.get_by_placeholder('搜索书名或作者').fill(book['title'])
    page.locator('article button',has_text=book['title']).first.click()
    page.locator('.reader-article').wait_for()
    page.wait_for_timeout(11_000)

    # Actual UI callback creates a pending reading write; pageshow invokes full sync before the 2.5s flush.
    before=get_state(page)['pushedAt']
    page.evaluate("""()=>{
        const e=document.querySelector('[data-sentence-id="s0-15-0"]');
        window.dispatchEvent(new Event('wheel'));
        window.scrollBy(0,e.getBoundingClientRect().top-150);
    }""")
    page.wait_for_function("id=>{const value=JSON.parse(localStorage.getItem('moting:pos:'+id)||'null');return value?.sentenceIndex>=40}",arg=book_id,timeout=15000)
    page.evaluate("window.dispatchEvent(new Event('pageshow'))")
    wait_synced(page,before)
    page.wait_for_timeout(3000)
    result=page.evaluate("""async bookId=>{
        const storage=await import('/lib/storage.ts');const sync=await import('/lib/sync.ts');
        const position=(await storage.getAllReadingPositions()).find(entry=>entry.bookId===bookId);
        const state=await storage.getSyncState();const payload=await sync.collectPushPayload(state);
        const remote=await(await fetch('/api/sync/pull',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({since:0,progressOnly:true})})).json();
        const cloud=remote.positions.find(row=>row.key===bookId);
        const journal=(await storage.getProgressQueue()).find(row=>row.key===bookId&&row.kind==='positions');
        return {sentence:position?.position?.sentenceIndex,savedAt:position?.savedAt,pushedAt:state.pushedAt,
                 appears_in_next_push:(payload.positions??[]).some(row=>row.key===bookId),remote_sentence:cloud?.data?.position?.sentenceIndex,pending:journal?.pending};
    }""",book_id)
    report['actual_reading_flush_watermark']=result

    # Keep reading every five seconds for more than the 30s debounce. No maxWait exists.
    start=len(requests)
    started_ms=int(time.time()*1000)
    for step in range(8):
        page.evaluate("()=>{window.dispatchEvent(new Event('wheel'));window.scrollBy(0,180)}")
        page.wait_for_timeout(5000)
    during=requests[start:]
    report['continuous_reading']={'duration_seconds':round((int(time.time()*1000)-started_ms)/1000,2),
                                                    'requests':during,'push_count':sum(r['path']=='push' for r in during),
                                                    'pull_count':sum(r['path']=='pull' for r in during)}
    page.screenshot(path=str(OUT/'ui-reproduction.png'))
    context.close()
    browser.close()
    (OUT/'ui_reproductions.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))

checks={
    'network_recovery_retries':report['network_recovery']['retried'],
    'latest_reading_uploaded':report['actual_reading_flush_watermark']['remote_sentence']==report['actual_reading_flush_watermark']['sentence'] and not report['actual_reading_flush_watermark']['pending'],
    'continuous_reading_syncs':report['continuous_reading']['push_count']>=4,
}
(OUT/'ui-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':all(checks.values()),'checks':checks},ensure_ascii=False))
assert all(checks.values()),'UI sync regression failed'
