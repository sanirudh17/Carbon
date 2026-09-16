import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const Module = require('node:module');

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');

/**
 * Drag-out payload contract (DOM path — the ONLY drag path since the native
 * OLE revert). Guards the exact regression reported: empty DataTransfer
 * (blocked circle everywhere). Uses a mock DataTransfer against the REAL
 * bundled clipDrag.ts.
 */

// Stub the Tauri JS bridge (convertFileSrc is sync and pure Kin-translation).
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@tauri-apps/api/core') {
    return {
      convertFileSrc: (p) => `https://asset.localhost/${String(p).replace(/\\/g, '/')}`,
      invoke: async () => 'copy',
    };
  }
  return origLoad.call(this, request, ...rest);
};

const built = esbuild.buildSync({
  entryPoints: [path.join(SRC_DIR, 'utils', 'clipDrag.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['@tauri-apps/api/core'],
  write: false,
});
const bundlePath = path.join(os.tmpdir(), 'carbon-clipdrag-bundle.cjs');
fs.writeFileSync(bundlePath, built.outputFiles[0].text);
const { setClipDragData } = require(bundlePath);

function mockEvent() {
  const store = {};
  return {
    dataTransfer: {
      effectAllowed: 'none',
      setData(k, v) { store[k] = String(v); },
      getData(k) { return store[k] || ''; },
      store,
    },
  };
}

const base = (over) => ({
  id: 'clip-1',
  title: 'hello world',
  content_type: 'text',
  text_content: 'hello world',
  html_content: null,
  image_path: null,
  file_paths: null,
  is_sensitive: false,
  ...over,
});

test('drag payload - text clip sets plain text (Notepad/chat guarantee)', () => {
  const e = mockEvent();
  setClipDragData(e, base({}));
  assert.equal(e.dataTransfer.store['text/plain'], 'hello world');
  assert.equal(e.dataTransfer.effectAllowed, 'all');
});

test('drag payload - every clip carries collection + internal flavors', () => {
  const e = mockEvent();
  setClipDragData(e, base({}), ['a', 'b']);
  assert.equal(e.dataTransfer.store['carbon/clip-ids'], JSON.stringify(['a', 'b']));
  assert.equal(JSON.parse(e.dataTransfer.store['application/json']).clipId, 'clip-1');
});

test('drag payload - NO clip type offers text/html (tab-crash vector)', () => {
  for (const item of [
    base({ html_content: '<b>hi</b>' }),
    base({ content_type: 'code', text_content: 'x();', html_content: '<code>x();</code>' }),
    base({ content_type: 'link', text_content: 'https://example.com', html_content: '<a href="https://example.com">x</a>' }),
  ]) {
    const e = mockEvent();
    setClipDragData(e, item);
    assert.ok(!('text/html' in e.dataTransfer.store), item.content_type + ': must not offer HTML');
    assert.ok(e.dataTransfer.store['text/plain'].length > 0, item.content_type + ': plain text must survive');
  }
});

test('drag payload - link exposes uri-list', () => {
  const e = mockEvent();
  setClipDragData(e, base({ content_type: 'link', text_content: 'https://example.com' }));
  assert.equal(e.dataTransfer.store['text/uri-list'], 'https://example.com');
});

test('drag payload - image exposes asset uri-list (never empty)', () => {
  const e = mockEvent();
  setClipDragData(
    e,
    base({ content_type: 'image', image_path: 'C:\\data\\shot.png', text_content: null })
  );
  assert.ok(
    e.dataTransfer.store['text/uri-list'].includes('shot.png'),
    'image uri-list must reference the file'
  );
  assert.ok(e.dataTransfer.store['text/plain'].length > 0, 'fallback text must never be empty');
});

test('drag payload - file exposes file:/// uri-list for every path', () => {
  const e = mockEvent();
  setClipDragData(
    e,
    base({
      content_type: 'file',
      file_paths: JSON.stringify(['C:\\a.txt', 'D:\\b.png']),
      text_content: null,
    })
  );
  const uris = e.dataTransfer.store['text/uri-list'];
  assert.ok(uris.includes('file:///C:/a.txt'), `must map to file:/// URLs (got ${uris})`);
  assert.ok(uris.includes('file:///D:/b.png'), `must map every path (got ${uris})`);
});

test('drag payload - no clip type may produce an empty transfer', () => {
  const cases = [
    base({}),
    base({ content_type: 'code', text_content: 'const x = 1;' }),
    base({ content_type: 'image', image_path: 'C:\\x.png', text_content: null, title: '' , id: 'i1' }),
    base({ content_type: 'file', file_paths: 'not-json{{{', text_content: null, title: 'f' }),
    base({ text_content: null, title: null, id: 'fallback-id' }),
  ];
  for (const item of cases) {
    const e = mockEvent();
    setClipDragData(e, item);
    assert.ok(
      Object.keys(e.dataTransfer.store).includes('text/plain') &&
        e.dataTransfer.store['text/plain'].length > 0,
      `${item.content_type}/${item.id}: text/plain must always be set (blocks the blocked-circle)`
    );
  }
});

/**
 * Rich-text drag-out is PLAIN TEXT ONLY (no text/html). Full-page capture
 * HTML (deep nesting, data-URL images, sliced tags) crashes target tabs on
 * drop across browsers. Same-window drops resolve via ids/json flavors.
 */

const NASTY_HTML =
  '<div><p>Real words here.</p>' +
  '<table><tr><td><div><span style="color:red">deep</span></div></td></tr></table>' +
  '<img src="data:image/png;base64,' + 'A'.repeat(5000) + '">' +
  '<p>Unclosed slice <b>bold';

test('drag payload - rich_text never offers text/html', () => {
  const e = mockEvent();
  setClipDragData(
    e,
    base({
      content_type: 'rich_text',
      text_content: 'Real words here. deep',
      html_content: NASTY_HTML,
    })
  );
  assert.ok(!('text/html' in e.dataTransfer.store), 'rich_text must not offer HTML');
  assert.equal(e.dataTransfer.store['text/plain'], 'Real words here. deep');
  assert.ok(e.dataTransfer.store['carbon/clip-ids'], 'internal flavors must survive');
});

test('drag payload - retired: HTML flavor removed for all types', () => {
  const e = mockEvent();
  setClipDragData(e, base({ content_type: 'text', html_content: '<b>hi</b>' }));
  assert.ok(!('text/html' in e.dataTransfer.store), 'text must not offer HTML either');
});
