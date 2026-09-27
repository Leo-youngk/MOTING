// Run against a local static server for public/: node tests/mms-probe-browser.mjs [url]
// Requires Playwright Chromium and ffmpeg. Synthetic MP3 isolates transport; no iOS claim.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(require.resolve('playwright',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()]}));
const root=mkdtempSync(join(tmpdir(),'mms-probe-'));
const path=join(root,'tone.mp3');
execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=2','-ar','24000','-ac','1','-b:a','48k',path]);
const mp3=readFileSync(path), meta=Buffer.from('[]'), len=Buffer.alloc(4);len.writeUInt32BE(meta.length);
const body=Buffer.concat([len,meta,mp3]);
const browser=await chromium.launch({headless:true, ...(process.env.BROWSER_PATH ? {executablePath:process.env.BROWSER_PATH} : {})});
try {
 for (const mode of ['mms','swap']) {
  const context=await browser.newContext();
  const page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(() => {
   const original=MediaSource.prototype.addSourceBuffer;
   MediaSource.prototype.addSourceBuffer=function(...args){
    const b=original.apply(this,args);window.probeBuffer=b;
    const append=b.appendBuffer.bind(b);let once=true;
    b.appendBuffer=bytes=>{if(once){once=false;throw new DOMException('injected quota','QuotaExceededError');}return append(bytes);};
    return b;
   };
  });
  await page.route('**/api/tts',route=>route.fulfill({status:200,body,contentType:'application/octet-stream'}));
  const base=process.argv[2] || 'http://127.0.0.1:8765';
  await page.goto(base+'/mms-probe.html');
  await page.evaluate(async()=>{
   await new Promise((resolve,reject)=>{
    const r=indexedDB.open('moting-reader',5);
    r.onupgradeneeded=()=>{r.result.createObjectStore('books',{keyPath:'id'});r.result.createObjectStore('contents',{keyPath:'bookId'});};
    r.onerror=()=>reject(r.error);
    r.onsuccess=()=>{
     const db=r.result,t=db.transaction(['books','contents'],'readwrite');
     t.objectStore('books').put({id:'probe',title:'音频交接自动化验证'});
     t.objectStore('contents').put({bookId:'probe',chapters:[{title:'拼接验证',paragraphs:[{sentences:Array.from({length:60},()=>({text:'音频拼接验证。'.repeat(10)}))}]}]});
     t.oncomplete=()=>{db.close();resolve();};
    };
   });
  });
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#chapter').options.length>0);
  await page.selectOption('#mode',mode);
  await page.click('#start');
  if(mode==='mms') {
   await page.waitForFunction(()=>JSON.parse(localStorage.getItem('moting:mms-probe-log')||'[]').filter(e=>e.type==='appended').length>=3);
   await page.evaluate(async()=>{
    const b=window.probeBuffer;
    if(b.updating)await new Promise(r=>b.addEventListener('updateend',r,{once:true}));
    const start=3,end=4;
    await new Promise(r=>{b.addEventListener('updateend',r,{once:true});b.remove(start,end);});
    const e=new Event('bufferedchange');Object.defineProperty(e,'removedRanges',{value:{length:1,start:()=>start,end:()=>end}});b.dispatchEvent(e);
   });
   await page.waitForFunction(()=>JSON.parse(localStorage.getItem('moting:mms-probe-log')||'[]').some(e=>e.type==='repaired'));
   await page.waitForFunction(()=>document.querySelector('audio').currentTime>5,null,{timeout:15000});
  } else {
   await page.waitForFunction(()=>JSON.parse(localStorage.getItem('moting:mms-probe-log')||'[]').filter(e=>e.type==='cache-hit').length>=2,null,{timeout:15000});
  }
  const logs=await page.evaluate(()=>JSON.parse(localStorage.getItem('moting:mms-probe-log')));
  assert.deepEqual(errors,[]);
  assert.equal(logs.some(e=>['run-fail','audio-error','play-reject'].includes(e.type)),false,JSON.stringify(logs.slice(-10)));
  if(mode==='mms'){assert(logs.some(e=>e.type==='quota'));assert(logs.some(e=>e.type==='repaired'));assert.equal(logs.filter(e=>e.type==='play-ok').length,1);}
  console.log(JSON.stringify({mode,passed:true,appended:logs.filter(e=>e.type==='appended').length,repaired:logs.filter(e=>e.type==='repaired').length,cacheHits:logs.filter(e=>e.type==='cache-hit').length}));
  await context.close();
 }
} finally {await browser.close();rmSync(root,{recursive:true,force:true});}
