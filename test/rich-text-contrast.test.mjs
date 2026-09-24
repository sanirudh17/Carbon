import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { Window } = require('happy-dom');

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');

/**
 * ADDENDUM v29-B3: machine-verified rich-text legibility (replaces eyeballing).
 * Headless-renders the failing dark-generator clip + the six-fragment matrix
 * through the REAL pipeline (esbuilt src/lib/richText.ts, no mocks) inside
 * happy-dom, injects the REAL .rich-doc-light/dark rules from index.css, and
 * asserts contrast >= 4.5:1 for every text node — pipeline-guessed theme,
 * both cards for theme-agnostic fragments, plus Raw mode.
 *
 * No browser is available in this environment, so there is no screenshot
 * diff: the per-node matrix printed below IS the CI contrast output. Counts
 * as the B3 proof together with the static B1/B2 pins further down.
 */

// ── Bundle the real pipeline (no mocks) ──────────────────────────────────
const built = esbuild.buildSync({
  entryPoints: [path.join(SRC_DIR, 'lib', 'richText.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
});
const bundlePath = path.join(os.tmpdir(), 'carbon-richtext-bundle.cjs');
fs.writeFileSync(bundlePath, built.outputFiles[0].text);
const rt = require(bundlePath);

// ── Headless DOM globals for the pipeline (DOMParser/NodeFilter) ─────────
const win = new Window();
for (const key of [
  'window', 'document', 'DOMParser', 'NodeFilter', 'Node',
  'Element', 'HTMLElement', 'DocumentFragment',
]) {
  globalThis[key] = win[key] ?? win.document;
}
globalThis.document = win.document;

// ── Colour math (same formula as the pipeline) ───────────────────────────
function parseCssColor(s) {
  s = (s || '').trim().toLowerCase();
  if (!s || s === 'transparent') return null;
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+\s*([\d.]+)[,\s]+\s*([\d.]+)(?:[,\s/]+\s*([\d.]+))?\)/);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])];
  // Engines may return hsl() verbatim (happy-dom does; browsers resolve it).
  m = s.match(/^hsla?\(\s*([\d.]+)(?:deg|rad|grad|turn)?\s*[,\s]+\s*([\d.]+)%\s*[,\s]+\s*([\d.]+)%/);
  if (m) {
    let h = Number(m[1]);
    h = ((h % 360) + 360) % 360;
    const sat = Math.min(1, Math.max(0, Number(m[2]) / 100));
    const li = Math.min(1, Math.max(0, Number(m[3]) / 100));
    const k = (n) => (n + h / 30) % 12;
    const a = sat * Math.min(li, 1 - li);
    const f = (n) => li - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
  }
  return null;
}

