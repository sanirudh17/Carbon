import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ADDENDUM v35 W3 — seamless window edges (remove the white rim).
// Window roots (overlay + main, both materials) carry NO perimeter border
// (including the ::after hairline), NO inset highlight, and NO OS shadow
// (Tauri shadow:false — the DWM drop shadow rendered as a wide white margin
// around the transparent frameless windows). Edge definition comes from the
// in-CSS dark var(--glass-shadow) + acrylic/base contrast only. Inner
// floating surfaces keep their hairlines.
// W5 (same commit): LINK-type preview card auto-heights to content.

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function readCss() {
  return fs.readFileSync(path.join(ROOT_DIR, 'src', 'index.css'), 'utf8');
}

function blockFor(src, selectorRe) {
  const m = src.match(selectorRe);
  assert.ok(m, 'window root block found');
  const start = m.index;
  const open = src.indexOf('{', start);
  const close = src.indexOf('}', open);
  return src.slice(open, close);
}

test('W3.2 overlay root: no inset highlight, no hairline, CSS shadow edge', () => {
  const css = readCss();
  const body = blockFor(css, /\.overlay,\s*\.overlay-window\s*\{/);
  assert.doesNotMatch(body, /glass-highlight/, 'overlay root must not paint an inset highlight');
  assert.ok(body.includes('var(--glass-shadow)'), 'overlay edge stays defined by the CSS shadow');
  assert.ok(body.includes('border: none'), 'overlay root must carry no perimeter border');
});

test('W3.2 main root: no inset highlight, no hairline, CSS shadow edge', () => {
  const css = readCss();
  const body = blockFor(css, /\.enlarged\s*\{/);
  assert.doesNotMatch(body, /glass-highlight/, 'main root must not paint an inset highlight');
  assert.ok(body.includes('var(--glass-shadow)'), 'main edge stays defined by the CSS shadow');
  assert.ok(body.includes('border: none'), 'main root must carry no perimeter border');
});

test('W3.2b overlay ::after pseudo-border must not paint a white hairline', () => {
  const css = readCss();
  const m = css.match(/\.overlay::after,\s*\.enlarged::after\s*\{[^}]*\}/);
  assert.ok(m, 'overlay ::after rule must exist (kept as a no-op)');
  assert.doesNotMatch(m[0], /border:\s*1px/, 'no 1px perimeter hairline on ::after');
  assert.ok(m[0].includes('border: none'), '::after must draw no border');
  assert.doesNotMatch(css, /border-color:\s*rgba\(0,\s*0,\s*0,\s*0\.12\)/, 'no light-theme hairline either');
});

test('W3.2 inner surfaces keep their hairlines (not flattened)', () => {
  const css = readCss();
  const floatUses = (css.match(/var\(--surface-float-highlight\)/g) || []).length;
  assert.ok(floatUses >= 5, `floating surfaces must keep inset highlights (found ${floatUses})`);
  assert.ok(
    css.includes('.segmented-control .seg-btn.active'),
    'inner controls keep their own highlight rules'
  );
});

test('W3.3 frameless discipline intact: no NC border can paint', () => {
  const conf = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8')
  );
  for (const win of conf.app.windows.filter((w) => w.label === 'overlay' || w.label === 'main')) {
    assert.equal(win.decorations, false, `${win.label} must stay frameless (no NC border)`);
    assert.equal(win.shadow, false, `${win.label} must not draw the OS shadow (white margin)`);
  }
  const vibrancy = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'vibrancy.rs'),
    'utf8'
  );
  assert.ok(vibrancy.includes('0xFFFFFFFE'), 'DWM border suppression (COLOR_NONE) stays in place');
  assert.ok(
    vibrancy.includes('DWMWA_WINDOW_CORNER_PREFERENCE'),
    'rounded corners stay DWM-owned'
  );
});

test('W5 link preview card auto-heights (min 96px, max 40% pane)', () => {
  const css = readCss();
  const m = css.match(/\.preview-link-card\s*\{[^}]*\}/);
  assert.ok(m, '.preview-link-card rule must exist');
  assert.ok(m[0].includes('min-height: 96px'), 'card floors at 96px');
  assert.ok(m[0].includes('max-height: 40%'), 'card caps at 40% of the pane');
  const preview = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'ClipPreview.tsx'),
    'utf8'
  );
  assert.ok(
    preview.includes('preview-text plain preview-link-card'),
    'link/email branch must render the auto-height card'
  );
});
