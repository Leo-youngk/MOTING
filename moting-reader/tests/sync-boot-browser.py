"""同步启动离线恢复回归；验证有效会话恢复。
只可连接已初始化、使用隔离存储的本地开发服务，会写入测试数据。
用法：python 本文件.py [http://127.0.0.1:5173]
依赖：Python Playwright、Edge、项目 tests 目录和本地 .dev.vars。
"""
import json
import pathlib
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs" / "sync-regressions"
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173").rstrip("/")
address = urlsplit(BASE)
if address.scheme not in ("http", "https") or address.hostname not in ("127.0.0.1", "localhost", "::1"):
    raise ValueError("诊断仅允许 loopback 地址；禁止连接生产服务。")
OUT.mkdir(parents=True, exist_ok=True)
env={}
for line in (ROOT/'.dev.vars').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        key,value=line.split('=',1)
        env[key.strip()]=value.strip().strip('\"').strip("'")

with sync_playwright() as pw:
    browser=pw.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':390,'height':844})
    page=context.new_page()
    page.goto(BASE + '/manifest.webmanifest')
    page.evaluate("""async credentials=>{
        const sync=await import('/lib/sync.ts');
        await sync.loginSync(credentials.username,credentials.password,new AbortController().signal);
    }""",{'username':env['SYNC_USERNAME'],'password':env['SYNC_PASSWORD']})
    requests=[]
    page.on('request',lambda r:requests.append(r.url.split('/api/sync/')[-1]) if '/api/sync/' in r.url else None)
    page.route('**/api/sync/session',lambda route:route.fulfill(status=503,content_type='application/json',body='{"error":"isolated boot outage"}'))
    page.goto(BASE + '/')
    page.wait_for_load_state('networkidle')
    page.get_by_role('button',name='主页').click()
    page.get_by_role('button',name='设置').click()
    page.locator('.settings-link',has_text='云端同步').click()
    page.locator('.settings-note',has_text='正在恢复同步连接').wait_for()
    page.unroute('**/api/sync/session')
    before=len(requests)
    page.evaluate("window.dispatchEvent(new Event('online'))")
    page.locator('.settings-status').wait_for(timeout=8000)
    page.wait_for_timeout(500)
    after=requests[before:]
    server=page.evaluate("async()=>await(await fetch('/api/sync/session',{credentials:'same-origin',cache:'no-store'})).json()")
    report={'session_requests_at_boot':requests[:before],'requests_after_online':after,
            'login_form_still_shown':page.locator('.sync-login').is_visible(),'server_session_connected':server.get('connected')}
    context.close()
    browser.close()
    (OUT/'boot_recovery_reproduction.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))

checks={
  'boot_session_rechecked': 'session' in report['requests_after_online'],
  'valid_cookie_reconnects':report['server_session_connected'] and not report['login_form_still_shown'],
}
(OUT/'boot-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':all(checks.values()),'checks':checks},ensure_ascii=False))
assert all(checks.values()),'boot recovery regression failed'
