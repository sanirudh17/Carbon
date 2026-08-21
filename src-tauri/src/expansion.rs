use crate::db::{DbState, Snippet};
use crate::settings::SettingsState;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use chrono::Datelike;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationValuePattern,
    UIA_ValuePatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, MapVirtualKeyW, VK_BACK, VK_CONTROL, VK_LCONTROL,
    VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN, VK_MENU, VK_SHIFT, VK_LSHIFT, VK_RSHIFT,
    VK_PACKET, VK_TAB, VK_LEFT, VK_RIGHT, VK_UP, VK_DOWN, VK_HOME, VK_END, VK_PRIOR, VK_NEXT,
    VK_ESCAPE, VK_CAPITAL,
};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetCaretPos, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
    PostThreadMessageW, SendMessageW, SetWindowsHookExW, UnhookWindowsHookEx, GUI_CARETBLINKING,
    GUITHREADINFO, HHOOK, KBDLLHOOKSTRUCT, KBDLLHOOKSTRUCT_FLAGS, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_KEYDOWN, WM_LBUTTONUP, WM_QUIT, WM_SYSKEYDOWN, GetMessageW, TranslateMessage,
    DispatchMessageW, MSG, HC_ACTION, LLKHF_INJECTED,
};

// ---------------------------------------------------------------------------
// Public status for Settings UI
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExpansionStatus {
    Off,
    NotYetActive,
    Active,
}

// ---------------------------------------------------------------------------
// Trie for O(L) longest-suffix lookup
// ---------------------------------------------------------------------------

struct TrieNode {
    children: HashMap<char, usize>,
    terminal: Option<TrieTerminal>,
}

struct TrieTerminal {
    snippet_id: String,
    keyword: String, // original case
    keyword_lower: String,
}

pub struct KeywordTrie {
    nodes: Vec<TrieNode>,
    // keyword_lower -> snippet_id for quick prefix checks
    keywords: HashMap<String, String>,
}

impl KeywordTrie {
    fn new() -> Self {
        Self {
            nodes: vec![TrieNode {
                children: HashMap::new(),
                terminal: None,
            }],
            keywords: HashMap::new(),
        }
    }

    fn clear(&mut self) {
        self.nodes.clear();
        self.nodes.push(TrieNode {
            children: HashMap::new(),
            terminal: None,
        });
        self.keywords.clear();
    }

    fn insert(&mut self, keyword: &str, snippet_id: String) {
        let lower = keyword.to_lowercase();
        if lower.is_empty() {
            return;
        }
        // If duplicate keyword, keep first (do not overwrite)
        if self.keywords.contains_key(&lower) {
            return;
        }
        // Insert reversed keyword into trie
        let rev: Vec<char> = lower.chars().rev().collect();
        let mut idx = 0usize;
        for ch in rev {
            let next = {
                let node = &self.nodes[idx];
                node.children.get(&ch).copied()
            };
            let next_idx = if let Some(n) = next {
                n
            } else {
                let new_idx = self.nodes.len();
                self.nodes.push(TrieNode {
                    children: HashMap::new(),
                    terminal: None,
                });
                self.nodes[idx].children.insert(ch, new_idx);
                new_idx
            };
            idx = next_idx;
        }
        self.nodes[idx].terminal = Some(TrieTerminal {
            snippet_id: snippet_id.clone(),
            keyword: keyword.to_string(),
            keyword_lower: lower.clone(),
        });
        self.keywords.insert(lower, snippet_id);
    }

    /// Find longest suffix of `buffer_lower` that equals a keyword.
    /// Returns (keyword_len_chars, snippet_id, keyword_original)
    fn find_longest_suffix(&self, buffer_lower: &str) -> Option<(usize, String, String)> {
        if buffer_lower.is_empty() || self.nodes.len() <= 1 {
            return None;
        }
        let rev: Vec<char> = buffer_lower.chars().rev().collect();
        let mut idx = 0usize;
        let mut best: Option<(usize, String, String)> = None;
        for (i, ch) in rev.iter().enumerate() {
            let next = {
                let node = &self.nodes[idx];
                node.children.get(ch).copied()
            };
            match next {
                Some(n) => {
                    idx = n;
                    if let Some(term) = &self.nodes[idx].terminal {
                        let kw_len = term.keyword.chars().count();
                        best = Some((kw_len, term.snippet_id.clone(), term.keyword.clone()));
                    }
                }
                None => break,
            }
        }
        best
    }

    fn is_prefix_of_longer(&self, keyword_lower: &str) -> bool {
        for kw in self.keywords.keys() {
            if kw.len() > keyword_lower.len() && kw.starts_with(keyword_lower) {
                return true;
            }
        }
        false
    }

    fn contains(&self, keyword_lower: &str) -> bool {
        self.keywords.contains_key(keyword_lower)
    }
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

struct ExpansionContext {
    db: Arc<DbState>,
    settings: Arc<SettingsState>,
    app_handle: AppHandle,
}

static EXPANSION_CTX: Mutex<Option<ExpansionContext>> = Mutex::new(None);
static HOOK_HANDLE: Mutex<Option<isize>> = Mutex::new(None);
static MOUSE_HOOK_HANDLE: Mutex<Option<isize>> = Mutex::new(None);
static HOOK_THREAD_ID: Mutex<Option<u32>> = Mutex::new(None);
static TYPING_BUFFER: Mutex<String> = Mutex::new(String::new());
static LAST_HWND: Mutex<Option<isize>> = Mutex::new(None);
static LAST_KEY_TIME: Mutex<Option<Instant>> = Mutex::new(None);
static TRIE: std::sync::LazyLock<RwLock<KeywordTrie>> = std::sync::LazyLock::new(|| RwLock::new(KeywordTrie::new()));
static ENABLED: AtomicBool = AtomicBool::new(false);
static HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);

// For debouncing prefix-overlap matches: generation counter so older pending tasks abort
static PENDING_GEN: Mutex<u64> = Mutex::new(0);

// For argument prompts triggered by system-wide expansion.
// Only ONE prompt is shown at a time; concurrent/nested requests queue up.
// Each request resolves its own channel — no more clobbered single sender.
static ARG_PROMPT_QUEUE: Mutex<std::collections::VecDeque<ArgPromptEntry>> =
    Mutex::new(std::collections::VecDeque::new());
// Spec waiting to be fetched by the argprompt window frontend (covers the
// "first-ever prompt before the webview finished loading" race).
static ARG_PROMPT_PENDING: Mutex<Option<ArgPromptRequest>> = Mutex::new(None);
static ARG_PROMPT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
// Our own process id (foreground check) so keys typed inside Carbon windows
// never feed the expansion hook.
static OUR_PID: AtomicU32 = AtomicU32::new(0);
// The hwnd of the app where the keyword was typed (for refocusing the target
// after an argument prompt steals focus).
static LAST_MATCH_HWND: Mutex<Option<isize>> = Mutex::new(None);

struct ArgPromptEntry {
    spec: ArgPromptRequest,
    tx: std::sync::mpsc::Sender<Option<String>>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct ArgPromptRequest {
    pub id: u64,
    pub name: String,
    pub defaultValue: Option<String>,
    pub options: Option<Vec<String>>,
    pub resolvedDefault: Option<String>,
}

fn show_arg_prompt(spec: &ArgPromptRequest) {
    // One-shot spec for the frontend fetch command
    *ARG_PROMPT_PENDING.lock().unwrap() = Some(spec.clone());
    if let Some(ctx) = EXPANSION_CTX.lock().unwrap().as_ref() {
        let _ = ctx.app_handle.emit("arg-prompt-request", spec.clone());
        // Retry emit shortly after — covers a webview that is still mounting
        // its listener (deduped by id in the frontend).
        let app = ctx.app_handle.clone();
        let spec2 = spec.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let _ = app.emit("arg-prompt-request", spec2);
        });
        if let Some(win) = ctx.app_handle.get_webview_window("argprompt") {
            let (cx, cy) = get_caret_screen_position();
            let scale = win.scale_factor().unwrap_or(1.0);
            let w_log = 480;
            let h_log = 220;
            let phys_w = (w_log as f64 * scale).round() as u32;
            let phys_h = (h_log as f64 * scale).round() as u32;
            // Center the prompt on the monitor containing the caret (avoids invisible top-left rectangle)
            let (x, y) = crate::hotkey::calculate_overlay_position(cx, cy, w_log, h_log, scale);
            crate::paste::log_diag(&format!(
                "[ARGPROMPT] showing prompt id={} at ({}, {}) size {}x{}",
                spec.id, x, y, phys_w, phys_h
            ));
            let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
            let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: phys_w, height: phys_h }));
            // Show immediately from Rust so the prompt is always visible even
            // if the frontend webview hasn't yet mounted its listener — the
            // frontend also calls show() once it has rendered the spec.
            let _ = win.show();
            let _ = win.set_focus();

        }
    }
}

