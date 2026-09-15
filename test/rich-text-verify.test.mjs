import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const SRC_TAURI_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

/**
 * Rich-text VERIFY matrix: generator code block + preview card +
 * white-on-black fragment + colorless fragment.
 * Bar: preview legible AA (>= 4.5:1 normal text) and paste fidelity intact.
 */

function relLum(hex) {
  const c = hex.replace('#', '');
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = [0, 2, 4].map((i) => f(parseInt(c.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('RichText VERIFY - preview card forces a light document surface', () => {
  const tsx = fs.readFileSync(path.join(SRC_DIR, 'components', 'ClipPreview.tsx'), 'utf8');
  // The white card is what makes dark-assuming page HTML readable on the
  // dark app surface. Both halves must be present together.
  assert.ok(tsx.includes("background: '#ffffff'"), 'preview card must force a white surface');
  assert.ok(tsx.includes("color: '#1f2937'"), 'preview card must force dark ink');
});

test('RichText VERIFY - preview pairs clear AA (4.5:1)', () => {
  const css = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
  const pairs = [
    ['body ink', '#1f2937', '#ffffff'],
    ['code block', '#111827', '#f3f4f6'],
    ['pre block', '#111827', '#f9fafb'],
    ['link', '#1d4ed8', '#ffffff'],
    ['blockquote', '#4b5563', '#ffffff'],
  ];
  for (const [label, fg, bg] of pairs) {
    assert.ok(css.includes(fg), `CSS must define ${label} ink ${fg}`);
    assert.ok(css.includes(bg), `CSS must define ${label} surface ${bg}`);
    const ratio = contrast(fg, bg);
    assert.ok(
      ratio >= 4.5,
      `${label} contrast ${ratio.toFixed(1)}:1 must clear AA (4.5:1)`
    );
  }
});

test('RichText VERIFY - sanitizer keeps author fidelity (incl. white-on-black)', () => {
  const tsx = fs.readFileSync(path.join(SRC_DIR, 'components', 'ClipPreview.tsx'), 'utf8');
  // Inline styles survive: a self-contained white-on-black fragment keeps
  // its own colors inside the card. Only executable vectors are stripped.
  assert.doesNotMatch(tsx, /removeAttribute\('style'\)/, 'sanitizer must never strip style attributes');
  assert.ok(tsx.includes("name.startsWith('on')"), 'sanitizer must strip event handlers');
  assert.ok(tsx.includes('javascript:'), 'sanitizer must block script protocols');
  for (const tag of ['script', 'iframe', 'object', 'embed']) {
    assert.ok(tsx.includes(`'${tag}'`), `sanitizer must ban <${tag}>`);
  }
  // Structure tags must NOT be banned — pre/code/tables are the fidelity.
  const bannedMatch = tsx.match(/const BANNED_TAGS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(bannedMatch, 'BANNED_TAGS set found');
  for (const tag of ['pre', 'code', 'table', 'span', 'div']) {
    assert.doesNotMatch(bannedMatch[1], new RegExp(`'${tag}'`), `<${tag}> must survive sanitizing`);
  }
});

test('RichText VERIFY - paste restores formatting (CF_HTML + text fallback)', () => {
  const pasteRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'paste.rs'), 'utf8');
  assert.ok(
    pasteRs.includes('HTML Format'),
    'rich paste must register the HTML Format clipboard format'
  );
  assert.ok(
    pasteRs.includes('wrap_in_cf_html'),
    'bare HTML must be wrapped with a CF_HTML header'
  );
  assert.ok(
    pasteRs.includes('CF_UNICODETEXT'),
    'plain-text fallback must accompany the HTML'
  );
  // Deliberate: RTF is NOT written (rich editors import both and insert twice).
  assert.ok(
    pasteRs.includes('RTF is deliberately NOT written'),
    'the RTF skip must stay documented'
  );
});

test('RichText VERIFY - capture stores HTML for fidelity', () => {
  const watcherRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'clipboard_watcher.rs'), 'utf8');
  assert.ok(
    watcherRs.includes('html_content = Some('),
    'capture must persist the HTML fragment'
  );
});
