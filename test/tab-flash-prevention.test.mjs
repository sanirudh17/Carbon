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
  // picker open on disk I/O. Cache may be read; the DB must only be touched
  // from the background refresh thread spawned after the emit.
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
  const spawnIdx = fnBody.indexOf('std::thread::spawn');
  assert.ok(spawnIdx > emitIdx, 'the fresh DB refresh must run on a background thread post-emit');

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
  const showIdx = handler.indexOf("executeWindowShow('overlay'");
  assert.ok(showIdx !== -1, 'handler must run the paint-gated show');
  const preShow = handler.slice(0, showIdx);
  assert.doesNotMatch(preShow, /fetchItems\(\)/, 'no clip fetch may precede the paint gate');
  assert.doesNotMatch(preShow, /fetchSnippets\(\)/, 'no snippet fetch may precede the paint gate');
  assert.doesNotMatch(preShow, /get_settings/, 'no settings round-trip may precede the paint gate');

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

  // Reversibility: the original full rules must still be present verbatim.
  assert.ok(
    css.includes('transform: scale(0.985) !important;'),
    'full-mode hide zoom must remain for mode "full"'
  );
  assert.ok(
    css.includes('transition: opacity 90ms cubic-bezier(0.16, 1, 0.3, 1),'),
    'full-mode 90ms hide fade must remain for mode "full"'
  );

  // Soft mode: opacity-only shorter fade, scoped behind data-anim="soft".
  const softIdx = css.indexOf('html[data-anim="soft"].wm-hiding #content');
  assert.ok(softIdx !== -1, 'soft override must exist for the hide content layer');
  const softBlock = css.slice(softIdx, softIdx + 600);
  assert.ok(softBlock.includes('transform: none !important;'), 'soft mode must drop the zoom');
  assert.ok(softBlock.includes('opacity 60ms linear'), 'soft mode must shorten the fade');
  assert.doesNotMatch(softBlock, /cloak|painted|mask|watchdog/i, 'soft CSS must not touch flash guards');

  // The overlay must always set the attribute (soft fallback), so CSS never
  // depends on a missing-attribute state.
  const overlayTsx = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'QuickOverlay.tsx'),
    'utf8'
  );
  assert.ok(
    overlayTsx.includes('document.documentElement.dataset.anim = anim'),
    'overlay must apply the animation mode from settings'
  );

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
    assert.ok(showIdx !== -1 && showIdx < 800, 'surface prep must precede show() in its branch');
  }
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
  assert.ok(
    css.includes('height: var(--info-h);'),
    'Information block must be fixed at 175px'
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
