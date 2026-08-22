use crate::paste::{get_cursor_position, restore_target_window, save_target_window};
use crate::settings::SettingsState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL,
    MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, VK_CONTROL, VK_MENU, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW,
    RegisterClassExW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HHOOK, HMENU,
    HWND_MESSAGE, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_HOTKEY, WM_KEYDOWN, WM_SYSKEYDOWN,
    WNDCLASSEXW, WS_OVERLAPPED,
};

const HOTKEY_ID_OVERLAY: i32 = 1001;
const HOTKEY_ID_ENLARGED: i32 = 1002;
static CURRENT_CYCLE_INDEX: AtomicU32 = AtomicU32::new(0);
static APP_HANDLE_HOLDER: Mutex<Option<AppHandle>> = Mutex::new(None);

// Ordered fallback chains tried when the configured combo is already claimed
// by another application. Each chain starts from the most natural neighbours
// of the factory default and ends well away from the other hotkey's chain, so
// the two bindings can never collide with each other while falling back.
const OVERLAY_FALLBACKS: &[&str] = &[
    "Ctrl+Shift+Z",
    "Ctrl+Shift+X",
    "Ctrl+Shift+F12",
    "Ctrl+Alt+Shift+X",
    "Ctrl+Shift+F9",
    "Ctrl+Win+Z",
];
const ENLARGED_FALLBACKS: &[&str] = &[
    "Ctrl+Alt+Z",
    "Ctrl+Alt+X",
    "Ctrl+Alt+F12",
    "Ctrl+Alt+Shift+Z",
    "Ctrl+Alt+F9",
    "Ctrl+Win+X",
];

#[derive(Serialize, Clone, Debug)]
pub struct HotkeyStatus {
    pub overlay: String,
    pub enlarged: String,
    pub overlay_preferred: String,
    pub enlarged_preferred: String,
    pub overlay_conflict: bool,
    pub enlarged_conflict: bool,
}

static LAST_STATUS: Mutex<Option<HotkeyStatus>> = Mutex::new(None);
static HOTKEY_WINDOW: Mutex<Option<isize>> = Mutex::new(None);

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
    pub fn start(app_handle: AppHandle, settings_state: Arc<SettingsState>) {
        *APP_HANDLE_HOLDER.lock().unwrap() = Some(app_handle.clone());
        let app_clone = app_handle.clone();
        let settings_clone = settings_state.clone();

        thread::spawn(move || unsafe {
            let msg_hwnd = create_message_only_window();
            *HOTKEY_WINDOW.lock().unwrap() = msg_hwnd.map(|h| h.0 as isize);

            let settings = settings_clone.get();
            register_global_hotkeys(&app_clone, &settings_clone, &settings.quick_hotkey, &settings.enlarged_hotkey);

            let hinstance = HINSTANCE(GetModuleHandleW(None).unwrap_or_default().0);
            let hook: HHOOK = SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_keyboard_proc), hinstance, 0).unwrap_or_default();

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                if msg.message == WM_HOTKEY {
                    let id = msg.wParam.0 as i32;
                    eprintln!("[carbon] WM_HOTKEY received: id={id}");
                    if id == HOTKEY_ID_OVERLAY {
                        handle_overlay_hotkey(&app_clone);
                    } else if id == HOTKEY_ID_ENLARGED {
                        handle_enlarged_hotkey(&app_clone);
                    }
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            if !hook.is_invalid() {
                let _ = UnhookWindowsHookEx(hook);
            }
        });
    }
}

pub fn register_global_hotkeys(
    app: &AppHandle,
    settings_state: &SettingsState,
    quick_str: &str,
    enlarged_str: &str,
) {
    unsafe {
        let hwnd: HWND = HOTKEY_WINDOW
            .lock()
            .unwrap()
            .map(|h| HWND(h as *mut _))
            .unwrap_or_default();

        let (overlay_eff, overlay_conflict) = register_with_fallbacks(
            app,
            hwnd,
            HOTKEY_ID_OVERLAY,
            quick_str,
            OVERLAY_FALLBACKS,
            "Quick Overlay",
        );
        let (enlarged_eff, enlarged_conflict) = register_with_fallbacks(
            app,
            hwnd,
            HOTKEY_ID_ENLARGED,
            enlarged_str,
            ENLARGED_FALLBACKS,
            "Enlarged Window",
        );

        if overlay_eff != quick_str || enlarged_eff != enlarged_str {
            let _ = settings_state.update_hotkeys(&overlay_eff, &enlarged_eff);
        }

        let status = HotkeyStatus {
            overlay: overlay_eff,
            enlarged: enlarged_eff,
            overlay_preferred: quick_str.to_string(),
            enlarged_preferred: enlarged_str.to_string(),
            overlay_conflict,
            enlarged_conflict,
        };
        *LAST_STATUS.lock().unwrap() = Some(status.clone());
        let _ = app.emit("hotkey-status", status);
    }
}

