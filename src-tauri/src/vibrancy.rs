use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowMaterial {
    Acrylic,
    Mica,
    Blur,
    Solid,
}

impl Default for WindowMaterial {
    fn default() -> Self {
        WindowMaterial::Acrylic
    }
}

impl WindowMaterial {
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "mica" => WindowMaterial::Mica,
            "blur" => WindowMaterial::Blur,
            "solid" => WindowMaterial::Solid,
            _ => WindowMaterial::Acrylic,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            WindowMaterial::Acrylic => "acrylic",
            WindowMaterial::Mica => "mica",
            WindowMaterial::Blur => "blur",
            WindowMaterial::Solid => "solid",
        }
    }
}

/// Returns the theme-neutral tint color tuple (R, G, B, A).
/// Neutral gray tint (64, 64, 64, 90) applied ONCE per session.
/// All theme tinting lives in the CSS --glass-base layer, eliminating
/// any OS acrylic clear/re-apply on theme change (F3).
pub fn get_tint_color() -> window_vibrancy::Color {
    (64, 64, 64, 90)
}

/// Configures Windows DWM rounded corners for the window.
/// Deliberately DWM-only (no SetWindowRgn): the library window proves this is
/// pixel-perfect — DWM rounds the whole surface including the acrylic blur at
/// the compositor level. GDI round-rect regions were tried for overlay/pill
/// and always left 1px halo tabs at the corners: GDI arcs can't match
/// Chromium's Skia arcs subpixel-for-subpixel, and blur-behind vs. region
/// disagree about the corner pixels.
pub fn set_round_corners(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
        };

        if let Ok(w_hwnd) = window.hwnd() {
            unsafe {
                let hwnd = windows::Win32::Foundation::HWND(w_hwnd.0 as _);
                // DWMWCP_ROUND = 2
                let preference = 2i32;
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    &preference as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<i32>() as u32,
                );
                // DWMWA_COLOR_NONE: suppress default Windows 11 window border
                set_window_border_suppressed(window);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

/// Re-asserts DWMWA_COLOR_NONE for the DWM border.
/// Called again immediately BEFORE any native resize: frame recalculation
/// during SetWindowPos can otherwise let DWM paint its default (light) border
/// for a frame on the exposed edge — the "white border" on Tab preview toggles.
pub fn set_window_border_suppressed(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_NOOWNERZORDER,
        };
        if let Ok(w_hwnd) = window.hwnd() {
            unsafe {
                let hwnd = windows::Win32::Foundation::HWND(w_hwnd.0 as _);
                // DWMWA_COLOR_NONE = 0xFFFFFFFE
                let no_border = 0xFFFFFFFEu32;
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_BORDER_COLOR,
                    &no_border as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                );
                let _ = SetWindowPos(
                    hwnd,
                    windows::Win32::Foundation::HWND(std::ptr::null_mut()),
                    0,
                    0,
                    0,
                    0,
                    SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                );
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

/// Clears any previously applied OS-level blur, acrylic, or mica effects.
#[allow(dead_code)]
pub fn clear_window_effects(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        let _ = window_vibrancy::clear_acrylic(window);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = window_vibrancy::clear_vibrancy(window);
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = window;
}

/// Applies the requested window material to a window with graceful fallback.
/// Windows 11/10-1809+: apply_acrylic -> fallback apply_blur -> solid.
/// macOS: apply_vibrancy(HudWindow).
/// Applied ONCE at window creation with theme-neutral tint; NEVER re-applied on
/// theme changes or show/hide.
pub fn apply_window_material(window: &WebviewWindow, material: WindowMaterial) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};
        if let Ok(w_hwnd) = window.hwnd() {
            unsafe {
                let hwnd = windows::Win32::Foundation::HWND(w_hwnd.0 as _);
                let is_dark: i32 = 1;
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_USE_IMMERSIVE_DARK_MODE,
                    &is_dark as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<i32>() as u32,
                );
            }
        }
        set_round_corners(window);
        match material {
            WindowMaterial::Solid => {
                let _ = window_vibrancy::clear_acrylic(window);
                log::info!(
                    "[Vibrancy] Window '{}' set to solid material",
                    window.label()
                );
            }
            WindowMaterial::Acrylic | WindowMaterial::Mica | WindowMaterial::Blur => {
                let tint = get_tint_color();
                if let Err(e) = window_vibrancy::apply_acrylic(window, Some(tint)) {
                    log::warn!(
                        "[Vibrancy] apply_acrylic failed on '{}': {:?}. Trying blur fallback",
                        window.label(),
                        e
                    );
                    if let Err(e2) = window_vibrancy::apply_blur(window, Some(tint)) {
                        log::warn!(
                            "[Vibrancy] fallback apply_blur failed on '{}': {:?}. Using solid fallback",
                            window.label(),
                            e2
                        );
                    } else {
                        log::info!("[Vibrancy] Applied fallback blur to window '{}'", window.label());
                    }
                } else {
                    log::info!("[Vibrancy] Applied acrylic to window '{}'", window.label());
                }
            }
        }
        set_window_border_suppressed(window);
    }
    #[cfg(target_os = "macos")]
    {
        match material {
            WindowMaterial::Solid => {
                let _ = window_vibrancy::clear_vibrancy(window);
            }
            _ => {
                if let Err(e) = window_vibrancy::apply_vibrancy(
                    window,
                    window_vibrancy::NSVisualEffectMaterial::HudWindow,
                    None,
                    None,
                ) {
                    log::warn!(
                        "[Vibrancy] macOS apply_vibrancy failed on '{}': {:?}",
                        window.label(),
                        e
                    );
                }
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (window, material);
    }
}

/// Applies the given material to all live webview windows.
pub fn apply_to_all_windows(app: &AppHandle, material: WindowMaterial, theme: &str) {
    for (_, win) in app.webview_windows() {
        apply_window_material(&win, material);
        set_window_default_background(&win, material, theme);
    }
}

/// Repaint only the controller fallback. Unlike `apply_to_all_windows`, this
/// does not touch DWM material and is safe during a live Solid theme switch.
pub fn set_default_background_for_all(app: &AppHandle, material: WindowMaterial, theme: &str) {
    for (_, win) in app.webview_windows() {
        set_window_default_background(&win, material, theme);
    }
}

/// Helper called on single window creation / setup to initialize vibrancy once.
pub fn init_window_vibrancy(window: &WebviewWindow, app: &AppHandle) {
    set_round_corners(window);
    if let Some(state) = app.try_state::<crate::AppState>() {
        let settings = state.settings.get();
        let mat = WindowMaterial::from_str(&settings.window_material);
        apply_window_material(window, mat);
        set_window_default_background(window, mat, &settings.theme);
    }
}

/// Sets WebView2's default pre-paint surface. Glass remains transparent so
/// acrylic can composite desktop blur; Solid must be an opaque theme match so
/// a cold frame is indistinguishable from the actual Solid window.
/// Returns whether the controller accepted it — a cold-start controller that
/// is not ready yet fails SILENTLY and Chromium's white default sticks
/// (rare first-present flash), so callers retry (see prepare_main_surface).
pub fn set_window_default_background(
    window: &WebviewWindow,
    material: WindowMaterial,
    theme: &str,
) -> bool {
    #[cfg(target_os = "windows")]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_COLOR;
        let color = match material {
            WindowMaterial::Solid if theme.eq_ignore_ascii_case("light") => {
                COREWEBVIEW2_COLOR { A: 255, R: 244, G: 244, B: 246 }
            }
            WindowMaterial::Solid => COREWEBVIEW2_COLOR { A: 255, R: 14, G: 14, B: 16 },
            _ => COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 },
        };
        let applied_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let applied_flag_inner = applied_flag.clone();
        let _ = window.with_webview(move |platform_webview| {
            use windows_core::Interface;
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2Controller, ICoreWebView2Controller2,
            };
            let controller: ICoreWebView2Controller = platform_webview.controller();
            // DefaultBackgroundColor lives on ICoreWebView2Controller2
            // (WebView2 1.0.774+): cast the base controller via its COM GUID.
            let controller2: ICoreWebView2Controller2 = match controller.cast() {
                Ok(c) => c,
                Err(_) => return,
            };
            if unsafe { controller2.SetDefaultBackgroundColor(color).is_ok() } {
                applied_flag_inner.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });
        let applied = applied_flag.load(std::sync::atomic::Ordering::SeqCst);
        if !applied {
            crate::paste::log_diag("[VIBRANCY] default background NOT applied (controller not ready) — retry will follow.");
        }
        applied
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, material, theme);
        true
    }
}

