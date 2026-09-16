use crate::db::ClipItem;
use regex::Regex;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::BITMAPINFOHEADER;
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
};
use windows::Win32::System::ProcessStatus::K32GetModuleFileNameExW;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VK_C, VK_CONTROL, VK_LEFT, VK_LWIN, VK_MENU, VK_RIGHT, VK_RWIN,
    VK_SHIFT, VK_V,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, BringWindowToTop, GetClassNameW, GetCursorPos, GetForegroundWindow,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
    SetForegroundWindow,
};

const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;

use tauri::{AppHandle, Manager};

static TARGET_HWND: Mutex<Option<isize>> = Mutex::new(None);
static TARGET_APP_NAME: Mutex<Option<String>> = Mutex::new(None);

/// Text selected in the app the user was in when Carbon opened. Captured
/// once, at window-open time, and consumed by the `{selection}` placeholder.
static SELECTED_TEXT: Mutex<Option<String>> = Mutex::new(None);

pub fn get_selected_text_snapshot() -> Option<String> {
    SELECTED_TEXT.lock().unwrap().take()
}

pub fn set_selected_text_snapshot(text: Option<String>) {
    *SELECTED_TEXT.lock().unwrap() = text;
}

/// Best-effort snapshot of the text currently selected in the foreground app.
/// Runs while the user's app is still focused (before Carbon's window shows):
/// it injects Ctrl+C, parks the result, then puts the previous clipboard
/// content back (marked as our own paste so it is not re-captured).
///
/// Terminals are skipped entirely: there Ctrl+C is SIGINT, not copy — it
/// cancels the in-progress command line / TUI and visually "clears the text"
/// the user just typed or pasted. Snapshotting is a convenience; destroying
/// the user's terminal session for it is not acceptable.
pub fn capture_selection_snapshot() {
    unsafe {
        let fg = GetForegroundWindow();
        let mut fg_pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut fg_pid));
        if fg_pid == std::process::id() {
            log_diag("[CAPTURE_SELECTION] Foreground is Carbon itself — keeping the previous snapshot.");
            return;
        }
    }

    // Try UIA selection (instant, non-destructive, zero UI-thread latency)
    if let Some(uia_sel) = crate::expansion::try_get_uia_selection() {
        log_diag(&format!(
            "[CAPTURE_SELECTION] Captured {} chars via UIA.",
            uia_sel.chars().count()
        ));
        *SELECTED_TEXT.lock().unwrap() = Some(uia_sel);
    } else {
        *SELECTED_TEXT.lock().unwrap() = None;
    }
}

/// True when `hwnd` belongs to a terminal emulator / console, by window
/// class name or the owning process's executable name.
#[allow(dead_code)]
fn is_terminal_window(hwnd: HWND) -> bool {
    let mut class_buf = [0u16; 128];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class_buf) };
    let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);

    let terminal_classes = [
        "CASCADIA_HOSTING_WINDOW_CLASS", // Windows Terminal
        "TerminalWindowClass",           // Windows Terminal (older builds)
        "ConsoleWindowClass",            // conhost: cmd / PowerShell consoles
        "mintty",                        // Git Bash / mintty
        "PuTTYWindowClass",              // PuTTY
        "ConEmu",                        // ConEmu
        "VirtualConsoleClass",           // ConEmu
        "WezTerm",                       // WezTerm
        "Alacritty",                     // Alacritty
        "kitty",                         // kitty (Windows port)
        "XTerm",                         // X server terminals over SSH
    ];
    for known in terminal_classes {
        if class_name.eq_ignore_ascii_case(known) {
            return true;
        }
    }

    // Exe-name fallback for terminals wrapped in unusual windows.
    if let Some(exe) = get_window_exe_name(hwnd) {
        let exe_lower = exe.to_lowercase();
        let terminal_exes = [
            "windowsterminal.exe",
            "openconsole.exe",
            "conhost.exe",
            "cmd.exe",
            "powershell.exe",
            "pwsh.exe",
            "wezterm-gui.exe",
            "alacritty.exe",
            "kitty.exe",
            "mintty.exe",
            "putty.exe",
            "conemu64.exe",
            "conemuc64.exe",
            "wsl.exe",
        ];
        if terminal_exes.iter().any(|name| *name == exe_lower) {
            return true;
        }
    }
    false
}

/// Reads the current CF_UNICODETEXT content of the clipboard, if any.
#[allow(dead_code)]
pub fn read_clipboard_text() -> Option<String> {
    unsafe {
        if !open_clipboard_with_retry() {
            return None;
        }
        let mut result = None;
        if IsClipboardFormatAvailable(CF_UNICODETEXT).is_ok() {
            if let Ok(handle) = GetClipboardData(CF_UNICODETEXT) {
                let hglobal = HGLOBAL(handle.0 as *mut _);
                let ptr = GlobalLock(hglobal);
                if !ptr.is_null() {
                    let len = (0..)
                        .take_while(|&i| *(ptr as *const u16).add(i) != 0)
                        .count();
                    let slice = std::slice::from_raw_parts(ptr as *const u16, len);
                    result = Some(String::from_utf16_lossy(slice));
                    GlobalUnlock(hglobal).ok();
                }
            }
        }
        CloseClipboard().ok();
        result
    }
}

pub fn build_text_clip_item(text: &str) -> ClipItem {
    ClipItem {
        id: String::new(),
        content_type: "text".to_string(),
        title: String::new(),
        text_content: Some(text.to_string()),
        rtf_content: None,
        html_content: None,
        image_path: None,
        image_width: None,
        image_height: None,
        file_paths: None,
        is_video: false,
        file_size: 0,
        is_pinned: false,
        source_app: None,
        created_at: String::new(),
        updated_at: String::new(),
        qr_content: None,
        is_sensitive: false,
        expires_at: None,
        ocr_text: None,
    }
}

/// Writes plain text to the clipboard and marks it as Carbon's own paste so
/// the watcher does not re-capture it into history (snippets stay out of the
/// clip history entirely).
pub fn write_text_to_clipboard(text: &str) -> Result<(), String> {
    let item = build_text_clip_item(text);
    write_item_to_clipboard(&item, true)?;
    crate::clipboard_watcher::mark_paste(&item);
    Ok(())
}

/// Pastes a snippet's resolved text into the saved target window. When `post`
/// is Some (the text after a `{cursor}` marker), it pastes prefix then suffix
/// and walks the caret back over the suffix so it lands at the marker.
pub fn paste_text_into_target(pre: &str, post: Option<&str>) -> Result<(), String> {
    // Single-shot guarantee (same as paste_item): one insert per request.
    if PASTE_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        log_diag(
            "[PASTE_GUARD] A paste is already in flight — dropping this duplicate snippet paste (single insert guaranteed).",
        );
        return Ok(());
    }

    let pre_item = build_text_clip_item(pre);
    if let Err(e) = write_item_to_clipboard(&pre_item, true) {
        PASTE_IN_FLIGHT.store(false, Ordering::SeqCst);
        return Err(e);
    }
    crate::clipboard_watcher::mark_paste(&pre_item);

    let target_hwnd = TARGET_HWND.lock().unwrap().take().or_else(|| {
        let my_pid = std::process::id();
        let mut hwnd = unsafe { GetForegroundWindow() };
        for _ in 0..24 {
            if hwnd.0.is_null() || unsafe { !IsWindow(hwnd).as_bool() } {
                break;
            }
            let mut hwnd_pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut hwnd_pid)) };
            if hwnd_pid != 0 && hwnd_pid != my_pid {
                let mut class_buf = [0u16; 256];
                let class_len = unsafe { GetClassNameW(hwnd, &mut class_buf) };
                let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);
                if !is_shell_desktop_class(&class_name) && is_real_visible_window(hwnd).is_ok() {
                    log_diag(&format!("[PASTE_SNIPPET] Found fallback Z-order target: 0x{:X}", hwnd.0 as usize));
                    return Some(hwnd.0 as isize);
                }
            }
            hwnd = unsafe {
                windows::Win32::UI::WindowsAndMessaging::GetWindow(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::GW_HWNDNEXT,
                )
                .unwrap_or_default()
            };
        }
        None
    });

    log_diag(&format!(
        "[PASTE_SNIPPET] TARGET_HWND resolved: 0x{:X?}",
        target_hwnd
    ));

    let post_owned = post.map(|s| s.to_string());
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));

        if let Some(hwnd_val) = target_hwnd {
            let target = HWND(hwnd_val as *mut _);
            for _attempt in 1..=20 {
                if try_bring_to_foreground(target) {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            thread::sleep(Duration::from_millis(40));
        } else {
            thread::sleep(Duration::from_millis(60));
        }

        log_diag("[PASTE_SNIPPET] Injecting Ctrl+V for snippet prefix...");
        inject_ctrl_v();

        if let Some(post) = post_owned {
            thread::sleep(Duration::from_millis(140));
            let post_item = build_text_clip_item(&post);
            if write_item_to_clipboard(&post_item, true).is_ok() {
                crate::clipboard_watcher::mark_paste(&post_item);
            }
            thread::sleep(Duration::from_millis(40));
            log_diag("[PASTE_SNIPPET] Injecting Ctrl+V for snippet suffix...");
            inject_ctrl_v();
            thread::sleep(Duration::from_millis(120));

            let n_left = post.chars().count();
            log_diag(&format!(
                "[PASTE_SNIPPET] Moving caret left {} chars (cursor placement)...",
                n_left
            ));
            if n_left > 0 && n_left <= 20000 {
                inject_left_arrows(n_left);
            }
        }
        log_diag("[PASTE_SNIPPET] Done.");

        // Paste fully carried out — allow the next (legitimate) request.
        PASTE_IN_FLIGHT.store(false, Ordering::SeqCst);
    });

    Ok(())
}

