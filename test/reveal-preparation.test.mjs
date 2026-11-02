import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
const require=createRequire(import.meta.url),esbuild=require('esbuild');
const bundle=esbuild.buildSync({entryPoints:['src/lib/choreo.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const file=new URL('../.validation/choreo-reveal-test.cjs',import.meta.url);fs.writeFileSync(file,bundle);
const {executeWindowShow,getFadeTarget,initCompositorHeartbeat}=require(file.pathname.replace(/^\/(.:\/)/,'$1'));
process.on('exit',()=>{try{fs.unlinkSync(file)}catch{}});
function setup(){
 const win=new Window();globalThis.window=win;globalThis.document=win.document;
 document.body.innerHTML='<div id="root" class="wm-fade-target"><div data-carbon-layout-root></div></div>';
 Object.defineProperty(document,'readyState',{value:'complete',configurable:true});
 document.documentElement.classList.add('wm-hidden');document.documentElement.dataset.painted='1';document.documentElement.dataset.settingsReady='1';
 let next=0,resolvePrepare,failNextReveal=false;const frames=new Map(),calls=[];
 globalThis.requestAnimationFrame=fn=>{frames.set(++next,fn);return next};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 window.__TAURI_INTERNALS__={invoke:(command,args)=>{calls.push({command,args});if(command==='prepare_window_present')return new Promise(r=>resolvePrepare=r);if((command==='overlay_painted'||command==='enlarged_painted')&&failNextReveal){failNextReveal=false;return Promise.resolve(false);}return Promise.resolve(true);}};
 return {calls,pendingFrames:()=>frames.size,failNextReveal:()=>{failNextReveal=true},resolve:value=>resolvePrepare(value),frame:async()=>{const pending=[...frames.values()];frames.clear();for(const fn of pending)void fn(0);await new Promise(r=>setImmediate(r));},cleanup:()=>{win.happyDOM.abort();delete globalThis.window;delete globalThis.document;}};
}
test('native preparation completes before unhide; cold and idle opens both paint a fresh full frame',async()=>{
 const h=setup();try{for(const token of [1,2]){
  h.calls.length=0;let revealed=0;const cancel=executeWindowShow('overlay',()=>revealed++,0,token);
  await h.frame();await h.frame();assert(h.calls.some(c=>c.command==='prepare_window_present'));assert(document.documentElement.classList.contains('wm-hidden'));
  h.resolve(true);await new Promise(r=>setImmediate(r));assert(!document.documentElement.classList.contains('wm-hidden'));
  await h.frame();assert(!h.calls.some(c=>c.command==='overlay_painted'));
  await h.frame();assert.equal(h.calls.filter(c=>c.command==='overlay_painted').length,1);assert.equal(revealed,1);cancel();
 }}finally{h.cleanup()}
});
test('late native preparation cannot reveal a cancelled show',async()=>{
 const h=setup();try{const cancel=executeWindowShow('main',undefined,0,4);await h.frame();await h.frame();cancel();h.resolve(true);await h.frame();await h.frame();assert(document.documentElement.classList.contains('wm-hidden'));assert(!h.calls.some(c=>c.command==='enlarged_painted'));}finally{h.cleanup()}
});
test('failed native preparation remains hidden and asks for safe recovery',async()=>{
 const h=setup();try{executeWindowShow('main',undefined,0,5);await h.frame();await h.frame();h.resolve(false);await h.frame();await h.frame();h.resolve(false);await h.frame();assert(document.documentElement.classList.contains('wm-hidden'));assert.equal(h.calls.find(c=>c.command==='choreo_show_recovery')?.args.token,5);assert(!h.calls.some(c=>c.command==='enlarged_painted'));}finally{h.cleanup()}
});
test('both themes and materials fade content, never the document backing',()=>{
 const h=setup();try{for(const theme of ['dark','light'])for(const material of ['glass','solid']){document.documentElement.dataset.theme=theme;document.documentElement.dataset.material=material;assert.equal(getFadeTarget(),document.getElementById('root'));}}finally{h.cleanup()}
});

test('lost native handoff retries preparation and paint before becoming interactable',async()=>{
 const h=setup();try{
  let revealed=0;h.failNextReveal();executeWindowShow('overlay',()=>revealed++,0,9);
  await h.frame();await h.frame();h.resolve(true);await new Promise(r=>setImmediate(r));
  await h.frame();await h.frame();assert.equal(revealed,0);assert(document.documentElement.classList.contains('wm-hidden'));
  await h.frame();h.resolve(true);await new Promise(r=>setImmediate(r));await h.frame();await h.frame();
  assert.equal(revealed,1);assert.equal(h.calls.filter(c=>c.command==='prepare_window_present').length,2);
  assert.equal(h.calls.filter(c=>c.command==='overlay_painted').length,2);assert(!h.calls.some(c=>c.command==='choreo_show_recovery'));
 }finally{h.cleanup()}
});

test('compositor wake pulses stop after two frames and coalesce repeated focus events',async()=>{
 const h=setup();try{
  initCompositorHeartbeat();assert.equal(h.pendingFrames(),1);
  await h.frame();assert.equal(h.pendingFrames(),1);await h.frame();assert.equal(h.pendingFrames(),0);
  await h.frame();assert.equal(h.pendingFrames(),0);
  window.dispatchEvent(new window.Event('focus'));window.dispatchEvent(new window.Event('focus'));
  assert.equal(h.pendingFrames(),1);await h.frame();await h.frame();assert.equal(h.pendingFrames(),0);
 }finally{h.cleanup()}
});