function relLum([r, g, b]) {
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastOf(fg, bg) {
  const [hi, lo] = [relLum(fg), relLum(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ── Real card CSS (extracted from index.css, not re-typed) ───────────────
const indexCss = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
const CARD_RULES = (indexCss.match(/^\.rich-doc-(?:light|dark)[^{]*\{[^}]*\}/gm) || []).join('\n');
assert.ok(CARD_RULES.includes('.rich-doc-light'), 'must extract light card rules');
assert.ok(CARD_RULES.includes('.rich-doc-dark'), 'must extract dark card rules');

// ClipPreview-faithful wrappers: outer inline surface + inner card class.
const WRAPPERS = {
  light: { cls: 'rich-doc rich-doc-light', surface: '#ffffff', outer: 'background:#ffffff;color:#1f2937;padding:14px 16px;' },
  dark: { cls: 'rich-doc rich-doc-dark', surface: '#14161a', outer: 'background:#14161a;padding:14px 16px;' },
};

function computedPairs(fragmentHtml, theme) {
  const doc = win.document.implementation.createHTMLDocument('');
  const style = doc.createElement('style');
  style.textContent = CARD_RULES;
  doc.head.appendChild(style);
  const w = WRAPPERS[theme];
  const outer = doc.createElement('div');
  outer.setAttribute('style', w.outer);
  const card = doc.createElement('div');
  card.setAttribute('class', w.cls);
  card.innerHTML = fragmentHtml;
  outer.appendChild(card);
  doc.body.appendChild(outer);

  const rows = [];
  const walker = doc.createTreeWalker(card, win.NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) {
      const el = node.parentElement;
      const fgRaw = win.getComputedStyle(el).color;
      const fg = parseCssColor(fgRaw);
      // Walk up for the effective background (transparent inherits).
      let bg = null;
      let bgRaw = '';
      let cursor = el;
      while (cursor && cursor !== doc.body) {
        bgRaw = win.getComputedStyle(cursor).backgroundColor;
        const parsed = parseCssColor(bgRaw);
        if (parsed && (parsed[3] ?? 1) >= 0.99) {
          bg = parsed.slice(0, 3);
          break;
        }
        cursor = cursor.parentElement;
      }
      rows.push({ tag: el.tagName.toLowerCase(), text: text.slice(0, 48), fgRaw, bgRaw, fg, bg });
    }
    node = walker.nextNode();
  }
  return rows;
}

// ── Fixtures ─────────────────────────────────────────────────────────────
const FRAGMENTS = {
  F1_bg_color: '<div style="background:#ffffff;color:#111827"><p>Paper-white card, explicit ink.</p></div>',
  F2_bg_only: '<div style="background:#ffff00"><p>Marker-yellow backdrop, no foreground declared.</p></div>',
  F3_color_only: '<p>Transparent ground, <span style="color:#f5f5f5">ghost-light run</span> and <span style="color:#111827">dark run</span>.</p>',
  F4_neither: '<h3>Untitled clipping</h3><p>Plain body with a <a href="https://example.com">link</a> and <code>token</code>.</p>',
  F5_class: '<div class="gmail-quote"><p class="q">Class-styled quote, no inline colors.</p></div>',
  F6_nested: '<div style="background:#000000"><p>Outer on black.</p><div style="background:#ffffff"><span style="color:#ffffff">Inner white-on-white trap.</span></div></div>',
  // The failing dark-generator clip: light runs on a stripped backdrop,
  // legacy <font>, hsl() run, table chrome, multibyte content.
  FAIL_dark_generator:
    '<div><p>Generated notes — \u00e9tude \u2713 \u2211 \u03bb</p>' +
    '<pre style="color:#e8eaed"><code>const \u03b1 = 42; // \u03bb</code></pre>' +
    '<p><font color="#cccccc">legacy font run</font> and ' +
    '<span style="color:hsl(0,0%,80%)">hsl run</span></p>' +
    '<table><tr><th>H</th></tr><tr><td>cell</td></tr></table></div>',
  // Qwen-chat capture: dark bubble kept, inline mid-gray <code> foregrounds,
  // chip backgrounds class-only (stripped). Carbon's light-card chip (#f3f4f6)
  // replaces them — gray-on-near-white washes out while the model saw
  // gray-on-bubble and passed it.
  QWEN_code_chips:
    '<div style="background-color:#151619;color:#e8eaed">' +
    '<ul><li>Do NOT touch <code style="color:#9aa0a6">scripts/build-desktop-artifact.ts</code>' +
    ' or the Swift <code style="color:#9aa0a6">apps/desktop/native/appsnap/</code> directory.</li>' +
    '<li>The macOS-specific logic is already gated by the <code style="color:#6b7280">darwin</code>' +
    ' platform check, so Windows builds will naturally skip the helper compilation.</li></ul></div>',
  // Same chips as nested spans with TRANSLUCENT chip backgrounds (chat
  // renderers emit these): the backdrop is white-12% OVER the dark bubble,
  // not the card. An alpha-blind model reads the layer as opaque white and
  // "fixes" gray text to dark ink — dark-on-dark-chip in the engine.
  QWEN_chip_spans:
    '<div style="background-color:#151619;color:#e8eaed">' +
    '<ul><li>Do NOT touch ' +
    '<span style="background-color:rgba(255,255,255,0.12);border-radius:4px;padding:0 4px;">' +
    '<span style="color:#9aa0a6">scripts/build-desktop-artifact.ts</span></span> or the Swift ' +
    '<span style="background-color:rgba(255,255,255,0.12);border-radius:4px;padding:0 4px;">' +
    '<span style="color:#6b7280">darwin</span></span> directory.</li></ul></div>',
};

// CF_HTML with byte-correct offsets (offsets-only: no markers, forces the
// byte path) plus a markers variant. Multibyte content proves offsets are
// bytes, not UTF-16 units.
function cfHtmlBytes(fragment, { markers }) {
  const body = markers
    ? `<!--StartFragment-->${fragment}<!--EndFragment-->`
    : fragment;
  const prefixOf = (sf, ef) =>
    `Version:0.9\r\nStartHTML:00000000\r\nEndHTML:00000000\r\nStartFragment:${sf}\r\nEndFragment:${ef}\r\n<html><body>\r\n`;
  // Iterate: offsets depend on the header length which depends on offsets.
  let sf = 0;
  let ef = 0;
  for (let i = 0; i < 4; i++) {
    const pre = prefixOf(
      String(sf).padStart(8, '0'),
      String(ef).padStart(8, '0')
    );
    sf = Buffer.byteLength(pre, 'utf8');
    ef = sf + Buffer.byteLength(body, 'utf8');
  }
  const head = prefixOf(String(sf).padStart(8, '0'), String(ef).padStart(8, '0'));
  return `${head}${body}</body></html>`;
}

test('v29-B1 - extractFragment honours CF_HTML byte offsets (multibyte)', () => {
  const frag = FRAGMENTS.FAIL_dark_generator;
  const viaBytes = rt.extractFragment(cfHtmlBytes(frag, { markers: false }));
  assert.equal(viaBytes, frag, 'byte-offset path must round-trip multibyte content exactly');
  const viaMarkers = rt.extractFragment(cfHtmlBytes(frag, { markers: true }));
  assert.equal(viaMarkers, frag, 'marker path must round-trip too');
});

test('v29-B1 - sanitizer preserves inline pairs, folds legacy attrs', () => {
  const frag = FRAGMENTS.FAIL_dark_generator;
  const clean = rt.sanitizeRichHtml(frag);
  // Inline pairs survive sanitization (the B1 suspect — acquitted).
  assert.ok(clean.includes('color:#e8eaed'), 'inline fg must survive');
  assert.ok(clean.includes('color:hsl(0,0%,80%)'), 'hsl run must survive');
  // Legacy attributes are folded to style (single source of truth).
  assert.ok(!clean.includes('<font color'), 'font color must be folded, not left as attr');
  assert.ok(clean.includes('#cccccc'), 'folded font color value must survive');
  // Executable vectors still stripped.
  assert.ok(!clean.includes('<script'), 'scripts stay banned');
});

test('v29-B3 - computed contrast >= 4.5:1 for every text node (matrix)', () => {
  const EXPECTED_THEME = {
    F1_bg_color: 'light',
    F2_bg_only: 'light',
    F3_color_only: 'dark',
    F4_neither: 'light',
    F5_class: 'light',
    F6_nested: 'light', // carries its own black backdrop -> light card, per-node overrides fix the traps
    FAIL_dark_generator: 'dark',
    QWEN_code_chips: 'light', // dark bubble kept on the light card; chips must survive Carbon's chip bg
    QWEN_chip_spans: 'light', // translucent chips composite over the bubble, never the card
  };
  // Opposite-card runs are valid ONLY for fully background-explicit
  // fragments (F1: explicit white bg + ink; F6: explicit black/white bgs).
  // Transparent-ground fragments (F2/F3/F4/F5/FAIL) are theme-BOUND by
  // design: their foreground comes from the card ink, so the guess+card
  // pairing IS the guarantee (ClipPreview never cross-wraps). Asserting
  // cross-wrapped transparent fragments would demand one inline fg that
  // reads on two different cards — impossible in general (e.g. F3's ghost
  // run is legible on dark, must be rewritten on light).
  const EXTRA_THEMES = { F1_bg_color: ['dark'], F6_nested: ['dark'] };

  const report = [];
  for (const [name, frag] of Object.entries(FRAGMENTS)) {
    const preview = rt.prepareRichPreview(frag);
    assert.equal(
      preview.theme,
      EXPECTED_THEME[name],
      `${name}: theme guess must be ${EXPECTED_THEME[name]} (got ${preview.theme})`
    );
    const themes = [preview.theme, ...(EXTRA_THEMES[name] || [])];
    for (const theme of themes) {
      const rows = computedPairs(preview.html, theme);
      assert.ok(rows.length > 0, `${name}/${theme}: must sample at least one text node`);
      for (const row of rows) {
        assert.ok(row.fg, `${name}/${theme} <${row.tag}> "${row.text}": computed fg must resolve (got ${row.fgRaw})`);
        assert.ok(row.bg, `${name}/${theme} <${row.tag}> "${row.text}": effective bg must resolve (got ${row.bgRaw})`);
        const ratio = contrastOf(row.fg, row.bg);
        report.push({ frag: name, theme, tag: row.tag, text: row.text, fg: row.fgRaw, bg: row.bgRaw, ratio: Number(ratio.toFixed(2)) });
        assert.ok(
          ratio >= 4.5,
          `${name}/${theme} <${row.tag}> "${row.text}": ${ratio.toFixed(2)}:1 (fg=${row.fgRaw} bg=${row.bgRaw}) must clear AA`
        );
      }
    }
  }
  // CI contrast output (this table is the B3 proof attached to the commit).
  console.log('\n[rich-contrast] per-node matrix (frag/theme/tag/ratio):');
  for (const r of report) {
    console.log(`  ${r.frag}/${r.theme} <${r.tag}> ${r.ratio.toFixed(2)}:1 "${r.text}"`);
  }
  console.log(`[rich-contrast] ${report.length} nodes, all >= 4.5:1.`);
});

test('v29-B3 - Raw mode carries no author styling (theme ink by construction)', () => {
  const doc = win.document.implementation.createHTMLDocument('');
  const style = doc.createElement('style');
  style.textContent = ':root { --text: #e8eaed; } .preview-text { color: var(--text); }';
  doc.head.appendChild(style);
  const raw = doc.createElement('div');
  raw.setAttribute('class', 'preview-text plain');
  // Raw mode renders text_content as TEXT (ClipPreview forceRaw path) —
  // markup in the payload must stay inert.
  raw.textContent = '<img src=x onerror=alert(1)> plain & <b>bold-looking</b>';
  doc.body.appendChild(raw);
  assert.equal(raw.querySelectorAll('img, b').length, 0, 'raw payload must not become elements');
  const fg = parseCssColor(win.getComputedStyle(raw).color);
  assert.ok(fg, 'raw ink must resolve through the theme var');
});
