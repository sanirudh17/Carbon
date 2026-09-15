use crate::paste::{get_cursor_position, restore_target_window, save_target_window};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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
    UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

static CURRENT_CYCLE_INDEX: AtomicU32 = AtomicU32::new(0);
static APP_HANDLE_HOLDER: Mutex<Option<AppHandle>> = Mutex::new(None);
static RECORDING_TARGET: Mutex<Option<String>> = Mutex::new(None);
/// Generation of webview-routed overlay hide requests (bumped per request and
/// on every show) + the last generation the overlay webview acknowledged.
/// The 250ms fallback only fires when the webview never acknowledged AND no
/// newer request/show happened — so hotkey spam and quick re-shows never
/// race the fallback, while a crashed renderer still gets a native hide.
static OVERLAY_HIDE_GEN: AtomicU64 = AtomicU64::new(0);
static OVERLAY_HIDE_ACK: AtomicU64 = AtomicU64::new(0);

/// DWM cloak gate (white-flash fix). A cloaked window keeps WS_VISIBLE (so
/// toggle logic, is_visible() checks and focus keep working) but DWM
/// composites nothing for it — no white redirection/controller frame can
/// reach the screen. Every show path cloaks FIRST, positions/shows/focuses
/// while invisible, and uncloaks only after the renderer confirms paint
/// (overlay_painted / enlarged_painted), with a timeout fallback so a dead
/// renderer can never leave a window stuck invisible.
///
/// This replaces the old alpha-zero gate (WS_EX_LAYERED + LWA_ALPHA): toggling
/// the layered flag rebuilds the acrylic composition surface, and that
/// rebuild was itself a white frame in glass mode — the flash on every open.
#[cfg(target_os = "windows")]
pub fn set_window_cloaked(window: &tauri::WebviewWindow, cloaked: bool) {
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let native = HWND(hwnd.0 as *mut _);
            let v: i32 = if cloaked { 1 } else { 0 };
            let _ = DwmSetWindowAttribute(
                native,
                DWMWA_CLOAK,
                &v as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
    // Single choke point for the logical-visibility flags: every cloak and
    // every painted-ack/fallback uncloak flows through here, so
    // is_overlay_visible() and is_main_visible() can never go stale.
    if window.label() == "overlay" {
        OVERLAY_CLOAKED.store(cloaked, Ordering::SeqCst);
    } else if window.label() == "main" || window.label() == "enlarged" {
        MAIN_CLOAKED.store(cloaked, Ordering::SeqCst);
    }
    crate::paste::log_diag(&format!(
        "[DWM_CLOAK] window='{}' cloaked={}",
        window.label(),
        cloaked
    ));
}

#[cfg(not(target_os = "windows"))]
pub fn set_window_cloaked(window: &tauri::WebviewWindow, cloaked: bool) {
    let _ = window;
    if window.label() == "overlay" {
        OVERLAY_CLOAKED.store(cloaked, Ordering::SeqCst);
    } else if window.label() == "main" || window.label() == "enlarged" {
        MAIN_CLOAKED.store(cloaked, Ordering::SeqCst);
    }
}

/// Show generation per surface: a painted-ack or fallback uncloak only
/// applies to the show that produced it — a quick hide/re-show can never be
/// undone by a stale callback (no rebound reveal, no stuck cloak).
static OVERLAY_SHOW_GEN: AtomicU64 = AtomicU64::new(0);
static ENLARGED_SHOW_GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone, Debug)]
pub struct OverlayOpenedPayload {
    pub token: u64,
    pub target_app: Option<String>,
    pub hide_gen: u64,
}

/// Unified overlay split-frame geometry (logical px, Tinycast-adapted): the
/// window owns this fixed frame — sized once at prewarm, never resized by
/// content, toggle, or the show path.
pub const OVERLAY_WIDTH: i32 = 750;
pub const OVERLAY_HEIGHT: i32 = 475;

#[derive(Serialize, Clone, Debug)]
pub struct EnlargedOpenedPayload {
    pub token: u64,
}

pub fn next_overlay_show_gen() -> u64 {
    OVERLAY_SHOW_GEN.fetch_add(1, Ordering::SeqCst) + 1
}

pub fn next_enlarged_show_gen() -> u64 {
    ENLARGED_SHOW_GEN.fetch_add(1, Ordering::SeqCst) + 1
}

pub fn invalidate_overlay_show_gen() {
    OVERLAY_SHOW_GEN.fetch_add(1, Ordering::SeqCst);
}

pub fn invalidate_enlarged_show_gen() {
    ENLARGED_SHOW_GEN.fetch_add(1, Ordering::SeqCst);
}

/// Forces a synchronous present of the window's current raster while it is
/// still cloaked, so the first uncloaked frame DWM composites is freshly
/// painted — never a stale or unpainted (white/black) surface. Runs on the
/// Tauri IPC thread (painted-ack path), never the hotkey thread, so rapid
/// taps can't queue behind it.
#[cfg(target_os = "windows")]
fn present_window_now(win: &tauri::WebviewWindow) {
    // Invariants I1, I2, S2/S3 (ADDENDUM v20):
    // WebView2 renders via DirectComposition, not GDI.
    // RedrawWindow with RDW_INVALIDATE erased the Win32 window background with the default white brush
    // before DirectComposition presented, causing white frame flashes on reveal.
    // DwmFlush ensures compositor state is flushed while cloaked without GDI white erase.
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Graphics::Dwm::DwmFlush;
        let _ = DwmFlush();
    }
    let _ = win;
}

