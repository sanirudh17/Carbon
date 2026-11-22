import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const SRC_TAURI = path.join(ROOT, 'src-tauri', 'src');

function loadModule(relPath) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', out.outputFiles[0].text);
  fn(require, mod, mod.exports);
  return mod.exports;
}

test('syntaxHighlight tokenizes JSON, TypeScript, Rust, HTML, CSS, SQL, Python, Go, TOML and preserves full source text', () => {
  const { highlightCodeTokens, detectCodeLanguage } = loadModule('src/lib/syntaxHighlight.ts');
  const samples = [
    ['JSON', '{"name": "Carbon", "count": 42, "local": true}'],
    ['TypeScript', 'export const greet = (name: string): number => {\n  // hello\n  return name.length;\n};'],
    ['Rust', '#[derive(Debug)]\npub fn add<\'a>(a: u32, b: u32) -> u32 {\n    /* sum */ println!("{}", a + b);\n    a + b\n}'],
    ['HTML', '<div class="glass"><!-- note --><p>Hi</p></div>'],
    ['CSS', '.panel { background: #14161a; padding: 12px; /* glass */ }'],
    ['SQL', "SELECT id, title FROM entries WHERE is_pinned = 1; -- pinned"],
    ['Python', 'def run(x):\n    # compute\n    return x * 2'],
    ['Go', 'package main\nfunc main() {\n    msg := "hi"\n    fmt.Println(msg)\n}'],
    ['TOML', '[package]\nname = "carbon"\nversion = "0.1.21"\n'],
  ];

  for (const [lang, src] of samples) {
    assert.equal(detectCodeLanguage(src), lang, `detectCodeLanguage should identify ${lang}`);
    const tokens = highlightCodeTokens(src, lang);
    assert.equal(
      tokens.map((t) => t.text).join(''),
      src,
      `${lang} tokenization must round-trip exact text with zero loss`
    );
    assert.ok(
      tokens.some((t) => t.type !== 'plain'),
      `${lang} must produce non-plain semantic tokens`
    );
  }

  const proseTokens = highlightCodeTokens('Please do so', null);
  assert.ok(
    !proseTokens.some((t) => t.text === 'Please' && t.type === 'type'),
    'Capitalized English word must not be colored as a type'
  );
});

test('Icons.tsx uses HugeIcons (@hugeicons/react + @hugeicons/core-free-icons) with zero lucide dependency', () => {
  const iconsSrc = fs.readFileSync(path.join(SRC, 'components', 'Icons.tsx'), 'utf8');
  assert.ok(iconsSrc.includes("from '@hugeicons/react'"), 'Icons.tsx must render via HugeiconsIcon');
  assert.ok(iconsSrc.includes("from '@hugeicons/core-free-icons'"), 'Icons.tsx must import from @hugeicons/core-free-icons');
  assert.ok(!iconsSrc.includes("from 'lucide-react'"), 'Icons.tsx must no longer import lucide-react');
});

test('clipActions has no Ctrl+Shift+R collision and exposes Save as Snippet', () => {
  const src = fs.readFileSync(path.join(SRC, 'utils', 'clipActions.tsx'), 'utf8');
  assert.ok(src.includes("id: 'save-as-snippet'"), 'Save as Snippet action must exist');
  assert.ok(src.includes("shortcut: 'Ctrl+Shift+S'"), 'Save as Snippet shortcut must be Ctrl+Shift+S');
  const rMatches = src.match(/shortcut:\s*'Ctrl\+Shift\+R'/g) || [];
  assert.equal(rMatches.length, 1, 'Ctrl+Shift+R must only be bound once (no URL encode vs Remove from Collection collision)');
  assert.ok(src.includes('act.isVisible(item, handlers)'), 'handleClipKeyDown must pass handlers into isVisible');
});