/// Applies the material-aware default background AND the transparent
/// controller background with bounded synchronous retries, preserving the
/// canonical order (material default first, transparent second).
/// The WebView2 controller often isn't ready on the first attempt (cold boot:
/// prewarm runs milliseconds after window creation; reopen-after-idle: the OS
/// may have torn the controller down) — the COM cast then fails silently and
/// Chromium's white default sticks, so the first present composites white.
/// Callers on background threads can afford generous budgets; the
/// hotkey-thread pre-show path uses a tight inline budget instead
/// (see prepare_main_surface) so a warm open never waits.
pub fn ensure_transparent_surface(
    window: &WebviewWindow,
    material: WindowMaterial,
    theme: &str,
    attempts: u32,
    sleep_ms: u64,
) -> bool {
    let budget = attempts.max(1);
    for attempt in 0..budget {
        let mut ok = true;
        ok = set_window_default_background(window, material, theme) && ok;
        ok = crate::webview_bg::set_webview_transparent_background(window.as_ref()) && ok;
        if ok {
            return true;
        }
        if attempt + 1 < budget {
            std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
        }
    }
    crate::paste::log_diag("[VIBRANCY] transparent surface NOT applied after retries — white-default risk remains.");
    false
}

/// The creation callback has a Webview rather than a WebviewWindow. It uses
/// the same controller API; setup replaces this safe transparent default with
/// Solid's opaque theme match before any warm hidden window is shown.
pub fn set_webview_default_background<W: tauri::Runtime>(
    webview: &tauri::Webview<W>,
    material: WindowMaterial,
    theme: &str,
) {
    #[cfg(target_os = "windows")]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_COLOR;
        let color = match material {
            WindowMaterial::Solid if theme.eq_ignore_ascii_case("light") => {
                COREWEBVIEW2_COLOR { A: 255, R: 244, G: 244, B: 246 }
            }
            WindowMaterial::Solid => COREWEBVIEW2_COLOR { A: 255, R: 14, G: 14, B: 16 },
            _ => COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 },
        };
        let _ = webview.with_webview(move |platform_webview| {
            use windows_core::Interface;
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2Controller, ICoreWebView2Controller2,
            };
            let controller: ICoreWebView2Controller = platform_webview.controller();
            let controller2: ICoreWebView2Controller2 = match controller.cast() {
                Ok(c) => c,
                Err(_) => return,
            };
            unsafe { let _ = controller2.SetDefaultBackgroundColor(color); }
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (webview, material, theme);
}

