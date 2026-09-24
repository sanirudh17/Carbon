# Changelog

All notable changes to [Carbon](https://github.com/sanirudh17/Carbon) are documented here.

## [0.1.16] — 2026-09-24

### Fixed
- **Main-window capture pop-in on open** — every clipboard capture (plain insert, bump-to-top, and merge) now upserts into the main prewarm cache before the update is broadcast, and the backend pushes that snapshot to the main window on every open. The main list also upserts live while hidden (preserving the selected row), so a fresh copy is already at the top in the first frame instead of popping in a beat later. Filtered and search views still refetch so the active query is respected.
- **Paint-gated reveal with no stale frames** — the uncloak now waits for the fresh list commit: the paint gate resets whenever an open snapshot or live capture changes the list head and re-stamps only after the commit lands (bounded by the gate's own recovery plus a short timeout). Opens with nothing new cost nothing and stay instant. The reveal carries the store version and the gate holds only when the store moved past what the window applied (overlay A2 parity), so fresh opens never wait.
- **Main-window open speed at overlay parity** — full-history serialization left the hotkey thread for a background push; the idle-rewarm present cycle is skipped when the surface revealed seconds ago; the reveal ramp is adaptive (30ms warm pop, 100ms cold mask); identical snapshots and refetches skip their commits entirely (same arrays and selection objects back, so memoized rows and the preview bail out). A background warmth loop re-presents the hidden surface every 45 seconds so long-idle opens stay warm instead of decaying cold, and all three show sites hold the present-cycle lock across their native operations so the loop can never interleave a real show. Rapid open/close hammering registers every press.
- **Residual white open-flash** — the uncloak flushes, holds at alpha 0 for one frame (~20ms), and flushes again before the fade starts, so DWM has composed real pixels first. Invisible (alpha is zero throughout) and a mid-settle hide still cancels cleanly through the ramp's token guard.
- **Rich-text inline-code chip legibility (e.g. Qwen captures)** — mid-gray chip foregrounds washed out because the contrast model saw only the nearest inline background (the site's dark bubble) while the engine painted Carbon's own near-white chip under them. The model now knows the card chip backgrounds for `code`/`pre`, and every background layer composites over the effective backdrop below it (recursively from the card up), so translucent chips over dark regions pick light ink and chips over light surfaces pick dark ink. Failing pairs measured 2.4:1 and 1.23:1 before the fix and 13.3:1 / 16.6:1 after, verified headless against the real card CSS. Author colors that genuinely pass are preserved; backgrounds are never rewritten.

### Changed
- The `enlarged-opened` payload now carries the store version; the main window tracks its applied-cache version (+1 per applied push/edit, sync on full unfiltered re-reads, never blind-incremented).
- The offscreen present cycle is generation-guarded and reports whether it genuinely presented; a raced cycle restores position without hiding or re-cloaking, so a background refresh can never swallow an open or strand the visibility flags.
- Suite now covers the open push, paint gate, version gating, commit short-circuits, background push ordering, rewarm skip, adaptive ramp, settle order, and warmth loop (147 JS / 52 Rust tests green).

## [0.1.15] — 2026-09-23

### Fixed
- **Residual main-window white flash on first open and after idle** — the main window now re-presents its DirectComposition surface off-screen (while still cloaked) on every show branch, after re-asserting the transparent controller colors and before `show()`. Windows discards hidden composition surfaces after roughly 30 seconds of idle; color re-assert alone never creates a present, so the uncloak ramp used to composite a cold (white) frame. A shared present-cycle lock and per-label once-flags keep the boot present and the show-path rewarm from racing each other, and the rewarm is skipped when the boot cycle is already mid-flight. The cold first-ever open is additionally covered by a label-scoped first present: the frontend now reports which window finished painting, the backend waits for prewarm plus that specific window's ready event (with a 4-second fallback for windows that never emit ready) before performing the genuine first off-screen present, so an unrelated webview can no longer satisfy the readiness gate.
- **Rich-text clipping and content loss** — the sanitizer now distinguishes tags that must be removed entirely (script, style, iframe, object, embed, link, meta, base) from tags that must be unwrapped so their children survive (form, input, button, select, textarea, svg, math, head). Unwrapping re-enters cleanup on the parent so nested junk is fully processed instead of leaving an empty shell. When a rich preview would render materially less text than the clipping's plain-text source (HTML is more than 48 characters short and under 85 percent of the source length), the preview falls back to the plain-text twin rather than silently dropping content.
- **Preview card clipping in both themes** — the preview surface no longer clips overflowing content in either the light or dark theme (`overflow: visible` on both document surfaces), and long unbroken tokens wrap outside of `pre`/`code` (`overflow-wrap: anywhere` plus wrap rules for prose) so wide URLs and identifiers no longer push content out of the card.
- **Overlay opening with stale rows after a capture** — every clipboard capture (plain insert, bump-to-top, and merge) now retains the item by id at the top of the overlay prewarm cache (capped at 250 entries), so the overlay opens with the freshest list even when it never re-queried the database. The overlay's `overlay-data` handler is guarded by a snapshot-fresher check: a late or empty payload can no longer clobber a list that the live push already advanced (applies only when the local list is empty, the snapshot contains the local head, or the snapshot is strictly longer).
- **DWM hairline flashing on main-window show** — the non-client border suppression is re-asserted immediately after `show()` on both main-window show branches (overlay-swap and cold open), not only before it, so a frame recalculation between show and uncloak cannot repaint the OS border during the reveal ramp.
- **Main window painted stamp parity** — the enlarged window stamps its content as painted on mount after a double requestAnimationFrame, matching the quick overlay, so the paint gate observes genuine first paint rather than assuming it.

### Changed
- Present-cycle extraction: the park, uncloak, settle, hide, restore, and re-cloak sequence is a single shared `offscreen_present_cycle` helper used by both the boot prewarm and the show-path rewarm, with module-level present-once flags per window label.
- The `carbon-ui-ready` event payload now includes the emitting window label; the backend rejects ready events from labels that are not main or overlay.

## [0.1.14] — 2026-09-22

### Fixed
- **Seamless window edges (no white border or margin)** — removed the 1px white perimeter hairline on the quick overlay and main window, and disabled the OS drop shadow on both windows (it rendered as a wide white margin around the transparent frameless surfaces). Edge definition now comes from the in-app dark shadow plus acrylic/base contrast only. DWM border suppression and 8px corner rounding are unchanged.
- **Snappy overlay open/close** — overlay show/hide no longer plays fading or scaling content animations; open and close are instant, matching the main window. Rapid hotkey spam and click bursts toggle cleanly without lag or dropped taps. The overlay reveals on a fast 30ms OS alpha ramp while the main window keeps its 100ms ramp, both through one shared uncloak path.
- **Instant overlay refresh with zero stale rows** — the overlay opens immediately with data pushed by Rust alongside the open (no pre-open wait, no IPC on the critical path). Captures insert at the top of the list instantly even while the overlay is hidden; a monotonic store version detects a stale cache and triggers exactly one guarded idle refresh after reveal, never a double insert.
- **Edit reflection across both windows** — committing an edit (on blur or Ctrl/Cmd+S) from either the quick overlay or the main window updates the row and preview in place in both windows via a shared entry-updated broadcast; the shared commit path logs source window and duration.
- **Overlay skeleton and painted lines removed** — the loading skeleton animation is gone, the read section and overlay chrome carry no painted hairlines between panes, and shared structural borders (meta strip, pills, controls) are untouched.
- **Corner-only rim elimination** — locked the four corner suspects (DWM border, controller background, CSS ring, radius mismatch) so a magnified corner crop over dark wallpaper paints no rim: controller default stays fully transparent, window roots carry no inset highlight or perimeter border, and DWM owns the single 8px rounded corners.
- **Timing parity between windows** — the overlay pre-serves its snapshot at hide time (refreshing the warm cache) so the show path does zero database work, mirroring the main window's pipeline; both windows gate on first present with settle 0, uncloak through the shared ack-gated path, and hide with the same 90ms fade.
- **Honest drop cursors and clean drag state** — collection drop targets classify payloads and show a no-drop cursor for unsupported ones (without highlighting), and every drop or cancel clears the target highlight so no leftover state remains.
- **Foreground restore rejections are logged** — restore-the-target-app attempts log SetForegroundWindow rejections and exhaustion after 8 attempts; no path flashes the taskbar.
- **Info scrollbar hidden** — the preview info block no longer shows a scrollbar.

### Changed
- The v36 pick-overlay-parity workstream (edit reflection, store version, drop cursors, timing parity) is merged with the v37 instant-gate design: the open path keeps its zero-wait gate, and the store/cache version comparison now gates the single post-reveal backstop instead of a pre-open refresh.

## [0.1.13] — 2026-09-16

### Fixed
- **Drag and paste stability** — drag payloads are hardened against hostile DataTransfer (the original main drag-and-drop behavior was restored and then guarded: `text/html` stripped from all payloads to stop target-tab crashes, rich-text clips offer plain unformatted text only, unsupported types never starve the rest of the payload). Paste releases its single-shot guard before the deselect tail, deselect is scoped to the paste target and the browser-gated collapse no longer triple-taps, and copy/default-arrow cursors show on drag surfaces with double-tap deselect ignored in chat shells. The overlay stays visible for any in-flight drag including DOM drags.
- **OS file drag-out** — image and file clips drag out of Carbon to Explorer and other apps via the proven Tauri drag plugin; in-process harness tests lock the payload contract (no clip type ever yields an empty transfer).
- **Paste confirmation and elevation** — paste waits on a bounded confirmation with send-time proof; when the target needs admin rights, the clip stays on the clipboard with a visible hint instead of failing silently.
- **Rich-text legibility** — per-node computed-contrast enforcement (AA, 4.5:1 minimum) runs across preview content with a CI contrast matrix; light-on-transparent fragments are darkened by content scan, dark-source captures render on a dark card, and pasted HTML restores with byte-accurate CF_HTML fidelity alongside a plain-text fallback.
- **Overlay unified frame** — the quick overlay is a fixed 750x475 frame with a permanent preview pane (no Tab toggle), a preview-dominant split with edge-to-edge text, an information block pinned to the bottom that hugs its content, and media using the full pane without stretched voids.
- **Tab-toggle flash eliminated** — the white flash and non-client border flash on the Tab preview toggle are suppressed, and the preview transition is smooth.
- **Cold-launch flash hardening** — overlay reveal uses a unified 100ms OS alpha ramp identical to the main window, the frontend fires ready only post-paint, and DWM cloak failures are logged loudly for the cold-chain audit trail.
- **Drag focus and preview polish** — drag focus guard, dark-card edge blending, prewarm snapshot trim, and instant overlay focus on open.

## [0.1.12] — 2026-09-12

### Fixed
- **Event-driven show gate & zero fixed settle delays** — Eliminated all fixed settle delays (previously up to 150ms) from the happy path across both Quick Overlay and Main Window. The show gate now uncloaks purely on per-cycle present confirmation from the renderer. Hotkey-to-interactive latency measured at p50=46ms / p95=46ms for the overlay and p50=47ms / p95=47ms for the main window (beating baseline by 11-15ms). A 300ms bounded wait provides flash-safe fallback without leaving windows in a cloaked state.
- **OS-alpha masking & flash elimination** — Windows uncloak at OS-level alpha 0 and ramp to 255 over 100ms, ensuring direct composition texture swaps composite invisibly and eliminating show-time white frame flashes. Raw SWP_SHOWWINDOW was removed from native window positioning to prevent premature DWM frame reveals.
- **Persistent hidden compositor heartbeat** — A hidden rAF heartbeat keeps Chromium's compositor awake and warm while windows are hidden, preventing animation suspension and render freezes upon opening.
- **Tab preview mask lifecycle & single layout root** — Desktop-blur mask is active strictly between content-out and content-in during Tab preview transitions, with mask-off assertions enforced at idle. Exactly one live layout root is mounted throughout all states, and preview toggle transitions complete with keypress-to-settled latency of 176ms (budget <= 200ms).
- **Tab-toggle ghost classification & DirectComposition swapchain handling** — Continuous 240fps frame sampling confirmed single layout root across all frames (ruling out dual-root crossfading). Transient resize artifacts were classified as DirectComposition swapchain re-allocation and deliberately accepted as a documented cosmetic known issue to preserve instant clip list solidity and avoid whole-window blackout dips.
- **Keyboard navigation boundary safety** — Keyboard arrow navigation in clip lists is strictly clamped at the top and bottom boundaries, preventing infinite scroll loops and unintentional jumping between the first and last entries.
- **Frontend choreography bundle transform** — Mask lifecycle helpers moved to top-level module scope in the choreography controller, resolving Vite and esbuild transform errors.

## [0.1.11] — 2026-09-03

### Fixed
- **Math covers study-note symbols** — audited against the Foundations-of-AI PDFs: `\Longrightarrow`→⟹, `\Leftrightarrow`→⇔, `\mapsto`→↦, `\sum`→∑ / `\prod`→∏ / `\int`→∫ (subscripts like `\sum_{i=1}^{n}` now convert), `\wedge`→∧ / `\vee`→∨ / `\neg`→¬ / `\models`→⊨ / `\vdash`→⊢, `\sim`→∼ / `\div`→÷, capital Greek (`\Delta`→Δ, `\Alpha`→Α, …), `\varepsilon`→ϵ, `\prime`→′ / `\ast`→∗ / `\star`→★ / `\bullet`→•, `\subseteq`→⊆ / `\bigcap`→⋂, blackboard sets (`\mathbb{N}`→ℕ, ℝ, ℤ, ℚ, ℂ), upright operators (`\lim`, `\argmax`, …). `\circ` now renders function composition (∘) while `18^\circ C` still gives 18°C, and `\left`/`\right` no longer eat `\rightarrow`-style prefixes.
- **Focused arrows stop at the edge** — clicking the preview image or rendered rich/markdown doc focuses it and all four arrows scroll/pan within; reaching the end no longer jumps to the next capture (an overshoot can't swap the whole preview). `Esc` now releases focus first and only closes on a second press; tooltips note the release.
- **Settings Save button removed** — every control already persists instantly, so the button just re-saved the same state.

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
