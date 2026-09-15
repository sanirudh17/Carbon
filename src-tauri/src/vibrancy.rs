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
pub fn set_window_default_background(
    window: &WebviewWindow,
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
            unsafe {
                let _ = controller2.SetDefaultBackgroundColor(color);
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (window, material, theme);
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
/// user can't see it. A cloaked window is excluded from DWM composition, so
/// the cloak-gated prewarm alone never produces a genuine first present —
/// the first uncloaked present then comes out white (the "first hotkey press
/// flashes" bug, ported from final-visual-polish). The windows are parked
/// off-screen and shown WITHOUT activation (SW_SHOWNOACTIVATE) so real
/// composition happens, then hidden and restored — nothing visible on screen.
/// Callers must re-cloak afterwards: show/hide cycles can clear the DWM cloak
/// flag on some drivers.
pub fn prewarm_first_paint(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use std::time::Duration;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE};
        for label in ["main", "overlay"] {
            let Some(win) = app.get_webview_window(label) else {
                continue;
            };
            if win.is_visible().unwrap_or(false) {
                continue;
            }
            let Ok(hwnd) = win.hwnd() else {
                continue;
            };
            let orig = win.outer_position().ok();
            let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: -32000,
                y: -32000,
            }));
            let h_raw: isize = hwnd.0 as isize;
            let h = HWND(h_raw as *mut _);
            unsafe {
                let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
            }
            std::thread::sleep(Duration::from_millis(80));
            unsafe {
                let _ = ShowWindow(h, SW_HIDE);
            }
            if let Some(p) = orig {
                let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                    x: p.x,
                    y: p.y,
                }));
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}
