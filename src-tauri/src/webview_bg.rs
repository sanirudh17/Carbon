/// Forces the WebView2 surface itself to fully transparent at creation via
/// ICoreWebView2Controller::put_DefaultBackgroundColor(ARGB 0,0,0,0) —
/// belt-and-braces on top of the WEBVIEW2_DEFAULT_BACKGROUND_COLOR=0 env var
/// set in run(). Chromium suspends rendering on hidden/occluded windows, so
/// show() after hide() and SetWindowPos resizes can present one unpainted
/// (controller-default white) frame — the white flash. A transparent
/// controller default removes that frame: any not-yet-painted present
/// composites as transparent instead of white.
pub fn set_webview_transparent_background<W: tauri::Runtime>(webview: &tauri::Webview<W>) -> bool {
    #[cfg(target_os = "windows")]
    {
        let applied_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let applied_flag_inner = applied_flag.clone();
        let _ = webview.with_webview(move |platform_webview| {
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
                if controller2.SetDefaultBackgroundColor(transparent).is_ok() {
                    applied_flag_inner.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
        });
        let applied = applied_flag.load(std::sync::atomic::Ordering::SeqCst);
        if !applied {
            eprintln!("[WEBVIEW_BG] transparent background NOT applied (controller not ready) — retry will follow.");
        }
        applied
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = webview;
        true
    }
}