#[cfg(not(target_os = "windows"))]
fn present_window_now(_win: &tauri::WebviewWindow) {}

/// I2 OS-ALPHA MASKING: Sets OS-level window opacity (0..255) via Win32 layered attributes.
/// Used at uncloak so residual unpainted compositor frames composite at alpha ~0 (invisible).
#[cfg(target_os = "windows")]
pub fn set_window_alpha(window: &tauri::WebviewWindow, alpha: u8) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetLayeredWindowAttributes, SetWindowLongW, GWL_EXSTYLE, LWA_ALPHA,
        WS_EX_LAYERED,
    };
    use windows::Win32::Foundation::COLORREF;
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let native = HWND(hwnd.0 as *mut _);
            let ex = GetWindowLongW(native, GWL_EXSTYLE);
            if (ex & (WS_EX_LAYERED.0 as i32)) == 0 {
                let _ = SetWindowLongW(native, GWL_EXSTYLE, ex | (WS_EX_LAYERED.0 as i32));
            }
            let _ = SetLayeredWindowAttributes(native, COLORREF(0), alpha, LWA_ALPHA);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_window_alpha(_window: &tauri::WebviewWindow, _alpha: u8) {}

/// Smoothly ramps window OS-level alpha from start to target over duration_ms (80-120ms).
/// Token-guarded: cancels early if window is hidden or re-shown.
pub fn ramp_window_alpha(
    window: tauri::WebviewWindow,
    start: u8,
    target: u8,
    duration_ms: u64,
    token: u64,
    is_overlay: bool,
) {
    std::thread::spawn(move || {
        let steps = 10;
        let step_delay = std::time::Duration::from_millis(duration_ms / steps);
        for i in 1..=steps {
            let cur_gen = if is_overlay {
                OVERLAY_SHOW_GEN.load(Ordering::SeqCst)
            } else {
                ENLARGED_SHOW_GEN.load(Ordering::SeqCst)
            };
            if cur_gen != token {
                return;
            }
            let a = (start as f64 + (target as f64 - start as f64) * (i as f64 / steps as f64)).round() as u8;
            set_window_alpha(&window, a);
            std::thread::sleep(step_delay);
        }
        set_window_alpha(&window, target);
    });
}

fn uncloak_overlay_if_current(app: &AppHandle, token: Option<u64>) {
    let current_gen = OVERLAY_SHOW_GEN.load(Ordering::SeqCst);
    let expected_token = match token {
        Some(t) if t == current_gen && t > 0 => t,
        Some(t) => {
            crate::paste::log_diag(&format!(
                "[SHOW_OVERLAY] uncloak skipped: stale token {} (current {})",
                t, current_gen
            ));
            return;
        }
        None => {
            crate::paste::log_diag(&format!(
                "[SHOW_OVERLAY] uncloak skipped: missing token (current {})",
                current_gen
            ));
            return;
        }
    };
    // A stale uncloak (e.g. the show's fallback firing after a quick hide)
    // must never revive the visibility flag on a hidden window.
    let phase = get_overlay_phase();
    if phase != OverlayPhase::Showing && phase != OverlayPhase::Shown {
        crate::paste::log_diag(&format!(
            "[SHOW_OVERLAY] uncloak skipped: phase is {:?}",
            phase
        ));
        return;
    }
    if let Some(win) = app.get_webview_window("overlay") {
        let hwnd_raw = win.hwnd().map(|h| h.0).unwrap_or(std::ptr::null_mut());
        let mut api_vis = win.is_visible().unwrap_or(false);
        let cloaked = OVERLAY_CLOAKED.load(Ordering::SeqCst);

        crate::paste::log_diag(&format!(
            "[UNCLOAK_PRECOND] window='overlay' token={} current_gen={} api_visible={} cloaked={} phase={:?} hwnd={:?}",
            expected_token, current_gen, api_vis, cloaked, phase, hwnd_raw
        ));

        // Invariant I3: Bounded wait up to 300ms for window visibility to settle.
        if !api_vis {
            crate::paste::log_diag("[SHOW_OVERLAY] waiting for native visibility (bounded up to 300ms)...");
            let start = std::time::Instant::now();
            while !api_vis && start.elapsed() < std::time::Duration::from_millis(300) {
                std::thread::sleep(std::time::Duration::from_millis(10));
                if OVERLAY_SHOW_GEN.load(Ordering::SeqCst) != expected_token {
                    crate::paste::log_diag(&format!(
                        "[SHOW_OVERLAY] uncloak aborted during wait: generation changed to {}",
                        OVERLAY_SHOW_GEN.load(Ordering::SeqCst)
                    ));
                    return;
                }
                let cur_phase = get_overlay_phase();
                if cur_phase != OverlayPhase::Showing && cur_phase != OverlayPhase::Shown {
                    crate::paste::log_diag(&format!(
                        "[SHOW_OVERLAY] uncloak aborted during wait: phase changed to {:?}",
                        cur_phase
                    ));
                    return;
                }
                api_vis = win.is_visible().unwrap_or(false);
            }
        }

        if !api_vis {
            crate::paste::log_diag("[SHOW_OVERLAY] uncloak recovery: overlay not natively visible after 300ms. Executing flash-safe recovery.");
            set_window_cloaked(&win, true);
            let _ = win.hide();
            set_overlay_phase(OverlayPhase::Hidden);
            return;
        }

        // Present-while-cloaked: guarantee real pixels before DWM can show us.
        present_window_now(&win);
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::Graphics::Dwm::DwmFlush;
            let _ = DwmFlush();
        }
        // I2 OS-ALPHA MASKING: Start at alpha 0, uncloak DWM, ramp to 255 over 100ms
        set_window_alpha(&win, 0);
        set_window_cloaked(&win, false);
        ramp_window_alpha(win.clone(), 0, 255, 100, expected_token, true);
        crate::paste::log_diag("[SHOW_OVERLAY] uncloaked after forced present with OS-alpha ramp (0->255 over 100ms)");
    }
}

