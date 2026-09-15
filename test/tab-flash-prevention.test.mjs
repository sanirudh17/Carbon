import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_TAURI_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

test('Tab Flash Fix: preview resize never leaves an unpainted white band', () => {
  const choreoRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'choreo.rs'), 'utf8');

  // SWP_NOREDRAW / SWP_NOCOPYBITS are forbidden on this path: they leave the
  // newly exposed client band unpainted, so DWM keeps compositing a stale,
  // rescaled surface (jagged toggle) that can composite white (the flash).
  assert.doesNotMatch(choreoRs, /SWP_NOREDRAW/, 'resize must NOT pass SWP_NOREDRAW');
  assert.doesNotMatch(choreoRs, /SWP_NOCOPYBITS/, 'resize must NOT pass SWP_NOCOPYBITS');
  assert.match(
    choreoRs,
    /SWP_NOACTIVATE \| SWP_NOZORDER/,
    'resize must use the plain SWP_NOACTIVATE | SWP_NOZORDER flags'
  );

  // The WebView2 controller surface is re-created by the resize: its
  // background must be re-asserted as transparent/theme-matched right before
  // the SetWindowPos, or the first present on the new surface is Chromium's
  // unpainted default (white on glass).
  const previewFnMatch = choreoRs.match(/pub fn set_overlay_preview[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(previewFnMatch, 'set_overlay_preview function found');
  const fnBody = previewFnMatch[0];
  const reassertIdx = fnBody.indexOf('set_webview_transparent_background');
  const resizeIdx = fnBody.indexOf('SetWindowPos');
  assert.ok(reassertIdx !== -1, 'transparent controller background must be re-asserted pre-resize');
  assert.ok(
    fnBody.includes('set_window_default_background'),
    'theme/material default background must be re-asserted pre-resize'
  );
  assert.ok(resizeIdx > reassertIdx, 'the transparent re-assert must precede the resize');
  assert.ok(
    fnBody.includes('set_window_border_suppressed'),
    'the DWM border must be re-suppressed across the frame recalculation'
  );

  // Persisting the choice must not sit in front of the resize (disk I/O in
  // the veil window showed up as a stutter on every toggle).
  const persistIdx = fnBody.indexOf('state.settings.update');
  assert.ok(persistIdx > fnBody.indexOf('app_handle.emit'), 'settings must persist after the ack');
});

test('Tab Flash Fix: DWM border suppression (DWMWA_BORDER_COLOR) configured for frameless windows', () => {
  const vibrancyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'vibrancy.rs'), 'utf8');
  assert.match(vibrancyRs, /DWMWA_BORDER_COLOR/, 'vibrancy.rs must configure DWMWA_BORDER_COLOR');
  assert.match(vibrancyRs, /0xFFFFFFFE/, 'vibrancy.rs must pass DWMWA_COLOR_NONE (0xFFFFFFFE)');

  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  assert.match(hotkeyRs, /DWMWA_BORDER_COLOR/, 'hotkey.rs must configure DWMWA_BORDER_COLOR');
  assert.match(hotkeyRs, /0xFFFFFFFE/, 'hotkey.rs must pass DWMWA_COLOR_NONE (0xFFFFFFFE)');
});

test('Tab Smooth - watchdog budget exceeds the real transition and re-asserts border', () => {
  const choreoTs = fs.readFileSync(path.join(ROOT_DIR, 'src', 'lib', 'choreo.ts'), 'utf8');
  // 60ms out + layout frame + native ack + 100ms in ≈ 275ms: a 250ms watchdog
  // fired on every expand and force-finalized mid in-fade (jagged end).
  assert.match(choreoTs, /const WATCHDOG_MS = 400;/, 'watchdog must be 400ms');
  assert.doesNotMatch(choreoTs, /WATCHDOG_MS = 250/, 'the 250ms budget is below the real transition');
  assert.ok(choreoTs.includes('>400ms'), 'watchdog traces must report the 400ms budget');

  const vibrancyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'vibrancy.rs'), 'utf8');
  assert.match(
    vibrancyRs,
    /pub fn set_window_border_suppressed/,
    'vibrancy.rs must expose the border re-suppression helper'
  );
});

test('Tab Smooth - expand skips the dead content-out when the pane is already hidden', () => {
  const choreoTs = fs.readFileSync(path.join(ROOT_DIR, 'src', 'lib', 'choreo.ts'), 'utf8');
  assert.match(
    choreoTs,
    /const expandingFromHidden = next && !options\.previewOpenRef\.current;/,
    'expand from a hidden pane must be detected'
  );
  // The 60ms content-out must be conditional: only a visible pane fades out.
  assert.match(
    choreoTs,
    /if \(expandingFromHidden\) \{\s*snapStep\(\);\s*\} else \{\s*timerId = window\.setTimeout\(\(\) => \{\s*snapStep\(\);\s*\}, 60\);/,
    'expand must snap immediately; collapse keeps the 60ms content-out'
  );
  // Ordering invariant (I2): React layout commit, then native resize on rAF.
  const snapIdx = choreoTs.indexOf('options.setPreviewOpen(next);');
  const rafIdx = choreoTs.indexOf('rafId = requestAnimationFrame(() => {', snapIdx);
  const sizeIdx = choreoTs.indexOf('setWindowPreviewSize(next, snapId);');
  assert.ok(snapIdx !== -1 && rafIdx > snapIdx && sizeIdx > rafIdx, 'layout must commit before the resize');
});

