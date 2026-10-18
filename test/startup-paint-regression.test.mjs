import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';

async function harness() {
  const win = new Window();
  globalThis.window = win;
  globalThis.document = win.document;
  Object.defineProperty(document, 'readyState', { value: 'complete' });
  document.body.innerHTML = '<div id="root" data-carbon-layout-root></div>';
  document.documentElement.classList.add('wm-hidden');
  document.documentElement.dataset.painted = '1';
  let next = 0;
  const callbacks = new Map();
  globalThis.requestAnimationFrame = cb => { callbacks.set(++next, cb); return next; };
  globalThis.cancelAnimationFrame = id => callbacks.delete(id);
  const calls = [];
  globalThis.__paintInvoke = async (command, args) => { calls.push({ command, args }); };
  const source = fs.readFileSync(new URL('../src/lib/choreo.ts', import.meta.url), 'utf8')
    .replace("import { invoke } from '@tauri-apps/api/core';", 'const invoke = globalThis.__paintInvoke;')
    .replace("import { listen } from '@tauri-apps/api/event';", 'const listen = async () => () => {};')
    .replace('  initCompositorHeartbeat();', '  // No background heartbeat in the controlled-frame harness.');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const choreo = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}#${Math.random()}`);
  return {
    choreo, calls,
    async frame() {
      const frame = [...callbacks.values()];
      callbacks.clear();
      for (const cb of frame) await cb(performance.now());
    },
    close() { win.happyDOM.abort(); },
  };
}

test('mount paint cannot overwrite a cold content hold', async () => {
  const h = await harness();
  try {
    document.documentElement.dataset.coldhold = '1';
    h.choreo.initPaintGate();
    await h.frame();
    await h.frame();
    assert.equal(document.documentElement.dataset.painted, '0');
  } finally { h.close(); }
});

for (const label of ['overlay', 'main']) {
  test(`${label} waits for settings and submits unhidden frames before native reveal`, async () => {
    const h = await harness();
    try {
      const html = document.documentElement;
      html.dataset.settingsReady = '0';
      h.choreo.executeWindowShow(label, undefined, 0, 42);
      for (let i = 0; i < 4; i++) await h.frame();
      assert.equal(html.classList.contains('wm-hidden'), true);
      assert.equal(h.calls.some(c => c.command.endsWith('_painted')), false);
      html.dataset.settingsReady = '1';
      await h.frame();
      assert.equal(html.classList.contains('wm-hidden'), false);
      await h.frame();
      assert.equal(h.calls.some(c => c.command.endsWith('_painted')), false);
      await h.frame();
      const ack = h.calls.find(c => c.command === (label === 'overlay' ? 'overlay_painted' : 'enlarged_painted'));
      assert.equal(ack?.args.token, 42);
    } finally { h.close(); }
  });
}

test('cancel during compositor submission cannot reveal a stale show', async () => {
  const h = await harness();
  try {
    const cancel = h.choreo.executeWindowShow('overlay', undefined, 0, 7);
    await h.frame();
    await h.frame();
    cancel();
    await h.frame();
    await h.frame();
    assert.equal(h.calls.some(c => c.command === 'overlay_painted'), false);
  } finally { h.close(); }
});

test('subsequent overlay opens keep the original single submission-frame timing', async () => {
  const h = await harness();
  try {
    h.choreo.executeWindowShow('overlay', undefined, 0, 1);
    for (let i = 0; i < 4; i++) await h.frame();
    h.choreo.executeWindowShow('overlay', undefined, 0, 2);
    for (let i = 0; i < 3; i++) await h.frame();
    assert.deepEqual(h.calls.filter(c => c.command === 'overlay_painted').map(c => c.args.token), [1, 2]);
  } finally { h.close(); }
});
