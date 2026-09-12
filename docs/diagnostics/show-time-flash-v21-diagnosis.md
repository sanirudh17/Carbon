# ADDENDUM v21: Investigation-Led Fix for Show-Time Flash (Overlay + Main Window)

## 1. Frame-Accurate Video Evidence & Cross-Referenced Analysis

Video source: `C:\Users\sanir\Videos\Glint\Glint 2026-09-12 at 17.46.20.mp4`  
Format: 55.52 FPS, 1524 frames, duration 27.45 seconds.

### Frame-by-Frame Evidence of Show Flash & Superimposed Labels

| Episode | Show Start Frame | Flash/Washed Frame | Normal Content Frame | Mean Pixel Intensity (Window Region) | Visual & Diagnostic Log Evidence |
|---|---|---|---|---|---|
| **Ep 8** | Frame 440 (7.925s) | **Frame 441 (7.943s)** | Frame 442 (7.961s) | Frame 440: 43.23 (desktop)<br>**Frame 441: 52.92 (washed)**<br>Frame 442: 35.62 (normal) | **S1 & S3**: At frame 441, the native window is sized to 1020x560 (expanded), but the frontend renders the collapsed layout (680px). The right preview pane is an empty, washed acrylic veil (`mean=52.92`). The footer displays `"Show Preview"` at frame 441, which snaps to `"Hide Preview"` at frame 442 when `get_settings` resolves. |
| **Ep 9** | Frame 493 (8.880s) | **Frame 494 (8.898s)** | Frame 495 (8.916s) | Frame 493: 43.17 (desktop)<br>**Frame 494: 49.85 (washed)**<br>Frame 495: 35.64 (normal) | **S1**: Washed veil in preview pane for exactly 1 frame before normal dark backdrop renders. |
| **Ep 10** | Frame 546 (9.834s) | **Frame 547 (9.852s)** | Frame 548 (9.870s) | Frame 546: 43.17 (desktop)<br>**Frame 547: 49.89 (washed)**<br>Frame 548: 35.62 (normal) | **S1 & S3**: Right preview pane is washed/milky. Footer label `"Hide Preview"` is shifted and `"Enter Paste"` is truncated for 1 frame. |
| **Ep 11** | Frame 608 (10.951s) | **Frame 609 (10.969s)** | Frame 610 (10.987s) | Frame 608: 43.16 (desktop)<br>**Frame 609: 49.85 (washed)**<br>Frame 610: 35.62 (normal) | **S1**: Washed veil frame at uncloak instant. |
| **Ep 12** | Frame 656 (11.816s) | **Frame 657 (11.834s)** | Frame 658 (11.852s) | Frame 656: 43.16 (desktop)<br>**Frame 657: 52.92 (washed)**<br>Frame 658: 35.61 (normal) | **S1**: Washed veil frame at uncloak instant. |
| **Ep 14** | Frame 748 (13.473s) | **Frame 749 (13.491s)** | Frame 748: 43.19 (desktop)<br>**Frame 749: 52.90 (washed)**<br>Frame 750: 35.62 (normal) | **S1**: Washed veil frame at uncloak instant. |
| **Ep 16** | Frame 1047 (18.858s) | **Frame 1048 (18.876s)** | Frame 1049 (18.894s) | Frame 1047: 43.14 (desktop)<br>**Frame 1048: 49.85 (washed)**<br>Frame 1049: 35.66 (normal) | **S1**: Washed veil frame at uncloak instant. |
| **Ep 17** | Frame 1188 (21.398s) | **Frame 1189 (21.416s)** | Frame 1190 (21.434s) | Frame 1188: 43.17 (desktop)<br>**Frame 1189: 80.29 (light)**<br>Frame 1190: 80.29 (main) | **S2**: Main window show episode (light theme). |

---

## 2. Identified Root Causes