fn hide_arg_prompt_window() {
    if let Some(ctx) = EXPANSION_CTX.lock().unwrap().as_ref() {
        if let Some(win) = ctx.app_handle.get_webview_window("argprompt") {
            let _ = win.hide();
        }
    }
}

/// Pop the active (front) prompt; if another is queued, show it; else hide.
pub fn advance_arg_prompt_queue() {
    let next_spec = {
        let mut q = ARG_PROMPT_QUEUE.lock().unwrap();
        q.pop_front();
        q.front().map(|e| e.spec.clone())
    };
    if let Some(next) = next_spec {
        show_arg_prompt(&next);
    } else {
        hide_arg_prompt_window();
    }
}

/// Fetched by the argprompt window frontend — covers first-prompt races.
pub fn get_pending_arg_request() -> Option<ArgPromptRequest> {
    ARG_PROMPT_PENDING.lock().unwrap().clone()
}

pub fn submit_arg_prompt_response(value: Option<String>) -> Result<(), String> {
    *ARG_PROMPT_PENDING.lock().unwrap() = None;
    let next_spec = {
        let mut q = ARG_PROMPT_QUEUE.lock().unwrap();
        let Some(entry) = q.pop_front() else {
            return Err("No pending argument prompt".to_string());
        };
        let _ = entry.tx.send(value);
        q.front().map(|e| e.spec.clone())
    };
    if let Some(next) = next_spec {
        show_arg_prompt(&next);
    } else {
        hide_arg_prompt_window();
    }
    Ok(())
}

fn request_arg_value(spec: ArgPromptRequest) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let should_show = {
        let mut q = ARG_PROMPT_QUEUE.lock().unwrap();
        q.push_back(ArgPromptEntry { spec, tx });
        q.len() == 1
    };
    if should_show {
        if let Some(front) = ARG_PROMPT_QUEUE.lock().unwrap().front() {
            show_arg_prompt(&front.spec);
        }
    }
    // Block up to 60s waiting for user (off hook thread, so okay to block)
    let res = rx.recv_timeout(std::time::Duration::from_secs(60)).ok().flatten();
    *ARG_PROMPT_PENDING.lock().unwrap() = None;
    if res.is_some() {
        // Prompt answered — bring the app where the keyword was typed back to
        // the foreground so the follow-up delete/insert lands in the right place.
        let target = LAST_MATCH_HWND.lock().unwrap().clone();
        if let Some(hwnd) = target {
            crate::paste::refocus_blocking(hwnd);
        }
    } else {
        // Timed out / cancelled — pop ourselves and surface the next queued prompt
        advance_arg_prompt_queue();
        let target = LAST_MATCH_HWND.lock().unwrap().clone();
        if let Some(hwnd) = target {
            crate::paste::refocus_blocking(hwnd);
        }
    }
    res
}

// ---------------------------------------------------------------------------
// Init / shutdown / settings sync
// ---------------------------------------------------------------------------

pub fn init_expansion(app_handle: AppHandle, db: Arc<DbState>, settings: Arc<SettingsState>) {
    // Remember our own process id — keys typed inside Carbon windows are
    // never treated as expansion input.
    OUR_PID.store(std::process::id(), std::sync::atomic::Ordering::SeqCst);
    // Ensure trie starts empty but valid
    {
        let mut trie = TRIE.write().unwrap();
        if trie.nodes.is_empty() {
            *trie = KeywordTrie::new();
        }
    }
    *EXPANSION_CTX.lock().unwrap() = Some(ExpansionContext {
        db: db.clone(),
        settings: settings.clone(),
        app_handle: app_handle.clone(),
    });

    let enabled = settings.get().snippet_expansion_enabled;
    ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        // Build trie then install hook
        rebuild_trie();
        install_hook();
    } else {
        uninstall_hook();
    }
}

pub fn on_snippets_changed() {
    if ENABLED.load(Ordering::SeqCst) {
        rebuild_trie();
    }
}

pub fn set_expansion_enabled(enabled: bool) -> Result<(), String> {
    ENABLED.store(enabled, Ordering::SeqCst);
    // Persist to settings.json (without triggering full save_settings hotkey re-register)
    if let Some(ctx) = EXPANSION_CTX.lock().unwrap().as_ref() {
        let mut s = ctx.settings.get();
        if s.snippet_expansion_enabled != enabled {
            s.snippet_expansion_enabled = enabled;
            ctx.settings.update(s).map_err(|e| e.to_string())?;
            let _ = ctx.app_handle.emit("settings-updated", &ctx.settings.get());
        }
    }
    set_hook_enabled(enabled);
    Ok(())
}

/// Install/uninstall the hook to match `enabled` without touching settings.json.
/// Used when `save_settings` has already persisted the flag.
pub fn set_hook_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        rebuild_trie();
        install_hook();
    } else {
        uninstall_hook();
        *TYPING_BUFFER.lock().unwrap() = String::new();
        *LAST_HWND.lock().unwrap() = None;
        *LAST_KEY_TIME.lock().unwrap() = None;
    }
}

pub fn get_expansion_status() -> ExpansionStatus {
    if !ENABLED.load(Ordering::SeqCst) {
        return ExpansionStatus::Off;
    }
    if HOOK_INSTALLED.load(Ordering::SeqCst) {
        // Verify hook handle still valid
        let h = HOOK_HANDLE.lock().unwrap();
        if h.is_some() {
            return ExpansionStatus::Active;
        }
    }
    ExpansionStatus::NotYetActive
}

pub fn rebuild_trie() {
    let snippets = {
        let ctx_guard = EXPANSION_CTX.lock().unwrap();
        let Some(ctx) = ctx_guard.as_ref() else { return };
        ctx.db.list_snippets().unwrap_or_default()
    };
    let mut trie = TRIE.write().unwrap();
    trie.clear();
    // Ensure nodes has root
    if trie.nodes.is_empty() {
        trie.nodes.push(TrieNode {
            children: HashMap::new(),
            terminal: None,
        });
    }
    for sn in snippets {
        let kw = sn.keyword.trim();
        if kw.is_empty() {
            continue;
        }
        trie.insert(kw, sn.id.clone());
    }
    crate::paste::log_diag(&format!(
        "[EXPANSION] Rebuilt trie with {} keywords",
        trie.keywords.len()
    ));
}

// ---------------------------------------------------------------------------
// Hook install / uninstall (dedicated thread with message loop)
// ---------------------------------------------------------------------------

fn install_hook() {
    if HOOK_INSTALLED.load(Ordering::SeqCst) {
        let h = HOOK_HANDLE.lock().unwrap();
        if h.is_some() {
            return;
        }
    }
    // Spawn thread that installs hooks and pumps messages
    std::thread::spawn(|| unsafe {
        let hmodule = GetModuleHandleW(None).unwrap_or_default();
        let hinstance = windows::Win32::Foundation::HINSTANCE(hmodule.0);
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), hinstance, 0);
        // Mouse hook only feeds a non-blocking channel; all UI Automation work
        // runs on the dedicated worker below, never on this hook thread.
        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), hinstance, 0);
        if let Ok(mh) = mouse_hook {
            *MOUSE_HOOK_HANDLE.lock().unwrap() = Some(mh.0 as isize);
        }
        match hook {
            Ok(h) => {
                crate::paste::log_diag(&format!("[EXPANSION] Keyboard hook installed: {:?}", h));
                *HOOK_HANDLE.lock().unwrap() = Some(h.0 as isize);
                HOOK_INSTALLED.store(true, Ordering::SeqCst);
                // Notify UI
                if let Some(ctx) = EXPANSION_CTX.lock().unwrap().as_ref() {
                    let _ = ctx.app_handle.emit("expansion-status-changed", get_expansion_status());
                }
                // Message loop required for LL hooks
                let mut msg = MSG::default();
                let tid = windows::Win32::System::Threading::GetCurrentThreadId();
                *HOOK_THREAD_ID.lock().unwrap() = Some(tid);
                while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                // Cleanup on exit (unhook on the same thread the hooks belong to)
                let _ = UnhookWindowsHookEx(h);
                if let Some(mv) = MOUSE_HOOK_HANDLE.lock().unwrap().take() {
                    let _ = UnhookWindowsHookEx(HHOOK(mv as *mut _));
                }
                HOOK_INSTALLED.store(false, Ordering::SeqCst);
                *HOOK_HANDLE.lock().unwrap() = None;
                *HOOK_THREAD_ID.lock().unwrap() = None;
                crate::paste::log_diag("[EXPANSION] Hook thread message loop exited, hooks removed");
            }
            Err(e) => {
                crate::paste::log_diag(&format!("[EXPANSION] Failed to install keyboard hook: {:?}", e));
                if let Some(mv) = MOUSE_HOOK_HANDLE.lock().unwrap().take() {
                    let _ = UnhookWindowsHookEx(HHOOK(mv as *mut _));
                }
                HOOK_INSTALLED.store(false, Ordering::SeqCst);
                if let Some(ctx) = EXPANSION_CTX.lock().unwrap().as_ref() {
                    let _ = ctx.app_handle.emit("expansion-status-changed", get_expansion_status());
                }
            }
        }
    });
}

