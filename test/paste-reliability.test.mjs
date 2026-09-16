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

test('paste deselect - browser-gated collapse exists and is scoped', () => {
  const rs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'paste.rs'), 'utf8');
  assert.ok(rs.includes('fn inject_right_arrow'), 'single Right-arrow injector must exist');
  assert.ok(rs.includes('VK_RIGHT'), 'must use the Right-arrow virtual key');
  assert.ok(rs.includes('DESELECT_BROWSERS'), 'browser allowlist must exist');
  for (const exe of ['chrome.exe', 'msedge.exe', 'firefox.exe', 'comet.exe', 'brave.exe']) {
    assert.ok(rs.includes(`"${exe}"`), `allowlist must cover ${exe}`);
  }
  assert.ok(rs.includes('fn collapse_pasted_selection'), 'gating decision fn must exist');
  assert.ok(rs.includes('get_window_exe_name'), 'decision must key on the foreground exe');
  assert.ok(rs.includes('[DESELECT]'), 'decision must be logged either way');
  // Main item-paste path only: snippet expansion owns its caret already.
  const callSites = rs.match(/collapse_pasted_selection\(\);/g) || [];
  assert.equal(callSites.length, 1, 'exactly one call site (main paste path)');
  const mainPath = rs.indexOf('// Inject Ctrl+V into focused control');
  assert.ok(
    mainPath !== -1 && rs.indexOf('collapse_pasted_selection();', mainPath) > mainPath,
    'must run right after the main Ctrl+V inject'
  );
  assert.ok(
    !rs.includes('PASTE_SNIPPET] Injecting Ctrl+V for snippet prefix...\n        inject_ctrl_v();\n\n        collapse_pasted_selection'),
    'snippet path must stay untouched'
  );
});
