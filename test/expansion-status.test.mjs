import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/lib/expansionStatus.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022}}).outputText;
const {refreshExpansionUntilActive}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
function clock(signal,timeoutMs=1000){let time=0;return {signal,timeoutMs,intervalMs:200,now:()=>time,wait:async ms=>{time+=ms;}};}
test('startup status becomes Active without navigating or an event',async()=>{
 const controller=new AbortController(), values=['off','not_yet_active','active'], seen=[];let reads=0;
 const result=await refreshExpansionUntilActive(async()=>{reads++;return values.shift();},s=>seen.push(s),clock(controller.signal));
 assert.equal(result,'active');assert.equal(reads,3);assert.deepEqual(seen,['off','not_yet_active','active']);
});
test('startup retries transient IPC errors then stops polling once active',async()=>{
 const c=new AbortController();let reads=0;const seen=[];
 assert.equal(await refreshExpansionUntilActive(async()=>{if(++reads===1)throw Error('transient');return 'active';},s=>seen.push(s),clock(c.signal)),'active');
 assert.equal(reads,2);assert.deepEqual(seen,['active']);
});
test('unavailable hook reaches a bounded deadline rather than polling forever',async()=>{
 const c=new AbortController();let reads=0;
 assert.equal(await refreshExpansionUntilActive(async()=>{reads++;return 'not_yet_active';},()=>{},clock(c.signal,600)),'not_yet_active');
 assert.equal(reads,4);
});
test('late replies cannot update an unmounted or disabled Settings view',async()=>{
 const c=new AbortController();let resolve;const seen=[];
 const pending=refreshExpansionUntilActive(()=>new Promise(r=>resolve=r),s=>seen.push(s),clock(c.signal));
 c.abort();resolve('active');await pending;assert.deepEqual(seen,[]);
});
test('abort interrupts the real startup wait without another read',async()=>{
 const c=new AbortController();let reads=0;
 const pending=refreshExpansionUntilActive(async()=>{reads++;queueMicrotask(()=>c.abort());return 'not_yet_active';},()=>{},{signal:c.signal});
 await pending;assert.equal(reads,1);
});