/// Friendly display names for well-known executables, so "Paste to" labels
/// read naturally ("Paste to Word", not "Paste to WINWORD").
fn friendly_app_name(exe: &str) -> String {
    let lower = exe.to_lowercase();
    let known: &[(&str, &str)] = &[
        ("winword.exe", "Word"),
        ("excel.exe", "Excel"),
        ("powerpnt.exe", "PowerPoint"),
        ("outlook.exe", "Outlook"),
        ("onenote.exe", "OneNote"),
        ("notepad.exe", "Notepad"),
        ("code.exe", "VS Code"),
        ("codium.exe", "VS Code"),
        ("chrome.exe", "Chrome"),
        ("msedge.exe", "Edge"),
        ("firefox.exe", "Firefox"),
        ("opera.exe", "Opera"),
        ("explorer.exe", "File Explorer"),
        ("windowsterminal.exe", "Windows Terminal"),
        ("terminal.exe", "Terminal"),
        ("powershell.exe", "PowerShell"),
        ("pwsh.exe", "PowerShell"),
        ("cmd.exe", "Command Prompt"),
        ("slack.exe", "Slack"),
        ("discord.exe", "Discord"),
        ("teams.exe", "Teams"),
        ("zoom.exe", "Zoom"),
        ("obsidian.exe", "Obsidian"),
        ("notion.exe", "Notion"),
        ("drafts.exe", "Drafts"),
        ("spotify.exe", "Spotify"),
        ("vlc.exe", "VLC"),
        ("photoshop.exe", "Photoshop"),
        ("figma.exe", "Figma"),
        ("python.exe", "Python"),
        ("git-bash.exe", "Git Bash"),
        ("wezterm.exe", "WezTerm"),
        ("searchhost.exe", "Windows Search"),
        ("searchapp.exe", "Windows Search"),
        ("searchui.exe", "Windows Search"),
        ("startmenuexperiencehost.exe", "Start Menu"),
    ];
    if let Some((_, name)) = known.iter().find(|(exe_name, _)| *exe_name == lower) {
        return (*name).to_string();
    }

    // Fallback: strip the extension, split separators, title-case each word.
    let stem = exe
        .strip_suffix(".exe")
        .unwrap_or(exe)
        .replace(['_', '-'], " ");
    let mut words = stem.split_whitespace();
    let mut out = String::new();
    for (i, w) in words.by_ref().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let mut chars = w.chars();
        match chars.next() {
            Some(c) => {
                out.extend(c.to_uppercase());
                out.push_str(&chars.as_str().to_lowercase());
            }
            None => {}
        }
    }
    if out.is_empty() {
        stem
    } else {
        out
    }
}

const IGNORED_SHELL_EXES: &[&str] = &[
    "carbon.exe",
    "glint.exe",
    "typr.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "screenclippinghost.exe",
    "snippingtool.exe",
    "textinputhost.exe",
    "applicationframehost.exe",
    "taskhostw.exe",
    "dwm.exe",
    "lockapp.exe",
];

fn get_window_exe_name(hwnd: HWND) -> Option<String> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }

        let process_handle = OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            false,
            pid,
        )
        .ok()?;

        let mut buf = vec![0u16; 1024];
        let len = K32GetModuleFileNameExW(process_handle, None, &mut buf);
        if len > 0 {
            let path_str = String::from_utf16_lossy(&buf[..len as usize]);
            let path = PathBuf::from(path_str);
            if let Some(file_name) = path.file_name() {
                return Some(file_name.to_string_lossy().to_string());
            }
        }
    }
    None
}

use std::fs::OpenOptions;
use std::io::Write;
use std::time::SystemTime;

/// File logging is opt-in via CARBON_DIAG_LOG=1: every hotkey press used to
/// open+append+close focus_diagnostic.log dozens of times (once per
/// save_target_window scan step), adding milliseconds to the show critical
/// path. Stderr logging stays always-on (cheap); the file sink only when set.
static DIAG_FILE_LOG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

pub fn log_diag(event: &str) {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let ms = now.as_millis() % 1000;
    let total_secs = now.as_secs();
    let s = total_secs % 60;
    let m = (total_secs / 60) % 60;
    let h = (total_secs / 3600) % 24;
    let line = format!("[{:02}:{:02}:{:02}.{:03}] {}", h, m, s, ms, event);
    eprintln!("{}", line);

    let enabled = DIAG_FILE_LOG.get_or_init(|| {
        std::env::var("CARBON_DIAG_LOG")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    });
    if !enabled {
        return;
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open("focus_diagnostic.log") {
        let _ = writeln!(file, "{}", line);
    }
}

/// Process-global crash hook: log the panic message + backtrace to stderr
/// AND an always-on `carbon_crash.log` before abort, so a future crash
/// records WHICH thread died and where (pair with WER/Event Viewer + the
/// .dmp for attribution). Idempotent — installs once. Called from `run()`
/// before the Tauri builder starts.
pub fn install_crash_hook() {
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>");
        let bt = std::backtrace::Backtrace::force_capture();
        let line = format!("[CARBON_CRASH] thread='{name}' panic={info}\n{bt}");
        eprintln!("{line}");
        log_diag(&format!("[CARBON_CRASH] thread='{name}' panic={info}"));
        // Backtraces are long — persist the full text to disk (best effort).
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("carbon_crash.log")
        {
            use std::io::Write as _;
            let _ = writeln!(f, "{line}");
            // v30 DRAG LOG: last 50 drag lines ride along (try_lock —
            // never blocks a panicking thread).
            if let Some(entries) = crate::native_drag::drag_log_snapshot_try() {
                let _ = writeln!(f, "[DRAG LOG — last {} lines]", entries.len());
                for entry in entries {
                    let _ = writeln!(f, "  {entry}");
                }
            }
        }
        prev(info);
    }));
    log_diag("[CRASH_HOOK] installed (panic -> carbon_crash.log + backtrace)");
}

pub fn get_window_diag_info(hwnd: HWND) -> String {
    if hwnd.0.is_null() {
        return "HWND(NULL)".to_string();
    }
    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return format!("HWND(0x{:X}, INVALID)", hwnd.0 as usize);
        }

        let mut pid = 0u32;
        let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));

        let mut title_buf = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);

        let mut class_buf = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);

        let exe_name = get_window_exe_name(hwnd).unwrap_or_else(|| "Unknown".to_string());

        format!(
            "HWND(0x{:X}, PID={}, TID={}, EXE='{}', CLASS='{}', TITLE='{}')",
            hwnd.0 as usize, pid, tid, exe_name, class_name, title
        )
    }
}

pub fn get_target_app_name() -> Option<String> {
    TARGET_APP_NAME.lock().unwrap().clone()
}

fn is_shell_desktop_class(class_name: &str) -> bool {
    let lower = class_name.to_lowercase();
    let known_shell_classes = [
        "shell_traywnd",
        "shell_secondarytraywnd",
        "progman",
        "workerw",
        "shell_lightdismissoverlay",
    ];
    known_shell_classes.iter().any(|c| lower == *c)
}

fn is_utility_window_class(class_name: &str) -> bool {
    let lower = class_name.to_lowercase();
    let known_utility_classes = [
        "msctfime ui",
        "ime",
        "default ime",
        "cicerouiwnframe",
        "cicerouiwndframe",
        "edgeuiinputtopwndclass",
        "focusproxy",
        "gdi+ hook window class",
        "sysshadow",
        "dummydwmlistenerwindow",
    ];
    known_utility_classes
        .iter()
        .any(|c| lower == *c || lower.starts_with("msctfime") || lower.starts_with("cicero"))
}

fn is_utility_title(title: &str) -> bool {
    let lower = title.to_lowercase();
    lower == "msctfime ui" || lower == "default ime" || lower.starts_with("msctfime")
}

fn is_real_visible_window(hwnd: HWND) -> Result<(), String> {
    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return Err("IsWindow returned false".to_string());
        }

        if !IsWindowVisible(hwnd).as_bool() {
            return Err("IsWindowVisible returned false (hidden window)".to_string());
        }

        if IsIconic(hwnd).as_bool() {
            return Err("Window is minimized (IsIconic=true)".to_string());
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_ok() {
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            if width <= 0 || height <= 0 {
                return Err(format!("Window has zero dimensions ({}x{})", width, height));
            }
        }

        // Check DWM cloaking (Windows 8+ suspends/cloaks background UWP or inactive shell windows)
        let mut cloaked: u32 = 0;
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
        if hr.is_ok() && cloaked != 0 {
            return Err(format!("Window is cloaked by DWM (flags=0x{:X})", cloaked));
        }

        Ok(())
    }
}

