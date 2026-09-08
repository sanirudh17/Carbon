// Global shortcut registration for the overlay and enlarged-window hotkeys.
//
// Uses `tauri-plugin-global-shortcut` with an idempotent swap: on every apply
// everything is unregistered, then re-added from settings. A strict reapply
// reports failure so callers can roll back to the previously active binding;
// a tolerant reapply logs + skips (startup / rollback re-arm). The two hotkeys
// can never collide with each other while swapping.
use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::hotkey::HotkeyStatus;
use crate::AppState;

/// Last known registration state, reported to the settings UI.
static LAST_STATUS: Mutex<Option<HotkeyStatus>> = Mutex::new(None);

/// Register global shortcuts from settings at startup. Tolerant.
pub fn register(app: &AppHandle) -> tauri::Result<()> {
    let _ = apply(app, false);
    Ok(())
}

/// Clear every registered global shortcut. Safe when nothing is registered.
pub fn unregister_all(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
}

/// Re-apply shortcuts from the CURRENT settings. Strict mode returns Err on
/// the first accelerator the OS rejects (caller rolls back); otherwise log +
/// skip (rollback re-arm).
pub fn reapply(app: &AppHandle, strict: bool) -> Result<(), String> {
    apply(app, strict)
}

fn apply(app: &AppHandle, strict: bool) -> Result<(), String> {
    // Idempotent: drop everything first.
    let _ = app.global_shortcut().unregister_all();

    let (quick, enlarged) = {
        let state = app.state::<AppState>();
        let s = state.settings.get();
        (s.quick_hotkey.clone(), s.enlarged_hotkey.clone())
    };

    // Previously active bindings — what stays live if a new accelerator
    // gets rejected.
    let previous = LAST_STATUS.lock().unwrap().clone();

    let mut overlay_ok = true;
    let mut enlarged_ok = true;
    let mut failures = Vec::new();

    // Quick paste hotkey → opens the quick overlay.
    if !quick.trim().is_empty() {
        match bind_shortcut(&quick) {
            Ok(shortcut) => {
                crate::paste::log_diag(&format!("[SHORTCUTS] Registering quick hotkey: {}", quick));
                if app
                    .global_shortcut()
                    .on_shortcut(
                        shortcut,
                        move |handle: &AppHandle, _shortcut, event| {
                            // Only fire on key-down; ignore release (no double-fire).
                            if event.state == ShortcutState::Pressed {
                                crate::paste::log_diag("[SHORTCUTS] Fired quick overlay hotkey");
                                crate::hotkey::handle_overlay_hotkey(handle);
                            }
                        },
                    )
                    .is_err()
                {
                    crate::paste::log_diag(&format!("[SHORTCUTS] Failed to register quick hotkey: {}", quick));
                    overlay_ok = false;
                    failures.push(format!("Quick Overlay hotkey \"{quick}\""));
                }
            }
            Err(e) => {
                crate::paste::log_diag(&format!("[SHORTCUTS] Invalid quick hotkey \"{}\": {}", quick, e));
                overlay_ok = false;
                failures.push(format!("Quick Overlay {e}"));
            }
        }
    }

    // Enlarged window hotkey → opens full library + settings.
    if !enlarged.trim().is_empty() {
        match bind_shortcut(&enlarged) {
            Ok(shortcut) => {
                crate::paste::log_diag(&format!("[SHORTCUTS] Registering enlarged hotkey: {}", enlarged));
                if app
                    .global_shortcut()
                    .on_shortcut(
                        shortcut,
                        move |handle: &AppHandle, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                crate::paste::log_diag("[SHORTCUTS] Fired enlarged window hotkey");
                                crate::hotkey::handle_enlarged_hotkey(handle);
                            }
                        },
                    )
                    .is_err()
                {
                    crate::paste::log_diag(&format!("[SHORTCUTS] Failed to register enlarged hotkey: {}", enlarged));
                    enlarged_ok = false;
                    failures.push(format!("Enlarged Window hotkey \"{enlarged}\""));
                }
            }
            Err(e) => {
                crate::paste::log_diag(&format!("[SHORTCUTS] Invalid enlarged hotkey \"{}\": {}", enlarged, e));
                enlarged_ok = false;
                failures.push(format!("Enlarged Window {e}"));
            }
        }
    }

    let prev_overlay =
        previous.as_ref().map(|s| s.overlay.clone()).unwrap_or_else(|| quick.clone());
    let prev_enlarged =
        previous.as_ref().map(|s| s.enlarged.clone()).unwrap_or_else(|| enlarged.clone());

    let status = HotkeyStatus {
        overlay: if overlay_ok { quick.clone() } else { prev_overlay },
        enlarged: if enlarged_ok { enlarged.clone() } else { prev_enlarged },
        overlay_preferred: quick,
        enlarged_preferred: enlarged,
        overlay_conflict: !overlay_ok,
        enlarged_conflict: !enlarged_ok,
    };
    *LAST_STATUS.lock().unwrap() = Some(status.clone());

    let _ = app.emit("hotkey-status", status);

    if strict && !failures.is_empty() {
        return Err(format!(
            "{} already in use by another application.",
            failures.join(" and ")
        ));
    }
    Ok(())
}

/// Parse Carbon's stored combo into a plugin `Shortcut`, mapping tokens the
/// plugin doesn't know ("win" → "super", "control" → "ctrl"; keys pass through).
fn bind_shortcut(combo: &str) -> Result<Shortcut, String> {
    let accel = combo
        .split('+')
        .map(|part| {
            let part = part.trim();
            match part.to_lowercase().as_str() {
                "ctrl" | "control" => "ctrl".to_string(),
                "alt" | "option" => "alt".to_string(),
                "shift" => "shift".to_string(),
                "win" | "super" | "meta" | "command" => "super".to_string(),
                _ => part.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("+");

    Shortcut::from_str(&accel).map_err(|e| format!("\"{combo}\" is not a valid shortcut: {e}"))
}

/// Last reported registration state for the settings UI.
pub fn get_hotkey_status() -> Option<HotkeyStatus> {
    LAST_STATUS.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bind_shortcut() {
        let cases = [
            "Ctrl+Alt+X",
            "Ctrl+Shift+Z",
            "Alt+Win+X",
            "Ctrl+Alt+Space",
            "Ctrl+Shift+F1",
            "Alt+Ctrl+X",
        ];
        for c in cases {
            let res = bind_shortcut(c);
            println!("Testing {}: {:?}", c, res);
            assert!(res.is_ok(), "Failed to bind shortcut {}", c);
        }
    }
}

