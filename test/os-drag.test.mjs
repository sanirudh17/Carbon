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
  assert.ok(rs.includes('pub fn set_os_drag_active'), 'in-flight flag command must exist');
  assert.ok(rs.includes('pub fn is_os_drag_active'), 'focus handler needs a reader');
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  assert.ok(libRs.includes('drag_icon::drag_blank_icon'), 'blank icon must be registered');
  assert.ok(libRs.includes('drag_icon::set_os_drag_active'), 'flag command must be registered');
  assert.ok(
    libRs.includes('drag_icon::is_os_drag_active()'),
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