pub fn save_target_window(app_handle: &AppHandle) {
    unsafe {
        let my_pid = std::process::id();
        let initial_fg = GetForegroundWindow();
        log_diag(&format!(
            "[SAVE_TARGET] Initiated. Current GetForegroundWindow: {}",
            get_window_diag_info(initial_fg)
        ));

        let mut hwnd = initial_fg;
        let mut found_target = None;
        let mut found_name = None;

        for step in 0..24 {
            if hwnd.0.is_null() || !IsWindow(hwnd).as_bool() {
                log_diag(&format!("[SAVE_TARGET] Step {}: HWND is null or invalid. Stopping scan.", step));
                break;
            }

            let mut hwnd_pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut hwnd_pid));
            let diag_info = get_window_diag_info(hwnd);

            // 1. CRITICAL: Never target Carbon's own process or its child WebView2 windows!
            if hwnd_pid != 0 && hwnd_pid == my_pid {
                log_diag(&format!("[SAVE_TARGET] Step {}: Skipped Carbon PID {}: {}", step, my_pid, diag_info));
                hwnd = windows::Win32::UI::WindowsAndMessaging::GetWindow(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::GW_HWNDNEXT,
                )
                .unwrap_or_default();
                continue;
            }

            let is_carbon = app_handle.webview_windows().values().any(|w| {
                if let Ok(w_hwnd) = w.hwnd() {
                    w_hwnd.0 == hwnd.0
                } else {
                    false
                }
            });

            if is_carbon {
                log_diag(&format!("[SAVE_TARGET] Step {}: Skipped Carbon Webview HWND: {}", step, diag_info));
                hwnd = windows::Win32::UI::WindowsAndMessaging::GetWindow(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::GW_HWNDNEXT,
                )
                .unwrap_or_default();
                continue;
            }

            // 2. Window visibility and geometry check (skip hidden, minimized, zero-sized, or cloaked windows)
            if let Err(vis_reason) = is_real_visible_window(hwnd) {
                log_diag(&format!("[SAVE_TARGET] Step {}: Skipped non-visible/utility window ({}): {}", step, vis_reason, diag_info));
                hwnd = windows::Win32::UI::WindowsAndMessaging::GetWindow(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::GW_HWNDNEXT,
                )
                .unwrap_or_default();
                continue;
            }

            // 3. Class name validation (skip desktop shells, taskbars, and utility/IME helper windows)
            let mut class_buf = [0u16; 256];
            let class_len = GetClassNameW(hwnd, &mut class_buf);
            let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);

            if is_shell_desktop_class(&class_name) {
                log_diag(&format!("[SAVE_TARGET] Step {}: Skipped Shell Class '{}': {}", step, class_name, diag_info));
                hwnd = windows::Win32::UI::WindowsAndMessaging::GetWindow(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::GW_HWNDNEXT,
                )
                .unwrap_or_default();
                continue;
            }

            if is_utility_window_class(&class_name) {
                log_diag(&format!("[SAVE_TARGET] Step {}: Skipped Utility/IME Class '{}': {}", step, class_name, diag_info));
                hwnd = windows::Win32::UI::WindowsAndMessaging::GetWindow(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::GW_HWNDNEXT,
                )
                .unwrap_or_default();
                continue;
            }

            // 4. Window title validation
            let mut title_buf = [0u16; 256];
            let title_len = GetWindowTextW(hwnd, &mut title_buf);
            let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);
            if is_utility_title(&title) {
                log_diag(&format!("[SAVE_TARGET] Step {}: Skipped Utility Title '{}': {}", step, title, diag_info));
                hwnd = windows::Win32::UI::WindowsAndMessaging::GetWindow(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::GW_HWNDNEXT,
                )
                .unwrap_or_default();
                continue;
            }

            // 5. EXE name validation & ignored shell exes
            if let Some(exe_name) = get_window_exe_name(hwnd) {
                let exe_lower = exe_name.to_lowercase();
                if IGNORED_SHELL_EXES.iter().any(|ig| exe_lower.contains(ig)) {
                    log_diag(&format!("[SAVE_TARGET] Step {}: Skipped Ignored Shell EXE '{}': {}", step, exe_name, diag_info));
                } else {
                    found_target = Some(hwnd.0 as isize);
                    found_name = Some(friendly_app_name(&exe_name));
                    log_diag(&format!(
                        "[SAVE_TARGET] Step {}: ACCEPTED Target Window: {} -> Friendly: {:?}",
                        step, diag_info, found_name
                    ));
                    break;
                }
            } else {
                log_diag(&format!("[SAVE_TARGET] Step {}: Unable to read EXE for {}", step, diag_info));
            }

            hwnd = windows::Win32::UI::WindowsAndMessaging::GetWindow(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::GW_HWNDNEXT,
            )
            .unwrap_or_default();
        }

        let mut target = TARGET_HWND.lock().unwrap();
        *target = found_target;
        *TARGET_APP_NAME.lock().unwrap() = found_name;
        log_diag(&format!(
            "[SAVE_TARGET] Finished. Final TARGET_HWND: 0x{:X?}, TARGET_APP_NAME: {:?}",
            found_target, TARGET_APP_NAME.lock().unwrap()
        ));
    }
}

const ASFW_ANY: u32 = 0xFFFFFFFF;

/// Peek at the saved paste target without consuming it (lets callers gate
/// on the target — e.g. the elevation check — before paste_item takes it).
pub fn peek_target_hwnd() -> Option<isize> {
    TARGET_HWND.lock().unwrap().clone()
}

/// Friendly label for a saved target HWND (exe display name), if resolvable.
pub fn describe_target(hwnd_val: isize) -> Option<String> {
    let hwnd = HWND(hwnd_val as *mut _);
    get_window_exe_name(hwnd).map(|exe| friendly_app_name(&exe))
}

/// True when injection is impossible: the target runs elevated but Carbon
/// does not. Callers must fall back to clipboard-set + a user-visible hint
/// instead of a dead keypress. Reads no window state beyond the given HWND.
pub fn target_needs_elevation_fallback(hwnd_val: isize) -> bool {
    use std::sync::OnceLock;
    static SELF_ELEVATED: OnceLock<bool> = OnceLock::new();
    let self_elevated = *SELF_ELEVATED.get_or_init(|| process_is_elevated(std::process::id()));
    if self_elevated {
        return false;
    }
    unsafe {
        let hwnd = HWND(hwnd_val as *mut _);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == std::process::id() {
            return false;
        }
        process_is_elevated(pid)
    }
}

