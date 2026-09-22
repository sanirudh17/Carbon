import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ADDENDUM v36 C — corner-only rim discrimination (C1 i–iv).
// Straight edges are already clean (v35 W3). This locks the four corner
// suspects so a 400% corner crop over dark wallpaper has nothing left to
// paint a rim: (i) DWM border, (ii) controller background, (iii) CSS ring,
// (iv) radius mismatch. Live re-shoot confirms on hardware; the code
// contracts below are what make the re-shoot pass deterministically.

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

function readCss() {
  return stripComments(
    fs.readFileSync(path.join(ROOT_DIR, 'src', 'index.css'), 'utf8')
  );
}

// First rule whose selector list contains the needle; exact selector hits
// win over descendant hits (theme overrides come first in the file).
function ruleFor(css, needle) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  let fallback = null;
  while ((m = re.exec(css)) !== null) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (sels.some((s) => s === needle)) return m[2];
    if (!fallback && sels.some((s) => s.endsWith(' ' + needle))) fallback = m[2];
  }
  if (fallback) return fallback;
  assert.fail(`CSS rule not found for ${needle}`);
}

test('C1(i) DWM drawn border suppressed on every open, both windows', () => {
  const vibrancy = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'vibrancy.rs'),
    'utf8'
  );
  const hotkey = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'),
    'utf8'
  );
  for (const [name, src] of [['vibrancy.rs', vibrancy], ['hotkey.rs', hotkey]]) {
    assert.ok(src.includes('DWMWA_BORDER_COLOR'), `${name} sets DWMWA_BORDER_COLOR`);
    assert.ok(src.includes('0xFFFFFFFE'), `${name} uses DWMWA_COLOR_NONE (no color)`);
  }
  assert.ok(
    hotkey.includes('disable_window_dwm_transitions(&win)'),
    'every open re-asserts suppression (both ensure fns)'
  );
});

test('C1(ii) controller default is transparent so corner AA blends to desktop', () => {
  const bg = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'webview_bg.rs'),
    'utf8'
  );
  assert.ok(bg.includes('A: 0'), 'creation default must be fully transparent (A:0)');
  const vibrancy = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'vibrancy.rs'),
    'utf8'
  );
  assert.ok(
    vibrancy.includes('_ => COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 }'),
    'glass-family materials must stay transparent (acrylic composites desktop blur)'
  );
  const hotkey = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'),
    'utf8'
  );
  const transparentCalls = (hotkey.match(/set_webview_transparent_background\(/g) || []).length;
  assert.ok(transparentCalls >= 4, `all create/recreate paths must force transparent (found ${transparentCalls})`);
});

test('C1(iii) no CSS ring traces the window radius on html/body/#root/surface', () => {
  const css = readCss();
  for (const sel of ['html', 'body', '#root', '.overlay', '.enlarged']) {
    const body = ruleFor(css, sel);
    assert.doesNotMatch(body, /box-shadow\s*:[^;]*inset/, `${sel} must have no inset box-shadow`);
    const borders = [...body.matchAll(/(^|;)\s*border\s*:[^;]*/g)].map((m) => m[0]);
    for (const b of borders) {
      assert.ok(/none/.test(b), `${sel} must carry no perimeter border (found '${b.trim()}')`);
    }
    const outlines = [...body.matchAll(/(^|;)\s*outline\s*:[^;]*/g)].map((m) => m[0]);
    for (const o of outlines) {
      assert.ok(/none/.test(o), `${sel} must carry no outline (found '${o.trim()}')`);
    }
  }
});

test('C1(iv) single radius: DWM ROUND + identical CSS radius everywhere', () => {
  const hotkey = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'),
    'utf8'
  );
  const vibrancy = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'vibrancy.rs'),
    'utf8'
  );
  assert.ok(
    vibrancy.includes('DWMWA_WINDOW_CORNER_PREFERENCE'),
    'corners must be DWM-owned'
  );
  assert.ok(
    /preference\s*=\s*2i32|DWMWCP_ROUND/.test(vibrancy),
    'DWM preference must be ROUND'
  );
  const css = readCss();
  for (const sel of ['body', '.overlay', '.enlarged']) {
    const body = ruleFor(css, sel);
    const radii = [...body.matchAll(/border-radius\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const r of radii) {
      assert.equal(r, '8px', `${sel} radius must be the single 8px DWM-arc match (found '${r}')`);
    }
  }
  // The window-body rules must actually declare the radius (html itself stays unshaped).
  assert.ok(ruleFor(css, 'body.win-overlay').includes('border-radius: 8px'), 'overlay body declares 8px');
  assert.ok(ruleFor(css, 'body.win-library').includes('border-radius: 8px'), 'library body declares 8px');
  assert.ok(ruleFor(css, '.overlay').includes('border-radius: 8px'), 'overlay surface declares 8px');
  assert.ok(ruleFor(css, '.enlarged').includes('border-radius: 8px'), 'main surface declares 8px');
  void hotkey;
});

test('C2 both themes: solid opaque match, glass transparent (corners indistinguishable)', () => {
  const css = readCss();
  assert.ok(
    css.includes('--glass-highlight: none') || css.includes('--glass-highlight:none'),
    'solid must disable the inset highlight token entirely'
  );
  const vibrancy = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'vibrancy.rs'),
    'utf8'
  );
  assert.ok(
    vibrancy.includes('WindowMaterial::Solid if theme.eq_ignore_ascii_case("light")'),
    'solid light must use its own opaque controller match'
  );
});