fn uninstall_hook() {
    let tid_opt = HOOK_THREAD_ID.lock().unwrap().take();
    if let Some(tid) = tid_opt {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        crate::paste::log_diag("[EXPANSION] Sent WM_QUIT to hook thread");
    }
    let hook_opt = HOOK_HANDLE.lock().unwrap().take();
    if let Some(h) = hook_opt {
        unsafe {
            let _ = UnhookWindowsHookEx(HHOOK(h as *mut _));
        }
    }
    let mouse_opt = MOUSE_HOOK_HANDLE.lock().unwrap().take();
    if let Some(h) = mouse_opt {
        unsafe {
            let _ = UnhookWindowsHookEx(HHOOK(h as *mut _));
        }
    }
    HOOK_INSTALLED.store(false, Ordering::SeqCst);
    if let Some(ctx) = EXPANSION_CTX.lock().unwrap().as_ref() {
        let _ = ctx.app_handle.emit("expansion-status-changed", get_expansion_status());
    }
}

// ---------------------------------------------------------------------------
// Low-level hook procs — must be extremely cheap, never block
// ---------------------------------------------------------------------------

/// Foreground-window pid check shared by the mouse hook and its worker:
/// never run UI Automation against our own windows (the WebView2 renderer),
/// which is what used to contend with Carbon's UI thread and stall clicks
/// on the Settings toggle.
fn foreground_window_is_ours() -> bool {
    let my_pid = OUR_PID.load(Ordering::Relaxed);
    if my_pid == 0 {
        return false;
    }
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid == 0 || pid != my_pid {
            let root = windows::Win32::UI::WindowsAndMessaging::GetAncestor(
                fg,
                windows::Win32::UI::WindowsAndMessaging::GA_ROOT,
            );
            if !root.0.is_null() {
                GetWindowThreadProcessId(root, Some(&mut pid));
            }
        }
        pid == my_pid
    }
}

