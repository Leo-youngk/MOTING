import test from 'node:test';
import assert from 'node:assert/strict';
import { continuousAhead, missingInterval, appendWithRecovery } from '../public/mms-probe-core.mjs';
const ranges = values => ({length:values.length,start:i=>values[i][0],end:i=>values[i][1]});
const quota = () => Object.assign(new Error('full'), {name:'QuotaExceededError'});

test('future buffered ranges do not hide the hole immediately ahead', () => {
  const r = ranges([[0,60],[120,300]]);
  assert.equal(continuousAhead(r,50),10);
  assert.equal(continuousAhead(r,80),0);
  assert.equal(missingInterval(r,50,200),true);
  assert.equal(missingInterval(r,120,300),false);
  assert.equal(missingInterval(ranges([[120,300]]),120,300),false);
});

test('quota with a stopped playback clock retries and fails within wall-clock deadline', async () => {
  let clock=0, attempts=0, trims=0;
  await assert.rejects(appendWithRecovery(new Uint8Array(100), {
    append:async()=>{attempts++;throw quota();}, trim:async()=>{trims++;},
    wait:async()=>{clock+=1000;}, now:()=>clock, timeout:3000,
  }), /缓冲空间不足/);
  assert.equal(attempts,4);
  assert.equal(trims,4);
});

test('quota splits and retries without omitting or duplicating MP3 bytes', async () => {
  const bytes=Uint8Array.from({length:150000},(_,i)=>i%251);
  const accepted=[];
  await appendWithRecovery(bytes, {
    append:async part=>{if(part.length>20000)throw quota();accepted.push(...part);},
    trim:async()=>{},wait:async()=>{},
  });
  assert.deepEqual(Uint8Array.from(accepted),bytes);
});

test('quota can recover after cleanup without waiting for playback to advance', async () => {
  let full=true, attempts=0;
  await appendWithRecovery(new Uint8Array(100), {
    append:async()=>{attempts++;if(full)throw quota();},
    trim:async()=>{full=false;}, wait:async()=>{},
  });
  assert.equal(attempts,2);
});

test('non-quota decoder failures and closed sources fail immediately', async () => {
  await assert.rejects(appendWithRecovery(new Uint8Array(100), {
    append:async()=>{throw Error('decoder');}, trim:async()=>{},wait:async()=>{},
  }), /decoder/);
  await assert.rejects(appendWithRecovery(new Uint8Array(100), {
    alive:()=>false,append:async()=>{},trim:async()=>{},wait:async()=>{},
  }), /媒体源已关闭/);
});
