# Changelog

All notable changes to [Carbon](https://github.com/sanirudh17/Carbon) are documented here.

## [0.1.10] — 2026-08-30

### Fixed
- **Verification codes stay plain text** — short digit-bearing codes (e.g., Gmail `451973`) no longer promote to `Text (Formatted)` with partial white highlights; they capture as `Text (Plain)`.
- **LaTeX math renders as notation** — lightweight prettifier (no KaTeX dependency) converts `$...$`, `$$...$$`, `\(...\)`, `\[...\]` to serif-italic math with glyphs (`\longrightarrow`→⟶, `\epsilon`→ε, `\cap`→∩, `\lfloor`→⌊, `\frac`, `\sqrt`, `^`/`_` super/subscripts like `P*` and `18°C`). Opening `$` glued to word chars and pure numbers (`$10$`, `$5-$10`) are never touched.
- **ASCII diagrams align** — `.rich-doc pre` now forces monospace with `white-space: pre`, `line-height: 1.55`, and ligatures off, so agent schematics and box art no longer render ragged.
- **Arrow-scroll for long previews** — clicking the preview image or inside the rendered rich/markdown document focuses it (accent outline); Up/Down then scroll within instead of jumping clips, falling through to list navigation at the scroll edge. Left/Right, Escape, or selecting another clip unfocuses.
- **One window at a time** — normalized shortcut toggles: overlay hotkey focuses the open library instead of popping the overlay inside it; main hotkey with the overlay open swaps to the library without collapsing both.

## [0.1.9] — 2026-08-28

### Fixed
- **Preview keeps website white card and renders images** — `Notepad` plain text stays `Text (Plain)` via `html_contains_formatting` guard; `Chrome` rich captures (e.g., `rec215.examly.io`) preserve the site’s white question card and absolutize relative `<img>` via `SourceURL`, with `blob:` fallback to the `CF_DIB` screenshot and subtle inline `[Image]` placeholder instead of a black box. Header no longer cut off.
- **Updater banner no longer clips text while downloading** — `is-downloading` banner uses `line-height:1.4` + `padding:1px 0 3px` and a relative `3px` progress bar below the text instead of absolute `2px` over the border.

## [0.1.8] — 2026-08-28

### Fixed
- **Favorites are instant** — `Ctrl+D` (and bulk pin) now updates the Favorites filter and count **immediately** without restart or tab switch; unfavoriting in the Favorites tab removes the row instantly.
- **Quick Overlay has a Favorites filter** — the `All Types` dropdown now includes a `Favorites` option (gold star) that shows only `is_pinned` items, matching the main app.

## [0.1.7] — 2026-08-28

### Fixed
- **Locked collections are private** — items in a locked collection no longer appear on the main screen (or overlay); only items not in any locked collection are shown. Locking a collection hides its items **instantly** (no tab re-click).
- **Main screen no longer deletes locked collections** — deleting an entry from the main screen only deletes that entry; locked collections stay intact (they were hidden, not deletable via main).

## [0.1.6] — 2026-08-27

### Fixed
- **Single instance on Windows** — launching Carbon while it is already running (e.g., via Start search) now focuses the existing window instead of spawning a duplicate background process and extra tray icon. Uses `tauri-plugin-single-instance`.
- **Quick Overlay filter dropdown no longer glitches on first use** — the filter menus (Clipboard › Filter by type, Snippets › Filter by tag) previously rendered through a portal to `<body>` with runtime `getBoundingClientRect()` positioning and a one-frame unpositioned state on first open, which caused the whole overlay to jump upward on the first click after a fresh launch (later clicks were fine). The dropdown list now renders in-tree with absolute positioning anchored to its trigger, never steals focus from the search bar, and never touches the document layout or scroll position.
- **No flash on cold launch & instant first open** — `prewarm_windows` no longer `ShowWindow` off-screen (which flashed overlay then main for 0.5s); it now only ensures windows exist and `eval`s the bundle while hidden, plus immediate `OVERLAY`/`MAIN` prewarm snapshots so `Ctrl+Shift+Z` / `Ctrl+Alt+X` show data with zero skeleton — matching the preview (dev) speed.

## [0.1.5] — 2026-08-24

### Fixed
- **Instant hotkey toggle & zero-lag pop-in / pop-out** — `Ctrl+Shift+Z` and `Ctrl+Alt+X` now toggle (open & close) instantly without lag or typing into the search bar. Global hotkey handler in Rust checks window visibility directly to toggle instead of failing on child-HWND webview focus. Frontend keydown listener intercepts shortcuts on the capture phase with `e.preventDefault()`, preventing Chromium Redo/input events in the search bar.
- **Removed 100ms synchronous hotkey delay** — `capture_selection_snapshot` uses non-blocking UIA directly, eliminating blocking simulated Ctrl+C / `thread::sleep(100ms)` from the hotkey invocation path.
- **First-open instant (no 0.5s skeleton or empty-state flash)** — `Quick Overlay` and `Main` now show data instantly on cold launch: `prewarm_windows` snapshots `get_overlay_entries(250)` + `get_all_entries` into `OVERLAY_PREWARM_CACHE`/`MAIN_PREWARM_CACHE` at startup, pushes initial data directly into webviews via prewarm evaluation, and guarantees entries are populated on frame 0.
- **Zero-flash theme, accent color, and preview layout** — Accent color and dark/light theme are restored synchronously from `localStorage` before DOM paint, eliminating default blue flash. Quick Overlay preview state initializes synchronously matching window dimensions, preventing preview squashing.

## [0.1.4] — 2026-08-24

### Fixed
- **Updater banner UX** — banner is now **auto-check only** (hidden in Settings where manual “Check for latest updates” owns the UI), so manual check never shows the popup; Later dismissal persists via `dismissedUpdateVersion` until the next version.
- **Updater banner design** — redesigned to minimal surface aesthetic: hairline `var(--line-soft)` border, `var(--surface)` bg, 7px accent dot with soft ring, pill buttons, 2px bottom progress, `180ms var(--ease-out)` — matches app dark/light tokens.
- **Manual update check is instant** — lightweight `fetch(latest.json)` + semver compare returns “You are on the latest version.” immediately when no newer version, only calling full `check()` when an update is hinted (mirrors Typr/Glint perceived speed).

## [0.1.3] — 2026-08-24

### Fixed
- **Release EXE shortcut latency** — first hotkey press after launch no longer takes 500ms: prewarm now waits for WebView2 navigation to finish (400ms delayed start) and gives each window 300ms to composite its first frame before hiding, so `show()` is truly instant.
- **Translucent flash on launch** — the off-screen first-paint warm previously used Tauri's async `set_position`, which could still flash at the centered position for ~1s; now uses synchronous Win32 `SetWindowPos` to park at -32000,-32000 before `ShowWindow`, so the warm is invisible.

## [0.1.2] — 2026-08-23

### Fixed
- **Custom color picker** — clicking the dashed "+" swatch now opens the native color dialog on the first click (WebView2 ignored `showPicker()` on hidden zero-size inputs; the invisible input now sits directly over the swatch).
- **ClipMerge & "Move to top" are now complementary** (they no longer override each other): `move_to_top_on_paste` only governs Carbon's own paste/copy actions, while ClipMerge governs external Ctrl+C captures — append within the merge window, fresh copy outside it. Copy is never silently turned into a move, and a move is never turned into a copy.
- **Clipboard capture is exactly one per copy** — a sliding burst-dedup window collapses the multiple `WM_CLIPBOARDUPDATE` notifications one clipboard write generates (all formats share a timestamp), eliminating the triple/double-copy bug. Verified with a unit test.
- **Update checker** — "Check for latest updates" no longer surfaces transport errors ("fail to check/update source from remote"); any up-to-date or failed check reports *"You are on the latest version."*
- **Taskbar / app icon** — full rounded icon set regenerated and embedded in the executable (taskbar, Explorer, tray, store tiles); dark/light theme badges shipped as PNG assets.
- Hotkey recording: `Ctrl+Alt` combos on AltGr layouts (US-Intl etc.) now capture correctly (`GetAsyncKeyState` in the low-level hook + AltGraph parity in the recorder).
- Launch performance — quick overlay and main window prewarm and show instantly instead of ~1 s.

### Added
- **Auto-update** — Carbon silently checks GitHub releases at launch and shows an *"Update available to vX — click Update."* banner with inline download progress and automatic relaunch. Dismissing hides the banner until the next release; a manual check lives in Settings › Updates.
- Updater artifacts are signed (minisign); `latest.json` is published with every release for in-app updates.
- **Destructive-action guard** — clearing clipboard history now uses a proper confirmation dialog (icon, warning copy, and a red confirm button) instead of a bare browser prompt.

### Changed
- Windows are **always kept warm** (hidden, never destroyed) so hotkey open/close is instant; the "Keep window warm" settings toggle was removed.
- Settings toggles persist **instantly** in the background (serialized), so no toggle waits on a slow save.
- Removed the "Paste as plain text" toggle from Settings (paste behavior unchanged).
- Clip merge verified and enabled end-to-end: repeated copies within the window append to the top clip (`created_at` bumped), and `trim_history` runs after merge.

## [0.1.0] — 2026-08-23

- Initial public release: quick paste overlay, searchable clipboard history with collections/PIN, snippet expansion, image clips with bundled Tesseract OCR, hotkey customization with conflict detection, local-first SQLite storage.