test('clipboard privacy formats and timed pause are wired in Rust backend', () => {
  const watcher = fs.readFileSync(path.join(SRC_TAURI, 'clipboard_watcher.rs'), 'utf8');
  assert.ok(watcher.includes('ExcludeClipboardContentFromMonitorProcessing'));
  assert.ok(watcher.includes('Clipboard Viewer Ignore'));
  assert.ok(watcher.includes('CanIncludeInClipboardHistory'));
  assert.ok(watcher.includes('pub fn pause_for_minutes'));

  const lib = fs.readFileSync(path.join(SRC_TAURI, 'lib.rs'), 'utf8');
  assert.ok(lib.includes('pause_capture_for'));
  assert.ok(lib.includes('resume_capture'));
  assert.ok(lib.includes('sync_native_theme'));
  assert.ok(lib.includes('Resume Capture'));
  // Ensure paste_clip and copy_clip use get_entry_by_id instead of full-table scans
  const pasteFn = lib.slice(lib.indexOf('fn paste_clip('), lib.indexOf('fn copy_clip('));
  assert.ok(pasteFn.includes('get_entry_by_id'), 'paste_clip must use get_entry_by_id');
  assert.ok(!pasteFn.includes('get_all_entries'), 'paste_clip must not scan all entries');
});

test('Follow System Theme and Ignored Apps UI are wired in Settings and App', () => {
  const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');
  assert.ok(app.includes('prefers-color-scheme: light'));
  assert.ok(app.includes('sync_native_theme'));
  assert.ok(app.includes('capture-pause-changed'));

  const settings = fs.readFileSync(path.join(SRC, 'components', 'Settings.tsx'), 'utf8');
  assert.ok(settings.includes("value: 'system'"), 'Settings must offer System theme');
  assert.ok(settings.includes('ignore_apps'), 'Settings must expose Ignored apps management');
  assert.ok(!settings.includes("'⚠️'"), 'Settings must not use emoji warning glyphs');
});

test('README has no stale Tesseract installer/license claims', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(!readme.includes('bundles Tesseract OCR'));
  assert.ok(!readme.includes('Bundled Tesseract is third-party'));
  assert.ok(readme.includes('PP-OCRv6 Small'));
});