fn uncloak_enlarged_if_current(app: &AppHandle, token: Option<u64>) {
    let current_gen = ENLARGED_SHOW_GEN.load(Ordering::SeqCst);
    let expected_token = match token {
        Some(t) if t == current_gen && t > 0 => t,
        Some(t) => {
            crate::paste::log_diag(&format!(
                "[SHOW_MAIN] uncloak skipped: stale token {} (current {})",
                t, current_gen
            ));
            return;
        }
        None => {
            crate::paste::log_diag(&format!(
                "[SHOW_MAIN] uncloak skipped: missing token (current {})",
                current_gen
            ));
            return;
        }
    };
    if let Some(win) = app.get_webview_window("main") {
        let hwnd_raw = win.hwnd().map(|h| h.0).unwrap_or(std::ptr::null_mut());
        let mut api_vis = win.is_visible().unwrap_or(false);
        let cloaked = MAIN_CLOAKED.load(Ordering::SeqCst);

        crate::paste::log_diag(&format!(
            "[UNCLOAK_PRECOND] window='main' token={} current_gen={} api_visible={} cloaked={} hwnd={:?}",
            expected_token, current_gen, api_vis, cloaked, hwnd_raw
        ));

        // Invariant I3: Bounded wait up to 300ms for window visibility to settle.
        if !api_vis {
            crate::paste::log_diag("[SHOW_MAIN] waiting for native visibility (bounded up to 300ms)...");
            let start = std::time::Instant::now();
            while !api_vis && start.elapsed() < std::time::Duration::from_millis(300) {
                std::thread::sleep(std::time::Duration::from_millis(10));
                if ENLARGED_SHOW_GEN.load(Ordering::SeqCst) != expected_token {
                    crate::paste::log_diag(&format!(
                        "[SHOW_MAIN] uncloak aborted during wait: generation changed to {}",
                        ENLARGED_SHOW_GEN.load(Ordering::SeqCst)
                    ));
                    return;
                }
                api_vis = win.is_visible().unwrap_or(false);
            }
        }

        if !api_vis {
            crate::paste::log_diag("[SHOW_MAIN] uncloak recovery: main not natively visible after 300ms. Executing flash-safe recovery.");
            set_window_cloaked(&win, true);
            let _ = win.hide();
            MAIN_CLOAKED.store(true, Ordering::SeqCst);
            MAIN_HAS_PAINTED.store(false, Ordering::SeqCst);
            return;
        }

        // Present-while-cloaked: guarantee real pixels before DWM can show us.
        present_window_now(&win);
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::Graphics::Dwm::DwmFlush;
            let _ = DwmFlush();
        }
        // I2 OS-ALPHA MASKING: Start at alpha 0, uncloak DWM, ramp to 255 over 100ms
        set_window_alpha(&win, 0);
        set_window_cloaked(&win, false);
        MAIN_HAS_PAINTED.store(true, Ordering::SeqCst);
        ramp_window_alpha(win.clone(), 0, 255, 100, expected_token, false);
        crate::paste::log_diag("[SHOW_MAIN] uncloaked after forced present with OS-alpha ramp (0->255 over 100ms)");
    }
}

/// Renderer confirms first painted frame after overlay show → reveal now.
pub fn note_overlay_painted(app: &AppHandle, token: Option<u64>) {
    uncloak_overlay_if_current(app, token);
}

/// Renderer confirms first painted frame after main show → reveal now.
pub fn note_enlarged_painted(app: &AppHandle, token: Option<u64>) {
    uncloak_enlarged_if_current(app, token);
}

pub static OVERLAY_CLOAKED: AtomicBool = AtomicBool::new(true);
pub static MAIN_CLOAKED: AtomicBool = AtomicBool::new(true);
pub static MAIN_HAS_PAINTED: AtomicBool = AtomicBool::new(false);

/// Epoch-milliseconds of the last overlay cloak, used for diagnostics around
/// the toggle path (see handle_overlay_hotkey). 0 = never hidden this run.
pub static LAST_HIDE_MS: AtomicU64 = AtomicU64::new(0);

/// Epoch-milliseconds of the last ACCEPTED overlay toggle. Presses arriving
/// <25ms after it are switch-chatter/doubled-delivery bursts, never
/// deliberate same-key re-taps — eating those keeps every deliberate press
/// toggling exactly once, in arrival order, no matter how fast the user taps.
pub static LAST_TOGGLE_MS: AtomicU64 = AtomicU64::new(0);

