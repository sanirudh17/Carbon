import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const SRC_TAURI_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

/**
 * ADDENDUM v28-B: native OLE drag-and-drop.
 * DOM DataTransfer only offers text flavors; real file/image drops need a
 * genuine DoDragDrop IDataObject (HDROP, descriptors, DIB).
 */

test('v28-B - native drag module owns the OLE surface (and only it)', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'native_drag.rs'), 'utf8');
  for (const token of [
    'IDataObject_Vtbl',
    'IDropSource_Vtbl',
    'IStream_Vtbl',
    'IEnumFORMATETC_Vtbl',
    'DoDragDrop',
    'OleInitialize',
    'OleUninitialize',
  ]) {
    assert.ok(rs.includes(token), `native_drag.rs must implement ${token}`);
  }
  // Hand-rolled vtables (implement! macro is version-poisoned here).
  assert.doesNotMatch(rs, /#\[implement\(/, 'must not use the implement! macro');
  // COPY-only negotiation with a logged violation otherwise.
  assert.ok(rs.includes('DROPEFFECT_COPY'), 'drag must allow COPY');
  assert.ok(rs.includes('circle-slash') || rs.includes('COPY-only'), 'COPY-only rationale documented');
  assert.ok(
    rs.includes("VIOLATION: drop settled with effect="),
    'non-COPY settlement must log a violation'
  );
  // Queried-vs-offered negotiation evidence.
  assert.ok(rs.includes('queried-vs-offered MISS'), 'format misses must log offered set');
  assert.ok(rs.includes('GetData served cf='), 'served formats must log');
});

test('v28-B - per-type format set (B2)', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'native_drag.rs'), 'utf8');
  // Text/code/link.
  assert.ok(rs.includes('CF_UNICODETEXT'), 'must offer unicode text');
  assert.ok(rs.includes('CF_TEXT'), 'must offer ANSI text');
  assert.ok(rs.includes('wrap_in_cf_html'), 'must offer wrapped CF_HTML');
  // Images: HDROP + descriptor/contents + DIB + path text.
  assert.ok(rs.includes('CF_HDROP'), 'images must offer HDROP');
  assert.ok(rs.includes('FileGroupDescriptorW'), 'images must offer virtual descriptors');
  assert.ok(rs.includes('FileContents'), 'images must offer descriptor contents');
  assert.ok(rs.includes('CF_DIB'), 'images must offer DIB for editors');
  assert.ok(rs.includes('BITMAPINFO'), 'DIB comment must document the layout');
  // Files: HDROP over real paths.
  assert.ok(rs.includes('hdrop_bytes'), 'HDROP serializer must exist');
  // Command wiring.
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  assert.ok(
    libRs.includes('native_drag::begin_native_drag'),
    'begin_native_drag must be registered'
  );
});

test('v28-B - frontend gesture routing and hygiene (B4)', () => {
  const util = fs.readFileSync(path.join(SRC_DIR, 'utils', 'clipDrag.ts'), 'utf8');
  assert.ok(util.includes('export function shouldNativeDrag'), 'type router must exist');
  assert.ok(util.includes('export async function beginNativeDrag'), 'native starter must exist');
  assert.ok(
    util.includes("invoke<string>('begin_native_drag'"),
    'must invoke the native command'
  );
  assert.ok(util.includes('preventDefault'), 'DOM drag must be cancelled for native rows');
  assert.ok(util.includes('removeAllRanges'), 'selection must be cleared for the gesture');
  assert.ok(util.includes('native-dragging'), 'drag class must gate selection suppression');

  for (const [file, handler] of [
    ['components/QuickOverlay.tsx', 'handleOverlayDragStart'],
    ['components/EnlargedWindow.tsx', 'handleDragStart'],
  ]) {
    const tsx = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    assert.ok(
      tsx.includes('shouldNativeDrag(item)'),
      `${file} must route image/file rows natively`
    );
    assert.ok(
      tsx.includes('beginNativeDrag(e, item)'),
      `${file} must start the native drag`
    );
    // DOM path retained for text-like clips.
    assert.ok(tsx.includes('setClipDragData(e, item'), `${file} must keep the DOM drag for text`);
  }

  const css = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
  assert.ok(css.includes('html.native-dragging'), 'suppression CSS must exist');
});

test('v28-B - native drag suppresses overlay auto-hide on blur to prevent crash', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'native_drag.rs'), 'utf8');
  assert.ok(rs.includes('is_native_drag_active'), 'must expose is_native_drag_active');
  assert.ok(rs.includes('NATIVE_DRAG_ACTIVE'), 'must track active drag state');

  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  assert.ok(
    libRs.includes('native_drag::is_native_drag_active()'),
    'focus-loss handler must check native_drag::is_native_drag_active'
  );
  assert.ok(
    libRs.includes('suppressing hide to prevent crash'),
    'focus-loss handler must log suppression rationale'
  );
});
