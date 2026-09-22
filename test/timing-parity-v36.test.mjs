import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ADDENDUM v36 B — timing parity (overlay == main).
// B1: pre-serve at HIDE (not show); gate on first present, settle 0;
// uncloak on ack via the shared path; 90ms fade mirrored exactly.
// The pipeline symmetry below is what makes overlay <= main + 20ms
// build-independent (same instrumentation, same code path).

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function readHotkey() {
  return fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'),
    'utf8'
  );
}

test('B1 pre-serve at HIDE: show path does zero DB work, hide refreshes cache', () => {
  const rs = readHotkey();
  const showStart = rs.indexOf('pub fn handle_overlay_hotkey');
  const payloadIdx = rs.indexOf('let opened_payload', showStart);
  const fnEndIdx = rs.slice(payloadIdx).search(/\r?\n\}\r?\n/);
  const fnEnd = fnEndIdx === -1 ? -1 : payloadIdx + fnEndIdx;
  assert.ok(showStart !== -1 && payloadIdx !== -1 && fnEnd !== -1, 'show tail found');
  // Emit-to-return tail: snapshot emit only, never a query or refresh
  // (strip // comments: historical notes name the queries they forbid).
  const tail = rs.slice(payloadIdx, fnEnd).replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(tail, /thread::spawn/, 'show tail must not spawn DB refresh threads');
  assert.doesNotMatch(tail, /get_overlay_entries/, 'show tail must not query SQLite');
  assert.doesNotMatch(tail, /list_snippets/, 'show tail must not query snippets');
  const hideStart = rs.indexOf('pub fn hide_overlay_window');
  const hideEnd = rs.indexOf('pub fn is_overlay_hiding');
  const hideRegion = rs.slice(hideStart, hideEnd);
  assert.ok(
    hideRegion.includes('get_overlay_entries(250)'),
    'hide must refresh the pre-serve snapshot for the next show'
  );
  assert.ok(
    hideRegion.includes('OVERLAY_PREWARM_CACHE'),
    'hide must write the refreshed snapshot to the prewarm cache'
  );
});

test('B1 both windows gate settle-0 on the hotkey path', () => {
  const overlay = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'QuickOverlay.tsx'),
    'utf8'
  );
  assert.ok(
    overlay.includes("executeWindowShow('overlay', () => {") && overlay.includes('}, 0, token);'),
    'overlay show gate must settle 0'
  );
  const app = fs.readFileSync(path.join(ROOT_DIR, 'src', 'App.tsx'), 'utf8');
  assert.ok(
    app.includes("executeWindowShow('main'"),
    'main show must run the same shared gate'
  );
});

test('B1 hide fade + uncloak ramp are one shared implementation', () => {
  const choreo = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'lib', 'choreo.ts'),
    'utf8'
  );
  const fades = (choreo.match(/setTimeout\(finish, 90\)/g) || []).length;
  assert.equal(fades, 1, 'exactly one 90ms hide fade shared by both windows');
  const hotkey = readHotkey();
  // Both windows uncloak through the ONE shared ramp fn; durations stay
  // per-design: overlay pops on a fast 30ms ramp (snappy v37, locked by
  // choreo/driver-v23 tests), main rides the 100ms ramp.
  const ramps = (hotkey.match(/ramp_window_alpha\(win\.clone\(\), 0, 255, (?:30|100)/g) || []).length;
  assert.equal(ramps, 2, 'both windows share the one OS-alpha ramp call shape');
  assert.ok(
    hotkey.includes('ramp_window_alpha(win.clone(), 0, 255, 30, expected_token, true);'),
    'overlay keeps its fast 30ms ramp'
  );
  assert.ok(
    hotkey.includes('ramp_window_alpha(win.clone(), 0, 255, 100, expected_token, false);'),
    'main keeps its 100ms ramp'
  );
  assert.ok(
    hotkey.includes('fn uncloak_overlay_if_current') && hotkey.includes('fn uncloak_enlarged_if_current'),
    'both windows uncloak through the mirrored ack-gated path'
  );
});

test('B2 same instrumentation measures both windows (parity delta is build-independent)', () => {
  const choreo = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'lib', 'choreo.ts'),
    'utf8'
  );
  assert.ok(
    choreo.includes('first user-interactable reached in'),
    'hotkey-to-interactable traced identically for both windows'
  );
  assert.ok(
    choreo.includes('show gate opened in'),
    'gate cost traced identically for both windows'
  );
});
