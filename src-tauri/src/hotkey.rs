use crate::paste::{get_cursor_position, restore_target_window, save_target_window};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN,
    WM_SYSKEYDOWN,
};

static CURRENT_CYCLE_INDEX: AtomicU32 = AtomicU32::new(0);
static APP_HANDLE_HOLDER: Mutex<Option<AppHandle>> = Mutex::new(None);
static RECORDING_TARGET: Mutex<Option<String>> = Mutex::new(None);

pub fn set_recording_target(target: Option<String>) {
    *RECORDING_TARGET.lock().unwrap() = target;
}

fn ensure_overlay_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(win) = app.get_webview_window("overlay") {
        return Some(win);
    }
    // Windows stay warm for the whole app lifetime, so hitting this means
    // something destroyed the window unexpectedly (e.g. first launch before
    // prewarm). Recreate from config as a safety net.
    crate::paste::log_diag("[HOTKEY] Overlay window not found — recreating (safety net).");
    if let Some(cfg) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "overlay")
        .cloned()
    {
        match tauri::WebviewWindowBuilder::from_config(app, &cfg) {
            Ok(builder) => match builder.build() {
                Ok(w) => {
                    crate::paste::log_diag("[HOTKEY] Recreated overlay from tauri.conf");
                    crate::vibrancy::init_window_vibrancy(&w, app);
                    return Some(w);
                }
                Err(e) => crate::paste::log_diag(&format!(
                    "[HOTKEY] Failed to build overlay from config: {:?}",
                    e
                )),
            },
            Err(e) => crate::paste::log_diag(&format!(
                "[HOTKEY] from_config for overlay failed: {:?}",
                e
            )),
        }
    }
    match tauri::WebviewWindowBuilder::new(
        app,
        "overlay",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Carbon Quick Paste")
    .inner_size(680.0, 440.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .transparent(true)
    .build()
    {
        Ok(w) => {
            crate::paste::log_diag("[HOTKEY] Recreated overlay via manual builder");
            crate::vibrancy::init_window_vibrancy(&w, app);
            Some(w)
        }
        Err(e) => {
            crate::paste::log_diag(&format!(
                "[HOTKEY] Manual overlay creation failed: {:?}",
                e
            ));
            None
        }
    }
}

fn ensure_main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(win) = app.get_webview_window("main") {
        return Some(win);
    }
    crate::paste::log_diag("[HOTKEY] Main window not found — recreating (safety net).");
    if let Some(cfg) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
    {
        match tauri::WebviewWindowBuilder::from_config(app, &cfg) {
            Ok(builder) => match builder.build() {
                Ok(w) => {
                    crate::paste::log_diag("[HOTKEY] Recreated main from tauri.conf");
                    crate::vibrancy::init_window_vibrancy(&w, app);
                    return Some(w);
                }
                Err(e) => crate::paste::log_diag(&format!(
                    "[HOTKEY] Failed to build main from config: {:?}",
                    e
                )),
            },
            Err(e) => crate::paste::log_diag(&format!(
                "[HOTKEY] from_config for main failed: {:?}",
                e
            )),
        }
    }
    match tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Carbon — Clipboard Manager")
    .inner_size(1240.0, 740.0)
    .resizable(true)
    .decorations(false)
    .visible(false)
    .transparent(true)
    .build()
    {
        Ok(w) => {
            crate::paste::log_diag("[HOTKEY] Recreated main via manual builder");
            crate::vibrancy::init_window_vibrancy(&w, app);
            Some(w)
        }
        Err(e) => {
            crate::paste::log_diag(&format!(
                "[HOTKEY] Manual main creation failed: {:?}",
                e
            ));
            None
        }
    }
}

/// Pre-warm hidden windows so the first hotkey press is instant.
/// Forces each hidden window's WebView2 to present its first frame while
/// off-screen: an un-presented surface renders as a white rectangle on first
/// show. Also warms the DB cache so the first overlay-data emit is instant.
pub(crate) static OVERLAY_PREWARM_CACHE: std::sync::Mutex<Option<Vec<crate::db::ClipItem>>> = std::sync::Mutex::new(None);
pub(crate) static MAIN_PREWARM_CACHE: std::sync::Mutex<Option<Vec<crate::db::ClipItem>>> = std::sync::Mutex::new(None);