/// Single reusable worker that captures the current text selection after a
/// mouse click — restores `{selection}` support (e.g. the seeded `/select`
/// snippet) without the resource costs that broke it before:
///  • the hook proc does only a non-blocking channel send (no COM, no threads);
///  • the worker blocks on `recv()` while idle → zero CPU outside clicks;
///  • rapid clicks are drained/coalesced into a single pass;
///  • a foreground pid re-check guarantees we never probe our own windows.
static MOUSE_SELECTION_TX: std::sync::LazyLock<Mutex<Option<std::sync::mpsc::Sender<()>>>> =
    std::sync::LazyLock::new(|| {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("carbon-selection-worker".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    // Coalesce rapid successive clicks (double-click, drag-select)
                    while rx.try_recv().is_ok() {}
                    // Let the click settle so the target app updates its selection
                    std::thread::sleep(Duration::from_millis(90));
                    if foreground_window_is_ours() {
                        continue;
                    }
                    if let Some(sel) = try_get_uia_selection() {
                        crate::paste::set_selected_text_snapshot(Some(sel));
                    }
                }
            })
            .ok();
        Mutex::new(Some(tx))
    });

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && wparam.0 as u32 == WM_LBUTTONUP {
        // Cheap checks only — no COM, no allocations, never block.
        if !foreground_window_is_ours() {
            if let Ok(guard) = MOUSE_SELECTION_TX.try_lock() {
                if let Some(tx) = guard.as_ref() {
                    let _ = tx.send(());
                }
            }
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code != HC_ACTION as i32 {
        return CallNextHookEx(HHOOK::default(), code, wparam, lparam);
    }
    let w = wparam.0 as u32;
    if w != WM_KEYDOWN && w != WM_SYSKEYDOWN {
        return CallNextHookEx(HHOOK::default(), code, wparam, lparam);
    }
    if !ENABLED.load(Ordering::Relaxed) {
        return CallNextHookEx(HHOOK::default(), code, wparam, lparam);
    }
    let kbd = *(lparam.0 as *const KBDLLHOOKSTRUCT);
    // Ignore injected events (our own SendInput)
    if (kbd.flags.0 & LLKHF_INJECTED.0) != 0 {
        return CallNextHookEx(HHOOK::default(), code, wparam, lparam);
    }
    // Quick check: if hook not installed flag, still pass through
    // Handle the key — must be non-blocking and fast
    handle_key_quick(kbd.vkCode, kbd.flags);
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

fn handle_key_quick(vk_code: u32, _flags: KBDLLHOOKSTRUCT_FLAGS) {
    // This runs in hook thread context — must be cheap and not panic.
    // We use try_lock to avoid blocking if contested.
    let now = Instant::now();

    // Check inactivity reset (15s)
    let should_reset_inactivity = {
        if let Ok(last) = LAST_KEY_TIME.try_lock() {
            if let Some(t) = *last {
                now.duration_since(t) > Duration::from_secs(15)
            } else {
                false
            }
        } else {
            false
        }
    };
    if should_reset_inactivity {
        if let Ok(mut buf) = TYPING_BUFFER.try_lock() {
            buf.clear();
        }
    }
    // Update last key time
    if let Ok(mut lt) = LAST_KEY_TIME.try_lock() {
        *lt = Some(now);
    }

    // Check window switch — foreground window
    let fg_hwnd = unsafe { GetForegroundWindow() };
    let fg_isize = fg_hwnd.0 as isize;

    // Never expand while an argument prompt is awaiting user input or while one
    // of OUR windows (prompt, pill, overlay, main…) has focus — keys typed
    // inside Carbon itself must not feed the buffer or trigger snippets.
    if ARG_PROMPT_PENDING.lock().unwrap().is_some() {
        if let Ok(mut buf) = TYPING_BUFFER.try_lock() {
            buf.clear();
        }
        return;
    }

    {
        let my_pid = OUR_PID.load(std::sync::atomic::Ordering::SeqCst);
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(fg_hwnd, Some(&mut pid));
            if pid == 0 || pid != my_pid {
                let root = windows::Win32::UI::WindowsAndMessaging::GetAncestor(
                    fg_hwnd,
                    windows::Win32::UI::WindowsAndMessaging::GA_ROOT,
                );
                if !root.0.is_null() {
                    GetWindowThreadProcessId(root, Some(&mut pid));
                }
            }
        }
        if pid != 0 && pid == my_pid {
            if let Ok(mut buf) = TYPING_BUFFER.try_lock() {
                buf.clear();
            }
            return;
        }
    }

    let window_changed = {
        if let Ok(mut last_hwnd) = LAST_HWND.try_lock() {
            let prev = *last_hwnd;
            if prev != Some(fg_isize) {
                *last_hwnd = Some(fg_isize);
                prev.is_some() // if there was a previous window, it's a switch
            } else {
                false
            }
        } else {
            false
        }
    };
    if window_changed {
        if let Ok(mut buf) = TYPING_BUFFER.try_lock() {
            buf.clear();
        }
    }

    // Navigation / modifier reset keys
    // Arrows, Tab, Home, End, PageUp, PageDown, Escape
    const RESET_VKS: [u32; 9] = [
        VK_LEFT.0 as u32,
        VK_RIGHT.0 as u32,
        VK_UP.0 as u32,
        VK_DOWN.0 as u32,
        VK_TAB.0 as u32,
        VK_HOME.0 as u32,
        VK_END.0 as u32,
        VK_PRIOR.0 as u32, // PageUp
        VK_NEXT.0 as u32,  // PageDown
    ];
    if RESET_VKS.contains(&vk_code) {
        if let Ok(mut buf) = TYPING_BUFFER.try_lock() {
            buf.clear();
        }
        return;
    }
    if vk_code == VK_ESCAPE.0 as u32 {
        if let Ok(mut buf) = TYPING_BUFFER.try_lock() {
            buf.clear();
        }
        return;
    }

    // Modifier combinations: Ctrl, Alt, Win held -> reset
    // Check GetKeyState for Ctrl / Alt / Win
    let ctrl_down = unsafe {
        (GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0
            || (GetKeyState(VK_LCONTROL.0 as i32) as u16 & 0x8000) != 0
            || (GetKeyState(VK_RCONTROL.0 as i32) as u16 & 0x8000) != 0
    };
    let alt_down = unsafe {
        (GetKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0
            || (GetKeyState(VK_LMENU.0 as i32) as u16 & 0x8000) != 0
            || (GetKeyState(VK_RMENU.0 as i32) as u16 & 0x8000) != 0
    };
    let win_down = unsafe {
        (GetKeyState(VK_LWIN.0 as i32) as u16 & 0x8000) != 0
            || (GetKeyState(VK_RWIN.0 as i32) as u16 & 0x8000) != 0
    };
    if ctrl_down || alt_down || win_down {
        if let Ok(mut buf) = TYPING_BUFFER.try_lock() {
            buf.clear();
        }
        return;
    }

    // Backspace: pop last char if any
    if vk_code == VK_BACK.0 as u32 {
        if let Ok(mut buf) = TYPING_BUFFER.try_lock() {
            buf.pop();
            // Truncate to 256 already bounded
        }
        return;
    }

    // Translate vk to char (case-insensitive, store lowercase)
    let shift_down = unsafe {
        (GetKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0
            || (GetKeyState(VK_LSHIFT.0 as i32) as u16 & 0x8000) != 0
            || (GetKeyState(VK_RSHIFT.0 as i32) as u16 & 0x8000) != 0
    };
    let caps_on = unsafe { (GetKeyState(VK_CAPITAL.0 as i32) as u16 & 0x0001) != 0 };
    // For letters, shift/caps affect case but we normalize to lower
    let ch_opt = vk_to_char(vk_code, shift_down, caps_on);
    let Some(ch) = ch_opt else {
        // Non-typing key (F1-F12, etc.) -> reset buffer as navigation
        // But don't reset for unknown if it's possibly part of keyword? Safer to ignore
        return;
    };

    // Append to buffer (lowercased for matching, but keep original case for deletion length? keyword_len is in chars, case-insensitive)
    let ch_lower = ch.to_lowercase().next().unwrap_or(ch);
    let mut matched: Option<(usize, String, String)> = None;
    {
        let mut buf = TYPING_BUFFER.lock().unwrap();
        buf.push(ch_lower);
        // Cap at 256 chars: keep most recent 256
        if buf.chars().count() > 256 {
            let trimmed: String = buf.chars().skip(buf.chars().count() - 256).collect();
            *buf = trimmed;
        }
        // Check for match (blocking read — rebuild holds write for <1ms, must not miss first keystroke)
        let trie = TRIE.read().unwrap();
        matched = trie.find_longest_suffix(&buf);
    }

    if let Some((kw_len, snippet_id, keyword)) = matched {
        crate::paste::log_diag(&format!("[EXPANSION] Matched keyword '{}' len {} -> snippet {}", keyword, kw_len, snippet_id));
        // Check if this keyword is prefix of longer keyword -> debounce
        let is_prefix = {
            let trie = TRIE.read().unwrap();
            trie.is_prefix_of_longer(&keyword.to_lowercase())
        };
        let fg_capture = fg_isize;
        // Increment generation
        let gen = {
            let mut g = PENDING_GEN.lock().unwrap();
            *g += 1;
            *g
        };
        // Dispatch async off hook
        if is_prefix {
            // Debounce 320ms to allow longer keyword to be typed
            let kw_clone = keyword.clone();
            let sid_clone = snippet_id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(320));
                // Check if generation still current and buffer still matches same keyword (and no longer match now exists)
                let current_gen = *PENDING_GEN.lock().unwrap();
                if current_gen != gen {
                    return; // newer keystroke already dispatched another match
                }
                // Re-check buffer
                let current_buf = TYPING_BUFFER.lock().unwrap().clone();
                let current_lower = current_buf.to_lowercase();
                let trie_guard = TRIE.read().unwrap();
                if let Some((cur_len, cur_id, _kw)) = trie_guard.find_longest_suffix(&current_lower) {
                    // If current longest is longer than pending, let that pending handle it (it will have its own dispatch)
                    if cur_len > kw_len {
                        return;
                    }
                    // If current no longer matches the pending keyword, abort
                    if cur_id != sid_clone {
                        return;
                    }
                    drop(trie_guard);
                    // Still matches pending — proceed
                    dispatch_expansion(sid_clone, kw_len, fg_capture);
                    // Clear buffer after dispatch (so expanded text not retrigger)
                    TYPING_BUFFER.lock().unwrap().clear();
                } else {
                    // No longer matches — abort
                }
                let _ = kw_clone; // keep
            });
        } else {
            // Immediate dispatch
            dispatch_expansion(snippet_id, kw_len, fg_capture);
            // Clear buffer (keyword consumed)
            if let Ok(mut buf) = TYPING_BUFFER.try_lock() {
                buf.clear();
            }
        }
    }
}

fn vk_to_char(vk: u32, shift: bool, _caps: bool) -> Option<char> {
    // A-Z
    if (0x41..=0x5A).contains(&vk) {
        let base = (vk - 0x41) as u8 + b'a';
        return Some(base as char);
    }
    // 0-9
    if (0x30..=0x39).contains(&vk) {
        if shift {
            let symbols = [')', '!', '@', '#', '$', '%', '^', '&', '*', '('];
            let idx = (vk - 0x30) as usize;
            return Some(symbols[idx]);
        } else {
            return Some(char::from_digit(vk - 0x30, 10).unwrap());
        }
    }
    // Numpad 0-9
    if (0x60..=0x69).contains(&vk) {
        return Some(char::from_digit(vk - 0x60, 10).unwrap());
    }
    // Space
    if vk == 0x20 {
        return Some(' ');
    }
    // OEM keys (US layout)
    match vk {
        0xBA => return Some(if shift { ':' } else { ';' }), // OEM_1
        0xBB => return Some(if shift { '+' } else { '=' }), // OEM_PLUS
        0xBC => return Some(if shift { '<' } else { ',' }), // OEM_COMMA
        0xBD => return Some(if shift { '_' } else { '-' }), // OEM_MINUS
        0xBE => return Some(if shift { '>' } else { '.' }), // OEM_PERIOD
        0xBF => return Some(if shift { '?' } else { '/' }), // OEM_2
        0xC0 => return Some(if shift { '~' } else { '`' }), // OEM_3
        0xDB => return Some(if shift { '{' } else { '[' }), // OEM_4
        0xDC => return Some(if shift { '|' } else { '\\' }), // OEM_5
        0xDD => return Some(if shift { '}' } else { ']' }), // OEM_6
        0xDE => return Some(if shift { '"' } else { '\'' }), // OEM_7
        _ => {}
    }
    None
}

fn dispatch_expansion(snippet_id: String, keyword_len: usize, hwnd_at_match: isize) {
    *LAST_MATCH_HWND.lock().unwrap() = Some(hwnd_at_match);
    // Heavy work off hook thread
    std::thread::spawn(move || {
        if let Err(e) = handle_expansion(snippet_id, keyword_len, hwnd_at_match) {
            crate::paste::log_diag(&format!("[EXPANSION] handle_expansion failed: {}", e));
        }
    });
}

fn handle_expansion(snippet_id: String, keyword_len: usize, hwnd_at_match: isize) -> Result<(), String> {
    // Re-check gates before delete
    if !ENABLED.load(Ordering::SeqCst) {
        return Ok(());
    }
    // Verify target window still same and valid
    let current_fg = unsafe { GetForegroundWindow() };
    if current_fg.0 as isize != hwnd_at_match {
        crate::paste::log_diag("[EXPANSION] Target window changed before delete — abort, leave typed text");
        return Ok(());
    }
    if unsafe { !IsWindow(current_fg).as_bool() } {
        return Ok(());
    }
    // Check password field via UIA (best approximation)
    if is_password_field(current_fg) {
        crate::paste::log_diag("[EXPANSION] Focused control appears to be password field — abort, reset buffer");
        TYPING_BUFFER.lock().unwrap().clear();
        return Ok(());
    }

    // Load snippet
    let snippet = {
        let ctx_guard = EXPANSION_CTX.lock().unwrap();
        let Some(ctx) = ctx_guard.as_ref() else {
            return Err("No expansion context".to_string());
        };
        let snips = ctx.db.list_snippets()?;
        snips.into_iter().find(|s| s.id == snippet_id)
    };
    let Some(snippet) = snippet else {
        return Err("Snippet not found".to_string());
    };

    // Resolve placeholder content (heavy) — off the hook thread
    let (final_text, cursor_offset) = match expand_with_cursor(&snippet) {
        Ok(v) => v,
        Err(e) if e == "argument_cancelled" => {
            crate::paste::log_diag("[EXPANSION] Argument prompt cancelled — abort, leave typed text");
            // Prompt was resolved/advanced already; nothing to clean up here.
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    let pre_text = if let Some(off) = cursor_offset {
        final_text[..off].to_string()
    } else {
        final_text.clone()
    };
    let post_text = cursor_offset.map(|off| final_text[off..].to_string());

    // Gate re-check before delete
    if !ENABLED.load(Ordering::SeqCst) {
        return Ok(());
    }
    let current_fg2 = unsafe { GetForegroundWindow() };
    if current_fg2.0 as isize != hwnd_at_match {
        crate::paste::log_diag("[EXPANSION] Window changed before delete (second check) — abort");
        return Ok(());
    }
    if is_password_field(current_fg2) {
        return Ok(());
    }

    // Try UIA atomic replacement first (with keyword for suffix verification, and a short delay inside)
    let use_uia = try_uia_replace(current_fg2, &snippet.keyword, keyword_len, &pre_text, post_text.as_deref());
    if use_uia {
        crate::paste::log_diag("[EXPANSION] UIA replacement succeeded");
        post_expansion_success(&snippet, &final_text);
        return Ok(());
    }

    // Fallback: synthetic input
    // Delete keyword
    // Re-check before delete (already did), now delete
    // If delete check fails, we already returned; so delete
    crate::paste::log_diag(&format!("[EXPANSION] Deleting {} chars of keyword", keyword_len));
    send_backspaces(keyword_len);

    // Gate re-check before insert
    if !ENABLED.load(Ordering::SeqCst) {
        // We already deleted — restore keyword to avoid half-deleted mess
        crate::paste::log_diag("[EXPANSION] Disabled before insert — restoring keyword");
        send_text_via_keystrokes(&snippet.keyword);
        return Ok(());
    }
    let current_fg3 = unsafe { GetForegroundWindow() };
    if current_fg3.0 as isize != hwnd_at_match {
        crate::paste::log_diag("[EXPANSION] Window changed before insert — restoring keyword");
        send_text_via_keystrokes(&snippet.keyword);
        return Ok(());
    }
    if is_password_field(current_fg3) {
        send_text_via_keystrokes(&snippet.keyword);
        return Ok(());
    }

    // Choose delivery method based on length and clipboard state
    let is_short_single_line = final_text.chars().count() <= 100 && !final_text.contains('\n') && !final_text.contains('\r');
    if is_short_single_line {
        crate::paste::log_diag("[EXPANSION] Using keystroke path (short single-line)");
        send_text_via_keystrokes(&pre_text);
        if let Some(post) = post_text {
            send_text_via_keystrokes(&post);
            // Move caret back over post
            let n = post.chars().count();
            if n > 0 {
                send_left_arrows(n);
            }
        }
    } else {
        // Longer/multiline: try clipboard paste if restorable
        crate::paste::log_diag("[EXPANSION] Trying clipboard paste fallback");
        let clipboard_ok = try_clipboard_paste(&pre_text, post_text.as_deref(), keyword_len);
        if !clipboard_ok {
            crate::paste::log_diag("[EXPANSION] Clipboard not restorable (image/empty/unreadable) — fallback to keystrokes");
            send_text_via_keystrokes(&pre_text);
            if let Some(post) = post_text {
                send_text_via_keystrokes(&post);
                let n = post.chars().count();
                if n > 0 {
                    send_left_arrows(n);
                }
            }
        }
    }

    post_expansion_success(&snippet, &final_text);
    Ok(())
}

fn post_expansion_success(snippet: &Snippet, expanded_text: &str) {
    // Record use
    if let Some(ctx) = EXPANSION_CTX.lock().unwrap().as_ref() {
        let _ = ctx.db.record_snippet_use(&snippet.id);
        if snippet.show_confirmation {
            let _ = ctx.app_handle.emit("snippet-expanded", snippet.name.clone());
            let _ = ctx.app_handle.emit("expansion-pill-show", snippet.name.clone());
            // Show transient pill centered on the monitor (always-on-top, auto-hides in JS)
            // Neat, centered toast — never cluttering the caret or the main app.
            if let Some(pill) = ctx.app_handle.get_webview_window("pill") {
                let scale = pill.scale_factor().unwrap_or(1.0);
                let w_log = 380;
                let h_log = 56;
                let phys_w = (w_log as f64 * scale).round() as i32;
                let phys_h = (h_log as f64 * scale).round() as i32;
                // Center on the monitor that contains the caret
                let (cx, cy) = get_caret_screen_position();
                let (mut x, mut y) = (0, 0);
                unsafe {
                    let pt = POINT { x: cx, y: cy };
                    let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
                    let mut info = MONITORINFO {
                        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    if GetMonitorInfoW(hmon, &mut info).as_bool() {
                        let work = info.rcWork;
                        let work_w = work.right - work.left;
                        let work_h = work.bottom - work.top;
                        x = work.left + (work_w - phys_w) / 2;
                        y = work.top + (work_h - phys_h) / 2;
                    } else {
                        x = cx - phys_w / 2;
                        y = cy - phys_h / 2;
                    }
                }
                let _ = pill.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                    x,
                    y,
                }));
                let _ = pill.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                    width: phys_w as u32,
                    height: phys_h as u32,
                }));
                // Visibility is asserted by the frontend once text is rendered
            }
        }
        let _ = ctx.app_handle.emit("snippets-updated", ());
    }
    crate::paste::log_diag(&format!(
        "[EXPANSION] Expanded '{}' -> {} chars",
        snippet.keyword,
        expanded_text.chars().count()
    ));
}

