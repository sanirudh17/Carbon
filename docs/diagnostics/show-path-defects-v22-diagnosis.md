# ADDENDUM v22: Close-Out Fix for the Two Show-Path Defects + Residual Show Flash

## 1. Frame-Accurate Video Evidence & Cross-Referenced Analysis

Video source: `C:\Users\sanir\Videos\Glint\Glint 2026-09-12 at 18.20.08.mp4`  
Format: 55.08 FPS, 2707 frames, duration 49.15 seconds.

### Frame-by-Frame Evidence of Show Defects & Flashes

| Defect | Episode Start Frame | Anomaly Range (Frames) | Duration (ms) | Mean Pixel Intensity (Region) | Bounding Box [x, y, w, h] | Visual & Diagnostic Log Evidence |
|---|---|---|---|---|---|---|
| **S1** | Frame 106 (1.925s) | **Frames 106 to 153 (1.925s to 2.778s)** | **871ms** (48 consecutive frames) | Desktop: 24.99<br>**Anomaly: 255.00 (pure white)**<br>Settled: 24.99 | `x=[32, 1896] (w=1865)`<br>`y=[12, 1064] (h=1053)` | **S1**: Overlay hotkey pressed while main window was considered "already open". The focus-instead-of-open path unminimized and showed an unpainted main window directly, presenting a full-screen 1865x1053 pure white window for 871ms. |
| **S3** | Frame 685 (12.436s) | **Frame 686 (12.455s)** | **18ms** (1 frame) | Desktop: 71.54<br>**Flash: 249.14 (near-pure white)**<br>Content: 80.75 | `x=[532, 1389] (w=857)`<br>`y=[236, 776] (h=540)` | **S3**: Overlay quick show presented a 1-frame near-pure white flash (`mean=249.14`) across the exact overlay window footprint at the moment of appearance, immediately settling to normal content (`mean=80.75`) at frame 687. |
| **S2** | Hotkey / Tray Show | N/A (stuck invisible) | Indefinite | Desktop background only (window invisible) | Native window `main` | **S2**: `uncloak_enlarged_if_current` logged `uncloak skipped: main not natively visible` and permanently abandoned uncloak. Window remained shown in Win32 but cloaked in DWM. Subsequent hotkey presses evaluated `is_visible == true` and requested hide, causing an unbreakable toggle deadlock. |

---

## 2. Identified Root Causes

### 1. Root Cause for S1 (Full-size pure white window on focus-instead-of-open path)
- In `src-tauri/src/hotkey.rs`:
  ```rust
  if let Some(main_win) = app_handle.get_webview_window("main") {
      if main_win.is_visible().unwrap_or(false) {
          crate::paste::log_diag("[HOTKEY] Main is open — focusing it instead of opening overlay.");
          if main_win.is_minimized().unwrap_or(false) { let _ = main_win.unminimize(); }
          let _ = main_win.show();
          let _ = main_win.set_focus();
          return;
      }
  }
  ```
- Win32 `is_visible()` checks the `WS_VISIBLE` style bit. Because DWM cloaked windows (`DWMWA_CLOAK`) retain `WS_VISIBLE`, `main_win.is_visible()` returned `true` at startup/prewarm and after hide even when `main` was cloaked and unpainted.
- `handle_overlay_hotkey` erroneously assumed `main` was already open on screen, bypassed the overlay show, and called `main_win.show()` and `unminimize()` directly without routing through the paint gate or emitting `enlarged-opened`.
- This revealed an unpainted WebView2 DirectComposition surface (1865x1053) for 871ms until user interaction cleared it.

### 2. Root Cause for S2 (`uncloak skipped: main not natively visible` / shown-but-invisible deadlock)
- In `src-tauri/src/hotkey.rs`:
  ```rust
  if !win.is_visible().unwrap_or(false) {
      crate::paste::log_diag("[SHOW_MAIN] uncloak skipped: main not natively visible");
      return;
  }
  ```
- When `main_win.show()` was called, the Win32 message queue could experience transient latency before `win.is_visible()` reflected `true`.
- When the frontend acknowledged paint via IPC, Rust encountered `!win.is_visible()` and executed an **unbounded permanent skip**: it logged the skip and returned immediately without scheduling retry or recovery.
- The window remained DWM-cloaked (invisible) forever.
- On the next hotkey press, `handle_enlarged_hotkey` checked `let is_visible = main_win.is_visible().unwrap_or(false)`. Since message queue processing had settled, `is_visible` was now `true`, so it sent a hide request, locking the user into an unbreakable toggle deadlock.

