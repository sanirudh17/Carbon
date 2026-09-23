import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_TAURI_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

test('Tab Flash Fix: DWM border suppression (DWMWA_BORDER_COLOR) configured for frameless windows', () => {
  const vibrancyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'vibrancy.rs'), 'utf8');
  assert.match(vibrancyRs, /DWMWA_BORDER_COLOR/, 'vibrancy.rs must configure DWMWA_BORDER_COLOR');
  assert.match(vibrancyRs, /0xFFFFFFFE/, 'vibrancy.rs must pass DWMWA_COLOR_NONE (0xFFFFFFFE)');

  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  assert.match(hotkeyRs, /DWMWA_BORDER_COLOR/, 'hotkey.rs must configure DWMWA_BORDER_COLOR');
  assert.match(hotkeyRs, /0xFFFFFFFE/, 'hotkey.rs must pass DWMWA_COLOR_NONE (0xFFFFFFFE)');
});

test('Picker Open - hotkey thread does zero DB work before show (parity with main)', () => {
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  const showFnMatch = hotkeyRs.match(/pub fn handle_overlay_hotkey[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(showFnMatch, 'handle_overlay_hotkey function found');
  const fnBody = showFnMatch[0];

  // No synchronous SQLite on the hotkey thread: the main-window show path
  // does zero DB work, and a blocking get_overlay_entries here stalled the
  // picker open on disk I/O. Cache may be read; the DB must never be touched
  // on the show path at all.
  // ADDENDUM v36 B1: even the background refresh moved off show — the
  // pre-serve is refreshed at the previous HIDE (hide_overlay_window), so
  // the show tail is snapshot-emit only. Staleness is covered by the
  // frontend's bounded version-gated refresh (A2).
  const emitIdx = fnBody.indexOf('emit("overlay-opened"');
  assert.ok(emitIdx !== -1, 'overlay-opened must be emitted on the show path');
  const preEmit = fnBody.slice(0, emitIdx);
  assert.doesNotMatch(preEmit, /get_overlay_entries/, 'no DB query may precede overlay-opened');
  assert.doesNotMatch(preEmit, /get_all_entries/, 'no DB query may precede overlay-opened');
  assert.doesNotMatch(preEmit, /list_snippets/, 'no DB query may precede overlay-opened');
  assert.ok(
    fnBody.includes('OVERLAY_PREWARM_CACHE.lock().unwrap().clone()'),
    'the open must serve the prewarm cache (lock + clone, no I/O)'
  );
  const showTail = fnBody.slice(emitIdx);
  assert.doesNotMatch(
    showTail.replace(/\/\/.*$/gm, ''),
    /std::thread::spawn/,
    'v36 B1: no refresh thread on show — pre-serve happens at hide'
  );
  const hideFn = hotkeyRs.match(/pub fn hide_overlay_window[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(hideFn, 'hide_overlay_window found');
  assert.ok(
    hideFn[0].includes('get_overlay_entries(250)'),
    'hide must refresh the pre-serve snapshot for the next show'
  );

  // No per-show DWM corner re-assert: the preference is persistent per-window
  // (applied at prewarm/create) and the main show path doesn't re-assert it.
  assert.doesNotMatch(
    fnBody,
    /set_round_corners\(&/,
    'overlay show must not re-assert round corners on the hotkey thread'
  );

  // Fixed frame: the show path never resizes — content can never resize the
  // window, so no fresh WebView2 surface (and no unpainted first present)
  // appears before show(). Positioning is NOSIZE-only, keeping the warm
  // composition surface.
  assert.doesNotMatch(
    fnBody,
    /set_size\(/,
    'overlay show must never resize the fixed frame'
  );
  assert.ok(
    fnBody.includes('SWP_NOACTIVATE | SWP_NOSIZE'),
    'show must position NOSIZE-only behind the cloak'
  );
  assert.ok(
    fnBody.includes('(OVERLAY_WIDTH, OVERLAY_HEIGHT)'),
    'show must use the fixed unified frame geometry'
  );
});

test('Picker Open - cross-process selection fallback is time-bounded', () => {
  const expansionRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'expansion.rs'), 'utf8');
  // A plain SendMessageW blocks the shortcut thread until the target app
  // pumps it — a hung/busy target stalled every open with no upper bound.
  assert.ok(
    expansionRs.includes('SendMessageTimeoutW'),
    'the EM_GETSEL fallback must use the bounded SendMessageTimeoutW'
  );
  assert.ok(
    expansionRs.includes('SMTO_ABORTIFHUNG'),
    'the bounded send must abort on hung windows'
  );
});

test('Picker Open - frontend fires zero invokes before the paint gate (parity with main)', () => {
  const overlayTsx = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'QuickOverlay.tsx'),
    'utf8'
  );
  const openedMatch = overlayTsx.match(
    /const unlistenOpened = safeListen<[\s\S]*?\n    \}\);/
  );
  assert.ok(openedMatch, 'overlay-opened handler found');
  const handler = openedMatch[0];

  // The list/snippet/settings refresh must live in the post-reveal callback
  // (after uncloak is requested), never inline in the event handler where it
  // would contend IPC + re-render with the 2-rAF paint gate. Rust pushes
  // overlay-data + overlay-snippets with the open, so the first frame already
  // has data — exactly like the main window's 0-invoke open.
  // v37: the gate opens IMMEDIATELY on every open (no pre-gate wait at all);
  // the reveal carries zero invokes (focus + phase only); freshness rides
  // the live pushes plus ONE idle backstop, gated on the v36 A2 store/cache
  // version comparison (stale → backstop refetch; fresh → single settle,
  // no double insert).
  assert.ok(handler.includes('beginOverlayShow('), 'handler must settle through the single show runner');
  const gateIdx = handler.indexOf('beginOverlayShow(');
  const preGate = handler.slice(0, gateIdx);
  assert.doesNotMatch(preGate, /fetchSnippets\(\)/, 'no snippet fetch may precede the paint gate');
  assert.doesNotMatch(preGate, /get_settings/, 'no settings round-trip may precede the paint gate');
  assert.doesNotMatch(preGate, /setTimeout/, 'no wait of any kind may precede the paint gate');

  // No deferred-show machinery may remain: the open is never parked.
  assert.doesNotMatch(overlayTsx, /deferShowForFreshness/, 'no deferred show');
  assert.doesNotMatch(overlayTsx, /settleFreshWait/, 'no push-wait resolver');
  assert.doesNotMatch(overlayTsx, /FRESH_WAIT_MS/, 'no fresh-wait bound');
  assert.doesNotMatch(overlayTsx, /refreshStaleBeforeShow/, 'no pre-gate refresh (v37 instant gate)');
  assert.doesNotMatch(overlayTsx, /justRefreshedRef/, 'no settle flag (single backstop instead)');
  // One guarded idle backstop, armed only for a stale cache, replaces the
  // reveal-time fetches (v36 A2 version gate + v37 zero-invoke reveal).
  assert.ok(
    overlayTsx.includes('backstopRef'),
    'a single idle backstop must cover post-reveal freshness'
  );
  assert.ok(
    overlayTsx.includes('lastStoreVersionRef.current > cacheVersionRef.current'),
    'backstop must be gated on the store/cache version comparison'
  );

  // The search-reset must not trigger a redundant [search]-effect fetch:
  // overlay-data already delivered the full unfiltered list.
  assert.ok(
    handler.includes('skipSearchFetchRef.current = true'),
    'open must arm the search-fetch skip when resetting a non-empty search'
  );

  // Show-focus (Rust focuses right after show) must not refetch mid-gate.
  assert.ok(
    overlayTsx.includes('FOCUS_QUIET_MS'),
    'a focus quiet period must suppress show-focus refetch'
  );
});