// ---------------------------------------------------------------------------
// Placeholder resolution (Rust port of snippets.ts logic, minimal for Phase B)
// ---------------------------------------------------------------------------

fn resolve_snippet_content(snippet: &Snippet) -> Result<String, String> {
    // For now, simple pass-through with cursor handling via expand_with_cursor
    // This wrapper exists for future full placeholder support.
    let (text, _off) = expand_with_cursor(snippet)?;
    Ok(text)
}

fn expand_with_cursor(snippet: &Snippet) -> Result<(String, Option<usize>), String> {
    // Load recent clips and selection for placeholder context
    let (recent_texts, selection) = {
        let ctx_guard = EXPANSION_CTX.lock().unwrap();
        let Some(ctx) = ctx_guard.as_ref() else {
            return Ok((snippet.content.clone(), None));
        };
        let recents = ctx.db.get_recent_clip_texts(20).unwrap_or_default();
        let sel = try_get_uia_selection().or_else(|| crate::paste::get_selected_text_snapshot());
        (recents, sel)
    };

    let content = snippet.content.clone();
    let mut arg_values: HashMap<String, String> = HashMap::new();
    expand_content_with_placeholders(&content, &recent_texts, selection.as_deref(), 0, &mut HashSet::new(), &mut arg_values)
}