### 1. Root Cause for S1 & S2 (Show-time flash / washed veil)
1. **Asynchronous Settings/State Desynchronization on Show:**
   - In Rust, `handle_overlay_hotkey` reads `settings.preview_enabled` synchronously and resizes the native window to 1020x560.
   - However, `app_handle.emit("overlay-opened", ...)` did NOT include `preview_enabled` in the event payload.
   - The webview received `overlay-opened` and began the paint gate with its existing/stale state (`previewOpen = false`).
   - Only AFTER the window was shown and uncloaked did `invoke('get_settings')` resolve asynchronously and switch `previewOpen` to `true`.
   - Result: For the first uncloaked frame, the native window was 1020px wide, but the webview rendered the 680px compact layout. The right 340px area was completely empty acrylic backdrop with no content, visible as a washed, milky veil (`mean=52.92`).
2. **Premature Uncloak Before DirectComposition Surface Commit:**
   - `executeWindowShow` called `html.classList.remove('wm-hidden')` and immediately called `invoke('overlay_painted')` in the same JS execution turn.
   - Chromium's compositor had not yet submitted the unhidden DirectComposition frame to DWM. DWM uncloaked while the surface was still displaying the `wm-hidden` (`opacity: 0`) state.
3. **Missing Cycle Token Validation in Rust:**
   - `note_overlay_painted` in Rust did not validate a token passed from the frontend; it loaded `OVERLAY_SHOW_GEN` from its own atomic. Any stale paint notification from a prior cycle or prewarm could immediately uncloak the window.

### 2. Root Cause for S3 (Superimposed/overlapping footer labels)
1. **Asynchronous Target App Name Resolution:**
   - `loadTargetApp()` called `invoke('get_target_app_name')` asynchronously after show.
   - When the overlay opened, the footer rendered with either a stale target app or generic `"Paste"`. When `get_target_app_name` resolved a frame later, the label changed to `"Paste to [App]"`.
2. **Transform and Opacity Transitions Active on Content:**
   - In `src/index.css`, `#content` had `html.wm-hidden #content { transform: scale(0.985); }` and `transition: opacity 100ms, transform 100ms`.
   - When `wm-hidden` was removed, `#content` transitioned its scale from 0.985 to 1.0 over 100ms. An asynchronous label change arriving during this scale transition caused consecutive frames to rasterize text at fractional, interpolated coordinates, producing superimposed text artifacts.

---

## 3. Minimal Fix Implementation

1. **Synchronous Show Payload (`src-tauri/src/hotkey.rs`):**
   - Emit `overlay-opened` with `OverlayOpenedPayload`:
     * `token`: fresh monotonic `OVERLAY_SHOW_GEN`.
     * `preview_enabled`: current persisted preview state.
     * `target_app`: current foreground target application name (`paste::get_target_app_name()`).
     * `hide_gen`: monotonic hide generation.
   - Emit `enlarged-opened` with `EnlargedOpenedPayload { token: enlarged_gen }`.
   - On every hide (`hide_overlay_window`, `hide_enlarged`, `request_webview_overlay_hide`, `request_webview_enlarged_hide`), increment the show generation counter to invalidate all in-flight paint tokens.
2. **Cycle Token Gating in Rust (`src-tauri/src/hotkey.rs` & `src-tauri/src/choreo.rs` & `src-tauri/src/lib.rs`):**
   - In `note_overlay_painted` and `note_enlarged_painted`, require `token: Option<u64>`. Reject any uncloak call where `token != CURRENT_SHOW_GEN`.
3. **Compositor-Committed Paint Gate (`src/lib/choreo.ts`):**
   - In `executeWindowShow`, remove `wm-hidden` and keep `no-anim` while cloaked.
   - Use double `requestAnimationFrame` before invoking `overlay_painted` / `enlarged_painted` with `{ token }`, allowing Chromium to commit its visual tree to DirectComposition before DWM uncloaks.
4. **Instant State Application (`src/components/QuickOverlay.tsx`):**
   - In `overlay-opened` listener, apply `preview_enabled` and `target_app` synchronously from the event payload before the paint gate starts.
   - Clear `targetApp` on hide.
5. **Eliminate Show Transitions on Content (`src/index.css`):**
   - Removed `transform: scale(0.985)` from `html.wm-hidden #content`. Kept scale/fade strictly on `html.wm-hiding #content` (hide only).
   - Removed show `transition:` from `#content, .overlay-content`.
   - In Solid mode, removed 90ms linear opacity transition from `html[data-material="solid"].wm-hidden #root.wm-fade-target`.