fn epoch_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    if nanos <= 0 {
        0
    } else {
        (nanos as u64) / 1_000_000
    }
}

pub fn is_overlay_visible() -> bool {
    !OVERLAY_CLOAKED.load(Ordering::SeqCst)
}

pub fn is_main_visible() -> bool {
    !MAIN_CLOAKED.load(Ordering::SeqCst) && MAIN_HAS_PAINTED.load(Ordering::SeqCst)
}

/// Re-cloak a window after an uncloaked off-screen present: show/hide cycles
/// (e.g. the first-paint prewarm) can clear the DWM cloak flag on some
/// drivers, which would leave a warm window one uncloaked show away from a
/// white flash.
pub fn recloak_window(app: &AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        set_window_cloaked(&win, true);
        if label == "main" || label == "enlarged" {
            MAIN_HAS_PAINTED.store(false, Ordering::SeqCst);
        }
    }
}

pub fn dismiss_main(app: &AppHandle) {
    let should_dismiss = is_main_visible()
        || app
            .get_webview_window("main")
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
    if should_dismiss {
        let _ = crate::choreo::hide_enlarged(app);
    }
}

pub fn set_recording_target(target: Option<String>) {
    *RECORDING_TARGET.lock().unwrap() = target;
}

#[cfg(windows)]
pub fn disable_window_dwm_transitions(win: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_TRANSITIONS_FORCEDISABLED,
    };
    if let Ok(hwnd) = win.hwnd() {
        let disable: i32 = 1;
        unsafe {
            let native = HWND(hwnd.0 as *mut _);
            let _ = DwmSetWindowAttribute(
                native,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &disable as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
            let no_border: u32 = 0xFFFFFFFE;
            let _ = DwmSetWindowAttribute(
                native,
                DWMWA_BORDER_COLOR,
                &no_border as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

fn ensure_overlay_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(win) = app.get_webview_window("overlay") {
        #[cfg(windows)]
        disable_window_dwm_transitions(&win);
        return Some(win);
    }
    // Windows stay warm for the whole app lifetime, so hitting this means
    // something destroyed the window unexpectedly (e.g. first launch before
    // prewarm). Recreate from config as a safety net.
    crate::paste::log_diag("[HOTKEY] Overlay window not found — recreating (safety net).");
    // Unified split frame: fixed geometry from tauri.conf (750x475).
    let (win_w, win_h) = (OVERLAY_WIDTH as f64, OVERLAY_HEIGHT as f64);
    if let Some(mut cfg) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "overlay")
        .cloned()
    {
        cfg.width = win_w;
        cfg.height = win_h;
        match tauri::WebviewWindowBuilder::from_config(app, &cfg) {
            Ok(builder) => match builder.build() {
                Ok(w) => {
                    crate::paste::log_diag("[HOTKEY] Recreated overlay from tauri.conf");
                    crate::vibrancy::init_window_vibrancy(&w, app);
                    crate::webview_bg::set_webview_transparent_background(w.as_ref());
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
    .inner_size(win_w, win_h)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .transparent(true)
    .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding")
    .build()
    {
        Ok(w) => {
            crate::paste::log_diag("[HOTKEY] Recreated overlay via manual builder");
            crate::vibrancy::init_window_vibrancy(&w, app);
            crate::webview_bg::set_webview_transparent_background(w.as_ref());
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
        #[cfg(windows)]
        disable_window_dwm_transitions(&win);
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
                    // Parity with the overlay recreate path: a recreated controller
                    // starts at Chromium's white default until this is set.
                    crate::webview_bg::set_webview_transparent_background(w.as_ref());
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
    .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding")
    .build()
    {
        Ok(w) => {
            crate::paste::log_diag("[HOTKEY] Recreated main via manual builder");
            crate::vibrancy::init_window_vibrancy(&w, app);
            // Parity with the overlay recreate path: a recreated controller
            // starts at Chromium's white default until this is set.
            crate::webview_bg::set_webview_transparent_background(w.as_ref());
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

    // Pre-size the fixed unified frame NOW, while hidden: if the size were
    // size were only fixed at show time, the hidden WebView2 surface would be
    // reallocated on every open whose size differed — the first present after
    // show() then comes out unpainted (white). Pre-sizing makes the show-path
    // resize a no-op in the common case.
    if let Some(state) = app.try_state::<crate::AppState>() {
        let settings = state.settings.get();

        // Unified split frame: pre-size the fixed 750x475 frame NOW, while
        // hidden, and apply vibrancy across full bounds. The show path never
        // resizes, so no fresh WebView2 surface appears before `show()`.
        if let Some(win) = app.get_webview_window("overlay") {
            let (win_w, win_h) = (OVERLAY_WIDTH, OVERLAY_HEIGHT);
            let scale_factor = win.scale_factor().unwrap_or(1.0);
            let phys_w = (win_w as f64 * scale_factor).round() as u32;
            let phys_h = (win_h as f64 * scale_factor).round() as u32;
            let want = tauri::PhysicalSize {
                width: phys_w,
                height: phys_h,
            };
            if win.outer_size().ok() != Some(want) {
                let _ = win.set_size(tauri::Size::Physical(want));
            }

            crate::vibrancy::set_round_corners(&win);
            let mat = crate::vibrancy::WindowMaterial::from_str(&settings.window_material);
            crate::vibrancy::apply_window_material(&win, mat);
            crate::vibrancy::set_window_default_background(&win, mat, &settings.theme);
            crate::webview_bg::set_webview_transparent_background(win.as_ref());

            // Cloak the overlay window and make it WS_VISIBLE without activating,
            // so WebView2 connects its swapchain and finishes its first paint
            // completely hidden from the desktop composition.
            set_window_cloaked(&win, true);
            if let Ok(hwnd) = win.hwnd() {
                let native = HWND(hwnd.0 as *mut _);
                unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        ShowWindow, SW_SHOWNOACTIVATE,
                    };
                    let _ = ShowWindow(native, SW_SHOWNOACTIVATE);
                }
            }
            // Re-cloak: some drivers clear the cloak flag on visibility change.
            set_window_cloaked(&win, true);
        }

        if let Some(main_win) = app.get_webview_window("main") {
            let mat = crate::vibrancy::WindowMaterial::from_str(&settings.window_material);
            crate::vibrancy::set_round_corners(&main_win);
            crate::vibrancy::apply_window_material(&main_win, mat);
            crate::vibrancy::set_window_default_background(&main_win, mat, &settings.theme);
            crate::webview_bg::set_webview_transparent_background(main_win.as_ref());
            set_window_cloaked(&main_win, true);
        }

        // Warm DB cache and push snapshot directly into WebViews while hidden
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayPhase {
    Hidden = 0,
    Showing = 1,
    Shown = 2,
    Hiding = 3,
}

static OVERLAY_PHASE: AtomicU32 = AtomicU32::new(OverlayPhase::Hidden as u32);

pub fn set_overlay_phase(phase: OverlayPhase) {
    OVERLAY_PHASE.store(phase as u32, Ordering::SeqCst);
}

pub fn get_overlay_phase() -> OverlayPhase {
    match OVERLAY_PHASE.load(Ordering::SeqCst) {
        1 => OverlayPhase::Showing,
        2 => OverlayPhase::Shown,
        3 => OverlayPhase::Hiding,
        _ => OverlayPhase::Hidden,
    }
}

pub fn handle_overlay_hotkey(app_handle: &AppHandle) {
    crate::paste::log_diag("[HOTKEY] handle_overlay_hotkey triggered.");
    // Toggle floor (sub-25ms presses are chatter/doubled deliveries, never
    // deliberate re-taps) — checked FIRST so bursts can't stack expensive
    // show/hide work on the shortcut thread and eat later taps.
    let now_ms = epoch_ms();
    if now_ms.saturating_sub(LAST_TOGGLE_MS.load(Ordering::SeqCst)) < 25 {
        crate::paste::log_diag("[HOTKEY] Toggle-floor ignored (sub-25ms burst).");
        return;
    }
    LAST_TOGGLE_MS.store(now_ms, Ordering::SeqCst);
    let overlay_win = match ensure_overlay_window(app_handle) {
        Some(w) => w,
        None => {
            crate::paste::log_diag("[HOTKEY] ERROR: overlay window not found and recreation failed!");
            return;
        }
    };
    // NB: prewarm leaves the overlay WS_VISIBLE-but-DWM-cloaked (warm
    // swapchain, invisible on screen), so tao is_visible() alone is TRUE from
    // startup. The toggle must ALSO require uncloaked, or the very first
    // press takes the hide path and nothing ever appears on screen.
    let is_visible = overlay_win.is_visible().unwrap_or(false) && is_overlay_visible();
    let phase = get_overlay_phase();
    crate::paste::log_diag(&format!(
        "[HOTKEY] Overlay state: phase={:?}, is_visible={}",
        phase, is_visible
    ));

    // Re-show during hide cancels hide (no hide/show churn)! (F2)
    // Sub-25ms duplicates never reach here (toggle floor above), so any
    // press arriving mid-hide is a deliberate re-tap: cancel instantly and
    // re-show, so mashing the hotkey never drops a tap.
    if phase == OverlayPhase::Hiding {
        crate::paste::log_diag("[HOTKEY] Re-show during hide: cancelling hide and revealing.");
        set_overlay_phase(OverlayPhase::Showing);
        let overlay_gen = OVERLAY_SHOW_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let cancel_gen = OVERLAY_HIDE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        #[derive(Serialize, Clone, Debug)]
        struct OverlayCancelHidePayload {
            token: u64,
            hide_gen: u64,
        }
        let _ = app_handle.emit_to(
            "overlay",
            "overlay-cancel-hide",
            OverlayCancelHidePayload {
                token: overlay_gen,
                hide_gen: cancel_gen,
            },
        );
        let _ = overlay_win.set_focus();
        return;
    }

    let overlay_is_open = phase == OverlayPhase::Shown
        || phase == OverlayPhase::Showing
        || (is_visible && !OVERLAY_CLOAKED.load(Ordering::SeqCst));
    if overlay_is_open {
        crate::paste::log_diag("[HOTKEY] Overlay is visible/showing. Requesting choreographed fade-hide via webview (toggle)...");
        set_overlay_phase(OverlayPhase::Hiding);
        request_webview_overlay_hide(app_handle);
        return;
    }

    // No post-hide time guard: the 25ms toggle floor at entry owns burst
    // suppression uniformly instead of punishing deliberate taps. A fixed
    // "since_hide < N" window cannot tell a delayed duplicate from a fast
    // re-tap — at 120ms it ate every other press for 90-210ms tap cadences
    // ("half the clicks don't register"). Every deliberate press now toggles.
    // LAST_HIDE_MS is still recorded for diagnostics.

    // Normalized behavior: the overlay never opens on top of an already-open
    // main window (that "overlay pops inside the main app" confusion). If the
    // library is visible, just bring it to front instead.
    // S1 Fix: only take this branch if main is actually open and painted (not cloaked/hidden).
    if let Some(main_win) = app_handle.get_webview_window("main") {
        if is_main_visible() && main_win.is_visible().unwrap_or(false) && !main_win.is_minimized().unwrap_or(false) {
            crate::paste::log_diag("[HOTKEY] Main is open and visible — focusing it instead of opening overlay.");
            let _ = main_win.set_focus();
            return;
        }
    }

    // Invariant I4: Exactly one app window visible at any instant (mutual exclusion)
    dismiss_main(app_handle);

    set_overlay_phase(OverlayPhase::Showing);

    // Fast path: save target HWND while it is still foreground (must be before show)
    crate::paste::log_diag("[HOTKEY] Overlay opening. Calling save_target_window...");
    save_target_window(app_handle);
    // Invalidate any pending webview-hide fallback: a show always wins over a
    // stale hide request (the fade choreography lives in QuickOverlay.tsx).
    // The new generation rides along in overlay-opened so the webview floors
    // any hide-request older than this show (out-of-order delivery under
    // hotkey spam can otherwise run a stale fade after the open).
    let show_hide_gen = OVERLAY_HIDE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    // Capture selected text while target is still focused. UIA is instant; clipboard
    // fallback (Ctrl+C + 120ms) is rare and only runs when UIA has no selection.
    crate::paste::capture_selection_snapshot();
    CURRENT_CYCLE_INDEX.store(0, Ordering::Relaxed);

    let (cx, cy) = get_cursor_position();
    // Unified split frame: fixed 750x475 geometry owned by the window (set
    // once at prewarm). This show path never resizes — content can never
    // resize the window, so no fresh WebView2 composition surface (and no
    // unpainted first present) appears immediately before `show()`.
    let (win_w, win_h) = (OVERLAY_WIDTH, OVERLAY_HEIGHT);
    let scale_factor = overlay_win.scale_factor().unwrap_or(1.0);
    let phys_w = (win_w as f64 * scale_factor).round() as u32;
    let phys_h = (win_h as f64 * scale_factor).round() as u32;
    // No set_round_corners here: DWMWA_WINDOW_CORNER_PREFERENCE is persistent
    // per-window (applied at prewarm/create), and the main-window show path
    // doesn't re-assert it either. Keeping this off the hotkey thread saves a
    // DWM round-trip on every picker open.

    let (pos_x, pos_y) = calculate_overlay_position(cx, cy, win_w, win_h, scale_factor);
    crate::paste::log_diag(&format!(
        "[HOTKEY] Calculated pos: ({}, {}), size: {}x{}, scale: {}",
        pos_x, pos_y, phys_w, phys_h, scale_factor
    )    );

    // Flash-free reveal, combining both branches' guarantees:
    //  - Cloak FIRST (fresh generation) so DWM composites nothing for this
    //    window; the cloak lifts only after the renderer confirms paint
    //    (overlay_painted).
    //  - Position (never resize) while cloaked: SWP_NOSIZE keeps the warm
    //    DirectComposition surface so the first present can't come out white.
    //    The fixed frame size was applied once at prewarm.
    //  - No synchronous present here: RedrawWindow(RDW_UPDATENOW) blocks the
    //    shortcut thread on a cross-process paint round-trip (slow first
    //    open, queued/dropped taps under spam). The cloak + paint-gate ack
    //    already guarantee the first uncloaked frame is real content.
    //  - The transparent controller background guarantees even a
    //    not-yet-painted region composites transparent — never white.
    let overlay_gen = OVERLAY_SHOW_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    set_window_cloaked(&overlay_win, true);

    if let Ok(hwnd) = overlay_win.hwnd() {
        let native = HWND(hwnd.0 as *mut _);
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOSIZE,
            };
            // Position-only: the fixed frame size is owned by prewarm/tauri.conf.
            // SWP_NOSIZE keeps the warm composition surface so the first
            // present can't come out white.
            let _ = SetWindowPos(
                native,
                HWND_TOPMOST,
                pos_x,
                pos_y,
                phys_w as i32,
                phys_h as i32,
                SWP_NOACTIVATE | SWP_NOSIZE,
            );
        }
    }
    // Supported show path: guarantees the WebView2 controller is marked
    // visible (the raw SetWindowPos above cannot do that).
    let _ = overlay_win.show();

    if overlay_win.is_minimized().unwrap_or(false) {
        let _ = overlay_win.unminimize();
    }
    // Re-assert cloak immediately after show/unminimize: Win32 ShowWindow /
    // SetWindowPos can clear DWMWA_CLOAK on visibility transitions.
    set_window_cloaked(&overlay_win, true);
    let focus_res = overlay_win.set_focus();
    crate::paste::log_diag(&format!(
        "[HOTKEY] overlay_win.set_focus() -> {:?}",
        focus_res
    ));
    // Emit opened immediately so frontend can render skeleton instantly.
    // If a prewarm snapshot exists, push it *with* the open so the first
    // frame already has data — zero skeleton time like Pico's instant open.
    let target_app = crate::paste::get_target_app_name();
    let opened_payload = OverlayOpenedPayload {
        token: overlay_gen,
        target_app,
        hide_gen: show_hide_gen,
    };
    let _ = app_handle.emit("overlay-opened", &opened_payload);
    // Fast path only: emit the cached snapshot if one exists and NEVER query
    // SQLite on the hotkey thread. The main-window show path does zero DB
    // work before show(); a synchronous get_overlay_entries here blocked the
    // picker open on disk I/O. Cold start (cache None) is covered by the
    // background refresh below plus the frontend's post-reveal refetch.
    let cached_opt = OVERLAY_PREWARM_CACHE.lock().unwrap().clone();
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

/// Re-asserts the main window's non-white surface immediately before show, on
/// EVERY open (not just prewarm/recreate). The prewarm background calls can
/// land before the WebView2 controller finishes initializing — the cast then
/// fails silently and Chromium's white default sticks. The first present on a
/// fresh surface (first boot, or after the OS discards the hidden window's
/// surface during idle) then composites white during the alpha ramp, while
/// warm repeat opens have real pixels and never flash. Same two calls, same
/// order as prewarm and the overlay Tab path: material-aware default first,
/// then the transparent controller background. Synchronous COM only — no
/// resize, no material change, safe on the hotkey thread.
pub(crate) fn prepare_main_surface(app_handle: &AppHandle, main_win: &tauri::WebviewWindow) {
    if let Some(state) = app_handle.try_state::<crate::AppState>() {
        let settings = state.settings.get();
        let mat = crate::vibrancy::WindowMaterial::from_str(&settings.window_material);
        crate::vibrancy::set_window_default_background(main_win, mat, &settings.theme);
    }
    crate::webview_bg::set_webview_transparent_background(main_win.as_ref());
}

pub fn handle_enlarged_hotkey(app_handle: &AppHandle) {
    crate::paste::log_diag("[HOTKEY] handle_enlarged_hotkey triggered.");
    // Normalized behavior: if the overlay is open, this press only swaps to
    // the library — it never toggles the library closed in the same press
    // (that "both collapse" confusion). Capture overlay state BEFORE
    // dismissing so the decision is race-free.
    let overlay_was_visible = is_overlay_visible();
    dismiss_overlay(app_handle);

    let main_win = match ensure_main_window(app_handle) {
        Some(w) => w,
        None => {
            crate::paste::log_diag("[HOTKEY] ERROR: main window not found and recreation failed!");
            return;
        }
    };
    if overlay_was_visible {
        crate::paste::log_diag("[HOTKEY] Overlay was open — showing main instead of toggling.");
        save_target_window(app_handle);
        prepare_main_surface(app_handle, &main_win);
        let _ = main_win.eval("document.documentElement.classList.add('wm-hidden')");
        let enlarged_gen = ENLARGED_SHOW_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        set_window_cloaked(&main_win, true);
        let _ = main_win.unminimize();
        let show_res = main_win.show();
        // Re-assert cloak immediately after show/unminimize: Win32 ShowWindow /
        // SetWindowPos can clear DWMWA_CLOAK on visibility transitions.
        set_window_cloaked(&main_win, true);
        let focus_res = main_win.set_focus();
        crate::paste::log_diag(&format!("[HOTKEY] main_win.show() -> {:?}, set_focus() -> {:?}, post-show is_visible={}", show_res, focus_res, main_win.is_visible().unwrap_or(false)));
        let _ = app_handle.emit("enlarged-opened", EnlargedOpenedPayload { token: enlarged_gen });
        return;
    }
    let is_visible = is_main_visible() && main_win.is_visible().unwrap_or(false);
    crate::paste::log_diag(&format!("[HOTKEY] Main window state: is_visible={}", is_visible));
    if is_visible {
        crate::paste::log_diag("[HOTKEY] Main window is visible. Requesting choreographed fade-hide via webview...");
        request_webview_enlarged_hide(app_handle);
    } else {
        save_target_window(app_handle);
        crate::paste::capture_selection_snapshot();
        prepare_main_surface(app_handle, &main_win);
        let _ = main_win.eval("document.documentElement.classList.add('wm-hidden')");
        let enlarged_gen = ENLARGED_SHOW_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        set_window_cloaked(&main_win, true);
        let _ = main_win.unminimize();
        let show_res = main_win.show();
        // Re-assert cloak immediately after show/unminimize: Win32 ShowWindow /
        // SetWindowPos can clear DWMWA_CLOAK on visibility transitions.
        set_window_cloaked(&main_win, true);
        let focus_res = main_win.set_focus();
        crate::paste::log_diag(&format!("[HOTKEY] main_win.show() -> {:?}, set_focus() -> {:?}, post-show is_visible={}", show_res, focus_res, main_win.is_visible().unwrap_or(false)));
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
        let _ = app_handle.emit("enlarged-opened", EnlargedOpenedPayload { token: enlarged_gen });
    }
}

/// Generation of webview-routed enlarged hide requests + acknowledged generation.
static ENLARGED_HIDE_GEN: AtomicU64 = AtomicU64::new(0);
static ENLARGED_HIDE_ACK: AtomicU64 = AtomicU64::new(0);

pub fn note_enlarged_hide_ack(gen: u64) {
    ENLARGED_HIDE_ACK.fetch_max(gen, Ordering::SeqCst);
}

fn request_webview_enlarged_hide(app: &AppHandle) {
    ENLARGED_SHOW_GEN.fetch_add(1, Ordering::SeqCst);
    let gen = ENLARGED_HIDE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    crate::paste::log_diag(&format!("[HIDE_MAIN] hide-requested gen={} emitted to webview", gen));
    let _ = app.emit_to("main", "enlarged-hide-requested", gen);
    let app2 = app.clone();
    thread::spawn(move || {
        thread::sleep(std::time::Duration::from_millis(150));
        if ENLARGED_HIDE_GEN.load(Ordering::SeqCst) == gen {
            if let Some(win) = app2.get_webview_window("main") {
                if win.is_visible().unwrap_or(false) {
                    set_window_cloaked(&win, true);
                    crate::paste::log_diag(
                        "[HOTKEY] hide fallback: cloaked (flash-safe)",
                    );
                    let _ = app2.emit("choreo-hide-fallback", "main");
                    restore_target_window();
                    let _ = win.eval("document.documentElement.classList.add('wm-hidden')");
                    let _ = win.hide();
                }
            }
        }
    });
}

/// Records that the overlay webview acknowledged a hide-request generation.
pub fn note_overlay_hide_ack(gen: u64) {
    OVERLAY_HIDE_ACK.fetch_max(gen, Ordering::SeqCst);
}

/// Routes the hide through the overlay webview so its choreography can fade
/// #root out BEFORE the native hide(). Re-entrant + idempotent: a re-press
/// while fading keeps the fade (mask stays ON until the native hide); cancel
/// only happens for an actual show. A 250ms fallback hides natively if the
/// webview never acknowledges (crashed renderer), so the hotkey can never go
/// dead. Blur/paste paths still hide natively+immediately. In every case the
/// mask class is left ON while invisible; the show path clears it after two
/// presented frames so no stale/composited-white frame is ever revealed.
fn request_webview_overlay_hide(app: &AppHandle) {
    OVERLAY_SHOW_GEN.fetch_add(1, Ordering::SeqCst);
    let gen = OVERLAY_HIDE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit_to("overlay", "overlay-hide-requested", gen);
    let app2 = app.clone();
    thread::spawn(move || {
        thread::sleep(std::time::Duration::from_millis(150));
        if OVERLAY_HIDE_GEN.load(Ordering::SeqCst) == gen
            && get_overlay_phase() == OverlayPhase::Hiding
        {
            if let Some(win) = app2.get_webview_window("overlay") {
                if win.is_visible().unwrap_or(false) {
                    set_window_cloaked(&win, true);
                    crate::paste::log_diag(
                        "[HOTKEY] hide fallback: cloaked (flash-safe)",
                    );
                    let _ = app2.emit("choreo-hide-fallback", "overlay");
                    hide_overlay_window(&app2);
                }
            }
        }
    });
}

/// Guard to prevent re-entrant calls to hide_overlay_window.
/// When paste_clip → hide_overlay_window runs, the overlay's hide() triggers
/// a Focused(false) event which would call hide_overlay_window again. This
/// flag prevents the second call from interfering.
static HIDING_OVERLAY: AtomicBool = AtomicBool::new(false);

pub fn hide_overlay_window(app: &AppHandle) {
    OVERLAY_SHOW_GEN.fetch_add(1, Ordering::SeqCst);
    // Prevent re-entrant calls (the Focused(false) event fires when we hide)
    if HIDING_OVERLAY.swap(true, Ordering::SeqCst) {
        crate::paste::log_diag("[HIDE_OVERLAY] Already executing hide_overlay_window (re-entrancy guard). Skipping.");
        return;
    }
    crate::paste::log_diag("[HIDE_OVERLAY] hide_overlay_window entered. Cloaking window...");

    if let Some(win) = app.get_webview_window("overlay") {
        set_window_cloaked(&win, true);
        OVERLAY_CLOAKED.store(true, Ordering::SeqCst);
        let hide_res = win.hide();
        crate::paste::log_diag(&format!("[HIDE_OVERLAY] win.hide() returned {:?}", hide_res));
    } else {
        crate::paste::log_diag("[HIDE_OVERLAY] overlay window not found!");
        OVERLAY_CLOAKED.store(true, Ordering::SeqCst);
    }
    LAST_HIDE_MS.store(epoch_ms(), Ordering::SeqCst);

    // Now restore the previously-active window
    crate::paste::log_diag("[HIDE_OVERLAY] Calling restore_target_window()...");
    restore_target_window();

    set_overlay_phase(OverlayPhase::Hidden);
    HIDING_OVERLAY.store(false, Ordering::SeqCst);
    crate::paste::log_diag("[HIDE_OVERLAY] Complete.");
}

/// Returns true if hide_overlay_window is currently executing.
/// Used by the Focused(false) handler in lib.rs to avoid re-entrancy.
pub fn is_overlay_hiding() -> bool {
    HIDING_OVERLAY.load(Ordering::SeqCst)
}

fn dismiss_overlay(app: &AppHandle) {
    let should_dismiss = is_overlay_visible()
        || get_overlay_phase() != OverlayPhase::Hidden
        || app
            .get_webview_window("overlay")
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
    if should_dismiss {
        hide_overlay_window(app);
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