pub fn get_hotkey_status() -> Option<HotkeyStatus> {
    LAST_STATUS.lock().unwrap().clone()
}

unsafe fn register_with_fallbacks(
    app: &AppHandle,
    hwnd: HWND,
    id: i32,
    preferred: &str,
    fallbacks: &[&str],
    name: &str,
) -> (String, bool) {
    let _ = UnregisterHotKey(hwnd, id);

    let mut candidates: Vec<&str> = vec![preferred];
    for fb in fallbacks {
        if !candidates.contains(fb) {
            candidates.push(fb);
        }
    }

    for combo in &candidates {
        if let Some((mods, vk)) = parse_hotkey_string(combo) {
            if RegisterHotKey(hwnd, id, mods | MOD_NOREPEAT, vk).is_ok()
                || RegisterHotKey(hwnd, id, mods, vk).is_ok()
            {
                eprintln!("[carbon] Registered {name} hotkey: {combo}");
                return (combo.to_string(), *combo != preferred);
            }
        }
    }

    // Every candidate — the user's combo plus the whole fallback chain,
    // factory defaults included — is claimed. Nothing is registered, so be
    // explicit: there is no working binding until the user picks a free one.
    let err = std::io::Error::last_os_error();
    eprintln!("[carbon] FAILED to register {name} hotkey ({preferred}): {err}");
    let _ = app.emit(
        "hotkey-error",
        format!(
            "{name} hotkey ({preferred}) and every automatic alternative are already in use by \
             other applications. This shortcut is currently inactive — close the conflicting app \
             or pick a different shortcut in Settings."
        ),
    );
    (preferred.to_string(), true)
}

unsafe extern "system" fn hotkey_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

unsafe fn create_message_only_window() -> Option<HWND> {
    const CLASS_NAME: &str = "CarbonHotkeyMessageWindow";
    let class_name_wide: Vec<u16> = CLASS_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let hinstance: HINSTANCE = HINSTANCE(GetModuleHandleW(None).ok()?.0);

    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: Default::default(),
        lpfnWndProc: Some(hotkey_wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinstance,
        hIcon: Default::default(),
        hCursor: Default::default(),
        hbrBackground: Default::default(),
        lpszMenuName: PCWSTR::null(),
        lpszClassName: PCWSTR(class_name_wide.as_ptr()),
        hIconSm: Default::default(),
    };

    RegisterClassExW(&wc);

    CreateWindowExW(
        Default::default(),
        PCWSTR(class_name_wide.as_ptr()),
        PCWSTR::null(),
        WS_OVERLAPPED,
        0,
        0,
        0,
        0,
        HWND_MESSAGE,
        HMENU::default(),
        hinstance,
        None,
    )
    .ok()
}

pub fn parse_hotkey_string(s: &str) -> Option<(HOT_KEY_MODIFIERS, u32)> {
    let parts: Vec<&str> = s.split('+').map(|p| p.trim()).collect();
    let mut mods = HOT_KEY_MODIFIERS(0);
    let mut vk = 0u32;

    for part in parts {
        match part.to_lowercase().as_str() {
            "ctrl" | "control" | "cmdorctrl" | "commandorcontrol" => mods |= MOD_CONTROL,
            "shift" => mods |= MOD_SHIFT,
            "alt" | "option" => mods |= MOD_ALT,
            "super" | "win" | "cmd" | "meta" => mods |= MOD_WIN,
            key => {
                let key_upper = key.to_uppercase();
                if key_upper.len() == 1 {
                    vk = key_upper.chars().next().unwrap() as u32;
                } else if key_upper.starts_with('F') {
                    if let Ok(num) = key_upper[1..].parse::<u32>() {
                        if (1..=24).contains(&num) {
                            vk = 0x6F + num;
                        }
                    }
                } else if key_upper == "SPACE" {
                    vk = 0x20;
                } else if key_upper == "TAB" {
                    vk = 0x09;
                } else if key_upper == "ENTER" || key_upper == "RETURN" {
                    vk = 0x0D;
                } else if key_upper == "ESC" || key_upper == "ESCAPE" {
                    vk = 0x1B;
                }
            }
        }
    }

    if vk != 0 {
        Some((mods, vk))
    } else {
        None
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
