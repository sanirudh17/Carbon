import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const SRC_TAURI_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

/**
 * ADDENDUM v30: drag-source OLE contract conformance (static pins).
 * The behavioral proof lives in-process: `cargo test` runs
 * native_drag::conformance_tests (R1..R8 hostile driving). These pins
 * guard the wiring: agreed format sets, no exotic formats, command +
 * routing, drag log, harness presence.
 */

const rs = () => fs.readFileSync(path.join(SRC_TAURI_DIR, 'native_drag.rs'), 'utf8');
// Non-doc, non-harness code: doc comments name removed things on purpose
// and the harness itself uses expect().
const codeOnly = () =>
  rs()
    .split('mod conformance_tests')[0]
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');

test('v30 - R6 agreed sets only, no exotic formats', () => {
  const src = codeOnly();
  assert.ok(src.includes('CF_UNICODETEXT'), 'must offer unicode text');
  assert.ok(src.includes('CF_TEXT'), 'must offer ANSI text');
  assert.ok(src.includes('CF_HDROP'), 'must offer HDROP');
  assert.ok(src.includes('wrap_in_cf_html'), 'must offer wrapped CF_HTML');
  for (const banned of [
    'FileGroupDescriptorW',
    'FileContents',
    'CF_DIB',
    'IStream_Vtbl',
    'CarbonClipIds',
    'bmp_file_bytes',
  ]) {
    assert.ok(!src.includes(banned), `R6 strictness: must not contain ${banned}`);
  }
});

test('v30 - R1/R2/R3/R8 contract tokens present', () => {
  const src = codeOnly();
  for (const token of [
    'DATADIR_GET', // R1: GET-only enumeration
    'DV_E_TYMED', // R2: wrong-medium distinction
    'DV_E_FORMATETC',
    'GetDataHere', // R3: fill caller medium
    'DRAGDROP_S_CANCEL', // R8
    'DRAGDROP_S_DROP',
    'DRAGDROP_S_USEDEFAULTCURSORS',
    'guard_hresult', // R8: panic guards
    'catch_unwind',
  ]) {
    assert.ok(src.includes(token), `contract must implement ${token}`);
  }
  // Harness-owned frees (referenced from the conformance module).
  assert.ok(rs().includes('ReleaseStgMedium'), 'harness must free via ReleaseStgMedium');
  assert.doesNotMatch(src, /\.unwrap\(\)/, 'no unwrapping calls in module scope paths');
  assert.doesNotMatch(src, /\.expect\(/, 'no expecting calls in module scope paths');
});

test('v30 - R7 deferred temp lifetime', () => {
  const src = rs();
  assert.ok(src.includes('STAGED_GRAVEYARD'), 'graveyard must exist');
  assert.ok(src.includes('retire_staged_dir'), 'settle must retire into deferred cleanup');
  assert.ok(src.includes('sweep_stale_staging'), 'next drag must sweep leftovers');
  assert.ok(src.includes('Duration::from_secs(60)'), 'deferred thread must outlive async reads');
  assert.ok(src.includes('CarbonDrag-'), 'staging must be namespaced');
});

test('v30 - drag log ring + crash-report attach', () => {
  const src = rs();
  assert.ok(src.includes('DRAG_LOG'), 'last-50 ring must exist');
  assert.ok(src.includes('drag_log_snapshot_try'), 'crash hook needs a snapshot reader');
  assert.ok(src.includes('try_lock'), 'snapshot must never block a panicking thread');
  const pasteRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'paste.rs'), 'utf8');
  assert.ok(
    pasteRs.includes('drag_log_snapshot_try()'),
    'panic hook must attach the drag log to crash reports'
  );
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  assert.ok(libRs.includes('native_drag::begin_native_drag'), 'command must be registered');
  assert.ok(
    libRs.includes('native_drag::is_native_drag_active()'),
    'focus-loss lifeline must check the drag flag'
  );
});

test('v30 - frontend routes covered types, DOM keeps the rest', () => {
  const util = fs.readFileSync(path.join(SRC_DIR, 'utils', 'clipDrag.ts'), 'utf8');
  assert.ok(util.includes('export function shouldNativeDrag'), 'type router must exist');
  assert.ok(util.includes('export async function beginNativeDrag'), 'native starter must exist');
  assert.ok(util.includes("invoke<string>('begin_native_drag'"), 'must invoke the command');
  assert.ok(util.includes('preventDefault'), 'DOM drag must be cancelled for native rows');
  for (const t of ['text', 'code', 'link', 'email', 'image', 'file']) {
    assert.ok(util.includes(`'${t}'`), `router must cover ${t}`);
  }
  for (const file of ['components/QuickOverlay.tsx', 'components/EnlargedWindow.tsx']) {
    const tsx = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    assert.ok(tsx.includes('shouldNativeDrag(item)'), `${file} must route covered rows`);
    assert.ok(tsx.includes('beginNativeDrag(e, item)'), `${file} must start the native drag`);
    assert.ok(tsx.includes('setClipDragData(e, item'), `${file} must keep the DOM path`);
  }
});

test('v30 - conformance harness wired into CI', () => {
  const src = rs();
  assert.ok(src.includes('mod conformance_tests'), 'in-process harness must exist');
  for (const r of ['r1_enumeration_contract', 'r2_query_matrix', 'r2_qi_contract',
    'r3_r4_medium_ownership_and_terminators', 'r3_getdata_here_fills_caller_medium',
    'r5_cf_html_wellformed', 'r6_offer_sets_per_type', 'r6_image_hdrop_and_path',
    'r6_file_hdrop_live_only', 'r7_graveyard_sweep', 'r8_drop_source_contract']) {
    assert.ok(src.includes(`fn ${r}()`), `harness must drive ${r}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:rust'], 'CI must expose the Rust harness (npm run test:rust)');
});
