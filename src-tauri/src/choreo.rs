use tauri::{AppHandle, Manager};

use crate::hotkey;
use crate::paste;

/// ADDENDUM v15: Rust Choreography Shim
/// Consolidates all native window show/hide/resize/paint-gate handshakes for
/// overlay, library (enlarged), and settings windows.
/// Enforces invariants on the native side:
///   I1: Cloaked until frontend confirms paint (note_overlay_painted / note_enlarged_painted).
///   I2: Window size changes atomically without animating native composition surface.

/// Cloaks a window immediately WITHOUT hiding it, so a hide fade plays
/// invisibly instead of exposing the bare acrylic slab (close flash).
/// Unknown labels are a no-op Ok. Idempotent: re-cloaking is a no-op.
pub fn cloak_window(app_handle: &AppHandle, window_label: String) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window(window_label.as_str()) {
        hotkey::set_window_cloaked(&win, true);
    }
    Ok(())
}

/// Natively hides the overlay window.
pub fn hide_overlay(app_handle: &AppHandle) -> Result<(), String> {
    if hotkey::get_overlay_phase() == hotkey::OverlayPhase::Showing {
        crate::paste::log_diag("[HIDE_OVERLAY] Skipped stale hide: re-show already won the race.");
        return Ok(());
    }
    hotkey::invalidate_overlay_show_gen();
    hotkey::hide_overlay_window(app_handle);
    Ok(())
}

/// Natively hides the enlarged (main) window.
pub fn hide_enlarged(app_handle: &AppHandle) -> Result<(), String> {
    hotkey::invalidate_enlarged_show_gen();
    if let Some(win) = app_handle.get_webview_window("main") {
        hotkey::set_window_cloaked(&win, true);
        hotkey::MAIN_HAS_PAINTED.store(false, std::sync::atomic::Ordering::SeqCst);
        paste::restore_target_window();
        let _ = win.eval("document.documentElement.classList.add('wm-hidden')");
        let _ = win.hide();
    }
    Ok(())
}

/// Confirms the frontend paint gate opened and rendered the first valid frame.
/// Uncloaks the window in DWM.
pub fn note_window_painted(app_handle: &AppHandle, window_label: &str, token: Option<u64>) {
    match window_label {
        "overlay" => hotkey::note_overlay_painted(app_handle, token),
        "main" | "enlarged" => hotkey::note_enlarged_painted(app_handle, token),
        _ => {}
    }
}

// ── Tauri Commands ──

#[tauri::command]
pub fn choreo_hide_overlay(app_handle: AppHandle) -> Result<(), String> {
    hide_overlay(&app_handle)
}

#[tauri::command]
pub fn choreo_hide_enlarged(app_handle: AppHandle) -> Result<(), String> {
    hide_enlarged(&app_handle)
}

#[tauri::command]
pub fn choreo_notify_painted(app_handle: AppHandle, window_label: String, token: Option<u64>) {
    note_window_painted(&app_handle, &window_label, token);
}

/// Frontend show-gate bound: if the paint gate never opens (>300ms), the
/// frontend calls this to force a flash-safe reset instead of leaving a
/// cloaked-visible window stuck forever (the "main never appears" state).
#[tauri::command]
pub fn choreo_show_recovery(app_handle: AppHandle, window_label: String) -> Result<(), String> {
    match window_label.as_str() {
        "main" | "enlarged" => {
            crate::paste::log_diag(
                "[SHOW_MAIN] show recovery: gate bound exceeded — flash-safe cloak+hide+reset.",
            );
            hotkey::invalidate_enlarged_show_gen();
            if let Some(win) = app_handle.get_webview_window("main") {
                hotkey::set_window_cloaked(&win, true);
                hotkey::MAIN_HAS_PAINTED.store(false, std::sync::atomic::Ordering::SeqCst);
                let _ = win.eval("document.documentElement.classList.add('wm-hidden')");
                let _ = win.hide();
            }
        }
        "overlay" => {
            crate::paste::log_diag(
                "[SHOW_OVERLAY] show recovery: gate bound exceeded — flash-safe hide.",
            );
            hotkey::invalidate_overlay_show_gen();
            // hide_overlay_window skips while phase == Showing (exactly the
            // stuck state we are recovering from) — drop the phase first.
            hotkey::set_overlay_phase(hotkey::OverlayPhase::Hidden);
            hotkey::hide_overlay_window(&app_handle);
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Unified split frame: the overlay owns a FIXED 750x475 frame. There is
    // no compact/expanded toggle anymore — content must never resize the
    // window (a resize reallocates the WebView2 surface and the first present
    // can come out unpainted).
    use super::hotkey::{OVERLAY_HEIGHT, OVERLAY_WIDTH};

    #[test]
    fn test_overlay_fixed_frame() {
        assert_eq!(OVERLAY_WIDTH, 750);
        assert_eq!(OVERLAY_HEIGHT, 475);
    }
}