test('Phase 2 UI polish: icons, centered inputs/buttons, sliding indicators, focus & dropdown fixes', () => {
  const iconsSrc = fs.readFileSync(path.join(SRC, 'components', 'Icons.tsx'), 'utf8');
  assert.ok(iconsSrc.includes('File02Icon'), 'RichTextIcon must use File02Icon document glyph');
  assert.ok(iconsSrc.includes('FileEmpty02Icon'), 'FilesIcon must use distinct FileEmpty02Icon glyph');
  assert.ok(!iconsSrc.includes('TextAlignLeftIcon'), 'RichTextIcon must no longer use bare lines TextAlignLeftIcon');

  const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
  const mat = fs.readFileSync(path.join(SRC, 'styles', 'material.css'), 'utf8');
  assert.ok(css.includes('.num::-webkit-inner-spin-button'), 'Storage .num inputs must hide native spin arrows so numbers stay centered');
  assert.ok(mat.includes('text-box-edge: cap alphabetic;'), 'Buttons, keys, dropdowns, and chips must trim to cap alphabetic for exact vertical centering');
  assert.ok(!mat.includes('text-box-edge: cap text;'), 'Must not use cap text which pushes Segoe UI labels above vertical center');
  assert.ok(!mat.includes('padding-block: 0 1px;'), 'Light-only asymmetric button padding hack should be removed');
  assert.ok(css.includes('.side-active-indicator'), 'Sidebar must support smooth sliding active indicator');
  assert.ok(css.includes('.list-active-indicator'), 'Entries list must support smooth sliding active indicator');
  assert.ok(css.includes('.seg-slider-thumb'), 'Segmented controls must support smooth sliding thumb');
  assert.ok(css.includes('min(380px, calc(100vh - 68px))'), 'All Types dropdown must fit all options without a 260px scrollbar');
  assert.ok(css.includes('.bar-actions'), 'Quick Overlay footer must group actions cleanly in a rounded-rectangle cluster');
  assert.ok(!css.includes('mask-image: linear-gradient(to bottom, transparent 0, black 24px)'), 'Main/Snippets lists must not fade out the Today/This Year top heading');
  const snippetsMainBlock = css.slice(css.indexOf('.snippets-main {'), css.indexOf('.snippets-main {') + 350);
  assert.ok(snippetsMainBlock.includes('background: var(--glass-list);'), 'Snippets middle pane must match Clips glass wash');
  const colLockedBlock = css.slice(css.indexOf('.col-locked-screen {'), css.indexOf('.col-locked-screen {') + 420);
  assert.ok(colLockedBlock.includes('backdrop-filter: none !important;'), 'Locked collection screen must not stack a full-pane blur');

  const hookSrc = fs.readFileSync(path.join(SRC, 'hooks', 'useSlidingIndicator.ts'), 'utf8');
  assert.ok(!hookSrc.includes('useState'), 'useSlidingIndicator must be pure-DOM ref-driven with zero React re-renders');

  const snippetModalSrc = fs.readFileSync(path.join(SRC, 'components', 'SnippetEditorModal.tsx'), 'utf8');
  assert.ok(snippetModalSrc.includes("const keyword = `/${slug || 'clip'}`;"), 'snippetDraftFromClip must auto-generate a /trigger keyword');

  const enlarged = fs.readFileSync(path.join(SRC, 'components', 'EnlargedWindow.tsx'), 'utf8');
  assert.ok(enlarged.includes('useSlidingIndicator'), 'EnlargedWindow must wire sliding indicators');
  assert.ok(enlarged.includes("closest?.('.side-item')"), 'EnlargedWindow sidebar must prevent mouse click focus trap');

  const overlay = fs.readFileSync(path.join(SRC, 'components', 'QuickOverlay.tsx'), 'utf8');
  assert.ok(overlay.includes('useSlidingIndicator'), 'QuickOverlay must wire sliding list indicator');
  assert.ok(overlay.includes('SlidingSegmentedControl'), 'QuickOverlay must use SlidingSegmentedControl');

  const settings = fs.readFileSync(path.join(SRC, 'components', 'Settings.tsx'), 'utf8');
  assert.ok(settings.includes('SlidingSegmentedControl'), 'Settings must use SlidingSegmentedControl for Theme and Window material');
  assert.ok(settings.includes('Local SQLite in WAL mode'), 'Settings must retain balanced, helpful row descriptions');

  // Dropdown labels must never use text-box-trim (overflow:hidden slices descenders/ascenders)
  assert.ok(!mat.includes('.c-dropdown-value'), 'Dropdown value must not be trimmed by text-box-trim');
  assert.ok(!mat.includes('.c-dropdown-item-label'), 'Dropdown item label must not be trimmed by text-box-trim');
  // Icons.tsx ClipTileIcon must lazily load thumbnails via IntersectionObserver + concurrency queue
  assert.ok(iconsSrc.includes('IntersectionObserver'), 'ClipTileIcon must lazily observe viewport before loading thumbnails');
  assert.ok(iconsSrc.includes('downscaleThumbnail'), 'ClipTileIcon must downscale thumbnails for instant Images<->Files switching');
  // App.tsx must keep EnlargedWindow mounted while Settings is open
  const appSrc = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');
  assert.ok(appSrc.includes('isHidden={isSettingsOpen}'), 'App must keep EnlargedWindow mounted while Settings is open');

  // Ctrl+K toggles action panel closed across EnlargedWindow, QuickOverlay, and SnippetsView
  const toggleCheck = "e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')";
  assert.ok(enlarged.includes(toggleCheck), 'EnlargedWindow Ctrl+K must close open action panel');
  assert.ok(overlay.includes(toggleCheck), 'QuickOverlay Ctrl+K must close open action panel');
  const snippetsViewSrc = fs.readFileSync(path.join(SRC, 'components', 'SnippetsView.tsx'), 'utf8');
  assert.ok(snippetsViewSrc.includes(toggleCheck), 'SnippetsView Ctrl+K must close open action panel');

  // Unified #tag labels across dropdown filters and editor chips
  assert.ok(overlay.includes('label: `#${t}`'), 'QuickOverlay tag filter must display #tag labels');
  assert.ok(snippetsViewSrc.includes('label: `#${t}`'), 'SnippetsView tag filter must display #tag labels');
  assert.ok(snippetModalSrc.includes('className="carbon-control-label">#{t}'), 'SnippetEditorModal chips must display #tag labels');

  // Settings scrolling avoids nested backdrop-filter per-control readbacks
  assert.ok(mat.includes('.settings :is(.btn, .hotkey-chip, .seg-btn)'), 'Settings controls must disable nested backdrop-filter for smooth scrolling');

  // Final-stretch polish invariants:
  // 1. Neutral lifted frosted lock card (distinct from background, no purple cast)
  assert.ok(css.includes('rgba(40, 40, 44, 0.48)'), 'Locked collection card must use lifted neutral charcoal glass');
  // 2. Clean TinyCast-style Quick Overlay footer (right-aligned actions, lowered info panel)
  assert.ok(!overlay.includes('className="bar-left"'), 'QuickOverlay must omit redundant Esc Close pill for clean TinyCast footer');
  assert.ok(css.includes('.overlay-preview .ov-preview-info .meta-strip'), 'QuickOverlay preview info panel must sit cleanly lowered above footer');
  // 3. Unified Quick Overlay dropdown translucency
  assert.ok(mat.includes('rgb(22 22 26 / 68%)'), 'Dark glass dropdown list must use unified neutral translucency');
  // 4. Smooth sliding selection indicator inside all 4 Ctrl+K action menus + race-free ResizeObserver
  assert.ok(css.includes('.action-active-indicator'), 'CSS must define .action-active-indicator for Ctrl+K action menus');
  assert.ok(enlarged.includes('action-active-indicator'), 'EnlargedWindow Ctrl+K menu must render sliding indicator');
  assert.ok(overlay.includes('action-active-indicator'), 'QuickOverlay Ctrl+K menus must render sliding indicator');
  assert.ok(snippetsViewSrc.includes('action-active-indicator'), 'SnippetsView Ctrl+K menu must render sliding indicator');
  const sliderHook = fs.readFileSync(path.join(SRC, 'hooks', 'useSlidingIndicator.ts'), 'utf8');
  assert.ok(sliderHook.includes('pendingAnimateRef'), 'useSlidingIndicator must protect animated glides from passive ResizeObserver cancellation');
  // 5. Shared IntersectionObserver + bounded LRU thumbnail cache + hidden-window filter cache cleanup
  assert.ok(iconsSrc.includes('THUMBNAIL_CACHE_MAX') && iconsSrc.includes('sharedThumbObserver'), 'Icons.tsx must use bounded LRU thumbnail cache and single shared IntersectionObserver');
  assert.ok(enlarged.includes('visibilitychange'), 'EnlargedWindow must clear filter cache when hidden');
  // 6. Glint single-image CF_HDROP capture + startup retroactive repair of existing Glint file rows
  const watcherSrc = fs.readFileSync(path.join(SRC_TAURI, 'clipboard_watcher.rs'), 'utf8');
  assert.ok(watcherSrc.includes('should_capture_hdrop_as_image') && watcherSrc.includes('capture_image_from_file'), 'clipboard_watcher.rs must capture Glint single-image CF_HDROP screenshots as image clips');
  const dbSrc = fs.readFileSync(path.join(SRC_TAURI, 'db.rs'), 'utf8');
  assert.ok(dbSrc.includes('repair_glint_image_entries'), 'db.rs must convert legacy Glint file entries into image clips on startup');
  // 7. No purple focus outline on .preview-edit, uniform lock-card border, dead-center .key pills, consumed snippetCreateSignal, GPU-isolated Settings scroll
  assert.ok(mat.includes('.preview-edit:focus-visible') && mat.includes('outline: none;'), 'preview-edit must suppress purple focus outline (blinking caret only)');
  assert.ok(mat.includes('translateY(1.5px)'), '.key labels must sit dead-center vertically');
  assert.ok(snippetsViewSrc.includes('onCreateSignalConsumed?.()') && enlarged.includes('onCreateSignalConsumed={() => setSnippetCreateSignal(0)}'), 'SnippetsView must consume createSignal so returning to Snippets never re-opens New Snippet modal');
  assert.ok(css.includes('box-shadow: 0 18px 44px rgba(0, 0, 0, 0.30);') && !css.includes('inset 0 1px 0 rgba(255, 255, 255, 0.10)'), 'Locked collection card must have uniform seamless perimeter border without thick top highlight');
  assert.ok(mat.includes('.btn.primary, .btn.accent, .hotkey-chip, .seg-btn, .c-dropdown-trigger'), 'Settings must disable nested backdrop-filter across all buttons including primary/accent/dropdown');
  // 8. Unified smooth sliding indicator across BOTH Snippets lists (Main App + Quick Overlay)
  assert.ok(snippetsViewSrc.includes('snippetsIndicatorRef') && snippetsViewSrc.includes('list-active-indicator'), 'SnippetsView must wire smooth sliding list indicator');
  assert.ok(overlay.includes('snOverlayListIndicatorRef') && overlay.includes("activeSelector: '.snippet-row.selected'"), 'QuickOverlay Snippets tab must wire smooth sliding list indicator');
  assert.ok(css.includes('.snippets-list[data-list-indicator="ready"] .snippet-row.selected'), 'CSS must hand off selected highlight to .list-active-indicator in Snippets lists');
  // 9. Snippets preview text well shares Clipboard's subtle --editor-field frosted box in Main App & Quick Overlay
  assert.ok(mat.includes(':is(.preview-edit, .sn-content-preview) { background: var(--editor-field); }'), 'Snippets preview must share Clipboard subtle --editor-field text well');
  // 10. Tailored natural-case Snippets preview header + inline dynamic token chips
  assert.ok(snippetsViewSrc.includes('className="sn-preview-title"'), 'SnippetsView must render natural-case snippet title instead of uppercase type tag');
  assert.ok(overlay.includes('className="sn-preview-title"'), 'QuickOverlay Snippets must render natural-case snippet title');
  assert.ok(css.includes('.sn-content-preview :is(.sn-tok, .sn-tok-dyn, .sn-tok-arg, .sn-tok-snip, .sn-tok-cursor)'), 'Snippet preview must render dynamic placeholders as subtle inline chips');
});

