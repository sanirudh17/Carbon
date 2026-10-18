import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';

test('image selection never exposes loading alt text, stale images, or duplicate fallback loads', async () => {
  const win = new Window();
  globalThis.window = win;
  globalThis.document = win.document;
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const images = [];
  globalThis.Image = class {
    constructor() { images.push(this); }
    decode() { return new Promise((resolve, reject) => { this.decoded = resolve; this.decodeFailed = reject; }); }
  };
  const calls = [];
  globalThis.__imageInvoke = async (command, args) => {
    calls.push({ command, args });
    return 'data:image/png;base64,fixture';
  };
  let source = fs.readFileSync(new URL('../src/components/ImagePreview.tsx', import.meta.url), 'utf8')
    .replace("import { convertFileSrc, invoke } from '@tauri-apps/api/core';", "const convertFileSrc = path => 'asset:' + path; const invoke = globalThis.__imageInvoke;");
  let js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText;
  js = js.replaceAll('from "react/jsx-runtime"', `from '${import.meta.resolve('react/jsx-runtime')}'`)
    .replaceAll("from 'react'", `from '${import.meta.resolve('react')}'`);
  const { ImagePreview } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const select = id => React.act(async () => root.render(React.createElement(ImagePreview, { item: { id, image_path: id + '.png' } })));
  const finish = async image => {
    const loaded = image.onload();
    await Promise.resolve();
    image.decoded();
    await loaded;
  };
  try {
    await select('a');
    assert.equal(container.querySelector('img'), null);
    assert.equal(container.textContent, '', 'loading must not flash a placeholder or alt text');
    const loadingA = images[0].onload();
    await Promise.resolve();
    assert.equal(container.querySelector('img'), null, 'loaded bytes are not yet decoded pixels');
    await select('b');
    await React.act(async () => { images[0].decoded(); await loadingA; });
    assert.equal(container.querySelector('img'), null, 'late decode must not paint the previous clip');
    await React.act(async () => finish(images[1]));
    assert.equal(container.querySelector('img').getAttribute('src'), 'asset:b.png');
    assert.equal(calls.length, 0, 'a successful asset must never be replaced with another source');
    await select('c');
    assert.equal(container.querySelector('img'), null, 'the previous image is removed synchronously');
    await React.act(async () => images[2].onerror());
    assert.equal(calls.length, 1);
    assert.equal(container.querySelector('img'), null, 'fallback stays hidden until decoded');
    await React.act(async () => finish(images[3]));
    assert.equal(container.querySelector('img').getAttribute('src'), 'data:image/png;base64,fixture');
    await select('d');
    await React.act(async () => images[4].onerror());
    await React.act(async () => images[5].onerror());
    assert.equal(container.querySelector('img'), null, 'failed images never expose browser broken-image UI');
    assert.equal(container.textContent, 'Image preview unavailable.');
    assert.equal(calls.length, 2, 'one fallback per failed selection, without retry loops');
  } finally {
    await React.act(async () => root.unmount());
    await win.happyDOM.abort();
    delete globalThis.Image;
    delete globalThis.__imageInvoke;
  }
});
