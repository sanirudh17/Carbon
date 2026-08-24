# Changelog

All notable changes to [Carbon](https://github.com/sanirudh17/Carbon) are documented here.

## [0.1.5] — 2026-08-24

### Fixed
- **Instant hotkey toggle & zero-lag pop-in / pop-out** — `Ctrl+Shift+Z` and `Ctrl+Alt+X` now toggle (open & close) instantly without lag or typing into the search bar. Global hotkey handler in Rust checks window visibility directly to toggle instead of failing on child-HWND webview focus. Frontend keydown listener intercepts shortcuts on the capture phase with `e.preventDefault()`, preventing Chromium Redo/input events in the search bar.
- **Removed 100ms synchronous hotkey delay** — `capture_selection_snapshot` uses non-blocking UIA directly, eliminating blocking simulated Ctrl+C / `thread::sleep(100ms)` from the hotkey invocation path.
- **First-open instant (no 0.5s skeleton)** — `Quick Overlay` and `Main` now show data instantly on cold launch: `prewarm_windows` snapshots `get_overlay_entries(250)` + `get_all_entries` into `OVERLAY_PREWARM_CACHE`/`MAIN_PREWARM_CACHE` at startup (immediate, no 800ms delay), `handle_overlay_hotkey` emits cached `overlay-data` with `overlay-opened`, `get_all_clips` fast path returns `MAIN` cache for unfiltered first open, and `QuickOverlay` no longer `fetchLatest()` on every `overlay-opened`/`focus` (relies on Rust pushes). Cold `Ctrl+Shift+Z` / `Ctrl+Alt+X` now matches preview speed.

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
