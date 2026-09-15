use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::hotkey::{self, calculate_overlay_position};
use crate::paste;
use crate::vibrancy;
use crate::AppState;

/// ADDENDUM v15: Rust Choreography Shim
/// Consolidates all native window show/hide/resize/paint-gate handshakes for
/// overlay, library (enlarged), and settings windows.
/// Enforces invariants on the native side:
///   I1: Cloaked until frontend confirms paint (note_overlay_painted / note_enlarged_painted).
///   I2: Window size changes atomically without animating native composition surface.

/// Payload for the preview-toggled ack: the resized size is live AND freshly
/// presented. The generation lets the frontend ignore stale acks under Tab spam.
#[derive(serde::Serialize, Clone)]
struct PreviewToggled {
    enabled: bool,
    r#gen: u64,
}

/// Resizes the Quick Overlay window between compact (680x440) and expanded (1020x560) preview.
/// Persists the setting and re-centers the window so it does not drift.
/// After the native resize, settles briefly and forces a synchronous present
/// while the renderer's snap veil holds, THEN emits the ack — so the veil
/// always lifts onto real pixels, never an unpainted (black) surface.
pub fn set_overlay_preview(
    state: &State<'_, AppState>,
    app_handle: &AppHandle,
    window: &WebviewWindow,
    enabled: bool,
    r#gen: u64,
) -> Result<(), String> {
    // Persist the choice AFTER the native resize + ack. A synchronous
    // settings.json write on the toggle path put disk I/O in front of the
    // resize, and the renderer veil only lifts on the ack — that dead time
    // read as a stutter/jagged start on every Tab press.
    let settings_before = state.settings.get();
    let persist_needed = settings_before.preview_enabled != enabled;
    let mat = vibrancy::WindowMaterial::from_str(&settings_before.window_material);
    let theme = settings_before.theme.clone();

    let scale = window.scale_factor().unwrap_or(1.0);
    let (w_log, h_log) = if enabled { (1020, 560) } else { (680, 440) };
    let (w_phys, h_phys) = (
        (w_log as f64 * scale).round() as u32,
        (h_log as f64 * scale).round() as u32,
    );
    let pos_x: i32;
    let pos_y: i32;
    if let (Ok(old_pos), Ok(old_size)) = (window.outer_position(), window.outer_size()) {
        pos_x = old_pos.x + old_size.width as i32 / 2 - w_phys as i32 / 2;
        pos_y = old_pos.y + old_size.height as i32 / 2 - h_phys as i32 / 2;
    } else {
        let (cx, cy) = paste::get_cursor_position();
        let (pos_x_l, pos_y_l) = calculate_overlay_position(cx, cy, w_log, h_log, scale);
        pos_x = pos_x_l;
        pos_y = pos_y_l;
    }

    // Instant centered snap behind renderer mask.
    //
    // Resizing a WebView2 window reallocates its composition surface, and the
    // first present on the new surface can be an UNPAINTED frame. Two guards
    // (both documented, both required) keep that frame invisible:
    //   1. The controller default background must be transparent (glass) or an
    //      opaque theme match (solid) — never Chromium's white default.
    //   2. The DWM border must stay suppressed across the frame recalculation.
    // Re-asserting them here (and NOT suppressing the redraw) matters: with a
    // suppressed redraw the newly exposed client band is never repainted, so
    // DWM keeps compositing a stale, rescaled surface (the jagged Tab toggle)
    // and the undefined band can composite white (the intermittent flash).
    vibrancy::set_window_default_background(window, mat, &theme);
    crate::webview_bg::set_webview_transparent_background(window.as_ref());
    vibrancy::set_window_border_suppressed(window);

    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let _ = SetWindowPos(
                    HWND(hwnd.0 as *mut _),
                    None,
                    pos_x,
                    pos_y,
                    w_phys as i32,
                    h_phys as i32,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                );
            }
        }
    }
    #[cfg(not(windows))]
    {
        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: w_phys,
                height: h_phys,
            }))
            .map_err(|e| e.to_string())?;

        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: pos_x,
                y: pos_y,
            }))
            .map_err(|e| e.to_string())?;
    }

    // Invariants I1, I2, I6 (ADDENDUM v20):
    // Previously used std::thread::sleep(Duration::from_millis(60)) and RedrawWindow.
    // That caused Symptom S1 (collapse exceeded 200ms budget) and Symptom S2 (GDI RedrawWindow
    // erased the DirectComposition swapchain causing a white frame flash).
    // Now we flush via DwmFlush to commit compositor state without GDI white erase, and emit preview-toggled immediately.
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Graphics::Dwm::DwmFlush;
        let _ = DwmFlush();
    }
    let _ = app_handle.emit("preview-toggled", PreviewToggled { enabled, r#gen });

    // Persist last: the resize + ack above are the latency-critical path.
    if persist_needed {
        let mut updated = settings_before;
        updated.preview_enabled = enabled;
        let _ = state.settings.update(updated);
    }
    Ok(())
}

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
    hotkey::invalidate_overlay_show_gen();
    if hotkey::get_overlay_phase() == hotkey::OverlayPhase::Showing {
        crate::paste::log_diag("[HIDE_OVERLAY] Skipped stale hide: re-show already won the race.");
        return Ok(());
    }
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
pub fn choreo_set_overlay_preview(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    window: WebviewWindow,
    enabled: bool,
    r#gen: u64,
) -> Result<(), String> {
    set_overlay_preview(&state, &app_handle, &window, enabled, r#gen)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_choreo_preview_dimensions() {
        let (w_compact, h_compact) = (680, 440);
        let (w_expanded, h_expanded) = (1020, 560);
        assert!(w_expanded > w_compact);
        assert!(h_expanded > h_compact);
    }
}
