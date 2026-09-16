import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const SRC_TAURI_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

/**
 * ADDENDUM v28-C: Enter-to-paste reliability.
 * One pipeline (paste_clip -> paste_item), bounded focus confirmation with
 * send-time proof, elevation fallback with a visible hint.
 */

test('v28-C - single paste pipeline (C1): Enter and mouse converge', () => {
  for (const file of ['components/QuickOverlay.tsx', 'components/EnlargedWindow.tsx']) {
    const tsx = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    // Every Enter path funnels through the shared handlePaste.
    assert.ok(tsx.includes('handlePaste(selectedItem'), `${file}: Enter must call handlePaste`);
    // Which invokes exactly one command with one shape.
    assert.ok(
      tsx.includes("invoke('paste_clip', { id: item.id, plainText"),
      `${file}: handlePaste must invoke paste_clip with {id, plainText, transform}`
    );
  }
  // No divergent clip-paste command exists anywhere in src.
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'target', 'dist'].includes(e.name)) walk(full);
      } else if (/\.(tsx?|jsx?)$/.test(e.name)) {
        const text = fs.readFileSync(full, 'utf8');
        const m = text.match(/invoke\(['"]paste_\w+['"]/g);
        if (m) hits.push(...m.map((s) => `${full}: ${s}`));
      }
    }
  };
  walk(SRC_DIR);
  const clipPastes = hits.filter((h) => h.includes('paste_clip'));
  assert.ok(clipPastes.length >= 2, 'both windows must use paste_clip');
  assert.ok(
    hits.every((h) => h.includes('paste_clip') || h.includes('paste_snippet')),
    `no divergent clip-paste path may exist (snippets own theirs by design): ${hits.join('; ')}`
  );
  // The key visualizer clause: nothing observes-and-substitutes keys.
  assert.doesNotMatch(
    fs.readFileSync(path.join(SRC_DIR, 'utils', 'clipActions.tsx'), 'utf8'),
    /visualiz/i,
    'no key visualizer may interpose on the action path'
  );
});

test('v28-C - bounded focus confirmation with send-time proof (C2)', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'paste.rs'), 'utf8');
  // 10 x 15ms = 150ms max budget (was 20 x 20ms = 400ms).
  assert.ok(rs.includes('for attempt in 1..=10'), 'focus loop must be bounded to 10 attempts');
  assert.ok(
    rs.includes('Duration::from_millis(15)'),
    'focus retry step must be 15ms (<=150ms total)'
  );
  assert.ok(rs.includes('10 x 15ms = 150ms'), 'the budget must be documented at the loop');
  // Send-time foreground proof with hwnd logging; mismatch is a violation.
  assert.ok(rs.includes('fg_at_send'), 'must capture foreground at send time');
  assert.ok(
    rs.includes('send-time foreground hwnd='),
    'must log the send-time foreground hwnd'
  );
  assert.ok(
    rs.includes('VIOLATION: foreground mismatch at send time'),
    'mismatch must log a violation, never fail silently'
  );
});

test('v28-C - elevation fallback with visible hint (C3)', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'paste.rs'), 'utf8');
  assert.ok(rs.includes('fn target_needs_elevation_fallback'), 'elevation gate must exist');
  assert.ok(rs.includes('fn process_is_elevated'), 'elevation probe must exist');
  assert.ok(rs.includes('TokenElevation'), 'must read the process elevation token');
  assert.ok(
    rs.includes('fn write_clip_to_clipboard_only'),
    'clipboard-only stage must exist (no injection, no guard)'
  );
  assert.ok(rs.includes('fn peek_target_hwnd'), 'gate must peek without consuming the target');

  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  const gateIdx = libRs.indexOf('target_needs_elevation_fallback');
  const hideIdx = libRs.indexOf("Hiding window");
  assert.ok(gateIdx !== -1 && gateIdx < hideIdx, 'elevation gate must precede the hide');
  assert.ok(
    libRs.includes('paste-elevation-fallback'),
    'fallback must emit the user-visible hint event'
  );

  for (const file of ['components/QuickOverlay.tsx', 'components/EnlargedWindow.tsx']) {
    const tsx = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    assert.ok(
      tsx.includes('paste-elevation-fallback'),
      `${file} must listen for the elevation hint`
    );
    assert.ok(tsx.includes('pasteNotice'), `${file} must render the transient notice`);
  }
});

/**
 * Deselect-after-paste: browser engines can leave a synthetic Ctrl+V insert
 * selected (highlighted). A single Right-arrow collapses it — but ONLY for
 * known browsers, since elsewhere it would nudge the caret for no benefit.
 * Snippet expansion keeps its own caret placement (untouched).
 */

