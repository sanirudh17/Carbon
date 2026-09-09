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

/// Returns the tint color tuple (R, G, B, A) corresponding to the theme.
/// For dark theme: deeper, subtle dark tint (18, 18, 20, 160).
/// For light theme: clean, bright translucent white/slate tint (246, 246, 248, 160).
pub fn get_tint_color(theme: &str) -> window_vibrancy::Color {
    if theme == "light" {
        (246, 246, 248, 160)
    } else {
        (18, 18, 20, 160)
    }
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
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE};

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
/// Any error logs and falls back to solid without panicking.
pub fn apply_window_material(window: &WebviewWindow, material: WindowMaterial, theme: &str) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};
        if let Ok(w_hwnd) = window.hwnd() {
            unsafe {
                let hwnd = windows::Win32::Foundation::HWND(w_hwnd.0 as _);
                let is_dark: i32 = if theme == "light" { 0 } else { 1 };
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
                let tint = get_tint_color(theme);
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
                if let Ok(w_hwnd) = window.hwnd() {
                    unsafe {
                        let hwnd = windows::Win32::Foundation::HWND(w_hwnd.0 as _);
                        let is_dark: i32 = if theme == "light" { 0 } else { 1 };
                        let _ = DwmSetWindowAttribute(
                            hwnd,
                            DWMWA_USE_IMMERSIVE_DARK_MODE,
                            &is_dark as *const _ as *const std::ffi::c_void,
                            std::mem::size_of::<i32>() as u32,
                        );
                    }
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
        let _ = (window, material, theme);
    }
}

/// Applies the given material to all live webview windows.
pub fn apply_to_all_windows(app: &AppHandle, material: WindowMaterial, theme: &str) {
    for (_, win) in app.webview_windows() {
        apply_window_material(&win, material, theme);
    }
}

/// Helper called on single window creation / setup to initialize vibrancy once.
pub fn init_window_vibrancy(window: &WebviewWindow, app: &AppHandle) {
    set_round_corners(window);
    if let Some(state) = app.try_state::<crate::AppState>() {
        let settings = state.settings.get();
        let mat = WindowMaterial::from_str(&settings.window_material);
        apply_window_material(window, mat, &settings.theme);
    }
}

/// Forces the WebView2 surface itself to fully transparent at creation via
/// ICoreWebView2Controller::put_DefaultBackgroundColor(ARGB 0,0,0,0) —
/// belt-and-braces on top of WEBVIEW2_DEFAULT_BACKGROUND_COLOR=0. Chromium
/// suspends rendering on hidden/occluded windows, so show() after hide() can
/// present one unpainted (controller-default white) frame. A transparent
/// controller default plus the keep-painting browser args
/// (--disable-backgrounding-occluded-windows etc.) remove that frame in BOTH
/// Glass and Solid modes — the choreography is mode-agnostic.
pub fn set_webview_transparent_background<W: tauri::Runtime>(webview: &tauri::Webview<W>) {
    #[cfg(target_os = "windows")]
    {
        let _ = webview.with_webview(|platform_webview| {
            use windows_core::Interface;
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2Controller, ICoreWebView2Controller2, COREWEBVIEW2_COLOR,
            };
            let controller: ICoreWebView2Controller = platform_webview.controller();
            // DefaultBackgroundColor lives on ICoreWebView2Controller2
            // (WebView2 1.0.774+): cast the base controller via its COM GUID.
            let controller2: ICoreWebView2Controller2 = match controller.cast() {
                Ok(c) => c,
                Err(_) => return,
            };
            unsafe {
                // A = 0 -> fully transparent (the RGB bytes are don't-care).
                let transparent = COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 };
                let _ = controller2.SetDefaultBackgroundColor(transparent);
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = webview;
}