pub(crate) fn invalidate_prewarm_cache() {
    *OVERLAY_PREWARM_CACHE.lock().unwrap() = None;
    *MAIN_PREWARM_CACHE.lock().unwrap() = None;
}

pub fn prewarm_windows(app: &AppHandle) {
    // Ensure windows exist so the first hotkey's WebView is already created.
    let _ = ensure_overlay_window(app);
    let _ = ensure_main_window(app);

    // Warm DB cache and push snapshot directly into WebViews while hidden
    if let Some(state) = app.try_state::<crate::AppState>() {
        let settings = state.settings.get();
        if let Ok(json) = serde_json::to_string(&settings) {
            for label in ["overlay", "main", "pill", "argprompt"] {
                if let Some(win) = app.get_webview_window(label) {
                    let _ = win.eval(&format!(
                        "window.__carbonSettings = {0}; if (window.__carbonApplySettings) window.__carbonApplySettings({0});",
                        json
                    ));
                }
            }
        }

        if let Ok(entries) = state.db.get_overlay_entries(250) {
            *OVERLAY_PREWARM_CACHE.lock().unwrap() = Some(entries.clone());
            if let Ok(json) = serde_json::to_string(&entries) {
                if let Some(win) = app.get_webview_window("overlay") {
                    let _ = win.eval(&format!(
                        "window.__carbonInitialData = {0}; if (window.__carbonSetData) window.__carbonSetData({0});",
                        json
                    ));
                }
            }
        }
        if let Ok(all) = state.db.get_all_entries(None, None, false, None) {
            *MAIN_PREWARM_CACHE.lock().unwrap() = Some(all.clone());
            if let Ok(json) = serde_json::to_string(&all) {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.eval(&format!(
                        "window.__carbonInitialData = {0}; if (window.__carbonSetData) window.__carbonSetData({0});",
                        json
                    ));
                }
            }
        }
        if let Ok(snips) = state.db.list_snippets() {
            if let Ok(json) = serde_json::to_string(&snips) {
                for label in ["overlay", "main"] {
                    if let Some(win) = app.get_webview_window(label) {
                        let _ = win.eval(&format!(
                            "window.__carbonInitialSnippets = {0}; if (window.__carbonSetSnippets) window.__carbonSetSnippets({0});",
                            json
                        ));
                    }
                }
            }
        }
        crate::paste::log_diag("[PREWARM] DB cache warmed and pushed to WebViews");
    }

    for label in ["overlay", "main"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.eval("window.__carbon_prewarm = 1");
        }
    }
    crate::paste::log_diag("[PREWARM] Complete");
}

// Registration status of the global hotkeys. Owned by the global-shortcut
// swap in crate::shortcuts; kept here so the settings UI command can read it.
#[derive(Serialize, Clone, Debug)]
pub struct HotkeyStatus {
    pub overlay: String,
    pub enlarged: String,
    pub overlay_preferred: String,
    pub enlarged_preferred: String,
    pub overlay_conflict: bool,
    pub enlarged_conflict: bool,
}

