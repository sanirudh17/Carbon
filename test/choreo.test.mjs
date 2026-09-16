import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const SRC_TAURI_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

/**
 * Recursively collects all files matching extensions in a directory.
 */
function walk(dir, exts = ['.ts', '.tsx', '.js', '.jsx', '.rs', '.css']) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'target' && entry.name !== 'dist' && entry.name !== '.git') {
        files.push(...walk(full, exts));
      }
    } else if (exts.some(ext => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

test('ADDENDUM v15 - Static grep: zero choreography calls outside choreo modules', () => {
  const tsFiles = walk(SRC_DIR, ['.ts', '.tsx', '.js', '.jsx']);
  const choreoTs = path.normalize(path.join(SRC_DIR, 'lib', 'choreo.ts'));

  const prohibitedInFrontend = [
    'set_overlay_preview',
    'hide_overlay',
    'hide_enlarged',
    'overlay_painted',
    'enlarged_painted',
  ];

  const violations = [];

  for (const file of tsFiles) {
    if (path.normalize(file) === choreoTs) continue;
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
      for (const token of prohibitedInFrontend) {
        // Look for invoke('token' or invoke("token"
        const regex = new RegExp(`invoke\\(['"]${token}['"]`);
        if (regex.test(line)) {
          violations.push(`${path.relative(ROOT_DIR, file)}:${idx + 1} calls invoke('${token}')`);
        }
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Found direct choreography invokes outside src/lib/choreo.ts:\n${violations.join('\n')}`
  );
});

test('ADDENDUM v15 - Invariant I1: Window becomes visible ONLY after paint gate (no timer fallback)', () => {
  const choreoTsPath = path.join(SRC_DIR, 'lib', 'choreo.ts');
  const choreoContent = fs.readFileSync(choreoTsPath, 'utf-8');

  // Must enforce windowLoaded AND isPainted AND framesSinceShow >= 2
  assert.ok(
    choreoContent.includes('windowLoaded && isPainted && framesSinceShow >= 2'),
    'choreo.ts must enforce I1: windowLoaded && isPainted && framesSinceShow >= 2'
  );

  // Must not have a timer that unhides or uncloaks without gate
  const lines = choreoContent.split('\n');
  let inExecuteWindowShow = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('function executeWindowShow')) inExecuteWindowShow = true;
    if (inExecuteWindowShow && line.includes('function executeWindowHide')) inExecuteWindowShow = false;

    if (inExecuteWindowShow && (line.includes('setTimeout') || line.includes('window.setTimeout'))) {
      // Any timeout inside executeWindowShow must only be a dev warning, not an unhide!
      const snippet = lines.slice(i, i + 8).join('\n');
      assert.ok(
        !snippet.includes('classList.remove(\'wm-hidden\')'),
        'executeWindowShow must NEVER lift wm-hidden on a timeout fallback'
      );
    }
  }
});

test('ADDENDUM v15 - Invariant I4: Fade target per mode (Glass -> html, Solid -> #root)', () => {
  const cssPath = path.join(SRC_DIR, 'index.css');
  const cssContent = fs.readFileSync(cssPath, 'utf-8');

  assert.ok(
    cssContent.includes('html:not([data-material="solid"]).wm-hiding'),
    'CSS must fade html in glass mode'
  );
  assert.ok(
    cssContent.includes('html:not([data-material="solid"]) #root.wm-fade-target'),
    'CSS must keep #root opacity: 1 in glass mode'
  );
  assert.ok(
    cssContent.includes('html[data-material="solid"].wm-hiding #root.wm-fade-target'),
    'CSS must fade #root in solid mode'
  );
});

test('ADDENDUM v15 - Invariant I6: Footer hints, keys and labels swap instantly with zero opacity/transform transition', () => {
  const cssPath = path.join(SRC_DIR, 'index.css');
  const cssContent = fs.readFileSync(cssPath, 'utf-8');

  assert.ok(
    cssContent.includes('.overlay-bar') && cssContent.includes('.hint'),
    'CSS must target overlay-bar and hint elements'
  );
  assert.ok(
    cssContent.includes('transition-property: background-color, border-color, color !important;'),
    'CSS must restrict footer transitions to background-color, border-color, and color only'
  );
});

test('ADDENDUM v15 - Visual Canary: frame-by-frame audit runs with zero violations', async () => {
  const canaryScript = path.join(ROOT_DIR, 'scripts', 'visual-canary.mjs');
  assert.ok(fs.existsSync(canaryScript), 'scripts/visual-canary.mjs must exist');
  // Dynamically import the script to execute the simulation
  await import(`file://${canaryScript.replace(/\\/g, '/')}`);
});

test('ADDENDUM v16 - F1: Flash-safe hide (DWM cloak before hide, cloak-only fallback)', () => {
  const hotkeyRsPath = path.join(SRC_TAURI_DIR, 'hotkey.rs');
  const hotkeyContent = fs.readFileSync(hotkeyRsPath, 'utf-8');

  // Fallback logs and emits choreo-hide-fallback
  assert.ok(
    hotkeyContent.includes('[HOTKEY] hide fallback: cloaked (flash-safe)'),
    'hotkey.rs fallback must log "[HOTKEY] hide fallback: cloaked (flash-safe)"'
  );
  assert.ok(
    hotkeyContent.includes('app2.emit("choreo-hide-fallback"'),
    'hotkey.rs must emit "choreo-hide-fallback" event'
  );

  // set_window_cloaked is called before win.hide()
  assert.ok(
    hotkeyContent.includes('set_window_cloaked(&win, true);'),
    'hotkey.rs must call set_window_cloaked(&win, true) before win.hide()'
  );

  // Frontend listens to choreo-hide-fallback
  const choreoTsPath = path.join(SRC_DIR, 'lib', 'choreo.ts');
  const choreoContent = fs.readFileSync(choreoTsPath, 'utf-8');
  assert.ok(
    choreoContent.includes('choreo-hide-fallback'),
    'choreo.ts must listen to choreo-hide-fallback to flash canary'
  );
});

test('FLASHFIX - Open: snap-unhide before uncloak + forced present while cloaked', () => {
  const choreoTsPath = path.join(SRC_DIR, 'lib', 'choreo.ts');
  const content = fs.readFileSync(choreoTsPath, 'utf-8');
  // Gate must lift the mask with transitions snapped off BEFORE asking Rust
  // to uncloak, so uncloak can never land mid-fade over bare acrylic.
  const gateIdx = content.indexOf('framesSinceShow >= 2');
  const noAnimIdx = content.indexOf("classList.add('no-anim')");
  const paintedIdx = content.indexOf("invoke(paintedCmd)");
  assert.ok(gateIdx !== -1 && noAnimIdx > gateIdx, 'show gate must snap-unhide with no-anim');
  assert.ok(paintedIdx > noAnimIdx, 'painted ack (uncloak) must come after the snap-unhide');

  const hotkeyRsPath = path.join(SRC_TAURI_DIR, 'hotkey.rs');
  const hotkeyContent = fs.readFileSync(hotkeyRsPath, 'utf-8');
  assert.ok(
    hotkeyContent.includes('fn present_window_now'),
    'hotkey.rs must force a synchronous present while still cloaked'
  );
  assert.ok(
    hotkeyContent.includes('present_window_now(&win);'),
    'uncloak paths must present before revealing'
  );
});

test('FLASHFIX - Close: cloak-first hide so the fade plays invisibly', () => {
  const choreoTsPath = path.join(SRC_DIR, 'lib', 'choreo.ts');
  const content = fs.readFileSync(choreoTsPath, 'utf-8');
  assert.ok(
    content.includes("invoke('cloak_window', { windowLabel: windowName })"),
    'executeWindowHide must cloak the window before fading'
  );
  const choreoRsPath = path.join(SRC_TAURI_DIR, 'choreo.rs');
  const choreoRs = fs.readFileSync(choreoRsPath, 'utf-8');
  assert.ok(
    choreoRs.includes('pub fn cloak_window'),
    'choreo.rs must expose a cloak-only command'
  );
  const libRsPath = path.join(SRC_TAURI_DIR, 'lib.rs');
  const libRs = fs.readFileSync(libRsPath, 'utf-8');
  assert.ok(
    libRs.includes('cloak_window,'),
    'lib.rs must register the cloak_window command'
  );
  // Cancel-hide must enter Showing first: the gate's painted ack only
  // uncloaks from Showing/Shown, and the window may already be cloaked.
  const qoPath = path.join(SRC_DIR, 'components', 'QuickOverlay.tsx');
  const qo = fs.readFileSync(qoPath, 'utf-8');
  const cancelIdx = qo.indexOf('overlay-cancel-hide');
  const showingIdx = qo.indexOf("overlayPhaseRef.current = 'showing'", cancelIdx);
  assert.ok(cancelIdx !== -1 && showingIdx > cancelIdx, 'cancel-hide must enter Showing before re-show gate');
});

test('FLASHFIX2 - Main open: cloaked settle for the heavy tree', () => {
  const choreoTsPath = path.join(SRC_DIR, 'lib', 'choreo.ts');
  const content = fs.readFileSync(choreoTsPath, 'utf-8');
  assert.ok(content.includes('settleMs: number = 0'), 'executeWindowShow must accept a cloaked settle');
  assert.ok(content.includes('await new Promise'), 'settle must wait invisibly before unhide');
  const appPath = path.join(SRC_DIR, 'App.tsx');
  const app = fs.readFileSync(appPath, 'utf-8');
  assert.ok(
    app.includes("executeWindowShow('main', undefined, 150)"),
    'main open must settle 150ms cloaked for rows/images'
  );
});

test('MAIN-NOSHOW - Show/hide milestones are terminal-visible', () => {
  const choreoTsPath = path.join(SRC_DIR, 'lib', 'choreo.ts');
  const content = fs.readFileSync(choreoTsPath, 'utf-8');
  assert.ok(content.includes('traceChoreo'), 'choreo.ts must expose traceChoreo');
  assert.ok(content.includes('show gate opened'), 'show gate must trace on open');
  assert.ok(content.includes('invoking ${paintedCmd} (uncloak)'), 'painted ack must trace');
  const appPath = path.join(SRC_DIR, 'App.tsx');
  const app = fs.readFileSync(appPath, 'utf-8');
  assert.ok(app.includes('main enlarged-opened received'), 'main open must trace receipt');
  assert.ok(app.includes('main doHide start'), 'main hide must trace its trigger');
  const hotkeyRsPath = path.join(SRC_TAURI_DIR, 'hotkey.rs');
  const hotkey = fs.readFileSync(hotkeyRsPath, 'utf-8');
  assert.ok(hotkey.includes('[SHOW_MAIN] uncloaked after forced present'), 'uncloak must log its result');
  assert.ok(hotkey.includes('post-show is_visible='), 'show must log post-show visibility');
  assert.ok(hotkey.includes('[HIDE_MAIN] hide-requested gen='), 'hide requests must log their gen');
  const libRsPath = path.join(SRC_TAURI_DIR, 'lib.rs');
  assert.ok(
    fs.readFileSync(libRsPath, 'utf-8').includes('[HIDE_MAIN] hide_enlarged invoked'),
    'native hide must log its invocation'
  );
});

test('TAB-NEAT - Async preview media never pops white while decoding', () => {
  const cssPath = path.join(SRC_DIR, 'index.css');
  const css = fs.readFileSync(cssPath, 'utf-8');
  assert.ok(css.includes('.overlay-preview-content img'), 'preview images need a dark placeholder');
  assert.ok(css.includes('rgba(10, 10, 12, 0.35)'), 'placeholder must be dark, never white');
});

test('reveal parity - overlay pops exactly like the main window (OS ramp only)', () => {
  // The overlay must not stack its own content fade on top of the OS
  // ramp: that double motion read as sluggish next to the main window.
  // Both windows reveal via the 100ms OS-alpha ramp and nothing else.
  const choreo = fs.readFileSync(path.join(SRC_DIR, 'lib', 'choreo.ts'), 'utf8');
  assert.ok(!choreo.includes('armOverlayReveal'), 'no overlay-only reveal helper may exist');
  assert.ok(!choreo.includes('ov-reveal'), 'no reveal class may be armed');
  const css = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
  assert.ok(!css.includes('ov-reveal-in'), 'no reveal keyframes may remain');
  const hotkey = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  assert.ok(
    hotkey.includes('ramp_window_alpha(win.clone(), 0, 255, 100, expected_token, true);'),
    'overlay ramp must match main at 100ms'
  );
  assert.ok(
    hotkey.includes('ramp_window_alpha(win.clone(), 0, 255, 100, expected_token, false);'),
    'main ramp must stay 100ms'
  );
  // Hide machinery untouched: 90ms hide fades stay.
  assert.ok(css.includes('opacity 90ms'), 'hide fades must stay at 90ms');
});

test('first-paint hardening - background application is verified and retried hidden-side', () => {
  const vib = fs.readFileSync(path.join(SRC_TAURI_DIR, 'vibrancy.rs'), 'utf8');
  assert.ok(
    vib.includes('pub fn set_window_default_background(') && vib.includes('-> bool'),
    'default-background fn must report success'
  );
  const bg = fs.readFileSync(path.join(SRC_TAURI_DIR, 'webview_bg.rs'), 'utf8');
  assert.ok(
    bg.includes('pub fn set_webview_transparent_background') && bg.includes('-> bool'),
    'transparent-background fn must report success'
  );
  const hotkey = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf8');
  assert.ok(hotkey.includes('background retry attempt'), 'prepare_main_surface must retry on failure');
  assert.ok(hotkey.includes('do not touch mid-show') || hotkey.includes('live surface now'), 'retry must skip visible windows');
  assert.ok(hotkey.includes('1..=3'), 'retry must be bounded');
  // Overlay reveal ramp untouched by this change (parity with main: 100ms).
  assert.ok(
    hotkey.includes('ramp_window_alpha(win.clone(), 0, 255, 100, expected_token, true);'),
    'overlay ramp must match main at 100ms'
  );
});

test('ui-ready fires post-paint, never at module evaluation', () => {
  const main = fs.readFileSync(path.join(SRC_DIR, 'main.tsx'), 'utf8');
  assert.ok(!main.includes('carbon-ui-ready'), 'main.tsx must not emit readiness at module scope');
  const app = fs.readFileSync(path.join(SRC_DIR, 'App.tsx'), 'utf8');
  assert.ok(app.includes("emit('carbon-ui-ready')"), 'App must emit readiness');
  assert.ok(app.includes('requestAnimationFrame'), 'readiness must wait for paint frames');
  assert.ok(app.includes('uiReadySent'), 'readiness must be once-guarded for StrictMode');
});
