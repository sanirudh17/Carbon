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
 * Drag-out crash hardening (behavior-preserving): the payload is main's
 * proven set, but a throwing DataTransfer (rejected custom type, quota on
 * huge HTML) must never abort the gesture mid-payload or escape dragstart
 * (both read as blocked-circle-everywhere / dead drags).
 */

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
const bundlePath = path.join(os.tmpdir(), 'carbon-clipdrag-hardened.cjs');
fs.writeFileSync(bundlePath, built.outputFiles[0].text);
const { setClipDragData } = require(bundlePath);

// DataTransfer mock; `failOn` names flavors whose setData throws (hostile
// engine), `failEffect` makes the effectAllowed setter throw.
function mockEvent({ failOn = [], failEffect = false } = {}) {
  const store = {};
  const dt = {
    setData(k, v) {
      if (failOn.includes(k)) throw new Error(`rejected: ${k}`);
      store[k] = String(v);
    },
    getData(k) {
      return store[k] || '';
    },
    store,
  };
  if (failEffect) {
    Object.defineProperty(dt, 'effectAllowed', {
      set() {
        throw new Error('effect denied');
      },
      get() {
        return 'none';
      },
    });
  } else {
    dt.effectAllowed = 'none';
  }
  return { dataTransfer: dt };
}

const base = (over) => ({
  id: 'clip-1',
  title: 'hello',
  content_type: 'text',
  text_content: 'hello',
  html_content: null,
  image_path: null,
  file_paths: null,
  is_sensitive: false,
  ...over,
});

test('drag harden - success path keeps main payload byte-identical', () => {
  const e = mockEvent();
  setClipDragData(e, base({ html_content: '<b>hi</b>' }));
  assert.equal(e.dataTransfer.store['text/plain'], 'hello');
  assert.equal(e.dataTransfer.store['text/html'], '<b>hi</b>');
  assert.equal(e.dataTransfer.store['carbon/clip-ids'], JSON.stringify(['clip-1']));
  assert.equal(e.dataTransfer.effectAllowed, 'all');
});

test('drag harden - rejected custom type cannot starve the rest', () => {
  const e = mockEvent({ failOn: ['carbon/clip-ids', 'application/json'] });
  assert.doesNotThrow(() => setClipDragData(e, base({ html_content: '<b>hi</b>' })));
  assert.equal(e.dataTransfer.store['text/plain'], 'hello');
  assert.equal(e.dataTransfer.store['text/html'], '<b>hi</b>');
});

test('drag harden - total setData failure still returns normally', () => {
  const e = mockEvent({ failOn: ['text/plain', 'application/json', 'carbon/clip-ids', 'text/html', 'text/uri-list'], failEffect: true });
  assert.doesNotThrow(() =>
    setClipDragData(e, base({ content_type: 'image', image_path: 'C:\\x.png', html_content: '<p>x</p>' }))
  );
});

test('drag harden - image/file uri-lists survive a hostile transfer', () => {
  const img = mockEvent({ failOn: ['text/html'] });
  setClipDragData(
    img,
    base({ content_type: 'image', image_path: 'C:\\s.png', text_content: null, html_content: '<p>i</p>' })
  );
  assert.ok(img.dataTransfer.store['text/uri-list'].includes('s.png'));
  const f = mockEvent({ failOn: ['application/json'] });
  setClipDragData(
    f,
    base({ content_type: 'file', file_paths: JSON.stringify(['C:\\a.txt']), text_content: null })
  );
  assert.ok(f.dataTransfer.store['text/uri-list'].includes('file:///C:/a.txt'));
});

test('drag harden - handlers still feed the payload (both windows)', () => {
  for (const file of ['components/QuickOverlay.tsx', 'components/EnlargedWindow.tsx']) {
    const tsx = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    assert.ok(tsx.includes('setClipDragData(e, item'), `${file} must call the payload`);
  }
  const util = fs.readFileSync(path.join(SRC_DIR, 'utils', 'clipDrag.ts'), 'utf8');
  assert.ok(util.includes('if (!dt) return'), 'null transfer must still early-return');
});