pub fn handle_overlay_hotkey(app_handle: &AppHandle) {
    crate::paste::log_diag("[HOTKEY] handle_overlay_hotkey triggered.");
    let overlay_win = match ensure_overlay_window(app_handle) {
        Some(w) => w,
        None => {
            crate::paste::log_diag("[HOTKEY] ERROR: overlay window not found and recreation failed!");
            return;
        }
    };
    let is_visible = overlay_win.is_visible().unwrap_or(false);
    crate::paste::log_diag(&format!(
        "[HOTKEY] Overlay state: is_visible={}",
        is_visible
    ));

    if is_visible {
        crate::paste::log_diag("[HOTKEY] Overlay is visible. Calling hide_overlay_window (toggle)...");
        hide_overlay_window(app_handle);
        return;
    }

    // Normalized behavior: the overlay never opens on top of an already-open
    // main window (that "overlay pops inside the main app" confusion). If the
    // library is visible, just bring it to front instead.
    if let Some(main_win) = app_handle.get_webview_window("main") {
        if main_win.is_visible().unwrap_or(false) {
            crate::paste::log_diag("[HOTKEY] Main is open — focusing it instead of opening overlay.");
            let _ = main_win.unminimize();
            let _ = main_win.show();
            let _ = main_win.set_focus();
            return;
        }
    }

    // Fast path: save target HWND while it is still foreground (must be before show)
    crate::paste::log_diag("[HOTKEY] Overlay opening. Calling save_target_window...");
    save_target_window(app_handle);
    // Capture selected text while target is still focused. UIA is instant; clipboard
    // fallback (Ctrl+C + 120ms) is rare and only runs when UIA has no selection.
    crate::paste::capture_selection_snapshot();
    CURRENT_CYCLE_INDEX.store(0, Ordering::Relaxed);

    let (cx, cy) = get_cursor_position();
    let preview_on = app_handle
        .try_state::<crate::AppState>()
        .map(|s| s.settings.get().preview_enabled)
        .unwrap_or(false);
    let (win_w, win_h) = if preview_on { (1020, 560) } else { (680, 440) };
    let scale_factor = overlay_win.scale_factor().unwrap_or(1.0);
    let phys_w = (win_w as f64 * scale_factor).round() as u32;
    let phys_h = (win_h as f64 * scale_factor).round() as u32;
    // Resize ONLY when target size actually differs: resizing a hidden WebView2
    // reallocates its composition surface, and the next present after show()
    // comes out white until the renderer catches up (the white flash).
    let want = tauri::PhysicalSize {
        width: phys_w,
        height: phys_h,
    };
    if overlay_win.outer_size().ok() != Some(want) {
        let _ = overlay_win.set_size(tauri::Size::Physical(want));
    }
    crate::vibrancy::set_round_corners(&overlay_win);

    let (pos_x, pos_y) = calculate_overlay_position(cx, cy, win_w, win_h, scale_factor);
    crate::paste::log_diag(&format!(
        "[HOTKEY] Calculated pos: ({}, {}), size: {}x{}, scale: {}",
        pos_x, pos_y, phys_w, phys_h, scale_factor
    ));

    // Position BEFORE show so window appears at correct monitor instantly (no flicker)
    let _ = overlay_win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: pos_x,
        y: pos_y,
    }));

    let _ = overlay_win.unminimize();
    let show_res = overlay_win.show();
    let focus_res = overlay_win.set_focus();
    crate::paste::log_diag(&format!(
        "[HOTKEY] overlay_win.show() -> {:?}, set_focus() -> {:?}",
        show_res, focus_res
    ));
    // Emit opened immediately so frontend can render skeleton instantly.
    // If a prewarm snapshot exists, push it *with* the open so the first
    // frame already has data — zero skeleton time like Pico's instant open.
    let _ = app_handle.emit("overlay-opened", ());
    let cached_opt = {
        let mut cache = OVERLAY_PREWARM_CACHE.lock().unwrap();
        if cache.is_none() {
            if let Some(state) = app_handle.try_state::<crate::AppState>() {
                if let Ok(entries) = state.db.get_overlay_entries(250) {
                    *cache = Some(entries);
                }
            }
        }
        cache.clone()
    };
    if let Some(cached) = cached_opt {
        let _ = app_handle.emit("overlay-data", &cached);
        crate::paste::log_diag("[HOTKEY] overlay-data served (instant)");
    }

    let app_clone = app_handle.clone();
    std::thread::spawn(move || {
        if let Some(state) = app_clone.try_state::<crate::AppState>() {
            // Fresh query — updates cache and pushes latest data (covers
            // cold-start where cache was still None and post-open updates).
            if let Ok(entries) = state.db.get_overlay_entries(250) {
                *OVERLAY_PREWARM_CACHE.lock().unwrap() = Some(entries.clone());
                let _ = app_clone.emit("overlay-data", &entries);
            }
            if let Ok(snips) = state.db.list_snippets() {
                let _ = app_clone.emit("overlay-snippets", &snips);
            }
        }
    });
}

