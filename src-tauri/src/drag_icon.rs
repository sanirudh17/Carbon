//! OS drag support (Glint-proven file pattern + DOM-drag guard).
//!
//! Image/file clips leave as REAL files through
//! `@crabnebula/tauri-plugin-drag` (`startDrag`) instead of hand-rolled COM
//! or DOM flavors: the plugin owns the modal loop on the right thread,
//! offers real HDROP, and reports Dropped/Cancelled. This module holds only
//! small pieces of our own:
//!
//! - `drag_blank_icon`: a cached 1x1 transparent PNG so the OS drag shows
//!   just the cursor, never a giant ghost image (Glint pattern; the plugin
//!   requires *some* icon path).
//! - `DRAG_ACTIVE`: set while ANY drag is in flight (plugin file drags AND
//!   DOM text drags) so the overlay's focus-loss handler suppresses
//!   auto-hide — without this the window vanishes from under the gesture:
//!   OS drags tear the modal surface down, DOM drags die (blocked circle)
//!   or take the renderer with them. Cleared on settle; the plugin path
//!   additionally carries a 60s safety timeout, so a wedged target can
//!   only delay auto-hide, never disable it.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

/// True while a drag gesture is in flight (see module docs).
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn is_drag_active() -> bool {
    DRAG_ACTIVE.load(Ordering::SeqCst)
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

/// Arm/disarm the in-flight flag around drags (plugin `finally`, DOM
/// dragstart/dragend). Fire-and-forget from the frontend.
#[tauri::command]
pub fn set_drag_active(active: bool) -> std::result::Result<(), String> {
    DRAG_ACTIVE.store(active, Ordering::SeqCst);
    crate::paste::log_diag(&format!("[DRAG_GUARD] active={active}"));
    Ok(())
}
