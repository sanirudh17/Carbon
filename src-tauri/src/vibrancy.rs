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

/// Configures Windows DWM rounded corners for the window and clips frameless HUD windows to exact rounded geometry.
pub fn set_round_corners(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE};
        use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
        use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

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

                // For frameless HUD windows (overlay, pill), clip the HWND region to an exact 14px rounded rect
                // taking display scaling into account so no underlying rectangular acrylic backdrop or ghost frame can protrude at corners.
                let label = window.label();
                if label == "overlay" || label == "pill" {
                    let mut rect = windows::Win32::Foundation::RECT::default();
                    if GetClientRect(hwnd, &mut rect).is_ok() {
                        let w = rect.right - rect.left;
                        let h = rect.bottom - rect.top;
                        if w > 0 && h > 0 {
                            let scale = window.scale_factor().unwrap_or(1.0);
                            let r = (14.0 * scale).round() as i32;
                            let d = r * 2;
                            let hrgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, d + 1, d + 1);
                            let _ = SetWindowRgn(hwnd, hrgn, true);
                        }
                    }
                }
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