fn process_is_elevated(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::OpenProcessToken;
    unsafe {
        let process = match OpenProcess(PROCESS_QUERY_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return false,
        };
        struct Closer(windows::Win32::Foundation::HANDLE);
        impl Drop for Closer {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
        let _proc = Closer(process);
        let mut token = windows::Win32::Foundation::HANDLE::default();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let _tok = Closer(token);
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut returned = 0u32;
        if GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut std::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_err()
        {
            return false;
        }
        elevation.TokenIsElevated != 0
    }
}

/// Clipboard half of a paste (transform + write + watcher mark), WITHOUT
/// injection or the in-flight guard. Used by the elevation fallback, where
/// the content is staged for a manual Ctrl+V and no injection follows.
pub fn write_clip_to_clipboard_only(
    item: &ClipItem,
    transform: PasteTransform,
) -> Result<ClipItem, String> {
    let item_to_paste = transformed_item(item, transform)?;
    let plain_text_only = transform != PasteTransform::Original;
    write_item_to_clipboard(&item_to_paste, plain_text_only)?;
    crate::clipboard_watcher::mark_paste(&item_to_paste);
    Ok(item_to_paste)
}

pub fn refocus_blocking(target_isize: isize) {
    if target_isize == 0 {
        return;
    }
    let target = HWND(target_isize as *mut _);
    for _ in 0..10 {
        if try_bring_to_foreground(target) {
            return;
        }
        thread::sleep(Duration::from_millis(30));
    }
}

pub fn restore_target_window() {
    let hwnd_val = TARGET_HWND.lock().unwrap().take();
    log_diag(&format!("[RESTORE_TARGET] restore_target_window called. Taken TARGET_HWND: 0x{:X?}", hwnd_val));
    let Some(hwnd_val) = hwnd_val else {
        log_diag("[RESTORE_TARGET] TARGET_HWND is None. Nothing to restore.");
        return;
    };
    thread::spawn(move || {
        log_diag(&format!("[RESTORE_THREAD] Spawned for HWND 0x{:X}. Sleeping 30ms initial...", hwnd_val));
        thread::sleep(Duration::from_millis(30));
        let target = HWND(hwnd_val as *mut _);
        for attempt in 1..=8 {
            log_diag(&format!("[RESTORE_THREAD] Attempt {} for HWND: {}", attempt, get_window_diag_info(target)));
            if try_bring_to_foreground(target) {
                log_diag(&format!(
                    "[RESTORE_THREAD] Succeeded on attempt {}! Current FG: {}",
                    attempt,
                    get_window_diag_info(unsafe { GetForegroundWindow() })
                ));
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
    });
}

fn try_bring_to_foreground(hwnd: HWND) -> bool {
    unsafe {
        let hwnd_info = get_window_diag_info(hwnd);
        if hwnd.0.is_null() || !IsWindow(hwnd).as_bool() {
            log_diag(&format!("[TRY_FG] HWND is null or invalid: {}", hwnd_info));
            return false;
        }

        let allow_all = AllowSetForegroundWindow(ASFW_ANY);
        let mut target_pid = 0u32;
        let _target_thread = GetWindowThreadProcessId(hwnd, Some(&mut target_pid));
        let allow_pid = if target_pid != 0 {
            AllowSetForegroundWindow(target_pid).is_ok()
        } else {
            false
        };

        let fg_before = GetForegroundWindow();
        log_diag(&format!(
            "[TRY_FG] Target: {}. FG before: {}. AllowAll: {:?}, AllowPid({}): {}",
            hwnd_info, get_window_diag_info(fg_before), allow_all, target_pid, allow_pid
        ));

        if fg_before == hwnd {
            log_diag("[TRY_FG] Already in foreground! Success.");
            return true;
        }

        let top_res = BringWindowToTop(hwnd);
        let set_fg_res = SetForegroundWindow(hwnd);

        let fg_after = GetForegroundWindow();
        let is_exact = fg_after == hwnd;
        let mut fg_pid = 0u32;
        if !fg_after.0.is_null() {
            GetWindowThreadProcessId(fg_after, Some(&mut fg_pid));
        }
        let is_pid_match = target_pid != 0 && fg_pid == target_pid;

        log_diag(&format!(
            "[TRY_FG] BringTop: {:?}, SetFG returned: {}. FG after: {} (ExactMatch: {}, PidMatch: {})",
            top_res, set_fg_res.as_bool(), get_window_diag_info(fg_after), is_exact, is_pid_match
        ));

        is_exact || is_pid_match
    }
}

pub fn get_cursor_position() -> (i32, i32) {
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            (pt.x, pt.y)
        } else {
            (100, 100)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PasteTransform {
    Original,
    PlainText,
    Markdown,
    Json,
    Uppercase,
    Lowercase,
    TitleCase,
    Base64Encode,
    Base64Decode,
    UrlEncode,
    UrlDecode,
}

/// Set while a paste request is mid-flight (clipboard write through the final
/// Ctrl+V injection). A second paste request arriving in that window is a
/// duplicate (double key event, repeated hotkey wiring, UI double-fire) and is
/// dropped so the target receives EXACTLY ONE insert. Cleared by the injection
/// thread when it finishes.
static PASTE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

pub fn paste_item(item: &ClipItem, transform: PasteTransform) -> Result<(), String> {
    log_diag(&format!(
        "[PASTE_ITEM] paste_item starting for clip id='{}', title='{}', transform={:?}",
        item.id, item.title, transform
    ));

    // Single-shot guarantee: if the previous paste request is still being
    // carried out (write -> focus -> inject), drop this one instead of
    // double-inserting into the target.
    if PASTE_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        log_diag(
            "[PASTE_GUARD] A paste is already in flight — dropping this duplicate request (single insert guaranteed).",
        );
        return Ok(());
    }

    let item_to_paste = match transformed_item(item, transform) {
        Ok(v) => v,
        Err(e) => {
            // Failed before any injection — release the guard so future
            // (legitimate) pastes are not blocked.
            PASTE_IN_FLIGHT.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let plain_text_only = transform != PasteTransform::Original;

    // 1. Write item to clipboard
    if let Err(e) = write_item_to_clipboard(&item_to_paste, plain_text_only) {
        PASTE_IN_FLIGHT.store(false, Ordering::SeqCst);
        return Err(e);
    }
    log_diag("[PASTE_ITEM] write_item_to_clipboard complete.");

    // Clipboard now holds this content — mark it so the watcher skips
    // re-capturing our own paste (content-equality based).
    crate::clipboard_watcher::mark_paste(&item_to_paste);

    // 2. Retrieve saved target HWND
    let target_hwnd = TARGET_HWND.lock().unwrap().take();
    log_diag(&format!("[PASTE_ITEM] Taken TARGET_HWND: 0x{:X?}", target_hwnd));

    // 3. Focus target and inject Ctrl+V on a background thread with confirmation
    thread::spawn(move || {
        log_diag("[PASTE_THREAD] Thread spawned. Sleeping 50ms initial for window hide...");
        thread::sleep(Duration::from_millis(50));

        if let Some(hwnd_val) = target_hwnd {
            let target = HWND(hwnd_val as *mut _);
            log_diag(&format!(
                "[PASTE_THREAD] Target HWND is 0x{:X}: {}",
                hwnd_val,
                get_window_diag_info(target)
            ));

            let mut focus_confirmed = false;
            // C2 budget: 10 x 15ms = 150ms max. A longer loop only delays a
            // paste that was already going to miss its target.
            for attempt in 1..=10 {
                log_diag(&format!("[PASTE_THREAD] Focus confirmation attempt {}...", attempt));
                if try_bring_to_foreground(target) {
                    focus_confirmed = true;
                    log_diag(&format!("[PASTE_THREAD] Focus confirmed on attempt {}!", attempt));
                    break;
                }
                thread::sleep(Duration::from_millis(15));
            }

            let settle_ms = if focus_confirmed { 40 } else { 80 };
            log_diag(&format!(
                "[PASTE_THREAD] Settling {}ms before injection (confirmed={})...",
                settle_ms, focus_confirmed
            ));
            thread::sleep(Duration::from_millis(settle_ms));
        } else {
            log_diag("[PASTE_THREAD] TARGET_HWND is None. Sleeping 60ms default before injection...");
            thread::sleep(Duration::from_millis(60));
        }

        // 4. Send-time foreground proof: the injected Ctrl+V lands wherever
        // focus REALLY is. A mismatch is a logged violation, never silent.
        let fg_at_send = unsafe { GetForegroundWindow() };
        log_diag(&format!(
            "[PASTE_THREAD] send-time foreground hwnd={:?} (target=0x{:X?})",
            fg_at_send.0 as usize, target_hwnd
        ));
        if let Some(want) = target_hwnd {
            if fg_at_send.0 as isize != want {
                log_diag(&format!(
                    "[PASTE_THREAD] VIOLATION: foreground mismatch at send time — want 0x{:X?}, have {} (proceeding best-effort)",
                    want,
                    get_window_diag_info(fg_at_send)
                ));
            }
        }
        // Inject Ctrl+V into focused control
        inject_ctrl_v();

        // Critical section ends here: clipboard content + keystrokes are
        // delivered. Release the guard BEFORE the deselect tail so a fast
        // consecutive paste is never dropped (the ~1s tap schedule used to
        // hold the flag and eat repeat pastes). The taps below touch only
        // the caret and abort the moment focus leaves this target, so they
        // are safe to run unguarded alongside a following paste.
        PASTE_IN_FLIGHT.store(false, Ordering::SeqCst);

        // Deselect-after-paste: some browser engines leave the inserted
        // text selected (highlighted) after a synthetic Ctrl+V. Collapse
        // it (browsers only — elsewhere a stray Right would nudge the
        // caret, so other targets are deliberately untouched).
        collapse_pasted_selection(target_hwnd);
    });

    Ok(())
}

fn transformed_item(item: &ClipItem, transform: PasteTransform) -> Result<ClipItem, String> {
    if transform == PasteTransform::Original {
        return Ok(item.clone());
    }

    let source = item.text_content.as_deref().filter(|s| !s.is_empty()).unwrap_or(&item.title);
    let text = match transform {
        PasteTransform::PlainText => strip_markdown_and_html(source, item.html_content.as_deref()),
        PasteTransform::Markdown => transform_to_markdown(item, source),
        PasteTransform::Json => transform_to_json(source)?,
        PasteTransform::Uppercase => source.to_uppercase(),
        PasteTransform::Lowercase => source.to_lowercase(),
        PasteTransform::TitleCase => transform_to_title_case(source),
        PasteTransform::Base64Encode => transform_to_base64_encode(source),
        PasteTransform::Base64Decode => transform_to_base64_decode(source)?,
        PasteTransform::UrlEncode => transform_to_url_encode(source),
        PasteTransform::UrlDecode => transform_to_url_decode(source)?,
        PasteTransform::Original => unreachable!(),
    };

    let mut transformed = item.clone();
    transformed.content_type = "text".to_string();
    transformed.title = text.lines().next().unwrap_or("Transformed clip").trim().to_string();
    transformed.text_content = Some(text.clone());
    transformed.html_content = None;
    transformed.rtf_content = None;
    transformed.file_size = text.len() as u64;
    Ok(transformed)
}

fn transform_to_title_case(input: &str) -> String {
    let mut result = String::new();
    let mut capitalize_next = true;
    for c in input.chars() {
        if c.is_alphabetic() {
            if capitalize_next {
                result.extend(c.to_uppercase());
                capitalize_next = false;
            } else {
                result.extend(c.to_lowercase());
            }
        } else {
            capitalize_next = true;
            result.push(c);
        }
    }
    result
}

fn transform_to_base64_encode(input: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(input.as_bytes())
}

fn try_decode_b64_str(input: &str) -> Option<String> {
    use base64::Engine;
    let clean: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .collect();

    if clean.is_empty() || clean.len() < 2 {
        return None;
    }

    // Check if contains valid base64 chars
    let is_valid_chars = clean.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '-' || c == '_' || c == '='
    });
    if !is_valid_chars {
        return None;
    }

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&clean)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&clean))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(&clean))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&clean))
        .or_else(|_| {
            let pad_needed = (4 - (clean.len() % 4)) % 4;
            let mut padded = clean.clone();
            for _ in 0..pad_needed {
                padded.push('=');
            }
            base64::engine::general_purpose::STANDARD
                .decode(&padded)
                .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(&padded))
                .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&padded))
        })
        .ok()?;

    if decoded.is_empty() {
        return None;
    }

    match String::from_utf8(decoded.clone()) {
        Ok(s) => Some(s),
        Err(_) => Some(String::from_utf8_lossy(&decoded).to_string()),
    }
}