fn expand_content_with_placeholders(
    content: &str,
    recent_texts: &[String],
    selection: Option<&str>,
    depth: usize,
    visited: &mut HashSet<String>,
    arg_values: &mut HashMap<String, String>,
) -> Result<(String, Option<usize>), String> {
    if depth > 5 {
        return Ok((content.to_string(), None));
    }
    let mut out = String::new();
    let mut cursor_offset: Option<usize> = None;
    let mut i = 0;
    let chars: Vec<char> = content.chars().collect();
    while i < chars.len() {
        if chars[i] == '{' {
            // Find closing }
            let mut end = None;
            let mut in_quote = false;
            for j in i + 1..chars.len() {
                let c = chars[j];
                if in_quote {
                    if c == '"' {
                        in_quote = false;
                    }
                } else if c == '"' {
                    in_quote = true;
                } else if c == '}' {
                    end = Some(j);
                    break;
                }
            }
            if let Some(e) = end {
                let raw: String = chars[i..=e].iter().collect();
                let inner = raw[1..raw.len() - 1].trim().to_string();
                // Check for cursor
                if inner.eq_ignore_ascii_case("cursor") {
                    if cursor_offset.is_none() {
                        cursor_offset = Some(out.chars().count());
                    }
                    i = e + 1;
                    continue;
                }
                // Check for snippet:Name
                if inner.to_lowercase().starts_with("snippet:") {
                    let name = inner["snippet:".len()..].trim().to_string();
                    if name.is_empty() {
                        out.push_str(&raw);
                    } else {
                        let key = name.to_lowercase();
                        if visited.contains(&key) {
                            out.push_str(&raw);
                        } else {
                            // Find snippet by name
                            let target = {
                                let ctx_guard = EXPANSION_CTX.lock().unwrap();
                                if let Some(ctx) = ctx_guard.as_ref() {
                                    let snips = ctx.db.list_snippets().unwrap_or_default();
                                    snips.into_iter().find(|s| s.name.to_lowercase() == key)
                                } else {
                                    None
                                }
                            };
                            if let Some(ts) = target {
                                visited.insert(key.clone());
                                let (sub_text, sub_cursor) = expand_content_with_placeholders(
                                    &ts.content,
                                    recent_texts,
                                    selection,
                                    depth + 1,
                                    visited,
                                    arg_values,
                                )?;
                                visited.remove(&key);
                                if let Some(sc) = sub_cursor {
                                    if cursor_offset.is_none() {
                                        cursor_offset = Some(out.chars().count() + sc);
                                    }
                                }
                                out.push_str(&sub_text);
                            } else {
                                out.push_str(&raw);
                            }
                        }
                    }
                    i = e + 1;
                    continue;
                }
                // Try known placeholders
                let lower_inner = inner.to_lowercase();
                // Split on '|' for modifiers
                let parts: Vec<&str> = inner.split('|').collect();
                let head = parts[0].trim();
                let modifiers: Vec<String> = parts[1..].iter().map(|s| s.trim().to_lowercase()).collect();
                let valid_mods = ["uppercase", "lowercase", "trim", "percent-encode", "json-stringify", "raw"];
                let mods_valid = modifiers.iter().all(|m| valid_mods.contains(&m.as_str()));
                if !mods_valid {
                    out.push_str(&raw);
                    i = e + 1;
                    continue;
                }
                let head_lower = head.to_lowercase();
                let keyword = head_lower.split_whitespace().next().unwrap_or("").to_string();
                let known = [
                    "clipboard",
                    "selection",
                    "selectedtext",
                    "date",
                    "time",
                    "datetime",
                    "day",
                    "uuid",
                    "argument",
                ];
                if !known.contains(&keyword.as_str()) {
                    out.push_str(&raw);
                    i = e + 1;
                    continue;
                }
                // Parse args for known keywords
                let mut value = String::new();
                let mut failed = false;
                match keyword.as_str() {
                    "clipboard" => {
                        // Parse offset= N
                        let offset = parse_arg_int(head, "offset").unwrap_or(0);
                        if offset < 0 {
                            failed = true;
                        } else {
                            value = recent_texts.get(offset as usize).cloned().unwrap_or_default();
                        }
                    }
                    "selection" | "selectedtext" => {
                        let sel = selection.unwrap_or("");
                        if !sel.trim().is_empty() {
                            value = sel.to_string();
                        } else {
                            value = recent_texts.first().cloned().unwrap_or_default();
                        }
                    }
                    "date" => {
                        let fmt = parse_arg_string(head, "format");
                        let locale = parse_arg_string(head, "locale");
                        if fmt.is_some() && locale.is_some() {
                            failed = true;
                        } else if let Some(f) = fmt {
                            value = format_date_custom(&f);
                        } else {
                            value = chrono::Local::now().format("%x").to_string();
                        }
                    }
                    "time" => {
                        let fmt = parse_arg_string(head, "format");
                        let locale = parse_arg_string(head, "locale");
                        let offset = parse_arg_string(head, "offset");
                        if fmt.is_some() && locale.is_some() {
                            failed = true;
                        } else {
                            let mut dt = chrono::Local::now();
                            if let Some(off) = offset {
                                if let Some(shifted) = apply_offset(dt, &off) {
                                    dt = shifted;
                                } else if !off.trim().is_empty() {
                                    failed = true;
                                }
                            }
                            if failed {
                            } else if let Some(f) = fmt {
                                value = format_date_custom(&f);
                            } else if let Some(loc) = locale {
                                let _ = loc;
                                value = dt.format("%X").to_string();
                            } else {
                                value = dt.format("%X").to_string();
                            }
                        }
                    }
                    "datetime" => {
                        let locale = parse_arg_string(head, "locale");
                        let _ = locale;
                        value = chrono::Local::now()
                            .format("%x %X")
                            .to_string();
                    }
                    "day" => {
                        let locale = parse_arg_string(head, "locale");
                        let _ = locale;
                        value = chrono::Local::now().format("%A").to_string();
                    }
                    "uuid" => {
                        value = generate_uuid();
                    }
                    "argument" => {
                        let arg_name = parse_arg_string(head, "name").unwrap_or_else(|| "Argument".to_string());
                        // Deduplicate same-named arguments (including nested)
                        if let Some(cached) = arg_values.get(&arg_name) {
                            value = cached.clone();
                        } else {
                            let default = parse_arg_string(head, "default");
                            let options_str = parse_arg_string(head, "options");
                            let options = options_str.map(|s| {
                                s.split(',').map(|o| o.trim().to_string()).filter(|o| !o.is_empty()).collect::<Vec<_>>()
                            });
                            let spec = ArgPromptRequest {
                                id: ARG_PROMPT_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
                                name: arg_name.clone(),
                                defaultValue: default.clone(),
                                options: options.clone(),
                                resolvedDefault: default.clone(),
                            };
                            match request_arg_value(spec) {
                                Some(v) => {
                                    arg_values.insert(arg_name.clone(), v.clone());
                                    value = v;
                                }
                                None => {
                                    // User cancelled the prompt — abort entire expansion
                                    return Err("argument_cancelled".to_string());
                                }
                            }
                        }
                    }
                    _ => failed = true,
                }
                if failed {
                    out.push_str(&raw);
                } else {
                    // Apply modifiers
                    for m in modifiers {
                        match m.as_str() {
                            "uppercase" => value = value.to_uppercase(),
                            "lowercase" => value = value.to_lowercase(),
                            "trim" => value = value.trim().to_string(),
                            "percent-encode" => value = urlencoding_simple(&value),
                            "json-stringify" => value = serde_json::to_string(&value).unwrap_or(value),
                            "raw" => {}
                            _ => {}
                        }
                    }
                    out.push_str(&value);
                }
                i = e + 1;
                continue;
            } else {
                out.push(chars[i]);
                i += 1;
                continue;
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    Ok((out, cursor_offset))
}

fn parse_arg_string(head: &str, key: &str) -> Option<String> {
    // Find key="value" or key=value
    let lower = head.to_lowercase();
    let needle = format!("{}=", key.to_lowercase());
    let pos = lower.find(&needle)?;
    let after = &head[pos + needle.len()..];
    let after = after.trim_start();
    if after.starts_with('"') {
        let end = after[1..].find('"')?;
        Some(after[1..1 + end].to_string())
    } else {
        let end = after.find(char::is_whitespace).unwrap_or(after.len());
        let val = &after[..end];
        if val.is_empty() {
            None
        } else {
            Some(val.to_string())
        }
    }
}

fn parse_arg_int(head: &str, key: &str) -> Option<i64> {
    parse_arg_string(head, key)?.parse().ok()
}

fn format_date_custom(fmt: &str) -> String {
    // Single-pass to avoid re-mangling (e.g. MMM->"Aug" must not have "A" -> "PM")
    single_pass_format(fmt, chrono::Local::now())
}

fn single_pass_format(fmt: &str, dt: chrono::DateTime<chrono::Local>) -> String {
    let months_full = [
        "January", "February", "March", "April", "May", "June", "July", "August", "September",
        "October", "November", "December",
    ];
    let months_short = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let weekdays_full = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let weekdays_short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let year = dt.format("%Y").to_string();
    let yy = dt.format("%y").to_string();
    let month_idx = dt.format("%m").to_string().parse::<usize>().unwrap_or(1) - 1;
    let day: u32 = dt.format("%d").to_string().parse().unwrap_or(1);
    let hours24: u32 = dt.format("%H").to_string().parse().unwrap_or(0);
    let hours12 = if hours24 % 12 == 0 { 12 } else { hours24 % 12 };
    let mins: u32 = dt.format("%M").to_string().parse().unwrap_or(0);
    let secs: u32 = dt.format("%S").to_string().parse().unwrap_or(0);
    let ampm = if hours24 < 12 { "am" } else { "pm" };
    let mut map = std::collections::HashMap::new();
    map.insert("yyyy", year.clone());
    map.insert("yy", yy);
    map.insert("MMMM", months_full[month_idx].to_string());
    map.insert("MMM", months_short[month_idx].to_string());
    map.insert("MM", format!("{:02}", month_idx + 1));
    map.insert("M", format!("{}", month_idx + 1));
    map.insert("EEEE", weekdays_full[dt.weekday().num_days_from_sunday() as usize].to_string());
    map.insert("EEE", weekdays_short[dt.weekday().num_days_from_sunday() as usize].to_string());
    map.insert("dd", format!("{:02}", day));
    map.insert("d", format!("{}", day));
    map.insert("HH", format!("{:02}", hours24));
    map.insert("H", format!("{}", hours24));
    map.insert("hh", format!("{:02}", hours12));
    map.insert("h", format!("{}", hours12));
    map.insert("mm", format!("{:02}", mins));
    map.insert("m", format!("{}", mins));
    map.insert("ss", format!("{:02}", secs));
    map.insert("s", format!("{}", secs));
    map.insert("A", ampm.to_uppercase());
    map.insert("a", ampm.to_string());

    // Single-pass scanning longest token first
    let tokens = ["yyyy", "yy", "MMMM", "MMM", "MM", "M", "EEEE", "EEE", "dd", "d", "HH", "H", "hh", "h", "mm", "m", "ss", "s", "A", "a"];
    let mut out = String::new();
    let mut i = 0;
    let chars: Vec<char> = fmt.chars().collect();
    while i < chars.len() {
        let mut matched = false;
        for tok in tokens {
            if fmt[i..].starts_with(tok) {
                out.push_str(map.get(tok).unwrap());
                i += tok.len();
                matched = true;
                break;
            }
        }
        if !matched {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn apply_offset(dt: chrono::DateTime<chrono::Local>, offset_str: &str) -> Option<chrono::DateTime<chrono::Local>> {
    let re = regex::Regex::new(r"([+-]?\d+)([mdhMy])").ok()?;
    let mut out = dt;
    let mut matched = false;
    for cap in re.captures_iter(offset_str) {
        matched = true;
        let amount: i64 = cap[1].parse().ok()?;
        match &cap[2] {
            "m" => out = out + chrono::Duration::minutes(amount),
            "h" => out = out + chrono::Duration::hours(amount),
            "d" => out = out + chrono::Duration::days(amount),
            "M" => out = out + chrono::Duration::days(amount * 30), // approx
            "y" => out = out + chrono::Duration::days(amount * 365),
            _ => return None,
        }
    }
    if !matched && !offset_str.trim().is_empty() {
        return None;
    }
    Some(out)
}

fn generate_uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let rand_val: u64 = {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEED: AtomicU64 = AtomicU64::new(0x9E3779B97F4A7C15);
        let mut v = SEED.fetch_add(0x9E3779B97F4A7C15, Ordering::Relaxed);
        v = v.wrapping_mul(0xBF58476D1CE4E5B9);
        v ^ (v >> 31)
    };
    let nanos = nanos as u64;
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (nanos >> 32) as u32,
        (nanos >> 16) as u16 & 0xFFFF,
        (rand_val & 0xFFF) as u16,
        ((rand_val >> 12) & 0x3FFF | 0x8000) as u16,
        rand_val & 0xFFFFFFFFFFFF
    )
}

fn urlencoding_simple(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

pub fn try_get_uia_selection() -> Option<String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: Result<IUIAutomation, _> =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER);
        if let Ok(automation) = automation {
            if let Ok(element) = automation.GetFocusedElement() {
                let pattern: Result<windows::Win32::UI::Accessibility::IUIAutomationTextPattern, _> =
                    element.GetCurrentPatternAs(windows::Win32::UI::Accessibility::UIA_TextPatternId);
                if let Ok(tp) = pattern {
                    if let Ok(selection_array) = tp.GetSelection() {
                        if let Ok(len) = selection_array.Length() {
                            if len > 0 {
                                if let Ok(range) = selection_array.GetElement(0) {
                                    if let Ok(bstr) = range.GetText(-1) {
                                        let s = bstr.to_string();
                                        if !s.trim().is_empty() {
                                            return Some(s);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Win32 EM_GETSEL fallback for standard Edit / RichEdit controls
        let fg = GetForegroundWindow();
        if !fg.0.is_null() {
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            let mut pid = 0u32;
            let tid = GetWindowThreadProcessId(fg, Some(&mut pid));
            if GetGUIThreadInfo(tid, &mut info).is_ok() && !info.hwndFocus.0.is_null() {
                let mut start = 0u32;
                let mut end = 0u32;
                SendMessageW(
                    info.hwndFocus,
                    0x00B0, // EM_GETSEL
                    WPARAM(&mut start as *mut _ as usize),
                    LPARAM(&mut end as *mut _ as isize),
                );
                if end > start && (end - start) < 100_000 {
                    let len = GetWindowTextLengthW(info.hwndFocus);
                    if len > 0 {
                        let mut buf = vec![0u16; (len + 1) as usize];
                        let read = GetWindowTextW(info.hwndFocus, &mut buf);
                        if read > 0 {
                            let text = String::from_utf16_lossy(&buf[..read as usize]);
                            let chars: Vec<char> = text.chars().collect();
                            if (end as usize) <= chars.len() {
                                let sel_slice: String = chars[start as usize..end as usize].iter().collect();
                                if !sel_slice.trim().is_empty() {
                                    return Some(sel_slice);
                                }
                            }
                        }
                    }
                }
            }
        }

        None
    }
}

fn is_password_field(hwnd: HWND) -> bool {
    // Best approximation via UI Automation where feasible
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: Result<IUIAutomation, _> =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER);
        let Ok(automation) = automation else {
            return false;
        };
        // Try GetFocusedElement (covers focused control inside hwnd)
        let Ok(element) = automation.GetFocusedElement() else {
            return false;
        };
        if let Ok(is_pwd) = element.CurrentIsPassword() {
            if is_pwd.as_bool() {
                return true;
            }
        }
        false
    }
}

fn get_caret_screen_position() -> (i32, i32) {
    unsafe {
        let fg = GetForegroundWindow();
        if !fg.0.is_null() {
            let mut pid = 0u32;
            let tid = GetWindowThreadProcessId(fg, Some(&mut pid));
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            if GetGUIThreadInfo(tid, &mut info).is_ok()
                && !info.hwndCaret.0.is_null()
                && info.flags.contains(GUI_CARETBLINKING)
            {
                if info.rcCaret.left > 0 || info.rcCaret.top > 0 || info.rcCaret.right > 0 {
                    let mut pt = POINT {
                        x: info.rcCaret.left,
                        y: info.rcCaret.bottom,
                    };
                    if ClientToScreen(info.hwndCaret, &mut pt).as_bool()
                        && pt.x > 0 && pt.y > 0 {
                        return (pt.x, pt.y);
                    }
                }
            }

            // Fallback: GetCaretPos (only accept non-zero client coordinates)
            let mut pt = POINT { x: 0, y: 0 };
            if GetCaretPos(&mut pt).is_ok() && (pt.x > 0 || pt.y > 0) {
                let mut screen_pt = pt;
                if ClientToScreen(fg, &mut screen_pt).as_bool()
                    && screen_pt.x > 0 && screen_pt.y > 0 {
                    return (screen_pt.x, screen_pt.y);
                }
            }

            // Fallback: mouse cursor if within the foreground window bounds
            let mut cur = POINT { x: 0, y: 0 };
            if GetCursorPos(&mut cur).is_ok() {
                let mut rc = windows::Win32::Foundation::RECT::default();
                if GetWindowRect(fg, &mut rc).is_ok() {
                    if cur.x >= rc.left && cur.x <= rc.right && cur.y >= rc.top && cur.y <= rc.bottom {
                        return (cur.x, cur.y);
                    }
                }
            }

            // Fallback: Center of the foreground window
            let mut rc = windows::Win32::Foundation::RECT::default();
            if GetWindowRect(fg, &mut rc).is_ok() {
                let w = rc.right - rc.left;
                let h = rc.bottom - rc.top;
                if w > 100 && h > 100 {
                    let cx = rc.left + w / 2;
                    let cy = rc.bottom - (h / 4).max(60);
                    return (cx, cy);
                }
            }
        }
        (500, 400)
    }
}

fn try_uia_replace(hwnd: HWND, keyword: &str, keyword_len: usize, pre: &str, post: Option<&str>) -> bool {
    // Small delay to let the target app process the final WM_CHAR for the keyword
    std::thread::sleep(std::time::Duration::from_millis(35));
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: Result<IUIAutomation, _> =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER);
        let Ok(automation) = automation else {
            return false;
        };
        // Use ElementFromHandle for the target window's focused element?
        // GetFocusedElement is more reliable for the actually focused control
        let element: Result<IUIAutomationElement, _> = automation.GetFocusedElement();
        let Ok(element) = element else {
            return false;
        };
        if let Ok(is_pwd) = element.CurrentIsPassword() {
            if is_pwd.as_bool() {
                return false;
            }
        }
        // Try ValuePattern
        let pattern: Result<IUIAutomationValuePattern, _> =
            element.GetCurrentPatternAs(UIA_ValuePatternId);
        let Ok(pattern) = pattern else {
            return false;
        };
        if let Ok(readonly) = pattern.CurrentIsReadOnly() {
            if readonly.as_bool() {
                return false;
            }
        }
        let Ok(current_val) = pattern.CurrentValue() else {
            return false;
        };
        let current_str = current_val.to_string();
        // Verify the control's value actually ends with the typed keyword (case-insensitive)
        // — the hook's buffer already did, but the UIA value may be stale or IME-composed.
        let kw_lower = keyword.to_lowercase();
        let cur_lower = current_str.to_lowercase();
        if !cur_lower.ends_with(&kw_lower) {
            // Control doesn't yet reflect the last keystroke (common on first entry) — signal fallback
            // so the synthetic path (which correctly deletes keyword_len chars) is used instead.
            crate::paste::log_diag(&format!(
                "[EXPANSION] UIA value does not end with keyword '{}' (value tail: '{}') — falling back",
                keyword,
                &current_str[current_str.len().saturating_sub(keyword_len + 5)..]
            ));
            return false;
        }
        let expanded_full = match post {
            Some(p) => format!("{}{}", pre, p),
            None => pre.to_string(),
        };
        // Build new value: remove keyword suffix, append expanded
        let current_chars: Vec<char> = current_str.chars().collect();
        let new_prefix: String = current_chars[..current_chars.len() - keyword_len]
            .iter()
            .collect();
        let new_value = format!("{}{}", new_prefix, expanded_full);
        if pattern.SetValue(&windows::core::BSTR::from(new_value.clone())).is_ok() {
            // Handle cursor placement if needed
            if let Some(p) = post {
                let n = p.chars().count();
                if n > 0 {
                    // Try to place caret via TextPattern or fallback to keystrokes
                    // Fallback: send left arrows
                    std::thread::sleep(Duration::from_millis(30));
                    send_left_arrows(n);
                }
            }
            return true;
        }
        false
    }
}

// ---------------------------------------------------------------------------
// Synthetic input helpers
// ---------------------------------------------------------------------------

fn send_backspaces(count: usize) {
    if count == 0 {
        return;
    }
    unsafe {
        let scan_back = MapVirtualKeyW(0x08, MAPVK_VK_TO_VSC) as u16;
        let mut inputs: Vec<INPUT> = Vec::with_capacity(count * 2);
        for _ in 0..count {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_BACK,
                        wScan: scan_back,
                        dwFlags: Default::default(),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_BACK,
                        wScan: scan_back,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn send_text_via_keystrokes(text: &str) {
    if text.is_empty() {
        return;
    }
    unsafe {
        // Use UTF-16 code units with KEYEVENTF_UNICODE
        let utf16: Vec<u16> = text.encode_utf16().collect();
        // Batch in chunks to avoid huge SendInput
        const CHUNK: usize = 64;
        for chunk in utf16.chunks(CHUNK) {
            let mut inputs: Vec<INPUT> = Vec::with_capacity(chunk.len() * 2);
            for &code in chunk {
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_PACKET,
                            wScan: code,
                            dwFlags: KEYEVENTF_UNICODE,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                });
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_PACKET,
                            wScan: code,
                            dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                });
            }
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

fn send_left_arrows(count: usize) {
    if count == 0 {
        return;
    }
    unsafe {
        let scan_left = MapVirtualKeyW(VK_LEFT.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let mut inputs: Vec<INPUT> = Vec::with_capacity(count * 2);
        for _ in 0..count {
            inputs.push(INPUT {
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
            inputs.push(INPUT {
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
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

fn try_clipboard_paste(pre: &str, post: Option<&str>, keyword_len: usize) -> bool {
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
        OpenClipboard,
    };
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    let full_text = match post {
        Some(p) => format!("{}{}", pre, p),
        None => pre.to_string(),
    };

    unsafe {
        // Check current clipboard: is it restorable plain text?
        let mut restorable_text: Option<String> = None;
        let mut seq_before: u32 = 0;
        let mut can_restore = false;

        // Try to read clipboard
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(HWND::default()).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if opened {
            seq_before = GetClipboardSequenceNumber();
            // Check for image formats — if present, not restorable
            const CF_DIB: u32 = 8;
            const CF_BITMAP: u32 = 2;
            let has_image = IsClipboardFormatAvailable(CF_DIB).is_ok()
                || IsClipboardFormatAvailable(CF_BITMAP).is_ok()
                || IsClipboardFormatAvailable(17).is_ok(); // CF_DIBV5
            if has_image {
                can_restore = false;
            } else if IsClipboardFormatAvailable(13).is_ok() {
                // CF_UNICODETEXT available
                if let Ok(handle) = GetClipboardData(13) {
                    let hglobal = windows::Win32::Foundation::HGLOBAL(handle.0 as *mut _);
                    let ptr = GlobalLock(hglobal);
                    if !ptr.is_null() {
                        let len = (0..).take_while(|&i| *(ptr as *const u16).add(i) != 0).count();
                        let slice = std::slice::from_raw_parts(ptr as *const u16, len);
                        restorable_text = Some(String::from_utf16_lossy(slice));
                        can_restore = true;
                        let _ = GlobalUnlock(hglobal);
                    }
                }
            } else {
                // Empty or unknown format -> treat as not restorable to avoid overwriting
                // Spec says: if empty or unreadable, skip to keystroke path
                can_restore = false;
            }
            let _ = CloseClipboard();
        } else {
            can_restore = false;
        }

        if !can_restore {
            return false;
        }

        // Write snippet text to clipboard
        let item = crate::paste::build_text_clip_item(&full_text);
        if crate::paste::write_item_to_clipboard(&item, true).is_err() {
            return false;
        }
        crate::clipboard_watcher::mark_paste(&item);
        std::thread::sleep(Duration::from_millis(20));

        // Inject Ctrl+V (uses existing helper but we inline to avoid PASTE_IN_FLIGHT)
        // We need to ensure we don't trigger paste queue hook — but that's low-level hook for Ctrl+V queue, not expansion
        // Use direct SendInput for Ctrl+V similar to paste.rs
        crate::paste::log_diag("[EXPANSION] Injecting Ctrl+V for clipboard paste");
        // Use paste.rs inject function via a helper — we replicate
        {
            let scan_ctrl = MapVirtualKeyW(VK_CONTROL.0 as u32, MAPVK_VK_TO_VSC) as u16;
            let scan_v = MapVirtualKeyW(0x56, MAPVK_VK_TO_VSC) as u16; // V
            let scan_shift = MapVirtualKeyW(VK_SHIFT.0 as u32, MAPVK_VK_TO_VSC) as u16;
            let scan_alt = MapVirtualKeyW(VK_MENU.0 as u32, MAPVK_VK_TO_VSC) as u16;
            let release_mods = [
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
            SendInput(&release_mods, std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(Duration::from_millis(15));
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
            std::thread::sleep(Duration::from_millis(15));
            let v_down = [INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VK_V,
                        wScan: scan_v,
                        dwFlags: Default::default(),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            }];
            SendInput(&v_down, std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(Duration::from_millis(25));
            let v_up = [INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VK_V,
                        wScan: scan_v,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            }];
            SendInput(&v_up, std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(Duration::from_millis(15));
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
            std::thread::sleep(Duration::from_millis(40));
        }

        // Handle cursor post part if needed — already full_text contains both, need to move caret
        if let Some(p) = post {
            let n = p.chars().count();
            if n > 0 {
                std::thread::sleep(Duration::from_millis(30));
                send_left_arrows(n);
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        // Restore original clipboard if safe (check sequence number)
        let seq_after = GetClipboardSequenceNumber();
        // seq_before was before our write; after our write seq should be seq_before+1
        // If seq_after == seq_before+1, no external copy happened, safe to restore
        // If larger, someone copied during our operation — don't overwrite
        if seq_after == seq_before.wrapping_add(1) {
            if let Some(orig) = restorable_text {
                let restore_item = crate::paste::build_text_clip_item(&orig);
                if crate::paste::write_item_to_clipboard(&restore_item, true).is_ok() {
                    crate::clipboard_watcher::mark_paste(&restore_item);
                    crate::paste::log_diag("[EXPANSION] Restored original clipboard after paste");
                }
            }
        } else {
            crate::paste::log_diag("[EXPANSION] Clipboard changed mid-operation (seq mismatch) — not restoring");
        }

        true
    }
}

// Ensure CoUninitialize on thread exit? Not needed heavily.

