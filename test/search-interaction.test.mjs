import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';

async function load(relative) {
  let source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText;
  js = js.replaceAll('from "react/jsx-runtime"', `from '${import.meta.resolve('react/jsx-runtime')}'`)
    .replaceAll("from 'react'", `from '${import.meta.resolve('react')}'`);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}#${Math.random()}`);
}

test('literal highlights retain Unicode offsets, merge overlaps and never interpret markup', async () => {
  const { matchRanges } = await load('../src/lib/searchHighlights.ts');
  const text = '😀 CAFÉ cafe\u0301 <tag> compute_index';
  assert.deepEqual(matchRanges(text, 'cafe'), [[3, 7], [8, 13]]);
  assert.deepEqual(matchRanges(text, '<tag> _index'), [[14, 19], [27, 33]]);
  assert.deepEqual(matchRanges('banana', 'ana banana'), [[0, 6]]);
  assert.deepEqual(matchRanges('secret', '   '), []);
});

test('typing coalesces searches, and Enter cannot paste the previous query selection', async () => {
  const win = new Window();
  globalThis.window = win;
  globalThis.document = win.document;
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ContentSearchInput } = await load('../src/components/ContentSearchInput.tsx');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const calls = [];
  let pasted = 0;
  win.addEventListener('keydown', () => pasted++);
  const onSearch = value => calls.push(value);
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
  try {
    await React.act(async () => root.render(React.createElement(ContentSearchInput, { value: '', onSearch, inputRef: null })));
    const input = container.querySelector('input');
    for (const value of ['q', 'qu', 'qua', 'quas', 'quasar']) {
      await React.act(async () => {
        setValue.call(input, value);
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
      });
    }
    assert.equal(input.value, 'quasar');
    assert.equal(calls.length, 0, 'no per-keystroke history work');
    await React.act(async () => input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.deepEqual(calls, ['quasar']);
    assert.equal(pasted, 0, 'Enter with a pending query is consumed');
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.deepEqual(calls, ['quasar'], 'Enter cancels the pending timer');
    await React.act(async () => {
      setValue.call(input, '');
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    });
    assert.deepEqual(calls, ['quasar', ''], 'clearing search must commit immediately');
    await React.act(async () => root.render(React.createElement(ContentSearchInput, { value: '', onSearch, inputRef: null })));
  } finally {
    await React.act(async () => root.unmount());
    await win.happyDOM.abort();
  }
});

test('argument paint waits for settings, two frames, cancellation and throttled-frame fallback', async () => {
  const win = new Window();
  globalThis.window = win;
  globalThis.document = win.document;
  const frames = new Map();
  let id = 0;
  globalThis.requestAnimationFrame = cb => { frames.set(++id, cb); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const frame = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(cb => cb()); };
  const { schedulePromptPaint } = await load('../src/lib/promptPaint.ts');
  let acks = 0;
  try {
    document.documentElement.dataset.settingsReady = '0';
    const cancel = schedulePromptPaint(() => acks++);
    frame(); frame();
    assert.equal(acks, 0);
    document.documentElement.dataset.settingsReady = '1';
    await new Promise(resolve => setTimeout(resolve, 25));
    frame(); assert.equal(acks, 0);
    frame(); assert.equal(acks, 1);
    cancel();
    const cancelled = schedulePromptPaint(() => acks++);
    cancelled(); frame(); frame();
    assert.equal(acks, 1);
    const fallback = schedulePromptPaint(() => acks++);
    await new Promise(resolve => setTimeout(resolve, 185));
    assert.equal(acks, 2, 'a cloaked webview cannot deadlock the prompt');
    fallback();
  } finally { await win.happyDOM.abort(); }
});