/// Force each hidden window's WebView2 to present its first frame while the
/// user can't see it. A DWM-cloaked window is excluded from composition, so
/// the cloak-gated prewarm alone never produces a genuine first present —
/// the first uncloaked show then composites a cold (white) surface.
///
/// CRITICAL: the skip condition must be the LOGICAL reveal flag, not
/// `is_visible()`. `prewarm_windows` leaves both windows WS_VISIBLE-but-
/// cloaked (ShowWindow while DWM-cloaked so WebView2 connects its swapchain);
/// bailing on `is_visible()` therefore skipped this cycle on every boot and
/// the first real show flashed white. Only a window the user can actually
/// see (logically uncloaked, or mid-reveal) must be left alone.
///
/// Per-window genuine first present. `only` limits the cycle to one label
/// so main's heavy tree presents only after MAIN reports ready (not when
/// pill/overlay finish first — that once-flag inversion left main cold).
static PRESENTED_MAIN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PRESENTED_OVERLAY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Serializes boot present vs show-path rewarm so two threads never park the
/// same HWND at once. `try_lock` on the show path: if boot is mid-cycle, skip
/// (that cycle is already warming the surface).
static PRESENT_CYCLE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Show-path hold on the present mutex: the background warmth loop can never
/// park/hide mid-show while this guard lives (it skips the tick instead).
/// Bounded: the loop's cycle is ~40ms, so a racing show waits at most that.
pub(crate) fn hold_present_cycle() -> std::sync::MutexGuard<'static, ()> {
    PRESENT_CYCLE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Park off-screen, physically uncloak, show-without-activate, settle for a