pub fn handle_enlarged_hotkey(app_handle: &AppHandle) {
    // Normalized behavior: if the overlay is open, this press only swaps to
    // the library — it never toggles the library closed in the same press
    // (that "both collapse" confusion). Capture overlay state BEFORE
    // dismissing so the decision is race-free.
    let overlay_was_visible = app_handle
        .get_webview_window("overlay")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    dismiss_overlay(app_handle);

    let main_win = match ensure_main_window(app_handle) {
        Some(w) => w,
        None => {
            eprintln!("[carbon] main window not found and recreation failed — hotkey did nothing");
            return;
        }
    };
    if overlay_was_visible {
        crate::paste::log_diag("[HOTKEY] Overlay was open — showing main instead of toggling.");
        save_target_window(app_handle);
        let _ = main_win.unminimize();
        let _ = main_win.show();
        let _ = main_win.set_focus();
        let _ = app_handle.emit("enlarged-opened", ());
        return;
    }
    let is_visible = main_win.is_visible().unwrap_or(false);
    if is_visible {
        restore_target_window();
        // Always hide, never close (windows stay warm for instant reopen).
        let _ = main_win.hide();
    } else {
        save_target_window(app_handle);
        crate::paste::capture_selection_snapshot();
        let _ = main_win.unminimize();
        let _ = main_win.show();
        let _ = main_win.set_focus();
        // Windows sometimes refuses the first SetForegroundWindow while the
        // window is still materializing. One gentle retry after it settles
        // keeps Enter-to-paste reliable when the user keys in immediately.
        let win = main_win.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(120));
            match win.is_focused() {
                Ok(true) => {}
                _ => {
                    let _ = win.set_focus();
                }
            }
        });
        let _ = app_handle.emit("enlarged-opened", ());
    }
}

/// Guard to prevent re-entrant calls to hide_overlay_window.
/// When paste_clip → hide_overlay_window runs, the overlay's hide() triggers
/// a Focused(false) event which would call hide_overlay_window again. This
/// flag prevents the second call from interfering.
static HIDING_OVERLAY: AtomicBool = AtomicBool::new(false);

pub fn hide_overlay_window(app: &AppHandle) {
    // Prevent re-entrant calls (the Focused(false) event fires when we hide)
    if HIDING_OVERLAY.swap(true, Ordering::SeqCst) {
        crate::paste::log_diag("[HIDE_OVERLAY] Already executing hide_overlay_window (re-entrancy guard). Skipping.");
        return;
    }
    crate::paste::log_diag("[HIDE_OVERLAY] hide_overlay_window entered. Hiding window...");

    if let Some(win) = app.get_webview_window("overlay") {
        // Always hide, never close: a live webview makes the next open instant
        // and avoids the recreate race that showed an unrendered window.
        let hide_res = win.hide();
        crate::paste::log_diag(&format!("[HIDE_OVERLAY] win.hide() returned {:?}", hide_res));
    } else {
        crate::paste::log_diag("[HIDE_OVERLAY] overlay window not found!");
    }

    // Now restore the previously-active window
    crate::paste::log_diag("[HIDE_OVERLAY] Calling restore_target_window()...");
    restore_target_window();

    HIDING_OVERLAY.store(false, Ordering::SeqCst);
    crate::paste::log_diag("[HIDE_OVERLAY] Complete.");
}

/// Returns true if hide_overlay_window is currently executing.
/// Used by the Focused(false) handler in lib.rs to avoid re-entrancy.
pub fn is_overlay_hiding() -> bool {
    HIDING_OVERLAY.load(Ordering::SeqCst)
}

fn dismiss_overlay(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        if win.is_visible().unwrap_or(false) {
            // Always hide, never close (windows stay warm for instant reopen).
            let _ = win.hide();
        }
    }
}

pub struct HotkeyManager;