test('dateGroups keeps Today, Yesterday, and older calendar headings aligned with relative timestamps', () => {
  const { groupItemsByDate, formatTimeAgo } = loadModule('src/utils/dateGroups.ts');
  const now = new Date(2026, 10, 21, 22, 40, 0); // Nov 21, 2026 22:40 local
  const make = (id, created_at) => ({ id, created_at, updated_at: created_at });

  const items = [
    make('today-1', '2026-11-21 22:10:00'),
    make('yest-late', '2026-11-20 23:10:00'),  // 23.5h ago, calendar Yesterday
    make('yest-day', '2026-11-20 14:00:00'),   // 32.6h ago, calendar Yesterday -> 1d ago
    make('two-days', '2026-11-19 23:30:00'),   // 47.1h ago, 2 calendar days ago -> must be 2d ago, NOT 1d ago!
  ];

  const groups = groupItemsByDate(items, now);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].label, 'Today');
  assert.equal(groups[1].label, 'Yesterday');
  assert.equal(groups[1].items.length, 2);
  assert.ok(groups[2].label.includes('19'), `expected calendar date for Nov 19, got ${groups[2].label}`);

  assert.equal(formatTimeAgo('2026-11-21 22:10:00', now), '30m ago');
  assert.equal(formatTimeAgo('2026-11-20 23:10:00', now), '23h ago');
  assert.equal(formatTimeAgo('2026-11-20 14:00:00', now), '1d ago');
  assert.equal(formatTimeAgo('2026-11-19 23:30:00', now), '2d ago');
});

