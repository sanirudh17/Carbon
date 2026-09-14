import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_TAURI_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

test('Tab Flash Fix: choreo.rs SetWindowPos passes SWP_NOREDRAW and SWP_NOCOPYBITS', () => {
  const choreoRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'choreo.rs'), 'utf8');

  // Verify SWP flags for non-client flash suppression
  assert.match(choreoRs, /SWP_NOREDRAW/, 'SetWindowPos must include SWP_NOREDRAW to prevent GDI non-client border painting');
  assert.match(choreoRs, /SWP_NOCOPYBITS/, 'SetWindowPos must include SWP_NOCOPYBITS to prevent GDI dirty border fill');
  assert.match(choreoRs, /SWP_NOSENDCHANGING/, 'SetWindowPos must include SWP_NOSENDCHANGING');

  // Verify no redundant background resets on toggle in set_overlay_preview
  const previewFnMatch = choreoRs.match(/pub fn set_overlay_preview[\s\S]*?\{([\s\S]*?)let _ = app_handle\.emit/);
  assert.ok(previewFnMatch, 'set_overlay_preview function found');
  const fnBody = previewFnMatch[1];
  assert.doesNotMatch(fnBody, /set_webview_transparent_background/, 'set_overlay_preview must not redundantly re-invoke set_webview_transparent_background');
  assert.doesNotMatch(fnBody, /set_window_default_background/, 'set_overlay_preview must not redundantly re-invoke set_window_default_background');
});

test('Tab Flash Fix: DWM border suppression (DWMWA_BORDER_COLOR) configured for frameless windows', () => {
  const vibrancyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'vibrancy.rs'), 'utf8');
  assert.match(vibrancyRs, /DWMWA_BORDER_COLOR/, 'vibrancy.rs must configure DWMWA_BORDER_COLOR');
  assert.match(vibrancyRs, /0xFFFFFFFE/, 'vibrancy.rs must pass DWMWA_COLOR_NONE (0xFFFFFFFE)');

  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  assert.match(hotkeyRs, /DWMWA_BORDER_COLOR/, 'hotkey.rs must configure DWMWA_BORDER_COLOR');
  assert.match(hotkeyRs, /0xFFFFFFFE/, 'hotkey.rs must pass DWMWA_COLOR_NONE (0xFFFFFFFE)');
});