unsafe extern "system" fn ll_keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && (wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN) {
        let kbd = *(lparam.0 as *const KBDLLHOOKSTRUCT);

        // If Settings is currently recording a new shortcut, intercept the keystroke
        // before any external application (like AMD Radeon Software or NVIDIA Overlay)
        // can capture it via RegisterHotKey or steal focus!
        let target_opt = RECORDING_TARGET.lock().unwrap().clone();
        if let Some(target) = target_opt {
            // GetAsyncKeyState is required inside WH_KEYBOARD_LL — GetKeyState
            // queries the calling thread's message queue and returns 0 on the
            // hook thread, while GetAsyncKeyState reflects the global physical
            // state and correctly sees Ctrl/Alt/Shift held before this hook.
            let ctrl_down = (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
            let shift_down = (GetAsyncKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0;
            let alt_down = (GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0;
            let win_down = (GetAsyncKeyState(VK_LWIN.0 as i32) as u16 & 0x8000) != 0
                || (GetAsyncKeyState(VK_RWIN.0 as i32) as u16 & 0x8000) != 0;

            let vk = kbd.vkCode;
            if vk == 0x1B {
                // Escape key cancels recording
                *RECORDING_TARGET.lock().unwrap() = None;
                if let Some(app) = APP_HANDLE_HOLDER.lock().unwrap().as_ref() {
                    let _ = app.emit("hotkey-record-canceled", ());
                }
                return LRESULT(1);
            }

            let is_mod = matches!(vk, 0x10..=0x12 | 0x5B..=0x5C | 0xA0..=0xA5);
            if !is_mod {
                // Mirrors frontend keyEventToCombo + global-hotkey parse_key: letters, digits,
                // Numpad, F1-F24, Space/Tab/Enter, arrows, and editing keys. Keeps hook and
                // webview in sync so a combo recorded via WH_KEYBOARD_LL triggers identically.
                let key_name: Option<&'static str> = match vk {
                    0x41 => Some("A"), 0x42 => Some("B"), 0x43 => Some("C"), 0x44 => Some("D"),
                    0x45 => Some("E"), 0x46 => Some("F"), 0x47 => Some("G"), 0x48 => Some("H"),
                    0x49 => Some("I"), 0x4A => Some("J"), 0x4B => Some("K"), 0x4C => Some("L"),
                    0x4D => Some("M"), 0x4E => Some("N"), 0x4F => Some("O"), 0x50 => Some("P"),
                    0x51 => Some("Q"), 0x52 => Some("R"), 0x53 => Some("S"), 0x54 => Some("T"),
                    0x55 => Some("U"), 0x56 => Some("V"), 0x57 => Some("W"), 0x58 => Some("X"),
                    0x59 => Some("Y"), 0x5A => Some("Z"),
                    0x30 => Some("0"), 0x31 => Some("1"), 0x32 => Some("2"), 0x33 => Some("3"),
                    0x34 => Some("4"), 0x35 => Some("5"), 0x36 => Some("6"), 0x37 => Some("7"),
                    0x38 => Some("8"), 0x39 => Some("9"),
                    // Numpad — mapped to digit token like frontend Numpad3 -> "3" so hook/webview agree
                    0x60 => Some("0"), 0x61 => Some("1"), 0x62 => Some("2"), 0x63 => Some("3"),
                    0x64 => Some("4"), 0x65 => Some("5"), 0x66 => Some("6"), 0x67 => Some("7"),
                    0x68 => Some("8"), 0x69 => Some("9"),
                    0x70 => Some("F1"), 0x71 => Some("F2"), 0x72 => Some("F3"), 0x73 => Some("F4"),
                    0x74 => Some("F5"), 0x75 => Some("F6"), 0x76 => Some("F7"), 0x77 => Some("F8"),
                    0x78 => Some("F9"), 0x79 => Some("F10"), 0x7A => Some("F11"), 0x7B => Some("F12"),
                    0x7C => Some("F13"), 0x7D => Some("F14"), 0x7E => Some("F15"), 0x7F => Some("F16"),
                    0x80 => Some("F17"), 0x81 => Some("F18"), 0x82 => Some("F19"), 0x83 => Some("F20"),
                    0x84 => Some("F21"), 0x85 => Some("F22"), 0x86 => Some("F23"), 0x87 => Some("F24"),
                    0x20 => Some("Space"), 0x09 => Some("Tab"), 0x0D => Some("Enter"),
                    0x08 => Some("Backspace"), 0x2E => Some("Delete"), 0x2D => Some("Insert"),
                    0x24 => Some("Home"), 0x23 => Some("End"), 0x21 => Some("PageUp"), 0x22 => Some("PageDown"),
                    0x25 => Some("Left"), 0x26 => Some("Up"), 0x27 => Some("Right"), 0x28 => Some("Down"),
                    0xBA => Some(";"), 0xBB => Some("="), 0xBC => Some(","), 0xBD => Some("-"),
                    0xBE => Some("."), 0xBF => Some("/"), 0xC0 => Some("`"), 0xDB => Some("["),
                    0xDC => Some("\\"), 0xDD => Some("]"), 0xDE => Some("'"),
                    _ => None,
                };

                if let Some(key_str) = key_name {
                    let mut mods = Vec::new();
                    if ctrl_down { mods.push("Ctrl"); }
                    if alt_down { mods.push("Alt"); }
                    if shift_down { mods.push("Shift"); }
                    if win_down { mods.push("Win"); }

                    if !mods.is_empty() {
                        *RECORDING_TARGET.lock().unwrap() = None;
                        let combo = format!("{}+{}", mods.join("+"), key_str);
                        if let Some(app) = APP_HANDLE_HOLDER.lock().unwrap().as_ref() {
                            let _ = app.emit("hotkey-recorded", serde_json::json!({
                                "target": target,
                                "combo": combo,
                            }));
                        }
                        return LRESULT(1); // Consume so GPU software / other apps NEVER see it!
                    }
                }
            } else {
                let mut mods = Vec::new();
                if ctrl_down { mods.push("Ctrl"); }
                if alt_down { mods.push("Alt"); }
                if shift_down { mods.push("Shift"); }
                if win_down { mods.push("Win"); }
                if !mods.is_empty() {
                    if let Some(app) = APP_HANDLE_HOLDER.lock().unwrap().as_ref() {
                        let _ = app.emit("hotkey-draft-update", serde_json::json!({
                            "draft": format!("{}+…", mods.join("+")),
                        }));
                    }
                }
            }
        }

        // Virtual Key Code 0x56 is 'V'
        if kbd.vkCode == 0x56 {
            let ctrl_down = (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
            let shift_down = (GetAsyncKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0;
            let alt_down = (GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0;

            // Plain Ctrl+V in target application
            if ctrl_down && !shift_down && !alt_down {
                if let Some(app) = APP_HANDLE_HOLDER.lock().unwrap().as_ref() {
                    if let Some(state) = app.try_state::<crate::AppState>() {
                        let has_queue = {
                            if let Ok(q) = state.paste_queue.lock() {
                                !q.is_empty()
                            } else {
                                false
                            }
                        };

                        if has_queue {
                            let app_c = app.clone();
                            // Delay 75ms to allow target application to read current clipboard item,
                            // then advance queue and load next item onto clipboard!
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(75));
                                if let Some(state) = app_c.try_state::<crate::AppState>() {
                                    let mut queue = match state.paste_queue.lock() {
                                        Ok(q) => q,
                                        Err(_) => return,
                                    };
                                    // Pop the item that was just pasted
                                    queue.pop_front();

                                    // If there is another item in queue, write it to OS clipboard
                                    if let Some(next_id) = queue.front() {
                                        if let Ok(all) = state.db.get_all_entries(None, None, false, None) {
                                            if let Some(next_item) = all.into_iter().find(|c| &c.id == next_id) {
                                                let _ = crate::paste::write_item_to_clipboard(&next_item, false);
                                                crate::clipboard_watcher::mark_paste(&next_item);
                                            }
                                        }
                                    }

                                    let _ = app_c.emit("paste-queue-updated", ());
                                    let _ = app_c.emit("clipboard-updated", ());
                                }
                            });
                        }
                    }
                }
            }
        }
    }

    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

impl HotkeyManager {
    /// Spawns the low-level keyboard hook thread. Global hotkey registration
    /// itself lives in crate::shortcuts (tauri-plugin-global-shortcut); this
    /// thread only services the WH_KEYBOARD_LL hook used by the paste queue,
    /// which needs its own message pump to stay alive.
    pub fn start(app_handle: AppHandle) {
        *APP_HANDLE_HOLDER.lock().unwrap() = Some(app_handle.clone());

        thread::spawn(move || unsafe {
            let hinstance = HINSTANCE(GetModuleHandleW(None).unwrap_or_default().0);
            let hook: HHOOK =
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_keyboard_proc), hinstance, 0)
                    .unwrap_or_default();

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            if !hook.is_invalid() {
                let _ = UnhookWindowsHookEx(hook);
            }
        });
    }
}

pub fn calculate_overlay_position(cx: i32, cy: i32, logical_w: i32, logical_h: i32, scale_factor: f64) -> (i32, i32) {
    unsafe {
        let pt = windows::Win32::Foundation::POINT { x: cx, y: cy };
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };

        if GetMonitorInfoW(hmon, &mut info).as_bool() {
            let work = info.rcWork;
            let avail_w = work.right - work.left;
            let avail_h = work.bottom - work.top;

            let phys_w = (logical_w as f64 * scale_factor).round() as i32;
            let phys_h = (logical_h as f64 * scale_factor).round() as i32;

            if avail_w < phys_w || avail_h < phys_h {
                return (work.left, work.top);
            }

            let center_x = work.left + (avail_w - phys_w) / 2;
            let center_y = work.top + (avail_h - phys_h) / 2;
            (center_x, center_y)
        } else {
            (100, 100)
        }
    }
}