test('v32-C - deselect is opt-in, web-class scoped, single keystroke', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'paste.rs'), 'utf8');
  // C1 classification: inserted text remains selected => target behavior,
  // cosmetic => accept + document + OPTIONAL setting (default OFF).
  assert.ok(rs.includes('fn inject_right_arrow'), 'single Right-arrow injector retained');
  assert.ok(rs.includes('fn maybe_deselect_after_paste'), 'opt-in decision fn must exist');
  assert.ok(rs.includes('Chrome_WidgetWin_'), 'must scope to Chromium window class');
  assert.ok(rs.includes('Mozilla'), 'must scope to Mozilla window class');
  assert.ok(!rs.includes('DESELECT_BROWSERS'), 'exe allowlist must be gone');
  assert.ok(!rs.includes('collapse_pasted_selection'), 'default tap loop must be gone');
  // C2: default configuration sends NO post-paste keystroke.
  assert.ok(rs.includes('maybe_deselect_after_paste(deselect_after);'), 'worker must call the gated deselect');
  // Setting exists, default false, old files still parse.
  const settings = fs.readFileSync(path.join(SRC_TAURI_DIR, 'settings.rs'), 'utf8');
  assert.ok(settings.includes('pub paste_deselect_after: bool'), 'setting must exist');
  assert.ok(settings.includes('paste_deselect_after: false'), 'default must be OFF');
  const types = fs.readFileSync(path.join(SRC_DIR, 'types.ts'), 'utf8');
  assert.ok(types.includes('paste_deselect_after: boolean'), 'frontend type must exist');
  const tsx = fs.readFileSync(path.join(SRC_DIR, 'components', 'Settings.tsx'), 'utf8');
  assert.ok(tsx.includes('paste_deselect_after'), 'settings UI must expose the toggle');
  assert.ok(tsx.includes('Off by default'), 'toggle must document the default');
});

test('v32-B - settle sequence, post-check, single retry', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'paste.rs'), 'utf8');
  assert.ok(rs.includes('CLIP_SEQ'), 'clipboard sequence counter must exist');
  assert.ok(rs.includes('stable_frames'), 'two-frame stability gate must count frames');
  assert.ok(rs.includes('settling 80ms'), 'bounded 80ms settle must be logged with hwnd');
  assert.ok(rs.includes('keystrokes sent: Ctrl+V'), 'keystrokes must be logged');
  assert.ok(rs.includes('post-check'), 'post-check must exist and log');
  assert.ok(rs.includes('retry 1/1'), 'exactly one retry path must exist');
  assert.ok(rs.includes('No further retries'), 'retry cap must be documented');
  assert.ok(rs.includes('mark_paste(&restage_item)'), 'retry must re-mark watcher skip');
  assert.ok(rs.includes('thread::sleep(Duration::from_millis(150))'), 'retry settle must be 150ms');
  assert.ok(rs.includes('thread::sleep(Duration::from_millis(250))'), 'post-check window must be 250ms');
});

test('paste guard - flag releases before any caret tail', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'paste.rs'), 'utf8');
  // The single-shot guard must never be held by post-inject tails: a fast
  // consecutive paste into another interface was silently dropped (read as
  // a crash). Critical section ends at inject/retry; caret tails run after.
  const threadStart = rs.indexOf('Focus confirmation attempt');
  const clearIdx = rs.indexOf('PASTE_IN_FLIGHT.store(false, Ordering::SeqCst);', threadStart);
  const deselectIdx = rs.indexOf('maybe_deselect_after_paste(deselect_after);', threadStart);
  assert.ok(threadStart !== -1 && clearIdx !== -1 && deselectIdx !== -1, 'anchors must exist');
  assert.ok(
    clearIdx < deselectIdx,
    'guard must release before the caret tail (consecutive pastes must not drop)'
  );
});


test('v33-D2 - hwnd-less path gets the same B2 settle', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'paste.rs'), 'utf8');
  // TARGET_HWND=None previously slept a flat 60ms with no stability gate:
  // unsettled injections miss SPA composers identically. Both branches
  // must count stability frames and settle 80ms (settle scope only).
  assert.ok(rs.includes('target=none stable_frames='), 'None path must log stability+settle');
  const noneIdx = rs.indexOf('target=none stable_frames=');
  const settle80 = rs.indexOf('Duration::from_millis(80)', noneIdx);
  assert.ok(settle80 !== -1 && settle80 - noneIdx < 600, 'None path must settle 80ms');
});
