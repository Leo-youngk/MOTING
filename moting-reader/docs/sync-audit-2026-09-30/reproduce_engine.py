"""同步审计诊断；输出观测值，退出码 0 不代表功能正确。
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

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "outputs" / "sync-audit"
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173").rstrip("/")
address = urlsplit(BASE)
if address.scheme not in ("http", "https") or address.hostname not in ("127.0.0.1", "localhost", "::1"):
    raise ValueError("诊断仅允许 loopback 地址；禁止连接生产服务。")
OUT.mkdir(parents=True, exist_ok=True)
env = {}
for line in (ROOT / '.dev.vars').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1)
        env[key.strip()] = value.strip().strip('\"').strip("'")

JS_INIT = """async ({ username, password, bookId }) => {
    window.auditSync = await import('/lib/sync.ts');
    window.auditStorage = await import('/lib/storage.ts');
    window.auditBookId = bookId;
    await window.auditSync.loginSync(username, password, new AbortController().signal);
    window.auditRun = () => window.auditSync.runSync({ signal: new AbortController().signal });
    window.auditPosition = (sentenceIndex, updatedAt) => ({ chapterId: 'audit-chapter', chapterIndex: 0,
        sentenceId: 'audit-s-' + sentenceIndex, sentenceIndex, percent: sentenceIndex * 10, updatedAt });
    return true;
}"""

with sync_playwright() as pw:
    browser = pw.chromium.launch(channel='msedge', headless=True)
    contexts = [browser.new_context() for _ in range(2)]
    pages = [context.new_page() for context in contexts]
    book_id = 'audit-engine-' + str(int(time.time() * 1000))
    for page in pages:
        page.goto(BASE + '/manifest.webmanifest')
        page.evaluate(JS_INIT, {'username': env['SYNC_USERNAME'], 'password': env['SYNC_PASSWORD'], 'bookId': book_id})
    a, b = pages
    a.evaluate("""async () => {
        const book = { id: auditBookId, title: '同步审计隔离样本', author: '测试', format: 'txt',
            accent: '#8a8f98', status: 'ready', createdAt: Date.now() - 1000,
            updatedAt: Date.now() - 1000, lastOpenedAt: Date.now() - 1000, sentenceCount: 10, characterCount: 40,
            chapters: [{ id: 'audit-chapter', title: '测试章', order: 0, sentenceCount: 10, characterCount: 40,
                paragraphs: [{ id: 'audit-p', kind: 'text', order: 0, sentences:
                    Array.from({length:10}, (_, i) => ({ id:'audit-s-'+i, text:'测试正文', speakableText:'测试正文', order:i })) }]}] };
        await auditStorage.saveBook(book);
        const t = Date.now() - 1000;
        await auditStorage.saveReadingPositions([{bookId:auditBookId,position:auditPosition(1,t),lastOpenedAt:t,savedAt:t}]);
        await auditRun();
    }""")
    b.evaluate('auditRun()')
    report = {}

    # UI keeps positions in memory for 2.5s/20s; this calls the actual engine before that deferred persistence.
    report['delayed_reading_flush'] = a.evaluate("""async () => {
        const savedAt = Date.now();
        const pending = {bookId:auditBookId,position:auditPosition(4,savedAt),lastOpenedAt:savedAt,savedAt};
        await new Promise(resolve=>setTimeout(resolve,20));
        await auditRun();
        await auditStorage.saveReadingPositions([pending]);
        const state = await auditStorage.getSyncState();
        const next = await auditSync.collectPushPayload(state);
        await auditRun();
        return { local_sentence:4, savedAt, pushedAt:state.pushedAt, skipped_by_watermark:savedAt<=state.pushedAt,
                 appears_in_next_push:(next.positions??[]).some(item=>item.key===auditBookId) };
    }""")
    b.evaluate('auditRun()')
    report['delayed_reading_flush']['peer_sentence'] = b.evaluate("""async()=>{
        const rows=await auditStorage.getAllReadingPositions();
        return rows.find(row=>row.bookId===auditBookId)?.position?.sentenceIndex;
    }""")

    report['delayed_listening_flush'] = a.evaluate("""async()=>{
        const updatedAt=Date.now(); const pending=auditPosition(5,updatedAt);
        await new Promise(resolve=>setTimeout(resolve,20));
        await auditRun();
        await auditStorage.updateBookMeta(auditBookId,{listeningPosition:pending,updatedAt});
        const state=await auditStorage.getSyncState();const next=await auditSync.collectPushPayload(state);
        await auditRun();
        return {local_sentence:5,updatedAt,pushedAt:state.pushedAt,skipped_by_watermark:updatedAt<=state.pushedAt,
                appears_in_next_push:(next.listening??[]).some(item=>item.key===auditBookId)};
    }""")
    b.evaluate('auditRun()')
    report['delayed_listening_flush']['peer_sentence'] = b.evaluate("""async()=>{
        return (await auditStorage.getBookMeta(auditBookId))?.listeningPosition?.sentenceIndex??null;
    }""")

    a.evaluate("""()=>{window.oldPending=auditPosition(2,Date.now()-1000)}""")
    b.evaluate("""async()=>{
        await auditStorage.updateBookMeta(auditBookId,{listeningPosition:auditPosition(8,Date.now())});
        await auditRun();
    }""")
    a.evaluate('auditRun()')
    report['listening_overwrite_after_pull'] = a.evaluate("""async()=>{
        const before=(await auditStorage.getBookMeta(auditBookId)).listeningPosition;
        await auditStorage.updateBookMeta(auditBookId,{listeningPosition:oldPending,updatedAt:oldPending.updatedAt});
        const after=(await auditStorage.getBookMeta(auditBookId)).listeningPosition;
        await auditRun();
        const afterNextSync=(await auditStorage.getBookMeta(auditBookId)).listeningPosition;
        return {remote_before:before.sentenceIndex,stale_after:after.sentenceIndex,
                after_next_sync:afterNextSync.sentenceIndex,old_timestamp_overwrote_new:after.updatedAt<before.updatedAt};
    }""")

    # A clock moved backwards: a real later write disappears from scans based on wall-clock pushedAt.
    report['clock_rollback'] = a.evaluate("""async()=>{
        const nativeNow=Date.now;
        const before=await auditStorage.getSyncState();
        Date.now=()=>nativeNow()-600_000;
        try {
            const at=Date.now();const pending={bookId:auditBookId,position:auditPosition(7,at),lastOpenedAt:at,savedAt:at};
            await auditStorage.saveReadingPositions([pending]);
            const stored=(await auditStorage.getAllReadingPositions()).find(row=>row.bookId===auditBookId);
            const next=await auditSync.collectPushPayload(await auditStorage.getSyncState());
            return {captured_at:at,pushedAt:before.pushedAt,attempted_sentence:7,stored_sentence:stored?.position?.sentenceIndex,
                    appears_in_next_push:(next.positions??[]).some(item=>item.key===auditBookId)};
        } finally {Date.now=nativeNow}
    }""")

    # Catching up progress waits behind R2 uploads even though both are unrelated.
    c = browser.new_context().new_page()
    c.goto(BASE+'/manifest.webmanifest')
    c.evaluate(JS_INIT, {'username':env['SYNC_USERNAME'],'password':env['SYNC_PASSWORD'],'bookId':book_id})
    c.evaluate("""async()=>{
        const old=await auditStorage.getSettings();
        await auditStorage.saveSettings({...old,aiModel:'audit-seed'});
    }""")
    c.evaluate('auditRun()')
    c.evaluate("""async()=>{
        const pendingId=auditBookId+'-blocked'; const chapters=(await auditStorage.getBook(auditBookId)).chapters;
        await auditStorage.saveBook({id:pendingId,title:'正文失败隔离样本',author:'测试',format:'txt',accent:'#8a8f98',
            status:'ready',createdAt:Date.now(),updatedAt:Date.now(),lastOpenedAt:Date.now(),sentenceCount:10,characterCount:40,chapters});
    }""")
    c.route('**/api/sync/book/*-blocked/content', lambda route: route.fulfill(status=503,content_type='application/json',body='{"error":"isolated audit fault"}'))
    report['partial_success_state'] = c.evaluate("""async()=>{
        const result=await auditRun();const state=await auditStorage.getSyncState();
        return {failedContent:result.failedContent,skipped:result.skipped,pendingContent:state.pendingContent.length,
                reports_completed:result.syncedAt>0,book_still_not_ready:!(await auditStorage.getBookMeta(auditBookId+'-blocked')).syncReadyAt};
    }""")
    c.context.close()
    for context in contexts:
        context.close()
    browser.close()
    (OUT/'engine_reproductions.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