fn transform_to_base64_decode(input: &str) -> Result<String, String> {
    let mut raw = input.trim().to_string();

    // 1. Strip surrounding quotes / backticks / brackets / parentheses
    raw = raw
        .trim_matches(|c: char| {
            c == '"'
                || c == '\''
                || c == '`'
                || c == '('
                || c == ')'
                || c == '['
                || c == ']'
                || c == '{'
                || c == '}'
        })
        .trim()
        .to_string();

    // 2. Strip data URI prefix if present
    if let Some(idx) = raw.find(";base64,") {
        raw = raw[idx + 8..].trim().to_string();
    } else if let Some(idx) = raw.find("base64,") {
        raw = raw[idx + 7..].trim().to_string();
    }

    // 3. Strip auth prefixes (Basic, Bearer, Token)
    let lower = raw.to_lowercase();
    if lower.starts_with("basic ") {
        raw = raw[6..].trim().to_string();
    } else if lower.starts_with("bearer ") {
        raw = raw[7..].trim().to_string();
    } else if lower.starts_with("token ") {
        raw = raw[6..].trim().to_string();
    }

    // 4. Try direct decode
    if let Some(res) = try_decode_b64_str(&raw) {
        return Ok(res);
    }

    // 5. If input contains percent-encoding (e.g. %3D for =), url-decode first then try
    if raw.contains('%') {
        if let Ok(urldecoded) = transform_to_url_decode(&raw) {
            if let Some(res) = try_decode_b64_str(&urldecoded) {
                return Ok(res);
            }
        }
    }

    // 6. Try word-by-word token extraction (e.g. if embedded in a sentence or key-value pair)
    for word in raw.split_whitespace() {
        let clean_word = word.trim_matches(|c: char| {
            !c.is_ascii_alphanumeric()
                && c != '+'
                && c != '/'
                && c != '-'
                && c != '_'
                && c != '='
        });
        if clean_word.len() >= 4 {
            if let Some(res) = try_decode_b64_str(clean_word) {
                return Ok(res);
            }
        }
    }

    // 7. Fallback: return raw text if decoding was not possible so paste never fails
    Ok(raw)
}

fn transform_to_url_encode(input: &str) -> String {
    let mut encoded = String::new();
    for b in input.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(b as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", b));
            }
        }
    }
    encoded
}

fn transform_to_url_decode(input: &str) -> Result<String, String> {
    let input_bytes = input.as_bytes();
    let mut bytes = Vec::with_capacity(input_bytes.len());
    let mut i = 0;

    while i < input_bytes.len() {
        if input_bytes[i] == b'%' && i + 2 < input_bytes.len() {
            let hex_slice = &input_bytes[i + 1..i + 3];
            if let Ok(hex_str) = std::str::from_utf8(hex_slice) {
                if let Ok(b) = u8::from_str_radix(hex_str, 16) {
                    bytes.push(b);
                    i += 3;
                    continue;
                }
            }
        } else if input_bytes[i] == b'+' {
            bytes.push(b' ');
            i += 1;
            continue;
        }

        bytes.push(input_bytes[i]);
        i += 1;
    }

    match String::from_utf8(bytes.clone()) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::from_utf8_lossy(&bytes).to_string()),
    }
}

fn strip_markdown_and_html(text: &str, html: Option<&str>) -> String {
    let source_text = if !text.trim().is_empty() {
        text.to_string()
    } else if let Some(html_str) = html {
        let fragment = extract_html_fragment(html_str);
        if let Ok(re_html) = Regex::new(r"<[^>]*>") {
            let cleaned = re_html.replace_all(fragment, "");
            if !cleaned.trim().is_empty() {
                cleaned.to_string()
            } else {
                text.to_string()
            }
        } else {
            text.to_string()
        }
    } else {
        text.to_string()
    };

    strip_markdown_syntax(&source_text)
}

fn strip_markdown_syntax(input: &str) -> String {
    let mut s = input.to_string();

    if let Ok(re_code_block) = Regex::new(r"(?m)^```\w*\n?|```$") {
        s = re_code_block.replace_all(&s, "").to_string();
    }
    if let Ok(re_headers) = Regex::new(r"(?m)^#{1,6}\s+") {
        s = re_headers.replace_all(&s, "").to_string();
    }
    if let Ok(re_quote) = Regex::new(r"(?m)^>\s+") {
        s = re_quote.replace_all(&s, "").to_string();
    }
    if let Ok(re_list) = Regex::new(r"(?m)^[\s]*[-*+]\s+") {
        s = re_list.replace_all(&s, "").to_string();
    }
    if let Ok(re_bold_italic) = Regex::new(r"\*{1,3}(.*?)\*{1,3}|_{1,3}(.*?)_{1,3}") {
        s = re_bold_italic.replace_all(&s, "$1$2").to_string();
    }
    if let Ok(re_strike) = Regex::new(r"~~(.*?)~~") {
        s = re_strike.replace_all(&s, "$1").to_string();
    }
    if let Ok(re_inline_code) = Regex::new(r"`([^`]+)`") {
        s = re_inline_code.replace_all(&s, "$1").to_string();
    }
    if let Ok(re_link) = Regex::new(r"\[([^\]]+)\]\([^)]+\)") {
        s = re_link.replace_all(&s, "$1").to_string();
    }
    if let Ok(re_img) = Regex::new(r"!\[([^\]]*)\]\([^)]+\)") {
        s = re_img.replace_all(&s, "$1").to_string();
    }

    s.trim().to_string()
}

fn transform_to_markdown(item: &ClipItem, fallback_text: &str) -> String {
    let Some(html) = item.html_content.as_deref() else {
        return fallback_text.to_string();
    };

    let fragment = extract_html_fragment(html);
    let markdown = html2md::parse_html(fragment);
    if markdown.trim().is_empty() {
        fallback_text.to_string()
    } else {
        markdown.trim().to_string()
    }
}

pub fn extract_html_fragment(html: &str) -> &str {
    let start_marker = "<!--StartFragment-->";
    let end_marker = "<!--EndFragment-->";
    if let (Some(s), Some(e)) = (html.find(start_marker), html.find(end_marker)) {
        if e > s + start_marker.len() {
            return html[s + start_marker.len()..e].trim_matches('\0').trim();
        }
    }

    let offset = |name: &str| {
        html.lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|value| value.trim().parse::<usize>().ok())
    };
    if let (Some(start), Some(end)) = (offset("StartFragment:"), offset("EndFragment:")) {
        if end > start && end <= html.len() {
            if let Some(slice) = html.get(start..end) {
                let trimmed = slice.trim_matches('\0').trim();
                if !trimmed.is_empty() {
                    return trimmed;
                }
            }
        }
    }

    if html.starts_with("Version:") {
        if let Some(body_pos) = html.find("<body") {
            if let Some(tag_end) = html[body_pos..].find('>') {
                let content_start = body_pos + tag_end + 1;
                let content_end = html.find("</body>").unwrap_or(html.len());
                if content_end > content_start {
                    return html[content_start..content_end].trim_matches('\0').trim();
                }
            }
        }
    }

    html.trim_matches('\0').trim()
}

pub fn wrap_in_cf_html(html_fragment: &str) -> String {
    let header_template = "Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000280\r\nStartFragment:0000000140\r\nEndFragment:0000000240\r\n";
    let prefix = "<html><body>\r\n<!--StartFragment-->";
    let suffix = "<!--EndFragment-->\r\n</body></html>\0";

    let start_html = header_template.len();
    let start_fragment = start_html + prefix.len();
    let end_fragment = start_fragment + html_fragment.as_bytes().len();
    let end_html = end_fragment + suffix.len() - 1; // excluding \0

    let header = format!(
        "Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\n",
        start_html, end_html, start_fragment, end_fragment
    );

    format!("{}{}{}{}", header, prefix, html_fragment, suffix)
}