test('Cover Animation - reversible set_overlay_animation command (full | soft)', () => {
  const settingsRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'settings.rs'), 'utf8');
  assert.ok(
    settingsRs.includes('pub overlay_animation: String'),
    'settings must carry the overlay_animation mode'
  );
  assert.ok(
    settingsRs.includes('default_overlay_animation'),
    'the mode must serde-default for older settings.json files'
  );
  assert.match(
    settingsRs,
    /fn default_overlay_animation\(\) -> String \{[\s\S]*?"soft"\.to_string\(\)/,
    'shipped default must be "soft" (reduced)'
  );

  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  const cmdMatch = libRs.match(/fn set_overlay_animation[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(cmdMatch, 'set_overlay_animation command found');
  const cmd = cmdMatch[0];
  assert.ok(cmd.includes('#[tauri::command]') || libRs.includes('fn set_overlay_animation'),
    'must be a tauri command');
  assert.ok(cmd.includes('"full"') && cmd.includes('"soft"'), 'must accept both modes');
  assert.ok(cmd.includes('settings-updated'), 'must emit settings-updated so the overlay applies it live');
  assert.ok(cmd.includes('Ok(mode)'), 'must return the applied mode');
  assert.ok(
    /generate_handler!\[[\s\S]*?set_overlay_animation/.test(libRs),
    'command must be registered in the invoke handler'
  );

  const typesTs = fs.readFileSync(path.join(ROOT_DIR, 'src', 'types.ts'), 'utf8');
  assert.ok(
    typesTs.includes("overlay_animation?: 'full' | 'soft'"),
    'TS settings type must carry the optional mode'
  );
});

test('Cover Animation - soft mode only trims the hide layer, guards untouched', () => {
  const css = fs.readFileSync(path.join(ROOT_DIR, 'src', 'index.css'), 'utf8');

  // v37: the content-layer zoom is gone in EVERY mode — hide is one plain
  // html fade, exactly mirrored between picker and library (the zoom is
  // what made the picker feel slower to close). Both modes resolve to the
  // same snappy fade; the setting stays reversible and live-applied.
  assert.doesNotMatch(css, /transform: scale\(0\.985\)/, 'no hide zoom in any mode');
  assert.ok(css.includes('opacity 90ms'), 'shared 90ms hide fade stays');

  // Tab-preview choreography timings are a separate concern — untouched.
  assert.ok(css.includes('--dur-expand: 170ms;'), 'preview expand duration untouched');
  assert.ok(css.includes('--dur-collapse: 130ms;'), 'preview collapse duration untouched');
});

test('Main First-Open Flash: recreate always sets the transparent controller background', () => {
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  const ensureMatch = hotkeyRs.match(/fn ensure_main_window[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(ensureMatch, 'ensure_main_window function found');
  const fnBody = ensureMatch[0];
  // Both recreate branches (from-config + manual builder) must set the
  // transparent background, exactly like the overlay recreate path — a
  // recreated controller otherwise starts at Chromium's white default.
  const transparentCalls = (fnBody.match(/set_webview_transparent_background\(w\.as_ref\(\)\)/g) || []).length;
  assert.equal(transparentCalls, 2, 'both main recreate branches must set the transparent background');
});

test('Main First-Open Flash: every show re-asserts the non-white surface pre-cloak', () => {
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');

  // The helper must apply the same two calls, in the same order, as prewarm
  // and the overlay Tab path: material-aware default first, then transparent.
  const helperMatch = hotkeyRs.match(/fn prepare_main_surface[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(helperMatch, 'prepare_main_surface helper found');
  const helper = helperMatch[0];
  const defaultIdx = helper.indexOf('set_window_default_background');
  const transparentIdx = helper.indexOf('set_webview_transparent_background');
  assert.ok(defaultIdx !== -1 && transparentIdx !== -1, 'helper must set both backgrounds');
  assert.ok(defaultIdx < transparentIdx, 'material-aware default must come first');

  // Both show branches (overlay-swap + cold open) must re-assert before the
  // cloak/show sequence, so a fresh surface after boot or idle discard can
  // never composite white during the alpha ramp.
  const showMatch = hotkeyRs.match(/pub fn handle_enlarged_hotkey[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(showMatch, 'handle_enlarged_hotkey function found');
  const showBody = showMatch[0];
  const prepCalls = (showBody.match(/prepare_main_surface\(app_handle, &main_win\)/g) || []).length;
  assert.equal(prepCalls, 2, 'both main show branches must prepare the surface');
  for (const m of showBody.matchAll(/prepare_main_surface\(app_handle, &main_win\)/g)) {
    const tail = showBody.slice(m.index);
    const showIdx = tail.indexOf('main_win.show()');
    assert.ok(showIdx !== -1 && showIdx < 1200, 'surface prep must precede show() in its branch');
    // Idle discard: the off-screen re-present must also land in this branch,
    // after the color re-assert and before the show (color alone never presents).
    const rewarmIdx = tail.indexOf('rewarm_main_surface(app_handle)');
    assert.ok(rewarmIdx !== -1 && rewarmIdx < showIdx, 'surface rewarm must precede show() in its branch');
  }
  const rewarmCalls = (showBody.match(/rewarm_main_surface\(app_handle\)/g) || []).length;
  assert.equal(rewarmCalls, 2, 'both main show branches must rewarm the surface');
});

test('Main First-Open Flash: second-launch path matches the hotkey pre-show discipline', () => {
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  const singleMatch = libRs.match(/single_instance::init\(\|app, _args, _cwd\|[\s\S]*?\r?\n        \}\)\)/);
  assert.ok(singleMatch, 'single-instance handler found');
  const handler = singleMatch[0];
  const mainBranchIdx = handler.indexOf('get_webview_window("main")');
  assert.ok(mainBranchIdx !== -1, 'single-instance main branch found');
  const branch = handler.slice(mainBranchIdx);
  assert.ok(
    branch.includes('hotkey::prepare_main_surface(app, &win)'),
    'second-launch main show must prepare the non-white surface'
  );
  assert.ok(
    branch.includes("classList.add('wm-hidden')"),
    'second-launch main show must arm the mask until the paint gate lifts'
  );
});

test('Main Flash: visible lifetime never toggles WS_EX_LAYERED (glass rebuild = white frame)', () => {
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');

  // Removing WS_EX_LAYERED rebuilds the DWM acrylic composition surface — a
  // white frame in glass mode. The reveal ramp must therefore END layered,
  // and the ONLY removal site must be the cloaked steady-state restore.
  const removals = hotkeyRs.match(/ex & !\(WS_EX_LAYERED/g) || [];
  assert.equal(removals.length, 1, 'exactly one layered-removal site may exist (the cloaked restore helper)');
  assert.ok(hotkeyRs.includes('fn clear_window_layered'), 'layered restore helper must exist');

  // The restore must run on the cloak path, guarded on success: a failed
  // cloak may leave the window visible, where stripping would rebuild right
  // on screen.
  const cloakMatch = hotkeyRs.match(/pub fn set_window_cloaked\(window[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(cloakMatch, 'set_window_cloaked (windows) found');
  assert.ok(
    cloakMatch[0].includes('clear_window_layered(window)'),
    'cloaking must restore the non-layered steady state'
  );
  assert.ok(
    cloakMatch[0].includes('cloaked && cloak_ok'),
    'the restore must be guarded on cloak success'
  );
});

test('Main Flash: transparent surface retries bound the cold-controller race', () => {
  const vibrancyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'vibrancy.rs'), 'utf8');
  const helperMatch = vibrancyRs.match(/pub fn ensure_transparent_surface[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(helperMatch, 'ensure_transparent_surface helper found');
  const helper = helperMatch[0];
  const defaultIdx = helper.indexOf('set_window_default_background');
  const transparentIdx = helper.indexOf('set_webview_transparent_background');
  assert.ok(defaultIdx !== -1 && transparentIdx !== -1, 'helper must set both backgrounds');
  assert.ok(defaultIdx < transparentIdx, 'material-aware default must come first');
  assert.ok(helper.includes('attempts') && helper.includes('sleep'), 'helper must retry on a bounded budget');

  // Prewarm runs milliseconds after window creation (controller rarely
  // ready): both windows must retry hidden-side instead of failing silently
  // and leaving Chromium's white default stuck for the first present.
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  const prewarmCalls = hotkeyRs.match(/ensure_transparent_surface\(&/g) || [];
  assert.equal(prewarmCalls.length, 2, 'prewarm must retry the surface for overlay + main');

  // The pre-show path cannot wait on a background thread (reveal would
  // already have happened): the retry must be synchronous and bounded.
  const prepMatch = hotkeyRs.match(/fn prepare_main_surface[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(prepMatch, 'prepare_main_surface helper found');
  assert.ok(prepMatch[0].includes('for _ in 0..'), 'pre-show surface prep must retry synchronously');
  assert.ok(prepMatch[0].includes('from_millis(50)'), 'pre-show retry budget must stay tight (warm opens never wait)');
});

test('Main Flash: prewarm_first_paint runs the genuine first present', () => {
  const vibrancyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'vibrancy.rs'), 'utf8');
  // Cycle lives in offscreen_present_cycle (shared by boot prewarm + show rewarm);
  // prewarm_first_paint still owns the reveal flags, once-per-label gate, and
  // prepare_main_surface. Assert BOTH.
  const cycleMatch = vibrancyRs.match(/fn offscreen_present_cycle[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(cycleMatch, 'offscreen_present_cycle function found');
  const body = cycleMatch[0];
  const prewarmMatch = vibrancyRs.match(/pub fn prewarm_first_paint[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(prewarmMatch, 'prewarm_first_paint function found');
  const prewarm = prewarmMatch[0];

  // prewarm_windows leaves both windows WS_VISIBLE-but-DWM-cloaked. The old
  // is_visible() bail therefore skipped this cycle on every boot — the first
  // uncloaked show composited a cold white surface. The skip must be the
  // LOGICAL reveal flag (OVERLAY_CLOAKED / MAIN_CLOAKED), never is_visible().
  assert.doesNotMatch(prewarm, /is_visible\(\)/, 'no is_visible() bail-out (it skipped every boot)');
  assert.ok(prewarm.includes('OVERLAY_CLOAKED'), 'overlay skip must use the logical reveal flag');
  assert.ok(prewarm.includes('MAIN_CLOAKED'), 'main skip must use the logical reveal flag');

  // Per-window gate: only the label that reported ready presents, and the
  // cycle is once-per-label (PRESENTED_*). Main must re-assert the
  // non-white controller immediately before its genuine present.
  assert.ok(prewarm.includes('only: Option<&str>'), 'cycle must accept a single-label filter');
  assert.ok(
    prewarm.includes('PRESENTED_MAIN') && prewarm.includes('PRESENTED_OVERLAY'),
    'once-per-label flags'
  );
  assert.ok(
    prewarm.includes('prepare_main_surface(app, &win)'),
    'main must re-assert the non-white surface before the present'
  );
  assert.ok(
    vibrancyRs.includes('rewarm_main_surface'),
    'show-path idle rewarm must exist'
  );

  // A DWM-cloaked window is excluded from composition: the cycle must
  // physically uncloak while parked off-screen, present, then re-cloak —
  // otherwise the ShowWindow below still produces no genuine present.
  assert.ok(body.includes('DWMWA_CLOAK'), 'cycle must manage the raw DWM cloak');
  assert.ok(body.includes('set_window_cloaked(win, true)'), 'cycle must re-cloak on exit');
  assert.ok(body.includes('SW_SHOWNOACTIVATE'), 'show must not activate');
  // Park FIRST with raw SetWindowPos (async Tauri set_position races the show).
  assert.ok(body.includes('SetWindowPos'), 'park/restore must be raw Win32 on this thread');
  assert.ok(body.includes('-32000'), 'window must park off-screen before uncloak');
  // Match call sites, not `use` imports (SW_SHOWNOACTIVATE is imported early).
  const parkIdx = body.indexOf('SetWindowPos(');
  const uncloakIdx = body.indexOf('DwmSetWindowAttribute(');
  const showIdx = body.indexOf('ShowWindow(h, SW_SHOWNOACTIVATE)');
  assert.ok(parkIdx !== -1 && uncloakIdx !== -1 && showIdx !== -1, 'park, uncloak, show all present');
  assert.ok(parkIdx < uncloakIdx && uncloakIdx < showIdx, 'order must be park → uncloak → show (no on-screen present)');
});

test('Main Flash: first present waits for prewarm + that window ready (not any webview)', () => {
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  assert.ok(
    libRs.includes('done.store(true, Ordering::SeqCst)'),
    'prewarm_windows thread must signal completion'
  );
  assert.ok(
    libRs.includes('if prewarm_done.load(Ordering::SeqCst)'),
    'present cycle must wait for prewarm (ShowWindow before present)'
  );
  assert.ok(
    /carbon-ui-ready[\s\S]{0,900}label != "main" && label != "overlay"/.test(libRs),
    'non-main/overlay readiness must not arm the present cycle'
  );
  assert.ok(
    libRs.includes('prewarm_first_paint(&handle, Some(label.as_str()))'),
    'present must be limited to the label that reported ready'
  );
  assert.ok(
    libRs.includes('std::time::Duration::from_millis(4000)'),
    'fallback timer presents windows that never emit ready'
  );
  // The old once-flag on ANY webview is gone.
  assert.doesNotMatch(
    libRs,
    /carbon-ui-ready[\s\S]{0,200}static DONE/,
    'app-global once-flag must be replaced by per-label present'
  );

  // Overlay show-path parity: border re-asserted immediately AFTER main show()
  // while still cloaked (mirror of overlay hotkey.rs:1134).
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  const showMatch = hotkeyRs.match(/pub fn handle_enlarged_hotkey[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(showMatch, 'handle_enlarged_hotkey found');
  const borderAfterShow = (showMatch[0].match(
    /main_win\.show\(\);[\s\S]{0,600}set_window_border_suppressed\(&main_win\)/g
  ) || []).length;
  assert.equal(borderAfterShow, 2, 'both main show branches re-suppress border after show');

  // Main content stamped painted after EnlargedWindow commits (parity overlay).
  const enlarged = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'),
    'utf8'
  );
  assert.ok(
    enlarged.includes("document.documentElement.dataset.painted = '1'"),
    'EnlargedWindow must stamp data-painted after its heavy tree commits'
  );
});

test('Unified Frame - zero Tab-toggle surface in src/', () => {
  const qo = fs.readFileSync(path.join(ROOT_DIR, 'src', 'components', 'QuickOverlay.tsx'), 'utf8');
  // No Tab key branch anywhere in the overlay (Tab keeps native focus duty).
  assert.doesNotMatch(qo, /e\.key === 'Tab'/, 'no Tab key branch may remain');
  assert.doesNotMatch(qo, /togglePreview/, 'no toggle callback may remain');
  assert.doesNotMatch(qo, /setPreviewOpen|previewOpenRef|targetPreviewOpen/, 'no preview boolean state may remain');
  assert.doesNotMatch(qo, /set_overlay_preview|preview-toggled/, 'no native toggle invoke/listener may remain');
  assert.doesNotMatch(
    qo,
    /no-preview|preview-out|snap-veil|kids-veil|'\.collapsed'|"collapsed"/,
    'no collapse/veil class logic may remain'
  );
  // Footer carries no toggle hint.
  assert.doesNotMatch(qo, /Hide Preview|Show Preview/, 'no toggle footer hint may remain');

  const choreoTs = fs.readFileSync(path.join(ROOT_DIR, 'src', 'lib', 'choreo.ts'), 'utf8');
  assert.doesNotMatch(
    choreoTs,
    /createPreviewLayoutController|LayoutTransitionController|setWindowPreviewSize|notifySnapPresented/,
    'the layout controller must be gone from choreo.ts'
  );

  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  assert.doesNotMatch(hotkeyRs, /1020|680/, 'no compact/expanded geometry literals may remain');
  const choreoRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'choreo.rs'), 'utf8');
  assert.doesNotMatch(
    choreoRs,
    /set_overlay_preview|PreviewToggled|preview-toggled/,
    'the native toggle resize path must be gone'
  );
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf8');
  assert.doesNotMatch(
    libRs,
    /set_overlay_preview|choreo_set_overlay_preview/,
    'the toggle commands must be unregistered'
  );
  const settingsRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'settings.rs'), 'utf8');
  assert.doesNotMatch(
    settingsRs,
    /preview_enabled/,
    'the persisted toggle setting must be gone from Rust'
  );
});

test('Unified Frame - fixed 750x475 geometry owned by the window', () => {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const overlay = conf.app.windows.find((w) => w.label === 'overlay');
  assert.ok(overlay, 'overlay window entry must exist');
  assert.equal(overlay.width, 750, 'overlay width must be 750');
  assert.equal(overlay.height, 475, 'overlay height must be 475');
  assert.equal(overlay.resizable, false, 'overlay must not be resizable');
  assert.equal(overlay.maximizable, false, 'overlay must not be maximizable');
  assert.equal(overlay.fullscreen, false, 'overlay must not be fullscreen');
  assert.equal(overlay.transparent, true, 'overlay must stay transparent');
  assert.equal(overlay.center, false, 'position is resolved once per show from Rust');

  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  assert.ok(
    hotkeyRs.includes('pub const OVERLAY_WIDTH: i32 = 750;'),
    'Rust must own the fixed width constant'
  );
  assert.ok(
    hotkeyRs.includes('pub const OVERLAY_HEIGHT: i32 = 475;'),
    'Rust must own the fixed height constant'
  );

  const css = fs.readFileSync(path.join(ROOT_DIR, 'src', 'index.css'), 'utf8');
  for (const token of ['--overlay-w: 750px', '--overlay-h: 475px', '--media-cap: 260px', '--info-h: 175px']) {
    assert.ok(css.includes(token), `CSS must define the ${token} token`);
  }
  assert.ok(css.includes('flex: 0 0 40%;'), 'list column must be pinned at 40%');
  assert.ok(css.includes('flex: 0 0 60%;'), 'preview column must be pinned at 60% (larger than the list)');
});

test('Unified Frame - permanent preview pane with media cap and info block', () => {
  const css = fs.readFileSync(path.join(ROOT_DIR, 'src', 'index.css'), 'utf8');
  // Namespaced wrappers: bare .preview-media belongs to the library image
  // wrapper (centered column) and must never match the overlay structure —
  // that collision shrank overlay text into a small centered box.
  assert.ok(
    css.includes('.overlay-preview .ov-preview-media'),
    'overlay media wrapper must be namespaced'
  );
  // Render container hugs content: the shared flex-grow stretched short
  // boxes (white rich card) into tall voids.
  assert.ok(
    css.includes('.overlay-preview .preview-render'),
    'overlay render container must hug content'
  );
  // Info pinned at the bottom: the media absorbs free space (flex-grow,
  // capped) so small images/texts can't drag the info block up.
  assert.ok(
    css.includes('flex: 1 1 auto;'),
    'overlay media must grow to pin the info block at the bottom'
  );
  assert.ok(
    css.includes('.overlay-preview .ov-preview-info'),
    'overlay info wrapper must be namespaced'
  );
  assert.ok(
    css.includes('align-items: stretch;'),
    'overlay media must stretch edge-to-edge'
  );
  assert.ok(
    css.includes('max-height: var(--media-cap);'),
    'media area must be capped at 260px'
  );
  assert.ok(
    css.includes('.overlay-preview .ov-preview-info'),
    'Information block must exist'
  );
  // Information block hugs its rows up to the cap (no internal gaps) while
  // the growing media area keeps it bottom-anchored.
  const infoRuleIdx = css.indexOf('.overlay-preview .ov-preview-info {');
  assert.ok(infoRuleIdx !== -1, 'Information block rule must exist');
  const infoRule = css.slice(infoRuleIdx, css.indexOf('}', infoRuleIdx));
  assert.ok(infoRule.includes('height: auto;'), 'info block must size to content');
  assert.ok(
    infoRule.includes('max-height: var(--info-h);'),
    'info block must cap at 175px and scroll beyond'
  );
  assert.ok(
    css.includes('.overlay-preview-empty'),
    'permanent-pane empty state must exist'
  );
  // Compact overlay media box: no tall voids around small images, and the
  // box stays inside the 260px cap (library sizing untouched — overlay scope).
  assert.ok(
    css.includes('.overlay-preview .preview-image-simple'),
    'overlay must hug images instead of min-height voids'
  );
  // No collapse machinery: the pane can never reach width 0.
  assert.doesNotMatch(css, /\.overlay-preview\.collapsed/, 'collapsed pane rule must be gone');
  assert.doesNotMatch(css, /\.overlay-preview\.preview-out/, 'preview-out rule must be gone');
  assert.doesNotMatch(css, /\.overlay-preview\.snap-veil/, 'snap-veil rule must be gone');

  const qo = fs.readFileSync(path.join(ROOT_DIR, 'src', 'components', 'QuickOverlay.tsx'), 'utf8');
  assert.ok(
    qo.includes('<div className="overlay-preview">'),
    'preview pane must mount unconditionally'
  );
  assert.ok(
    qo.includes('Nothing selected'),
    'empty list must render an in-pane placeholder, never unmount'
  );
  assert.ok(
    qo.includes('placeholder="Type to filter entries…"'),
    'filter input must carry the unified placeholder'
  );
});

test('Unified Frame - media types skip the preview header for image space', () => {
  // Overlay: image/file render no kind/seg header so the image uses the
  // freed space; text keeps the head (Render/Raw toggle lives there).
  const qo = fs.readFileSync(path.join(ROOT_DIR, 'src', 'components', 'QuickOverlay.tsx'), 'utf8');
  assert.ok(
    qo.includes('Media types get the full pane'),
    'overlay must gate the preview head on media type'
  );
  assert.ok(
    qo.includes('<div className="overlay-preview-head">'),
    'overlay must keep the head for text'
  );
  // Main window: heading gated the same way, but the action buttons stay
  // (right-aligned for media via marginLeft auto).
  const enlarged = fs.readFileSync(path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'), 'utf8');
  assert.ok(
    enlarged.includes('Media types skip the kind/seg heading'),
    'main preview must gate the heading on media type'
  );
  assert.ok(
    enlarged.includes('<div className="preview-actions"'),
    'main preview must keep the action buttons'
  );
  assert.ok(
    enlarged.includes('<div className="preview-head">'),
    'main preview must keep the head for text'
  );
});

test('Unified Frame - selection contract without layout mutation', () => {
  const qo = fs.readFileSync(path.join(ROOT_DIR, 'src', 'components', 'QuickOverlay.tsx'), 'utf8');
  // Arrow keys drive the single selectedEntry source of truth.
  assert.ok(qo.includes("e.key === 'ArrowDown'"), 'ArrowDown must navigate');
  assert.ok(qo.includes("e.key === 'ArrowUp'"), 'ArrowUp must navigate');
  // First entry auto-selected when data lands.
  assert.ok(
    qo.includes('setSelectedIndex(0);'),
    'selection must reset to the first entry on data'
  );
  // Paste + Actions footer intact; shortcuts unchanged.
  assert.ok(qo.includes('Ctrl+K'), 'Actions shortcut must survive');
  assert.ok(qo.includes('>Paste</b>') || qo.includes("`Paste to ${targetApp}`"), 'Paste action must survive');
});
