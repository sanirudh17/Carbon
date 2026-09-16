//! OS file drag-out support (Glint-proven pattern).
//!
//! Image/file clips leave through `@crabnebula/tauri-plugin-drag`
//! (`startDrag` with real file paths) instead of hand-rolled COM or DOM
//! flavors: the plugin owns the modal loop on the right thread, offers real
//! HDROP, and reports Dropped/Cancelled. This module holds only two small
//! pieces of our own:
//!
//! - `drag_blank_icon`: a cached 1x1 transparent PNG so the OS drag shows
//!   just the cursor, never a giant ghost image (Glint pattern; the plugin
//!   requires *some* icon path).
//! - `OS_DRAG_ACTIVE`: set while an OS drag is in flight so the overlay's
//!   focus-loss handler suppresses auto-hide (same reason the old native
//!   guard existed — the window must not vanish from under the gesture).
//!   Cleared in `finally` on settle plus a safety timeout frontend-side, so
//!   a wedged target can only delay auto-hide, never disable it.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

/// True while an OS file drag is in flight (see module docs).
static OS_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn is_os_drag_active() -> bool {
    OS_DRAG_ACTIVE.load(Ordering::SeqCst)
}

/// Return the path to a 1x1 transparent PNG (created once in the cache dir),
/// used as the drag-out preview icon so dragging shows no big ghost image —
/// just the OS drag cursor.
#[tauri::command]
pub fn drag_blank_icon(app: AppHandle) -> std::result::Result<String, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("carbon-drag-blank.png");
    if !p.exists() {
        image::RgbaImage::from_pixel(1, 1, image::Rgba([0, 0, 0, 0]))
            .save(&p)
            .map_err(|e| e.to_string())?;
    }
    Ok(p.to_string_lossy().to_string())
}

/// Arm/disarm the in-flight flag around `startDrag` (frontend `finally`).
#[tauri::command]
pub fn set_os_drag_active(active: bool) -> std::result::Result<(), String> {
    OS_DRAG_ACTIVE.store(active, Ordering::SeqCst);
    crate::paste::log_diag(&format!("[OS_DRAG] active={active}"));
    Ok(())
}