fn transform_to_json(text: &str) -> Result<String, String> {
    let input = text.trim();
    if input.is_empty() {
        return Err("Paste as JSON needs text content".to_string());
    }

    if let Ok(value) = serde_json::from_str::<Value>(input) {
        if let Ok(pretty) = serde_json::to_string_pretty(&value) {
            return Ok(pretty);
        }
    }

    if let Some(value) = parse_xmlish_object(input) {
        if let Ok(pretty) = serde_json::to_string_pretty(&Value::Object(value)) {
            return Ok(pretty);
        }
    }

    if let Some(value) = parse_key_value_object(input) {
        if let Ok(pretty) = serde_json::to_string_pretty(&Value::Object(value)) {
            return Ok(pretty);
        }
    }

    // Fallback for plain text: format into a JSON object so Paste as JSON never fails
    let mut map = Map::new();
    map.insert("text".to_string(), Value::String(input.to_string()));
    serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())
}

fn parse_xmlish_object(input: &str) -> Option<Map<String, Value>> {
    let expression = Regex::new(r"(?s)<([A-Za-z_][A-Za-z0-9_.-]*)\b[^>]*>([^<]*)</[A-Za-z_][A-Za-z0-9_.-]*>").ok()?;
    let mut object = Map::new();

    for captures in expression.captures_iter(input) {
        let key = captures.get(1)?.as_str().to_string();
        let value = captures.get(2)?.as_str().trim();
        if !key.is_empty() {
            object.insert(key, json_scalar(value));
        }
    }

    (!object.is_empty()).then_some(object)
}

fn parse_key_value_object(input: &str) -> Option<Map<String, Value>> {
    let lines = input.lines().filter(|line| !line.trim().is_empty()).collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }

    let mut object = Map::new();
    for line in lines {
        let (key, value) = line.split_once(':').or_else(|| line.split_once('='))?;
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            return None;
        }
        object.insert(key.to_string(), json_scalar(value));
    }

    (!object.is_empty()).then_some(object)
}