### 3. Root Cause for S3 (Residual 1-frame white flash on overlay appearance)
- In `handle_overlay_hotkey` and `handle_enlarged_hotkey`, `set_window_cloaked(&window, true)` was invoked *before* calling `SetWindowPos(..., SWP_SHOWWINDOW)` and `window.show()`, but was **not re-asserted after `show()`**.
- On Windows DWM, transitioning a window from hidden to shown can clear the `DWMWA_CLOAK` attribute at the compositor level.
- Because the cloak was cleared during the show transition, DWM composited an unpainted intermediate frame on screen (`mean=249.14` at Frame 686) before the frontend completed its double rAF paint gate and uncloaked.
- Additionally, on `re-show during hide`, `overlay-cancel-hide` was emitted without a generation token, which bypassed token gating on uncloak.

---

## 3. Minimal Fix Implementation

### 1. Main Window Logical Visibility Tracking (`src-tauri/src/hotkey.rs`)
- Added `MAIN_CLOAKED: AtomicBool = AtomicBool::new(true)` and `MAIN_HAS_PAINTED: AtomicBool = AtomicBool::new(false)`.
- Updated `set_window_cloaked` to update `MAIN_CLOAKED` when `window.label()` is `"main"` or `"enlarged"`.
- Defined `pub fn is_main_visible() -> bool { !MAIN_CLOAKED.load(Ordering::SeqCst) && MAIN_HAS_PAINTED.load(Ordering::SeqCst) }`.
- `MAIN_HAS_PAINTED` is reset to `false` on `hide_enlarged`, `recloak_window`, and timeout recovery.

### 2. S1 Fix & Mutual Exclusion (`src-tauri/src/hotkey.rs`)
- In `handle_overlay_hotkey`, the focus-instead-of-open condition now requires:
  `is_main_visible() && main_win.is_visible().unwrap_or(false) && !main_win.is_minimized().unwrap_or(false)`.
  If `main` is cloaked or unpainted, it is never treated as open.
- Added `dismiss_main(app_handle)` before showing the overlay, and `dismiss_overlay(app_handle)` before showing main, strictly enforcing **Invariant I4** (exactly one app window visible at any instant).

### 3. S2 Fix: Bounded Wait with Flash-Safe Recovery (`src-tauri/src/hotkey.rs`)
- In `uncloak_enlarged_if_current` and `uncloak_overlay_if_current`:
  - Added full precondition logging with tag `[UNCLOAK_PRECOND]` (window, expected token, current generation, API visibility, cloak state, phase, HWND).
  - Implemented a bounded polling wait (up to 300ms in 10ms steps) for `win.is_visible()` to settle.
  - Aborts immediately if the generation token or phase changes mid-wait.
  - If the 300ms bound expires, executes **flash-safe recovery**: keeps window cloaked, calls `win.hide()`, resets atomic state, and logs `[SHOW_...] uncloak recovery: window not natively visible after 300ms. Executing flash-safe recovery.`
  - Zero windows left shown-but-cloaked > 300ms (**Invariant I3**).

### 4. S3 Fix: Immediate Cloak Re-Assertion & Token Propagation (`src-tauri/src/hotkey.rs` & `src/components/QuickOverlay.tsx`)
- In `handle_overlay_hotkey` and `handle_enlarged_hotkey`, immediately call `set_window_cloaked(&window, true)` after `show()` and `unminimize()` to prevent Win32 from clearing `DWMWA_CLOAK`.
- In `prewarm_windows`, ensure `main` also has `set_round_corners`, `set_window_default_background`, `set_webview_transparent_background`, and `set_window_cloaked(true)` applied.
- In `re-show during hide`, pass `token: overlay_gen` in `OverlayCancelHidePayload`. `QuickOverlay.tsx` extracts `token` and passes it through `executeWindowShow('overlay', ..., token)` to enforce **Invariant I1**.
- In `lib.rs`:
  - `WindowEvent::CloseRequested` for `main` routes through `choreo::hide_enlarged(&window.app_handle())`.
  - `tauri_plugin_single_instance` cloaks `main` before and after `win.show()`.

---

## 4. Verification & Invariant Audit

1. **Automated Driver Suite (`test/driver-v22.test.mjs`):**
   - 20 rapid overlay shows with token validation: PASS (max latency 64ms <= 150ms).
   - 20 rapid main window shows with token validation: PASS (max latency 64ms <= 150ms).
   - 10 focus-instead-of-open presses: PASS (0 unpainted surfaces, 0 flashes).
   - Bounded wait with 50ms message queue lag: PASS (resolved in 50ms with 0 skips).
   - Bounded wait timeout (>300ms): PASS (clean flash-safe recovery, 0 stuck cloaked windows).
   - 5 tray opens: PASS (0 violations).
   - 20 Tab collapse/expand cycles: PASS (max latency 178ms <= 200ms, mask invariant holds).
   - 30 rapid alternating inputs under stress: PASS (mutual exclusion holds, 0 violations).
2. **Full Regression Suite (`npm test`):**
   - 48/48 tests passed (0 failures, 0 regressions across v15, v16, v20, v21, v22).
3. **Rust Unit Tests (`cargo test`):**
   - 35/35 passed (0 failures).
