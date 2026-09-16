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
    'IEnumFORMATETC_Vtbl',
    'DoDragDrop',
    'OleInitialize',
    'OleUninitialize',
    'run_on_main_thread',
    'guard_hresult',
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

test('v28-B - per-type format set (B2, minimal payload as of v29-A)', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'native_drag.rs'), 'utf8');
  // Text/code/link.
  assert.ok(rs.includes('CF_UNICODETEXT'), 'must offer unicode text');
  assert.ok(rs.includes('CF_TEXT'), 'must offer ANSI text');
  assert.ok(rs.includes('wrap_in_cf_html'), 'must offer wrapped CF_HTML');
  // Images/files: HDROP + path text only (v29-A deleted the exotic
  // virtual-file/DIB surface after the crash audit).
  assert.ok(rs.includes('CF_HDROP'), 'images/files must offer HDROP');
  assert.ok(rs.includes('hdrop_bytes'), 'HDROP serializer must exist');
  assert.ok(rs.includes('stage_image_temp'), 'images must stage a temp copy');
  assert.ok(rs.includes('CarbonDrag'), 'staging dir must be namespaced');
  assert.ok(rs.includes('remove_dir_all'), 'staging must be cleaned after the drop');
  for (const dead of [
    'FileGroupDescriptorW',
    'new_mem_stream',
    'bmp_file_bytes',
    'CarbonClipIds',
    'IStream_Vtbl',
  ]) {
    assert.ok(!rs.includes(dead), `v29-A minimal payload must not contain ${dead}`);
  }
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
  // v29-A frontend spam guard.
  assert.ok(util.includes('nativeDragInFlight'), 'must refuse stacked invokes');
  assert.ok(util.includes('threshold detected'), 'must log the threshold handoff');
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

/**
 * ADDENDUM v29-A: crash-safe native drag source.
 * The drag modal loop used to run on a thread-pool worker while the WebView
 * owned the window, offered exotic virtual-file/DIB formats through a
 * hand-rolled IStream, and had no FFI panic containment. These tests pin
 * the hardened contract: main-STA dispatch, busy guard, per-entry unwind
 * guards, minimal payload, lifecycle telemetry, and the crash hook.
 */

test('v29-A - drag runs ONLY on the main STA thread (never a worker)', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'native_drag.rs'), 'utf8');
  assert.ok(rs.includes('run_on_main_thread'), 'modal body must post to the main STA thread');
  assert.ok(rs.includes('run_modal_drag'), 'modal body must be a dedicated main-thread fn');
  assert.ok(!rs.includes('thread::spawn'), 'no worker thread may own the modal loop');
});

test('v29-A - busy guard rejects concurrent / spam dragstarts', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'native_drag.rs'), 'utf8');
  assert.ok(rs.includes('compare_exchange'), 'entry must be a compare_exchange busy guard');
  assert.ok(
    rs.includes('native drag already in progress'),
    'concurrent dragstart must fail loudly'
  );
  assert.ok(rs.includes('spam guard'), 'rejection rationale must be documented');
});

test('v29-A - every COM entry point is unwind-guarded and null-checked', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'native_drag.rs'), 'utf8');
  assert.ok(rs.includes('fn guard_hresult'), 'FFI boundary guard must exist');
  assert.ok(rs.includes('catch_unwind'), 'guard must catch unwinds');
  assert.ok(rs.includes('E_FAIL'), 'panics must degrade to E_FAIL');
  assert.ok(rs.includes('AssertUnwindSafe'), 'main-thread body must be unwind-contained');
  for (const entry of [
    'fmt_next', 'fmt_skip', 'fmt_reset', 'fmt_clone',
    'data_getdata', 'data_query', 'data_enum',
    'src_query_continue',
  ]) {
    assert.ok(
      rs.includes(`guard_hresult("${entry}"`),
      `${entry} must funnel through the unwind guard`
    );
  }
  // Audit-pinned: no panic paths inside the module (unwrap/expect/panic
  // macros). unwrap_or / unwrap_or_default are fine (no panic).
  assert.doesNotMatch(rs, /\.unwrap\(\)/, 'no unwrapping calls allowed');
  assert.doesNotMatch(rs, /\.expect\(/, 'no expecting calls allowed');
  assert.doesNotMatch(rs, /panic!\(/, 'no panic! allowed');
  assert.doesNotMatch(rs, /unreachable!\(/, 'no unreachable! allowed');
  // QI answers exactly IUnknown + the object's own IID.
  assert.ok(rs.includes('E_NOINTERFACE'), 'QI must reject unknown IIDs');
  assert.ok(rs.includes('this.is_null()'), 'entry points must null-check the object');
});

test('v29-A - drag lifecycle telemetry covers threshold to return', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'native_drag.rs'), 'utf8');
  for (const token of [
    'drag message posted to main STA thread',
    'handler entered on main STA thread',
    'OleInitialize ok',
    'OleInitialize FAILED',
    'DoDragDrop entered',
    'DoDragDrop returned hr=',
    'first QueryInterface',
    'first GetData',
    'first QueryContinueDrag tick',
  ]) {
    assert.ok(rs.includes(token), `lifecycle must log: ${token}`);
  }
});

test('v29-A - crash hook captures message + backtrace before abort', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'native_drag.rs'), 'utf8');
  assert.ok(rs.includes('pub fn install_crash_hook'), 'hook installer must be exported');
  assert.ok(rs.includes('set_hook'), 'must install a process panic hook');
  assert.ok(
    rs.includes('Backtrace::force_capture'),
    'hook must capture a backtrace'
  );
  assert.ok(rs.includes('carbon_crash.log'), 'hook must persist to carbon_crash.log');
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  assert.ok(
    libRs.includes('native_drag::install_crash_hook()'),
    'run() must install the hook before the builder starts'
  );
});