fn json_scalar(value: &str) -> Value {
    serde_json::from_str::<Value>(value)
        .ok()
        .filter(|parsed| parsed.is_boolean() || parsed.is_number() || parsed.is_null())
        .unwrap_or_else(|| Value::String(value.trim_matches('"').to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_flat_key_value_lines_to_json() {
        let output = transform_to_json("name: Carbon\nversion: 1.1\nenabled: true").unwrap();
        let parsed = serde_json::from_str::<Value>(&output).unwrap();

        assert_eq!(parsed["name"], "Carbon");
        assert_eq!(parsed["version"], 1.1);
        assert_eq!(parsed["enabled"], true);
    }

    #[test]
    fn converts_flat_xml_style_text_to_json() {
        let output = transform_to_json("<name>Carbon</name><count>3</count>").unwrap();
        let parsed = serde_json::from_str::<Value>(&output).unwrap();

        assert_eq!(parsed["name"], "Carbon");
        assert_eq!(parsed["count"], 3);
    }

    #[test]
    fn strips_markdown_syntax_for_plain_text_paste() {
        let md = "# Heading 1\nThis is **bold** and *italic* with `code` and [link](https://carbon.app).\n- Item 1\n- Item 2";
        let stripped = strip_markdown_syntax(md);
        assert!(!stripped.contains('#'));
        assert!(!stripped.contains("**"));
        assert!(!stripped.contains('`'));
        assert!(stripped.contains("Heading 1"));
        assert!(stripped.contains("bold"));
        assert!(stripped.contains("Item 1"));
    }

    #[test]
    fn uses_html_for_markdown_when_available() {
        let item = ClipItem {
            id: "test".to_string(),
            content_type: "rich_text".to_string(),
            title: "Carbon".to_string(),
            text_content: Some("Carbon".to_string()),
            rtf_content: None,
            html_content: Some("<h1>Carbon</h1><p>Local clipboard manager</p>".to_string()),
            image_path: None,
            image_width: None,
            image_height: None,
            file_paths: None,
            is_video: false,
            file_size: 0,
            is_pinned: false,
            source_app: None,
            created_at: String::new(),
            updated_at: String::new(),
            qr_content: None,
            is_sensitive: false,
            expires_at: None,
            ocr_text: None,
        };

        let markdown = transform_to_markdown(&item, "Carbon");
        assert!(markdown.contains("Carbon"));
        assert!(markdown.contains("Local clipboard manager"));
        // html2md renders <h1> as a Setext heading (underlined), not "# "
        assert!(markdown.contains('='));
    }

    #[test]
    fn transformed_item_converts_markdown_and_json() {
        let rich_item = ClipItem {
            id: "rich".to_string(),
            content_type: "rich_text".to_string(),
            title: "Title".to_string(),
            text_content: Some("name: Carbon".to_string()),
            rtf_content: None,
            html_content: Some("<h1>Carbon</h1><p>Local clipboard manager</p>".to_string()),
            image_path: None,
            image_width: None,
            image_height: None,
            file_paths: None,
            is_video: false,
            file_size: 0,
            is_pinned: false,
            source_app: None,
            created_at: String::new(),
            updated_at: String::new(),
            qr_content: None,
            is_sensitive: false,
            expires_at: None,
            ocr_text: None,
        };

        let markdown = transformed_item(&rich_item, PasteTransform::Markdown).unwrap();
        assert_eq!(markdown.content_type, "text");
        assert!(markdown.text_content.unwrap().contains("Local clipboard manager"));
        assert!(markdown.html_content.is_none());

        let json = transformed_item(&rich_item, PasteTransform::Json).unwrap();
        assert_eq!(json.content_type, "text");
        let parsed = serde_json::from_str::<Value>(json.text_content.unwrap().as_str()).unwrap();
        assert_eq!(parsed["name"], "Carbon");
        assert!(json.rtf_content.is_none());

        let plain = transformed_item(&rich_item, PasteTransform::PlainText).unwrap();
        assert_eq!(plain.text_content.as_deref(), Some("name: Carbon"));

        let upper = transformed_item(&rich_item, PasteTransform::Uppercase).unwrap();
        assert_eq!(upper.text_content.as_deref(), Some("NAME: CARBON"));

        let lower = transformed_item(&rich_item, PasteTransform::Lowercase).unwrap();
        assert_eq!(lower.text_content.as_deref(), Some("name: carbon"));

        let title = transformed_item(&rich_item, PasteTransform::TitleCase).unwrap();
        assert_eq!(title.text_content.as_deref(), Some("Name: Carbon"));

        let b64_enc = transformed_item(&rich_item, PasteTransform::Base64Encode).unwrap();
        assert_eq!(b64_enc.text_content.as_deref(), Some("bmFtZTogQ2FyYm9u"));

        let mut b64_item = rich_item.clone();
        b64_item.text_content = Some("bmFtZTogQ2FyYm9u".to_string());
        let b64_dec = transformed_item(&b64_item, PasteTransform::Base64Decode).unwrap();
        assert_eq!(b64_dec.text_content.as_deref(), Some("name: Carbon"));

        let url_enc = transformed_item(&rich_item, PasteTransform::UrlEncode).unwrap();
        assert_eq!(url_enc.text_content.as_deref(), Some("name%3A%20Carbon"));

        let mut url_item = rich_item.clone();
        url_item.text_content = Some("name%3A%20Carbon".to_string());
        let url_dec = transformed_item(&url_item, PasteTransform::UrlDecode).unwrap();
        assert_eq!(url_dec.text_content.as_deref(), Some("name: Carbon"));

        // Edge case tests for Base64 Decoder
        let mut b64_newline_item = rich_item.clone();
        b64_newline_item.text_content = Some("bmFt\r\nZTog\nQ2Fy\r\nYm9u\n".to_string());
        let b64_nl_dec = transformed_item(&b64_newline_item, PasteTransform::Base64Decode).unwrap();
        assert_eq!(b64_nl_dec.text_content.as_deref(), Some("name: Carbon"));

        let mut b64_unpadded_item = rich_item.clone();
        b64_unpadded_item.text_content = Some("SGVsbG8gV29ybGQ".to_string()); // Missing '='
        let b64_unpad_dec = transformed_item(&b64_unpadded_item, PasteTransform::Base64Decode).unwrap();
        assert_eq!(b64_unpad_dec.text_content.as_deref(), Some("Hello World"));

        let mut b64_data_uri_item = rich_item.clone();
        b64_data_uri_item.text_content = Some("data:text/plain;base64,SGVsbG8gV29ybGQ=".to_string());
        let b64_uri_dec = transformed_item(&b64_data_uri_item, PasteTransform::Base64Decode).unwrap();
        assert_eq!(b64_uri_dec.text_content.as_deref(), Some("Hello World"));

        let mut b64_auth_item = rich_item.clone();
        b64_auth_item.text_content = Some("Basic SGVsbG8gV29ybGQ=".to_string());
        let b64_auth_dec = transformed_item(&b64_auth_item, PasteTransform::Base64Decode).unwrap();
        assert_eq!(b64_auth_dec.text_content.as_deref(), Some("Hello World"));

        let mut b64_paren_item = rich_item.clone();
        b64_paren_item.text_content = Some("(SGVsbG8=)".to_string());
        let b64_paren_dec = transformed_item(&b64_paren_item, PasteTransform::Base64Decode).unwrap();
        assert_eq!(b64_paren_dec.text_content.as_deref(), Some("Hello"));

        let mut b64_urlenc_item = rich_item.clone();
        b64_urlenc_item.text_content = Some("SGVsbG8%3D".to_string());
        let b64_urlenc_dec = transformed_item(&b64_urlenc_item, PasteTransform::Base64Decode).unwrap();
        assert_eq!(b64_urlenc_dec.text_content.as_deref(), Some("Hello"));

        // Edge case tests for URL Decoder
        let mut url_query_item = rich_item.clone();
        url_query_item.text_content = Some("https://example.com/search?q=hello+world&lang=en%20US".to_string());
        let url_query_dec = transformed_item(&url_query_item, PasteTransform::UrlDecode).unwrap();
        assert_eq!(url_query_dec.text_content.as_deref(), Some("https://example.com/search?q=hello world&lang=en US"));

        let mut url_utf8_item = rich_item.clone();
        url_utf8_item.text_content = Some("%E4%BD%A0%E5%A5%BD%2C%20%F0%9F%8C%8D".to_string()); // "你好, 🌍"
        let url_utf8_dec = transformed_item(&url_utf8_item, PasteTransform::UrlDecode).unwrap();
        assert_eq!(url_utf8_dec.text_content.as_deref(), Some("你好, 🌍"));

        // Original returns the item untouched.
        let original = transformed_item(&rich_item, PasteTransform::Original).unwrap();
        assert_eq!(original.content_type, "rich_text");
        assert!(original.html_content.is_some());
    }

    #[test]
    fn wraps_and_extracts_cf_html() {
        let frag = "<h1>Heading</h1><p>Paragraph with <b>bold</b></p>";
        let cf_html = wrap_in_cf_html(frag);
        assert!(cf_html.starts_with("Version:0.9\r\nStartHTML:"));
        assert!(cf_html.contains("<!--StartFragment-->"));
        assert!(cf_html.contains("<!--EndFragment-->"));

        let extracted = extract_html_fragment(&cf_html);
        assert_eq!(extracted, frag);
    }
}

fn open_clipboard_with_retry() -> bool {
    unsafe {
        for _ in 0..10 {
            if OpenClipboard(HWND::default()).is_ok() {
                return true;
            }
            thread::sleep(Duration::from_millis(15));
        }
    }
    false
}

pub fn write_item_to_clipboard(item: &ClipItem, plain_text_only: bool) -> Result<(), String> {
    unsafe {
        if !open_clipboard_with_retry() {
            return Err("Could not open clipboard".to_string());
        }

        EmptyClipboard().map_err(|e| e.to_string())?;

        let html_format = RegisterClipboardFormatW(
            PCWSTR("HTML Format\0".encode_utf16().collect::<Vec<u16>>().as_ptr()),
        );

        if !plain_text_only {
            // A. Image
            if item.content_type == "image" {
                if let Some(ref img_path_str) = item.image_path {
                    let path = PathBuf::from(img_path_str);
                    if let Ok(img) = image::open(&path) {
                        let rgba = img.to_rgba8();
                        let (width, height) = rgba.dimensions();
                        if let Some(dib_data) = rgba_to_dib(&rgba, width, height) {
                            if let Ok(h_mem) = GlobalAlloc(GMEM_MOVEABLE, dib_data.len()) {
                                let ptr = GlobalLock(h_mem);
                                if !ptr.is_null() {
                                    std::ptr::copy_nonoverlapping(
                                        dib_data.as_ptr(),
                                        ptr as *mut u8,
                                        dib_data.len(),
                                    );
                                    GlobalUnlock(h_mem).ok();
                                    let _ = SetClipboardData(CF_DIB, HANDLE(h_mem.0));
                                }
                            }
                        }
                    }
                }
            }
            // B. Files
            else if item.content_type == "file" {
                if let Some(ref file_paths_json) = item.file_paths {
                    if let Ok(paths) = serde_json::from_str::<Vec<String>>(file_paths_json) {
                        if !paths.is_empty() {
                            set_clipboard_hdrop(&paths);
                        }
                    }
                }
            }
            // C. Rich text HTML / RTF
            else if item.content_type == "rich_text" || item.html_content.is_some() || item.rtf_content.is_some() {
                if let Some(ref html) = item.html_content {
                    let cf_html = if html.starts_with("Version:") {
                        html.clone()
                    } else {
                        wrap_in_cf_html(html)
                    };
                    set_clipboard_raw_bytes(html_format, cf_html.as_bytes());
                }
                // NOTE: RTF is deliberately NOT written for pastes. When both
                // text/html and text/rtf are present, rich web editors (e.g.
                // ChatGPT's composer) can import both formats and insert the
                // content TWICE. HTML + plain text is unambiguous everywhere;
                // the stored rtf_content is still available for future use.
            }
        }

        // Always set plain text as fallback or primary text
        if let Some(ref text) = item.text_content {
            let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            let bytes_len = utf16.len() * 2;
            if let Ok(h_mem) = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes_len) {
                let ptr = GlobalLock(h_mem);
                if !ptr.is_null() {
                    std::ptr::copy_nonoverlapping(utf16.as_ptr() as *const u8, ptr as *mut u8, bytes_len);
                    GlobalUnlock(h_mem).ok();
                    let _ = SetClipboardData(CF_UNICODETEXT, HANDLE(h_mem.0));
                }
            }
        }

        CloseClipboard().ok();
    }

    Ok(())
}

fn set_clipboard_raw_bytes(format: u32, bytes: &[u8]) {
    if format == 0 {
        return;
    }
    unsafe {
        if let Ok(h_mem) = GlobalAlloc(GMEM_MOVEABLE, bytes.len() + 1) {
            let ptr = GlobalLock(h_mem);
            if !ptr.is_null() {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
                *(ptr as *mut u8).add(bytes.len()) = 0;
                GlobalUnlock(h_mem).ok();
                let _ = SetClipboardData(format, HANDLE(h_mem.0));
            }
        }
    }
}

fn set_clipboard_hdrop(paths: &[String]) {
    use windows::Win32::UI::Shell::DROPFILES;

    let mut buffer: Vec<u16> = Vec::new();
    for p in paths {
        buffer.extend(p.encode_utf16());
        buffer.push(0);
    }
    buffer.push(0); // Double null terminator

    let header_size = std::mem::size_of::<DROPFILES>();
    let total_size = header_size + (buffer.len() * 2);

    unsafe {
        if let Ok(h_mem) = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_size) {
            let ptr = GlobalLock(h_mem);
            if !ptr.is_null() {
                let df = ptr as *mut DROPFILES;
                (*df).pFiles = header_size as u32;
                (*df).fWide = windows::Win32::Foundation::BOOL(1);

                let dest = (ptr as *mut u8).add(header_size) as *mut u16;
                std::ptr::copy_nonoverlapping(buffer.as_ptr(), dest, buffer.len());

                GlobalUnlock(h_mem).ok();
                let _ = SetClipboardData(CF_HDROP, HANDLE(h_mem.0));
            }
        }
    }
}

fn rgba_to_dib(rgba: &image::RgbaImage, width: u32, height: u32) -> Option<Vec<u8>> {
    let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
    let bytes_per_pixel = 4;
    let row_stride = width as usize * bytes_per_pixel;
    let pixel_bytes_size = row_stride * height as usize;
    let total_size = header_size + pixel_bytes_size;

    let mut dib = vec![0u8; total_size];

    let header = BITMAPINFOHEADER {
        biSize: header_size as u32,
        biWidth: width as i32,
        biHeight: height as i32, // positive for bottom-up DIB
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0, // BI_RGB
        biSizeImage: pixel_bytes_size as u32,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };

    unsafe {
        std::ptr::copy_nonoverlapping(
            &header as *const _ as *const u8,
            dib.as_mut_ptr(),
            header_size,
        );
    }

    let pixel_buf = &mut dib[header_size..];

    for y in 0..height {
        let src_y = height - 1 - y; // Bottom-up
        for x in 0..width {
            let p = rgba.get_pixel(x, src_y);
            let dst_idx = (y as usize * row_stride) + (x as usize * 4);
            pixel_buf[dst_idx] = p[2];     // B
            pixel_buf[dst_idx + 1] = p[1]; // G
            pixel_buf[dst_idx + 2] = p[0]; // R
            pixel_buf[dst_idx + 3] = p[3]; // A
        }
    }

    Some(dib)
}