/// real DWM present, hide, restore, re-cloak. Logical flags stay cloaked.
/// Shared by boot prewarm and the main show-path idle rewarm.
///
/// `gen_guard`: expected enlarged show generation for background callers.
/// A real show that raced the cycle owns cloak state from here on: restore
/// position but do NOT hide and do NOT re-cloak (re-cloaking a revealed
/// window while the flag says revealed is the "never appears again" state),
/// and report false so no warmth is stamped. Boot passes None (legacy path).
/// Returns true when the surface genuinely re-presented.
fn offscreen_present_cycle(
    win: &tauri::WebviewWindow,
    label: &str,
    settle_ms: u64,
    gen_guard: Option<u64>,
) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::sync::atomic::Ordering;
        use std::time::Duration;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE};
        let Ok(hwnd) = win.hwnd() else {
            return false;
        };
        let orig = win.outer_position().ok();
        let h_raw: isize = hwnd.0 as isize;
        let h = HWND(h_raw as *mut _);
        // Park FIRST while still cloaked: an uncloak at the real on-screen
        // position could composite one frame before the move lands.
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
            };
            let _ = SetWindowPos(
                h,
                HWND(std::ptr::null_mut()),
                -32000,
                -32000,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        // Physically uncloak while parked: DWM excludes cloaked windows
        // from composition, so without this the show below still never
        // produces a real present. Raw DWMWA_CLOAK only — logical flags
        // stay `cloaked` so hotkey visibility never lies mid-prewarm.
        unsafe {
            use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};
            let open: i32 = 0;
            let _ = DwmSetWindowAttribute(
                h,
                DWMWA_CLOAK,
                &open as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
        unsafe {
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
        }
        std::thread::sleep(Duration::from_millis(settle_ms));
        // Best-effort compose flush before we hide again.
        unsafe {
            use windows::Win32::Graphics::Dwm::DwmFlush;
            let _ = DwmFlush();
        }
        // Raced by a real show (or revealed mid-cycle): the show path owns
        // the window now — restore position, touch nothing else, report cold.
        // Hiding here would swallow the user's open; re-cloaking would strand
        // it invisible with the flag claiming revealed.
        let raced = gen_guard
            .map(|g| {
                crate::hotkey::enlarged_show_gen() != g
                    || !crate::hotkey::MAIN_CLOAKED.load(Ordering::SeqCst)
            })
            .unwrap_or(false);
        if raced {
            if let Some(p) = orig {
                unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
                    };
                    let _ = SetWindowPos(
                        h,
                        HWND(std::ptr::null_mut()),
                        p.x,
                        p.y,
                        0,
                        0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
            }
            return false;
        }
        unsafe {
            let _ = ShowWindow(h, SW_HIDE);
        }
        if let Some(p) = orig {
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
                };
                let _ = SetWindowPos(
                    h,
                    HWND(std::ptr::null_mut()),
                    p.x,
                    p.y,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
        }
        // Physical re-cloak while hidden (logical flags were never
        // changed). Show/hide cycles can also clear DWMWA_CLOAK on some
        // drivers — belt-and-braces through the normal path too.
        crate::hotkey::set_window_cloaked(win, true);
        let _ = label;
        let _ = Ordering::SeqCst;
        return true;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (win, label, settle_ms, gen_guard);
    #[cfg(not(target_os = "windows"))]
    false
}

pub fn prewarm_first_paint(app: &AppHandle, only: Option<&str>) {
    #[cfg(target_os = "windows")]
    {
        use std::sync::atomic::Ordering;
        use std::sync::MutexGuard;
        for label in ["main", "overlay"] {
            if let Some(want) = only {
                if want != label {
                    continue;
                }
            }
            let presented = if label == "main" {
                &PRESENTED_MAIN
            } else {
                &PRESENTED_OVERLAY
            };
            let Some(win) = app.get_webview_window(label) else {
                continue;
            };
            // Skip only if the user is actually looking at this window.
            // WS_VISIBLE alone is the normal post-prewarm state and MUST
            // NOT skip — that surface still has no genuine DWM present.
            let revealed = if label == "overlay" {
                !crate::hotkey::OVERLAY_CLOAKED.load(Ordering::SeqCst)
                    || matches!(
                        crate::hotkey::get_overlay_phase(),
                        crate::hotkey::OverlayPhase::Showing
                            | crate::hotkey::OverlayPhase::Shown
                    )
            } else {
                !crate::hotkey::MAIN_CLOAKED.load(Ordering::SeqCst)
            };
            if revealed {
                continue;
            }
            // Once per label: a second caller (late ready + fallback timer)
            // must not re-run the park/show/hide cycle over a live show.
            if presented.swap(true, Ordering::SeqCst) {
                continue;
            }
            // Main: re-assert the non-white controller immediately before
            // the genuine present — a cold COM cast can still be racing
            // prewarm's one-shot setters, and that white default would be
            // baked into the only first frame the user ever sees.
            if label == "main" {
                crate::hotkey::prepare_main_surface(app, &win);
            }
            let _guard: MutexGuard<'_, ()> = PRESENT_CYCLE.lock().unwrap_or_else(|e| e.into_inner());
            // Main's EnlargedWindow tree is heavy — give it time to reach a
            // real first present; the overlay frame is much smaller.
            let settle = if label == "main" { 200 } else { 80 };
            let _ = offscreen_present_cycle(&win, label, settle, None);
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (app, only);
}

/// Show-path idle rewarm (main only). The OS can discard a hidden window's
/// DirectComposition surface after idle; `prepare_main_surface` re-asserts
/// controller *colors* but never re-presents, so the next uncloak still
/// composites a cold frame (the residual white flash). Run the same
/// park→present→re-cloak cycle while still logically cloaked, before show.
/// Warm re-present is one-to-two frames; first-ever open waits longer for a
/// real present.
///
/// LOCK CONTRACT: the caller must hold `hold_present_cycle()` across rewarm
/// AND the subsequent native show — the background warmth loop skips its
/// tick while held, so it can never park/hide mid-show. (A blocking hold is
/// correct here: the loop's cycle is ~40ms, so a racing show waits at most
/// that, instead of risking a swallowed open.)
pub fn rewarm_main_surface(app: &AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::sync::atomic::Ordering;
        if !crate::hotkey::MAIN_CLOAKED.load(Ordering::SeqCst) {
            return false;
        }
        let Some(win) = app.get_webview_window("main") else {
            return false;
        };
        // Idle discard takes minutes: a live surface skips the 32-120ms
        // cycle so rapid toggles open instantly. First-ever / long-idle
        // opens still pay it (no cold-frame flash).
        if crate::hotkey::main_surface_warm() {
            return false;
        }
        let already = PRESENTED_MAIN.load(Ordering::SeqCst);
        let settle = if already { 32 } else { 120 };
        crate::paste::log_diag(&format!(
            "[MAIN_SURFACE] rewarm off-screen present (presented={}, settle={}ms)",
            already, settle
        ));
        offscreen_present_cycle(&win, "main", settle, Some(crate::hotkey::enlarged_show_gen()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        false
    }
}

/// Background surface-warmth loop (main only): every MAIN_WARM_LOOP_MS, if
/// the main window is hidden from the user, run one light offscreen present
/// and stamp the warmth clock. Long-idle opens then stay on the warm path
/// (30ms pop, no cold flash, no surprise fade) instead of decaying cold.
/// Hands off a revealed window (logical cloak flag — never native
/// is_visible, which stays true under the cloak by design). try_lock:
/// never contend a live show — skip the tick instead. Generation-guarded:
/// a show that races the cycle aborts the stamp (the cycle itself restores
/// position and never re-cloaks a raced window).
pub fn spawn_main_warmth_loop(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(
            crate::hotkey::MAIN_WARM_LOOP_MS,
        ));
        #[cfg(target_os = "windows")]
        {
            use std::sync::atomic::Ordering;
            let Ok(_guard) = PRESENT_CYCLE.try_lock() else {
                continue;
            };
            if !crate::hotkey::MAIN_CLOAKED.load(Ordering::SeqCst) {
                continue;
            }
            let Some(win) = app.get_webview_window("main") else {
                continue;
            };
            let gen_before = crate::hotkey::enlarged_show_gen();
            if offscreen_present_cycle(&win, "main", 32, Some(gen_before)) {
                crate::hotkey::note_main_warm();
            }
        }
    });
}
