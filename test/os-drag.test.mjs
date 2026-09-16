import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const SRC_TAURI_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

/**
 * OS file drag-out via @crabnebula/tauri-plugin-drag (Glint-proven).
 * Image/file rows leave as REAL files through the plugin-owned modal loop
 * (pointerdown + threshold gesture); text-like rows keep the proven DOM
 * path. Pins the split and forbids a return to hand-rolled COM.
 */

test('os-drag - plugin wired on both sides', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.ok(
    pkg.dependencies['@crabnebula/tauri-plugin-drag'],
    'frontend must depend on the drag plugin'
  );
  const cargo = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.ok(cargo.includes('tauri-plugin-drag'), 'backend must depend on the drag plugin');
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  assert.ok(
    libRs.includes('.plugin(tauri_plugin_drag::init())'),
    'plugin must be initialized'
  );
  for (const cap of ['default.json', 'overlay.json']) {
    const json = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'capabilities', cap), 'utf8');
    assert.ok(json.includes('"drag:default"'), `${cap} must grant the drag permission`);
  }
});

test('os-drag - blank icon command and auto-hide guard exist', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'drag_icon.rs'), 'utf8');
  assert.ok(rs.includes('pub fn drag_blank_icon'), 'blank icon command must exist');
  assert.ok(rs.includes('carbon-drag-blank.png'), 'blank icon must be cached by name');
  assert.ok(rs.includes('pub fn set_drag_active'), 'in-flight flag command must exist');
  assert.ok(rs.includes('pub fn is_drag_active'), 'focus handler needs a reader');
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  assert.ok(libRs.includes('drag_icon::drag_blank_icon'), 'blank icon must be registered');
  assert.ok(libRs.includes('drag_icon::set_drag_active'), 'flag command must be registered');
  assert.ok(
    libRs.includes('drag_icon::is_drag_active()'),
    'focus-loss handler must suppress hide during OS drags'
  );
});

test('os-drag - no hand-rolled COM may return', () => {
  const files = fs.readdirSync(SRC_TAURI_DIR).filter((f) => f.endsWith('.rs'));
  for (const f of files) {
    const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, f), 'utf8');
    for (const token of ['DoDragDrop', 'IDataObject', 'IDropSource', 'IStream_Vtbl', 'OleInitialize']) {
      assert.ok(!rs.includes(token), `${f} must not contain hand-rolled COM (${token})`);
    }
  }
  const util = fs.readFileSync(path.join(SRC_DIR, 'utils', 'clipDrag.ts'), 'utf8');
  assert.ok(!util.includes('begin_native_drag'), 'dead native command must stay gone');
});

test('os-drag - gesture rides pointerdown + threshold, never dragstart', () => {
  const util = fs.readFileSync(path.join(SRC_DIR, 'utils', 'clipDrag.ts'), 'utf8');
  assert.ok(util.includes("from '@crabnebula/tauri-plugin-drag'"), 'must use the plugin');
  assert.ok(util.includes("invoke<string>('drag_blank_icon')"), 'blank icon must be prefetched');
  assert.ok(util.includes("mode: 'copy'"), 'OS drag must be COPY-only');
  assert.ok(util.includes('attachOsFileDrag'), 'threshold gesture helper must exist');
  assert.ok(util.includes('OS_DRAG_THRESHOLD_PX'), 'gesture must have a movement threshold');
  assert.ok(util.includes('pointerdown'), 'gesture must arm on pointerdown');
  assert.ok(util.includes('60_000'), 'auto-hide guard must have a safety timeout');
  assert.ok(!util.includes('preventDefault('), 'OS path must never cancel DOM gestures');
  // Sensitive clips never expose real files.
  assert.ok(
    util.includes('if (item.is_sensitive) return null'),
    'osDragPaths must refuse sensitive clips'
  );
});

test('os-drag - rows split by type (OS files vs DOM text)', () => {
  for (const file of ['components/QuickOverlay.tsx', 'components/EnlargedWindow.tsx']) {
    const tsx = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    assert.ok(tsx.includes('shouldOsDrag(item)'), `${file} must split rows by type`);
    assert.ok(
      tsx.includes('draggable={osDrag ? false : true}'),
      `${file}: OS rows must not start DOM drags`
    );
    assert.ok(tsx.includes('handleOsDragStart'), `${file} must highlight during OS drags`);
    assert.ok(tsx.includes('handleOsDragSettled'), `${file} must clear after OS drags`);
  }
  const qo = fs.readFileSync(path.join(SRC_DIR, 'components', 'QuickOverlay.tsx'), 'utf8');
  assert.ok(qo.includes('previewOsRef'), 'preview media wrapper must use the OS gesture');
  // Text path untouched: DOM dragstart still feeds setClipDragData.
  assert.ok(qo.includes('setClipDragData(e, item)'), 'text rows must keep the DOM payload');
});

/**
 * DOM-drag auto-hide safeguard: the overlay must hold visible for the whole
 * gesture. A blur mid-drag hides the source surface from under the OS
 * (teardown) or kills a DOM drag (blocked circle / renderer crash) — the
 * rich-text Orca crash with zero WER trace. Armed on dragstart (both
 * branches), released on dragend (browser-guaranteed for DOM drags).
 */

test('drag-guard - overlay DOM dragstart arms, dragend releases', () => {
  const qo = fs.readFileSync(path.join(SRC_DIR, 'components', 'QuickOverlay.tsx'), 'utf8');
  assert.ok(qo.includes('armDragGuard()'), 'dragstart must arm the guard');
  assert.ok(qo.includes('disarmDragGuard()'), 'dragend must release the guard');
  // Arming sits before the sensitive branch so decoy drags are covered too.
  const startIdx = qo.indexOf('handleOverlayDragStart = useCallback');
  const armIdx = qo.indexOf('armDragGuard()', startIdx);
  const sensIdx = qo.indexOf('is_sensitive', startIdx);
  assert.ok(armIdx !== -1 && armIdx < sensIdx, 'arm must precede all branches');
  const util = fs.readFileSync(path.join(SRC_DIR, 'utils', 'clipDrag.ts'), 'utf8');
  assert.ok(util.includes('export function armDragGuard'), 'arm helper must be exported');
  assert.ok(util.includes('export function disarmDragGuard'), 'disarm helper must be exported');
  assert.ok(
    util.includes("invoke('set_drag_active'"),
    'guard must reuse the backend flag command'
  );
});

test('drag-guard - backend suppresses hide for ANY in-flight drag', () => {
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  assert.ok(
    libRs.includes('drag_icon::is_drag_active()'),
    'focus-loss handler must check the unified guard'
  );
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'drag_icon.rs'), 'utf8');
  assert.ok(rs.includes('DRAG_ACTIVE'), 'unified in-flight flag must exist');
  assert.ok(!rs.includes('OS_DRAG_ACTIVE'), 'old OS-only flag must be gone');
});

test('drag-cursor - drag surfaces show copy cursor, never a grab hand', () => {
  const css = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
  // Blink reuses the source cursor as drag feedback: a grab hand over
  // small inputs masks the drop affordance and reads as broken.
  const rowRule = css.match(/\.row\[draggable='true'\]\s*\{[^}]*\}/);
  assert.ok(rowRule, 'row drag rule must exist');
  assert.ok(rowRule[0].includes('cursor: copy'), 'draggable rows must show the copy cursor');
  assert.ok(!rowRule[0].includes('grab'), 'draggable rows must not show a grab hand');
  const handleRule = css.match(/\.drag-handle\s*\{[^}]*\}/);
  assert.ok(handleRule && handleRule[0].includes('cursor: copy'), 'drag handle must show copy');
});