test('smartInspector decodes JWTs, Unix timestamps, URL query params, percent strings, and UTF-8 Base64 without false positives', () => {
  const { inspectClipContent } = loadModule('src/lib/smartInspector.ts');
  const nowMs = Date.UTC(2026, 10, 21, 18, 0, 0);

  // 1. Active JWT with Bearer prefix
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const activeJwt = `Bearer ${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'user_42', iss: 'carbon.local', exp: Math.floor(nowMs / 1000) + 3600 })}.sig1234567890`;
  const jwtActive = inspectClipContent(activeJwt, nowMs);
  assert.equal(jwtActive?.kind, 'jwt');
  assert.ok(jwtActive?.badge?.text.startsWith('Active'), `expected Active badge, got ${jwtActive?.badge?.text}`);
  assert.equal(jwtActive?.badge?.tone, 'ok');
  assert.ok(jwtActive?.codeBlock?.includes('"sub": "user_42"'));

  // 2. Expired JWT
  const expiredJwt = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ sub: 'user_99', exp: Math.floor(nowMs / 1000) - 600 })}.sig9876543210`;
  const jwtExpired = inspectClipContent(expiredJwt, nowMs);
  assert.equal(jwtExpired?.kind, 'jwt');
  assert.ok(jwtExpired?.badge?.text.startsWith('Expired'), `expected Expired badge, got ${jwtExpired?.badge?.text}`);
  assert.equal(jwtExpired?.badge?.tone, 'warn');

  // 3. Unix timestamp (10-digit seconds & 13-digit ms)
  const tsSec = inspectClipContent('1700000000', nowMs);
  assert.equal(tsSec?.kind, 'timestamp');
  assert.equal(tsSec?.title, 'Unix Timestamp (s)');
  assert.ok(tsSec?.badge?.text.endsWith('ago'));
  assert.ok(tsSec?.copyValue.startsWith('2023-11-14T22:13:20'));

  const tsMs = inspectClipContent('1700000000123', nowMs);
  assert.equal(tsMs?.kind, 'timestamp');
  assert.equal(tsMs?.title, 'Unix Timestamp (ms)');
  assert.equal(tsMs?.copyValue, '2023-11-14T22:13:20.123Z');

  // 4. URL with query parameters
  const urlRes = inspectClipContent('https://api.example.com/v1/search?q=hello%20world&page=2&sort=desc', nowMs);
  assert.equal(urlRes?.kind, 'url_params');
  assert.equal(urlRes?.rows?.length, 3);
  assert.equal(urlRes?.rows?.[0]?.value, 'hello world');

  // 5. Percent-encoded text
  const pctRes = inspectClipContent('hello%20world%2Fpath%3Fok%3D1', nowMs);
  assert.equal(pctRes?.kind, 'url_encoded');
  assert.equal(pctRes?.copyValue, 'hello world/path?ok=1');

  // 6. Readable UTF-8 Base64 (JSON auto-formatted)
  const b64Res = inspectClipContent(Buffer.from('{"hello":"carbon","ok":true}', 'utf8').toString('base64'), nowMs);
  assert.equal(b64Res?.kind, 'base64');
  assert.deepEqual(JSON.parse(b64Res?.copyValue || '{}'), { hello: 'carbon', ok: true });

  // 7. ISO-8601 date, Color formats, UUIDv7, Cron, JSON, and plain URL breakdown
  const isoRes = inspectClipContent('2026-11-21T18:00:00Z', nowMs);
  assert.equal(isoRes?.kind, 'iso_date');
  assert.equal(isoRes?.copyValue, String(Math.floor(nowMs / 1000)));

  const colorRes = inspectClipContent('#5B7CFA', nowMs);
  assert.equal(colorRes?.kind, 'color');
  assert.equal(colorRes?.copyValue, 'rgb(91, 124, 250)');

  const uuidRes = inspectClipContent('01934f5e-8a10-7abc-9123-456789abcdef', nowMs);
  assert.equal(uuidRes?.kind, 'uuid');
  assert.equal(uuidRes?.badge?.text, 'v7');

  const cronRes = inspectClipContent('*/5 * * * *', nowMs);
  assert.equal(cronRes?.kind, 'cron');
  assert.equal(cronRes?.copyValue, 'Every 5 minutes');

  const jsonRes = inspectClipContent('{"name":"carbon","items":[1,2,3]}', nowMs);
  assert.equal(jsonRes?.kind, 'json');
  assert.equal(jsonRes?.copyLabel, 'Copy Pretty');

  const plainUrlRes = inspectClipContent('https://github.com/berkaygkc/yabbistir', nowMs);
  assert.equal(plainUrlRes?.kind, 'url_info');
  assert.equal(plainUrlRes?.copyValue, 'github.com');

  // 8. Universal real-world inputs (not just canonical demo strings)
  // Embedded JWT inside Authorization header or log block
  const authJwt = inspectClipContent(`Authorization: ${activeJwt}`, nowMs);
  assert.equal(authJwt?.kind, 'jwt');
  const embeddedJwt = inspectClipContent(`user=alice\ntoken=${expiredJwt}`, nowMs);
  assert.equal(embeddedJwt?.kind, 'jwt');

  // Microsecond & nanosecond timestamps, ISO date-only, RFC 2822 HTTP date
  assert.equal(inspectClipContent('1700000000123456', nowMs)?.title, 'Unix Timestamp (µs)');
  assert.equal(inspectClipContent('1700000000123456789', nowMs)?.title, 'Unix Timestamp (ns)');
  assert.equal(inspectClipContent('2026-11-22', nowMs)?.kind, 'iso_date');
  assert.equal(inspectClipContent('Sun, 22 Nov 2026 05:12:21 GMT', nowMs)?.kind, 'iso_date');

  // CSS4 space-separated colors with alpha, 8-digit hex, and CSS declarations
  const css4Color = inspectClipContent('rgb(91 124 250 / 80%)', nowMs);
  assert.equal(css4Color?.kind, 'color');
  assert.equal(css4Color?.badge?.text, '#5B7CFACC');
  assert.equal(inspectClipContent('color: #5B7CFA;', nowMs)?.kind, 'color');

  // Braced UUID, ULID, Email with plus-tag
  assert.equal(inspectClipContent('{01934f5e-8a10-7abc-9123-456789abcdef}', nowMs)?.kind, 'uuid');
  assert.equal(inspectClipContent('01ARZ3NDEKTSV4RRFFQ69G5FAV', nowMs)?.title, 'ULID Inspector');
  const emailRes = inspectClipContent('Alice <alice+news@example.com>', nowMs);
  assert.equal(emailRes?.kind, 'email');
  assert.equal(emailRes?.copyValue, 'alice@example.com');

  // URL with tracking params offers Copy Clean URL; markdown link & standalone query string
  const trackedUrl = inspectClipContent('https://www.youtube.com/watch?v=abc123&utm_source=chatgpt.com', nowMs);
  assert.equal(trackedUrl?.kind, 'url_params');
  assert.equal(trackedUrl?.copyLabel, 'Copy Clean URL');
  assert.equal(trackedUrl?.copyValue, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(inspectClipContent('[Carbon](https://github.com/sanirudh17/Carbon)', nowMs)?.kind, 'url_info');
  assert.equal(inspectClipContent('foo=1&bar=hello%20world', nowMs)?.kind, 'url_params');

  // 6-field cron, @daily preset, CIDR subnet, cURL command, fenced & escaped JSON, .env, HTTP Basic, Unicode/HTML escapes
  assert.equal(inspectClipContent('0 */15 * * * MON-FRI', nowMs)?.badge?.text, '6-field');
  assert.equal(inspectClipContent('@daily', nowMs)?.copyValue, 'Daily at 00:00');
  const cidrRes = inspectClipContent('192.168.1.0/24', nowMs);
  assert.equal(cidrRes?.kind, 'cidr');
  assert.equal(cidrRes?.copyValue, '192.168.1.1 – 192.168.1.254');
  const curlRes = inspectClipContent('curl -X POST https://api.example.com/v1/items -H "Accept: application/json" -d \'{"a":1}\'', nowMs);
  assert.equal(curlRes?.kind, 'curl');
  assert.equal(curlRes?.badge?.text, 'POST');
  assert.equal(inspectClipContent('```json\n{"ok":true}\n```', nowMs)?.kind, 'json');
  assert.equal(inspectClipContent('"{\\"nested\\":1}"', nowMs)?.title, 'Escaped JSON');
  const envRes = inspectClipContent('PORT=3000\nNODE_ENV=production\nAPI_HOST=localhost', nowMs);
  assert.equal(envRes?.kind, 'env');
  assert.equal(JSON.parse(envRes?.copyValue || '{}').PORT, '3000');
  const basicAuth = inspectClipContent(`Basic ${Buffer.from('admin:s3cr3t', 'utf8').toString('base64')}`, nowMs);
  assert.equal(basicAuth?.title, 'HTTP Basic Auth');
  assert.equal(basicAuth?.copyValue, 'admin:s3cr3t');
  assert.equal(inspectClipContent('\\u0048\\u0065\\u006c\\u006c\\u006f', nowMs)?.copyValue, 'Hello');
  assert.equal(inspectClipContent('&lt;div&gt;Hi &amp; bye&lt;/div&gt;', nowMs)?.copyValue, '<div>Hi & bye</div>');

  // 9. Reject ordinary prose, hex hashes, and short numbers
  assert.equal(inspectClipContent('Please do so', nowMs), null);
  assert.equal(inspectClipContent('deadbeefcafe0123456789abcdef0123', nowMs), null);
  assert.equal(inspectClipContent('42', nowMs), null);
});

test('Commit 2 features: caret overlay placement, reorderable paste stack drawer, and smart inspector are wired', () => {
  const settingsSrc = fs.readFileSync(path.join(SRC, 'components', 'Settings.tsx'), 'utf8');
  const overlaySrc = fs.readFileSync(path.join(SRC, 'components', 'QuickOverlay.tsx'), 'utf8');
  const enlargedSrc = fs.readFileSync(path.join(SRC, 'components', 'EnlargedWindow.tsx'), 'utf8');
  const drawerSrc = fs.readFileSync(path.join(SRC, 'components', 'PasteStackDrawer.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI, 'hotkey.rs'), 'utf8');
  const expansionRs = fs.readFileSync(path.join(SRC_TAURI, 'expansion.rs'), 'utf8');
  const libRs = fs.readFileSync(path.join(SRC_TAURI, 'lib.rs'), 'utf8');

  assert.ok(
    settingsSrc.includes("updateSetting('overlay_position'") &&
      settingsSrc.includes("{ value: 'center', label: 'Center' }") &&
      settingsSrc.includes("{ value: 'caret', label: 'Caret' }") &&
      settingsSrc.includes("{ value: 'cursor', label: 'Cursor' }"),
    'Settings must expose 3-option Center | Caret | Cursor selector'
  );
  assert.ok(
    hotkeyRs.includes('resolve_overlay_position') &&
      hotkeyRs.includes('probe_active_caret_with_source') &&
      hotkeyRs.includes('clamp_cursor_rect') &&
      hotkeyRs.includes('calculate_cursor_overlay_position') &&
      hotkeyRs.includes('foreground_window_center_position'),
    'hotkey.rs must keep Caret (caret + fg-window fallback) and Cursor (centered on mouse pointer) distinct'
  );
  assert.ok(
    expansionRs.includes('IUIAutomationTextPattern2') &&
      expansionRs.includes('GetCaretRange') &&
      expansionRs.includes('uia-focus-editor'),
    'expansion.rs must probe modern Chromium/Electron/WinUI carets and tall multiline editors via UIA'
  );
  assert.ok(overlaySrc.includes('<PasteStackDrawer') && enlargedSrc.includes('<PasteStackDrawer'), 'Both windows must render interactive PasteStackDrawer');
  assert.ok(enlargedSrc.includes("listen('paste-queue-updated'") && enlargedSrc.includes('onQueueChange={fetchQueue}') && overlaySrc.includes('onQueueChange={fetchQueue}'), 'Both windows must stay in sync with paste-queue-updated and pass onQueueChange');
  assert.ok(drawerSrc.includes('onPointerDown') && !drawerSrc.includes('draggable'), 'PasteStackDrawer must use pointer-event drag-to-reorder instead of HTML5 draggable (prevents red no-drop cursor in WebView2)');
  assert.ok(css.includes('.paste-stack-ic .clip-thumb-img') && css.includes('position: absolute;'), 'Paste stack thumbnails must be contained and drawer must float without squishing preview');
  assert.ok(libRs.includes('queue_reorder') && libRs.includes('queue_remove_at') && libRs.includes('queue_reverse'), 'lib.rs must register queue reorder/remove/reverse commands');
  assert.ok(overlaySrc.includes('<SmartContentInspector') && enlargedSrc.includes('<SmartContentInspector'), 'SmartContentInspector must be wired across QuickOverlay and EnlargedWindow');
  assert.ok(overlaySrc.includes('useState<boolean>(false)') && overlaySrc.includes('smart-inspect-trigger') && enlargedSrc.includes('smart-inspect-trigger'), 'SmartContentInspector must be OFF by default and toggled via the Sparkles button beside Render/Raw');
  assert.ok(enlargedSrc.includes('className="preview-head-right"') && css.includes('.preview-head-sep'), 'Main app Sparkles button must group flush-right beside preview actions');
  assert.ok(hotkeyRs.includes('pub fn hide_overlay_window_on_blur') && libRs.includes('hotkey::hide_overlay_window_on_blur'), 'Blur-hide must skip restore_target_window so Win+Shift+S screenshot overlay is never stolen');
  assert.ok(overlaySrc.includes('!e.shiftKey && !e.altKey') && enlargedSrc.includes('!e.shiftKey && !e.altKey'), 'Ctrl+S save-key must never swallow Win+Shift+S');
  assert.ok(css.includes('::highlight(carbon-search)') && !css.includes('#f5cf62'), 'Search highlight must use refined champagne-amber glass tint instead of harsh plain yellow');
  assert.ok(css.includes('.overlay-preview-content .color-swatch-box') && css.includes('flex-shrink: 0;'), 'Quick Overlay color swatch must never squish when enhancements are hidden');
});
