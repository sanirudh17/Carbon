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
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN,
    WM_SYSKEYDOWN,
};

static CURRENT_CYCLE_INDEX: AtomicU32 = AtomicU32::new(0);
static APP_HANDLE_HOLDER: Mutex<Option<AppHandle>> = Mutex::new(None);

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
    if let Some(overlay_win) = app_handle.get_webview_window("overlay") {
        let is_visible = overlay_win.is_visible().unwrap_or(false);
        let is_focused = overlay_win.is_focused().unwrap_or(false);
        crate::paste::log_diag(&format!(
            "[HOTKEY] Overlay state: is_visible={}, is_focused={}",
            is_visible, is_focused
        ));

        if is_visible && is_focused {
            crate::paste::log_diag("[HOTKEY] Overlay is visible+focused. Calling hide_overlay_window...");
            hide_overlay_window(app_handle);
        } else {
            crate::paste::log_diag("[HOTKEY] Overlay opening. Calling save_target_window...");
            save_target_window(app_handle);
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
            let _ = overlay_win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: phys_w,
                height: phys_h,
            }));

            let (pos_x, pos_y) = calculate_overlay_position(cx, cy, win_w, win_h, scale_factor);
            crate::paste::log_diag(&format!(
                "[HOTKEY] Calculated pos: ({}, {}), size: {}x{}, scale: {}",
                pos_x, pos_y, phys_w, phys_h, scale_factor
            ));

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
            let _ = app_handle.emit("overlay-opened", ());

            if let Some(state) = app_handle.try_state::<crate::AppState>() {
                if let Ok(entries) = state.db.get_all_entries(None, None, false, None) {
                    let _ = app_handle.emit("overlay-data", &entries);
                }
                if let Ok(snips) = state.db.list_snippets() {
                    let _ = app_handle.emit("overlay-snippets", &snips);
                }
            }
        }
    } else {
        crate::paste::log_diag("[HOTKEY] ERROR: overlay window not found in app_handle!");
    }
}

pub fn handle_enlarged_hotkey(app_handle: &AppHandle) {
    dismiss_overlay(app_handle);

    if let Some(main_win) = app_handle.get_webview_window("main") {
        let is_visible = main_win.is_visible().unwrap_or(false);
        let is_focused = main_win.is_focused().unwrap_or(false);

        if is_visible && is_focused {
            restore_target_window();
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
                std::thread::sleep(std::time::Duration::from_millis(180));
                match win.is_focused() {
                    Ok(true) => {}
                    _ => {
                        let _ = win.set_focus();
                    }
                }
            });
            let _ = app_handle.emit("enlarged-opened", ());
        }
    } else {
        eprintln!("[carbon] main window not found — hotkey did nothing");
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
            let _ = win.hide();
        }
    }
}

pub struct HotkeyManager;

unsafe extern "system" fn ll_keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && (wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN) {
        let kbd = *(lparam.0 as *const KBDLLHOOKSTRUCT);
        // Virtual Key Code 0x56 is 'V'
        if kbd.vkCode == 0x56 {
            let ctrl_down = (GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
            let shift_down = (GetKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0;
            let alt_down = (GetKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0;

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
