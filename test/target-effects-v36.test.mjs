import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ADDENDUM v36 D — target effects.
// D1: copy cursor for supported payloads, no-drop otherwise; target visual
//     state fully cleared after drop/cancel (no leftover highlight).
// D2: restore only via the restore thread; SetForegroundWindow rejections
//     logged; no taskbar flash, no activation flicker.
// D3: overlay list rows — hover = fill bump only; selected = ring + fill;
//     no leftover outline anywhere.

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

function ruleFor(css, needle) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  let fallback = null;
  while ((m = re.exec(css)) !== null) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (sels.some((s) => s === needle)) return m[2];
    if (!fallback && sels.some((s) => s.endsWith(' ' + needle))) fallback = m[2];
  }
  if (fallback) return fallback;
  assert.fail(`CSS rule not found for ${needle}`);
}

test('D1 collection targets gate cursor + highlight on supported payloads', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'),
    'utf8'
  );
  assert.ok(src.includes('isSupportedCollectionDrop'), 'drop targets must classify payloads');
  assert.ok(src.includes("dropEffect = 'none'"), 'unsupported payloads must get the no-drop cursor');
  // Unsupported must never preventDefault (native no-drop cursor) nor highlight.
  const gateUses = (src.match(/if \(!isSupportedCollectionDrop\(e\)\)/g) || []).length;
  assert.ok(gateUses >= 4, `all collection enter/over handlers gated (found ${gateUses})`);
});

test('D1 drop/cancel clears every highlight (no leftover state)', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'),
    'utf8'
  );
  assert.ok(src.includes('onDrop={async (e) => {'), 'collection drop handler exists');
  const dropIdx = src.indexOf('onDrop={async (e) => {');
  const dropTail = src.slice(dropIdx, dropIdx + 400);
  assert.ok(dropTail.includes('setDropTargetColId(null)'), 'drop must clear the highlight first');
  assert.ok(
    /setDropTargetColId\(null\);\r?\n\s*window\.__carbonDraggingClipIds = null;\r?\n\s*\}\);/.test(src),
    'cancelled native drag (Esc: no drop/dragleave) must clear the highlight');
});

test('D2 restore goes only through the restore thread; rejections logged', () => {
  const paste = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'paste.rs'),
    'utf8'
  );
  assert.ok(paste.includes('SetForegroundWindow REJECTED'), 'FG rejections must be logged');
  assert.ok(paste.includes('after 8 attempts'), 'exhausted restore must be logged');
  const hotkey = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'),
    'utf8'
  );
  const lib = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'lib.rs'),
    'utf8'
  );
  const choreo = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'choreo.rs'),
    'utf8'
  );
  // (strip comments: docs name the API they forbid.)
  const code = (s) => s.replace(/\/\/.*$/gm, '');
  for (const [name, s] of [['hotkey.rs', hotkey], ['lib.rs', lib], ['choreo.rs', choreo], ['paste.rs', paste]]) {
    assert.doesNotMatch(code(s), /FlashWindow/, `${name} must never flash the taskbar`);
  }
  // Hide paths restore via the single choke point (which spawns the thread).
  assert.ok(hotkey.includes('restore_target_window()'), 'hide must restore via the restore thread');
});

test('D3 overlay rows: hover fill-only, selected ring+fill, no outline', () => {
  const css = stripComments(
    fs.readFileSync(path.join(ROOT_DIR, 'src', 'index.css'), 'utf8')
  );
  const hover = ruleFor(css, '.row:hover');
  assert.doesNotMatch(hover, /box-shadow/, 'hover must be a fill bump only (no ring)');
  assert.doesNotMatch(hover, /outline/, 'hover must have no outline');
  const selected = ruleFor(css, '.row.selected');
  assert.ok(selected.includes('inset 0 0 0 1px'), 'selected keeps the existing inset ring');
  assert.ok(selected.includes('accent-soft') || selected.includes('background'),
    'selected keeps the existing fill token');
  const base = ruleFor(css, '.row');
  assert.doesNotMatch(base, /outline/, 'rows must carry no outline anywhere');
});