fn inject_ctrl_v() {
    unsafe {
        let fg = GetForegroundWindow();
        log_diag(&format!(
            "[INJECT_CTRL_V] Starting injection. Current Foreground Window: {}",
            get_window_diag_info(fg)
        ));

        let scan_ctrl = MapVirtualKeyW(VK_CONTROL.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let scan_v = MapVirtualKeyW(VK_V.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let scan_shift = MapVirtualKeyW(VK_SHIFT.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let scan_alt = MapVirtualKeyW(VK_MENU.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let scan_lwin = MapVirtualKeyW(VK_LWIN.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let scan_rwin = MapVirtualKeyW(VK_RWIN.0 as u32, MAPVK_VK_TO_VSC) as u16;

        // 1. Release physical modifier keys if held (Win, Shift, Alt, Ctrl)
        let release_modifiers = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_LWIN,
                        wScan: scan_lwin,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_RWIN,
                        wScan: scan_rwin,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_SHIFT,
                        wScan: scan_shift,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_MENU,
                        wScan: scan_alt,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: scan_ctrl,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        let rel_res = SendInput(&release_modifiers, std::mem::size_of::<INPUT>() as i32);
        log_diag(&format!("[INJECT_CTRL_V] Step 1: Released modifiers (SendInput returned {})", rel_res));

        thread::sleep(Duration::from_millis(20));

        // 2. Press Ctrl DOWN
        let ctrl_down = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: scan_ctrl,
                        dwFlags: Default::default(),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        let c_down_res = SendInput(&ctrl_down, std::mem::size_of::<INPUT>() as i32);
        log_diag(&format!("[INJECT_CTRL_V] Step 2: Sent Ctrl DOWN (SendInput returned {})", c_down_res));

        thread::sleep(Duration::from_millis(15));

        // 3. Press V DOWN
        let v_down = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_V,
                        wScan: scan_v,
                        dwFlags: Default::default(),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        let v_down_res = SendInput(&v_down, std::mem::size_of::<INPUT>() as i32);
        log_diag(&format!("[INJECT_CTRL_V] Step 3: Sent V DOWN (SendInput returned {})", v_down_res));

        thread::sleep(Duration::from_millis(25));

        // 4. Release V UP
        let v_up = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_V,
                        wScan: scan_v,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        let v_up_res = SendInput(&v_up, std::mem::size_of::<INPUT>() as i32);
        log_diag(&format!("[INJECT_CTRL_V] Step 4: Sent V UP (SendInput returned {})", v_up_res));

        thread::sleep(Duration::from_millis(15));

        // 5. Release Ctrl UP
        let ctrl_up = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: scan_ctrl,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        let c_up_res = SendInput(&ctrl_up, std::mem::size_of::<INPUT>() as i32);
        log_diag(&format!("[INJECT_CTRL_V] Step 5: Sent Ctrl UP (SendInput returned {})", c_up_res));

        let fg_end = GetForegroundWindow();
        log_diag(&format!(
            "[INJECT_CTRL_V] Finished. Final Foreground Window: {}",
            get_window_diag_info(fg_end)
        ));
    }
}

/// Injects Ctrl+C into the currently focused window (releases held modifiers
/// first, mirroring inject_ctrl_v). Used to snapshot `{selection}`.
#[allow(dead_code)]
fn inject_ctrl_c() {
    unsafe {
        let scan_ctrl = MapVirtualKeyW(VK_CONTROL.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let scan_c = MapVirtualKeyW(VK_C.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let scan_shift = MapVirtualKeyW(VK_SHIFT.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let scan_alt = MapVirtualKeyW(VK_MENU.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let scan_lwin = MapVirtualKeyW(VK_LWIN.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let scan_rwin = MapVirtualKeyW(VK_RWIN.0 as u32, MAPVK_VK_TO_VSC) as u16;

        let release_modifiers = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_LWIN,
                        wScan: scan_lwin,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_RWIN,
                        wScan: scan_rwin,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_SHIFT,
                        wScan: scan_shift,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_MENU,
                        wScan: scan_alt,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: scan_ctrl,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        SendInput(&release_modifiers, std::mem::size_of::<INPUT>() as i32);
        thread::sleep(Duration::from_millis(20));

        let ctrl_down = [INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: scan_ctrl,
                    dwFlags: Default::default(),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }];
        SendInput(&ctrl_down, std::mem::size_of::<INPUT>() as i32);
        thread::sleep(Duration::from_millis(15));

        let c_down = [INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_C,
                    wScan: scan_c,
                    dwFlags: Default::default(),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }];
        SendInput(&c_down, std::mem::size_of::<INPUT>() as i32);
        thread::sleep(Duration::from_millis(25));

        let c_up = [INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_C,
                    wScan: scan_c,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }];
        SendInput(&c_up, std::mem::size_of::<INPUT>() as i32);
        thread::sleep(Duration::from_millis(15));

        let ctrl_up = [INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: scan_ctrl,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }];
        SendInput(&ctrl_up, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Sends a single Right-arrow press (down+up, batched into one SendInput).
/// Collapses a post-paste selection to its end so pasted text lands
/// unhighlighted. At an unselected caret it is at most a one-char nudge —
/// hence browser-gated by collapse_pasted_selection, never unconditional.
fn inject_right_arrow() {
    unsafe {
        let scan_right = MapVirtualKeyW(VK_RIGHT.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let events = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_RIGHT,
                        wScan: scan_right,
                        dwFlags: Default::default(),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_RIGHT,
                        wScan: scan_right,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        let sent = SendInput(&events, std::mem::size_of::<INPUT>() as i32);
        log_diag(&format!("[DESELECT] Right-arrow sent (SendInput returned {sent})"));
    }
}

/// Browser + chat-shell allowlist for deselect-after-paste: Chromium/Gecko
/// inputs (and Electron chat shells built on them) are the ones observed
/// leaving synthetic Ctrl+V inserts selected. Everything else (terminals,
/// editors, Office, IDEs) is left untouched — a stray Right there would
/// move the caret for no benefit. Tell us the exe and it gets added.
const DESELECT_BROWSERS: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "comet.exe",
    "brave.exe",
    "arc.exe",
    "opera.exe",
    "vivaldi.exe",
    "zen.exe",
    "thorium.exe",
    "floorp.exe",
    "librewolf.exe",
    "slack.exe",
    "discord.exe",
    "msteams.exe",
    "teams.exe",
    "notion.exe",
    "whatsapp.exe",
    "telegram.exe",
];

/// If the foreground window is a known browser, collapse any selection the
/// just-injected paste left behind. Three taps (+80/+350/+900ms): the first
/// catches synchronous inserts, the later ones catch editors that render or
/// focus-late (busy pages can process Ctrl+V long after injection). Every
/// tap re-validates that focus never left the paste target — the sequence
/// aborts otherwise, so a tap can never land in another window. At an
/// unselected caret each tap is a no-op; logs every step for traceability.
fn collapse_pasted_selection(target_hwnd: Option<isize>) {
    thread::sleep(Duration::from_millis(80));
    let exe = foreground_exe();
    if !DESELECT_BROWSERS.iter().any(|b| exe == *b) {
        log_diag(&format!(
            "[DESELECT] non-browser target '{exe}' — leaving caret alone"
        ));
        return;
    }
    for (i, wait_ms) in [0u64, 270, 550].iter().enumerate() {
        if *wait_ms > 0 {
            thread::sleep(Duration::from_millis(*wait_ms));
        }
        if !still_on_target(target_hwnd, &exe) {
            log_diag(&format!(
                "[DESELECT] focus left the paste target — stopping after tap {i}/3"
            ));
            return;
        }
        log_diag(&format!(
            "[DESELECT] browser target '{exe}' — collapsing (tap {}/3)",
            i + 1
        ));
        inject_right_arrow();
    }
}

/// Lowercased foreground exe name (empty when unreadable).
fn foreground_exe() -> String {
    unsafe {
        get_window_exe_name(GetForegroundWindow())
            .unwrap_or_default()
            .to_lowercase()
    }
}

/// True when focus is still where the paste landed: same hwnd when the
/// target is known, else same exe family (target-less snippet/legacy
/// paths). Any user Alt-Tab (or focus theft) aborts the tap sequence.
fn still_on_target(target_hwnd: Option<isize>, exe: &str) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return false;
        }
        if let Some(want) = target_hwnd {
            if fg.0 as isize != want {
                return false;
            }
        }
        let now = get_window_exe_name(fg).unwrap_or_default().to_lowercase();
        now == exe
    }
}

/// Sends `count` Left-arrow presses (batched into a single SendInput call).
/// Used to move the caret back over a snippet's suffix for `{cursor}`.
fn inject_left_arrows(count: usize) {
    unsafe {
        let scan_left = MapVirtualKeyW(VK_LEFT.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let mut events: Vec<INPUT> = Vec::with_capacity(count * 2);
        for _ in 0..count {
            events.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_LEFT,
                        wScan: scan_left,
                        dwFlags: Default::default(),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
            events.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_LEFT,
                        wScan: scan_left,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
        SendInput(&events, std::mem::size_of::<INPUT>() as i32);
    }
}
