# Carbon UI Overhaul — Unified Overlay Split Frame

Worktree-only change. Not merged into `main`. This note covers the token
table, the vibrancy choice + fallback, and the deleted Tab-toggle surface.

## What changed

The overlay (picker) is now exactly ONE layout state: a permanent split
frame at a fixed **750 × 475** footprint, Tinycast-adapted. The Tab preview
toggle (compact 680×440 ↔ expanded 1020×560) is fully removed — no boolean,
no conditional rendering, no expand/collapse animation, no compatibility flag.

- Top: filter input ("Type to filter entries…").
- Left (40%): scrollable, date-grouped capture list (thumbnail + one-line label).
- Right (60%): permanent preview — media area above the Information block.
  (Tinycast-like: the preview is deliberately larger than the capture list.
  The media box hugs its content inside the 260px cap instead of a 200px
  min-height void; the info block hugs its rows up to the 175px cap with no
  internal gaps, and stays bottom-anchored via the growing media area.)
- Footer: Paste + `Enter` keycap, Actions + `Ctrl+K` keycap, Close + `Esc`.
- Selection contract: row click and `ArrowUp/ArrowDown` set the single
  `selectedIndex`; the right pane re-renders from it. First entry is
  auto-selected on open/data. The pane never unmounts — an empty list renders
  an in-pane placeholder, which keeps the frame stable (kills the jank).
- `Tab` is unbound (native focus traversal). It never mutates layout.

## Token table (single source of truth: `src/index.css` `:root`)

| Token | Value | Source |
|---|---|---|
| `--overlay-w` | `750px` | Tinycast expanded palette width |
| `--overlay-h` | `475px` | Tinycast expanded palette height |
| `--row-h` | `44px` | list row height (overlay-scoped) |
| `--thumb` | `32px` | list row thumbnail (overlay-scoped) |
| `--media-cap` | `260px` | Tinycast `clipboardMediaHeight` (max, scale-to-fit) |
| `--info-h` | `175px` | Tinycast Information block (Source/Type/Dimensions/Size/Copied) |
| `--hairline` | `rgba(255,255,255,.08)` | column divider |
| `--ui-scale` | `1` | reserved multiplier (not wired — future) |

List rows: single-line label with `text-overflow: ellipsis`. Preview images:
`max-width: 100%`, `max-height: 260px`, `object-fit: contain`; text scrolls.
Async media keeps the dark placeholder (`rgba(10,10,12,.35)`) — never white.

## Window ownership (the window, not CSS, owns size)

- `src-tauri/tauri.conf.json` → overlay: `750×475`, `resizable: false`,
  `maximizable: false`, `fullscreen: false`, `decorations: false`,
  `transparent: true`, `center: false` (Rust resolves the anchor once per
  show), `visible: false`.
- `src-tauri/src/hotkey.rs` → `OVERLAY_WIDTH/OVERLAY_HEIGHT` constants (750/475).
  Prewarm sizes once; the show path positions with `SWP_NOSIZE` only and never
  calls `set_size` — content can never resize the window (this also removes
  the resize-driven unpainted-surface flash by construction).
- The web layer never calls resize/auto-size APIs.

## Vibrancy choice + fallback (Windows port of Tinycast glass)

- `window-vibrancy` crate (already at `0.8.0`): `apply_acrylic` with a dark
  tint; falls back to `apply_blur` on older builds; `apply_mica` path exists
  for flat depth. Applied **once** at creation/prewarm — never re-applied on
  show/hide (re-application is a classic flash source).
- No CSS `backdrop-filter` for desktop blur (WebView2 cannot blur outside the
  window); DWM owns the backdrop. Surface tint lives in CSS
  (`--glass-base` slab + list/preview scrims).
- First-frame guarantee unchanged: `index.html` inline pre-style keeps
  `html/body` transparent + `wm-hidden` masked before any JS loads; the
  WebView2 controller default background is transparent (glass) or an opaque
  theme match (solid); the show path stays cloak-first with the paint-gate
  ack before uncloak.

## Deleted Tab-toggle surface area

- Frontend: `previewOpen` state/ref, preview phase machine
  (`idle|out|snap|in`), `createPreviewLayoutController` + `setWindowPreviewSize`
  + `preview-toggled` ack protocol, both `Tab`/`Ctrl+Shift+O` key branches,
  footer toggle hint, `no-preview`/`collapsed`/`preview-out`/`snap-veil`/
  `kids-veil` classes and CSS, `data-painted-expanded` writes in the overlay,
  `carbon_preview_enabled` persistence.
- Rust: `choreo::set_overlay_preview` (+ `PreviewToggled`,
  `choreo_set_overlay_preview`, both command registrations),
  compact/expanded geometry literals, per-show overlay resize,
  `preview_enabled` setting field, `preview_enabled` in `OverlayOpenedPayload`.
- Retired choreo invariants: I2 (toggle-resize discipline), I5 (expand cold
  gate), I7 (transition watchdog). Show/hide invariants (I1 cloak/paint gate,
  I3 single root, I4 fade target, I6 instant labels) are untouched.
- Tests: toggle state-machine simulations and toggle-pinning static checks
  were removed across `test/choreo.test.mjs`, `driver-v20/21/22/23/24`; new
  `Unified Frame` static tests pin zero toggle surface, the 750×475 chain,
  the permanent pane, and the selection contract. Historical driver docs under
  `docs/diagnostics/` are kept as the record of the removed behavior.

## Screenshots (this directory)

- `shot-overlay-before-compact.png` — old compact frame (680×440, list only,
  `Tab / Show Preview` footer hint).
- `shot-overlay-before-expanded.png` — old Tab-expanded frame (1020×560).
- `shot-overlay-after.png` — new unified split frame (750×475, list +
  permanent preview + Information block), floating over the live desktop
  through the acrylic surface. No `Tab` hint in the footer.
