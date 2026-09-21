import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// v37 — picker close matches library close; no painted lines in the overlay.
// Hide is ONE plain html fade on both windows (the overlay-only content
// zoom is gone). Overlay chrome separates panes by background tone, never
// by 1px hairlines.

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

function readCss() {
  return stripComments(
    fs.readFileSync(path.join(ROOT_DIR, 'src', 'index.css'), 'utf8')
  );
}

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

test('v37 hide parity: no content-layer animation on either window', () => {
  const css = readCss();
  for (const sel of ['#content', '.overlay-content']) {
    const body = ruleFor(css, sel);
    assert.doesNotMatch(body, /transform/, `${sel} must not scale (plain html fade only)`);
    assert.doesNotMatch(body, /transition/, `${sel} must not transition (plain html fade only)`);
    assert.doesNotMatch(body, /will-change/, `${sel} must not pin a compositor layer`);
  }
  assert.doesNotMatch(css, /\.overlay-content\.content-fading/, 'dead fading classes must be gone');
  // The single shared html fade remains for both windows.
  assert.ok(css.includes('html.wm-hidden'), 'shared hidden mask stays');
  assert.ok(css.includes('opacity 90ms'), 'shared 90ms fade stays');
});

test('v37 overlay chrome: no painted hairlines between panes', () => {
  const css = readCss();
  const bar = ruleFor(css, '.overlay-bar');
  assert.doesNotMatch(bar, /border-top\s*:\s*1px/, 'bottom bar must not draw a top line');
  const divider = ruleFor(css, '.overlay-preview::before');
  assert.doesNotMatch(divider, /width\s*:\s*1px/, 'no full-height vertical line');
  assert.doesNotMatch(divider, /background\s*:\s*var\(--glass-hairline\)/, 'divider must not paint');
  const info = ruleFor(css, '.overlay-preview .ov-preview-info');
  assert.doesNotMatch(info, /border-top\s*:\s*1px/, 'info block must not draw a top line');
  const head = ruleFor(css, '.overlay-preview-head');
  assert.doesNotMatch(head, /border-bottom\s*:\s*1px/, 'preview head must not draw a bottom line');
});

test('v37 shared structural hairlines untouched (meta strip, pills, controls)', () => {
  const css = readCss();
  assert.ok(css.includes('.meta-row + .meta-row'), 'meta separators stay (real UI, not rim)');
  assert.ok(css.includes('.preview-link-card'), 'v35 link card untouched');
});

test('v37 read section and preview chrome: no painted border lines in overlay or main', () => {
  const css = readCss();
  for (const sel of ['.preview-text.mono', '.preview-text.plain', '.sn-content-preview', '.preview-edit', '.preview-file-card', '.preview-image-wrapper']) {
    const body = ruleFor(css, sel);
    assert.doesNotMatch(body, /border\s*:\s*1px/, `${sel} must not draw a border box`);
  }
  const mainDivider = ruleFor(css, '.preview::before');
  assert.doesNotMatch(mainDivider, /width\s*:\s*1px/, 'main preview must not draw a vertical line');
  assert.doesNotMatch(mainDivider, /background\s*:\s*var\(--glass-hairline\)/, 'main divider must not paint');
  const mainHead = ruleFor(css, '.preview-head');
  assert.doesNotMatch(mainHead, /border-bottom\s*:\s*1px/, 'main preview head must not draw a bottom line');
  const mainFoot = ruleFor(css, '.preview-foot');
  assert.doesNotMatch(mainFoot, /border-top\s*:\s*1px/, 'main preview foot must not draw a top line');
});

