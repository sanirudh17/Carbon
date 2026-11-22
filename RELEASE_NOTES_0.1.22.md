# Carbon 0.1.22

A major polish and feature release introducing Caret-anchored Quick Overlay placement, an interactive Reorderable Paste Stack Drawer, an opt-in universal Smart Content Inspector, TinyCast/Linear-inspired frosted-glass refinements, smoother content search, and zero-warning native performance hardening.

## New features

- **Caret-anchored Quick Overlay placement** — Choose between `Center` and `Caret` in `Settings → Behavior`. Caret mode probes the active text insertion point across native Win32 and modern Windows UI Automation (`IUIAutomationTextPattern2::GetCaretRange` / `TextPattern::GetSelection` / focused control bounds) with cursor fallback and automatic screen-edge clamping.
- **Floating Reorderable Paste Stack Drawer** — Manage queued clips from a compact frosted drawer in both the Quick Overlay and Full Library with live pointer drag-to-reorder (no WebView2 no-drop cursor), move up/down, reverse order, remove, and cross-window live sync (`paste-queue-updated`).
- **Opt-in Smart Content Inspector** — Off by default so clip browsing stays calm; toggle on demand via the Sparkles button beside `Render | Raw`. Deterministically inspects real-world payloads locally (zero AI, zero network): JWTs (bare, `Bearer`, `Authorization:`, or embedded), Unix timestamps (`s`/`ms`/`µs`/`ns`), ISO-8601 & RFC 2822 dates, CSS colors (HEX/RGB/HSL/CSS4/alpha), UUIDs & ULIDs, emails, URLs & query strings (with 1-click tracking-parameter stripping), 5/6-field & preset Cron schedules, IPv4 CIDR subnets, cURL commands, raw/fenced/escaped JSON (1-click Pretty/Minify), `.env` configs, Base64 (`Basic` auth, data URIs, wrapped MIME), and Unicode/HTML escapes — plus decoded QR/OCR text on images in the Library.
- **Follow System Theme & Ignored Apps** — Follow Windows' light/dark mode automatically alongside Light/Dark pins, and configure ignored `.exe` applications in Settings with default password-manager exclusions.

## UI polish, capture accuracy & reliability

- **Unified frosted-glass & motion polish** — Quiet TinyCast/Linear-inspired hierarchy, refined HugeIcons strokes, pure-DOM GPU-composited sliding selection indicators across lists, segmented controls, and action menus, theme-aware syntax highlighting for 11 languages, champagne-amber glass search highlights, and fixed Quick Overlay color swatch sizing.
- **Accurate capture classification & Glint image support** — Prevents plain prose, banners, filenames, and plain-wrapped HTML/RTF from misclassifying as Code, Link, or Formatted Text; captures Glint screenshot files as real image clips with automatic startup repair for prior entries.
- **`Win+Shift+S` screenshot overlay fix** — Blur-hiding the Quick Overlay skips restoring the prior foreground window, and `Ctrl+S` edit-save guards `!shiftKey && !altKey`, preventing interference with Windows Snipping Tool or Glint shortcuts.
- **Smooth, non-stalling content search** — Fixes the mid-typing search stall where async `startTransition` updates could reset the search draft or cancel pending debounce timers; bounds list snippet slicing, indexes `clip_collections(clip_id)`, isolates list row layout with CSS `contain`, and avoids double preview highlighting.
- **Performance, memory & compiler cleanup** — Moves `get_image_data_url` and `get_today_clips` onto Tokio's blocking pool, streams thumbnails via the asset protocol first with immediate temporary canvas/bitmap cleanup, memoizes Smart Content Inspector parsing, and resolves all Rust compiler warnings.

## Validation and packaging

- Retains bundled offline PP-OCRv6 Small, Windows x64 NSIS installer, app identity, and signed-updater flow.
- Full verification results: [v0.1.22 validation report](https://github.com/sanirudh17/Carbon/blob/v0.1.22/RELEASE_0.1.22_VALIDATION.md).
