use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use windows::core::PCWSTR;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegSetValueExW, HKEY_CURRENT_USER, KEY_WRITE,
    REG_OPTION_NON_VOLATILE, REG_SZ,
};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CaptureRule {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub replacement: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

fn default_merge_window() -> u64 {
    2500
}

fn deserialize_clip_merge_window<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = u64::deserialize(deserializer)?;
    Ok(v.clamp(500, 10000))
}

fn default_expansion_enabled() -> bool {
    false
}

fn default_show_snippets() -> bool {
    true
}

fn default_overlay_animation() -> String {
    // "soft" trims the overlay cover layer's extra hide zoom/fade closer to
    // the main window's plain fade. Reversible at runtime via the
    // set_overlay_animation command ("full" restores the original).
    "soft".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSettings {
    pub quick_hotkey: String,
    pub enlarged_hotkey: String,
    pub paste_plain_text: bool,
    /// v32-C: optional post-paste deselect (ONE Right-arrow) for web-class
    /// targets whose engines leave synthetic Ctrl+V inserts selected.
    /// Default OFF per C2 — the default configuration sends NO post-paste
    /// keystroke. serde(default) keeps older settings.json files parsing.
    #[serde(default)]
    pub paste_deselect_after: bool,
    /// Move-to-top for Carbon-initiated actions only: when the user pastes or
    /// copies a clip from Carbon (paste button, paste queue, right-click copy),
    /// move that entry to the top of history. It does NOT affect external
    /// Ctrl+C captures — those are governed by `clip_merge_enabled`. The two
    /// settings are complementary: this one decides whether a Carbon action
    /// relocates the existing entry; ClipMerge decides what an external repeat
    /// copy does (append within the window, fresh copy otherwise).
    pub move_to_top_on_paste: bool,
    // `keep_window_warm` was removed: windows are always kept warm (hidden,
    // never destroyed) for instant open/close. Older settings.json files may
    // still carry the key — serde ignores unknown fields.
    #[serde(default = "default_true")]
    pub start_with_windows: bool,
    pub retention_days: u32,
    pub max_entries: u32,
    pub image_size_limit_mb: u32,
    pub accent_color: String,
    pub theme: String,
    pub ignore_apps: Vec<String>,
    /// Quick Overlay: which tab opens by default ("clips" | "snippets").
    #[serde(default = "default_overlay_tab")]
    pub overlay_default_tab: String,
    /// Whether sensitive data detection and auto-expiry is enabled.
    #[serde(default = "default_false")]
    pub detect_sensitive_data: bool,
    /// ClipMerge: when enabled, external Ctrl+C repeats of text/code/link within
    /// the time window are APPENDED to the last-captured clip (A+A -> "A\nA")
    /// instead of creating a new entry or moving the old one. When disabled,
    /// every external copy inserts a fresh clip (identical re-copies create a
    /// new entry rather than relocating the previous one). This governs external
    /// captures only; `move_to_top_on_paste` governs Carbon's own paste/copy.
    #[serde(default = "default_false")]
    pub clip_merge_enabled: bool,
    /// Time window in milliseconds to trigger ClipMerge (e.g. 2500ms).
    #[serde(default = "default_merge_window", deserialize_with = "deserialize_clip_merge_window")]
    pub clip_merge_window_ms: u64,
    /// Strip URL tracking parameters (utm_source, fbclid, etc.) at capture time.
    #[serde(default = "default_false")]
    pub strip_tracking_params: bool,
    /// User-defined capture-time find/replace rules.
    #[serde(default = "Vec::new")]
    pub capture_rules: Vec<CaptureRule>,
    /// System-wide snippet keyword expansion (WH_KEYBOARD_LL hook). Off by
    /// default — enabling is the explicit consent for keystroke monitoring.
    /// This flag is deliberately excluded from backup/restore.
    #[serde(default = "default_expansion_enabled")]
    pub snippet_expansion_enabled: bool,
    /// Whether the Snippets UI (overlay tab + library section) is visible.
    /// Independent from `snippet_expansion_enabled` — hiding the UI does not
    /// stop an already-enabled expansion hook.
    #[serde(default = "default_show_snippets")]
    pub show_snippets: bool,
    /// Overlay cover-layer animation: "full" (original hide zoom + 90ms fade)
    /// or "soft" (opacity-only 60ms fade, closer to the main window).
    /// Show-path flash guards (cloak gate, paint gate, mask) are untouched by
    /// either mode — this only trims the hide content-layer transition.
    #[serde(default = "default_overlay_animation")]
    pub overlay_animation: String,
    /// Window material blur-behind: "acrylic" | "mica" | "blur" | "solid".
    #[serde(default = "default_window_material")]
    pub window_material: String,
    /// The update version the user dismissed via "Later" — banner stays quiet
    /// for this exact version across restarts. Empty means nothing dismissed.
    /// Only the banner respects this; manual check in Settings always shows.
    #[serde(default, rename = "dismissedUpdateVersion")]
    pub dismissed_update_version: String,
}

fn default_window_material() -> String {
    "acrylic".to_string()
}

fn default_false() -> bool {
    false
}

fn default_overlay_tab() -> String {
    "clips".to_string()
}

fn sanitize_settings(s: &mut AppSettings) {
    s.overlay_default_tab = s.overlay_default_tab.trim().to_lowercase();
    if s.overlay_default_tab != "snippets" {
        s.overlay_default_tab = "clips".to_string();
    }
    s.clip_merge_window_ms = s.clip_merge_window_ms.clamp(500, 10000);
    s.quick_hotkey = s.quick_hotkey.trim().to_string();
    s.enlarged_hotkey = s.enlarged_hotkey.trim().to_string();
    s.accent_color = s.accent_color.trim().to_string();
    s.theme = s.theme.trim().to_string();
    s.window_material = match s.window_material.trim().to_lowercase().as_str() {
        "solid" => "solid".to_string(),
        _ => "acrylic".to_string(),
    };
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            quick_hotkey: "Ctrl+Shift+Z".to_string(),
            enlarged_hotkey: "Ctrl+Alt+X".to_string(),
            paste_plain_text: false,
            paste_deselect_after: false,
            move_to_top_on_paste: true,
            start_with_windows: true,
            retention_days: 30,
            max_entries: 5000,
            image_size_limit_mb: 20,
            accent_color: "#5B7CFA".to_string(),
            theme: "dark".to_string(),
            window_material: "acrylic".to_string(),
            ignore_apps: vec![
                "1Password.exe".to_string(),
                "KeePass.exe".to_string(),
                "KeePassXC.exe".to_string(),
                "Bitwarden.exe".to_string(),
                "Enpass.exe".to_string(),
                "Dashlane.exe".to_string(),
                "LastPass.exe".to_string(),
            ],
            overlay_default_tab: "clips".to_string(),
            detect_sensitive_data: false,
            clip_merge_enabled: false,
            clip_merge_window_ms: 2500,
            strip_tracking_params: false,
            capture_rules: Vec::new(),
            snippet_expansion_enabled: false,
            show_snippets: true,
            overlay_animation: default_overlay_animation(),
            dismissed_update_version: String::new(),
        }
    }
}

pub struct SettingsState {
    pub settings: Mutex<AppSettings>,
    pub file_path: PathBuf,
}

impl SettingsState {
    pub fn new(file_path: PathBuf) -> Self {
        let settings = if file_path.exists() {
            fs::read_to_string(&file_path)
                .ok()
                .and_then(|content| serde_json::from_str::<AppSettings>(&content).ok())
                .map(|mut s| {
                    sanitize_settings(&mut s);
                    s
                })
                .unwrap_or_default()
        } else {
            AppSettings::default()
        };

        let state = SettingsState {
            settings: Mutex::new(settings),
            file_path,
        };

        state.save().ok();
        state
    }

    pub fn get(&self) -> AppSettings {
        self.settings.lock().unwrap().clone()
    }

    pub fn update(&self, mut new_settings: AppSettings) -> Result<(), String> {
        sanitize_settings(&mut new_settings);
        let old_start_with_win = self.settings.lock().unwrap().start_with_windows;
        
        {
            let mut settings = self.settings.lock().unwrap();
            *settings = new_settings.clone();
        }

        self.save()?;

        if old_start_with_win != new_settings.start_with_windows {
            set_autostart(new_settings.start_with_windows)?;
        }

        Ok(())
    }

    /// Persists just the two hotkey strings (used when the app auto-falls
    /// back to a free combo because the configured one is claimed).
    pub fn update_hotkeys(&self, quick: &str, enlarged: &str) -> Result<(), String> {
        {
            let mut settings = self.settings.lock().unwrap();
            settings.quick_hotkey = quick.to_string();
            settings.enlarged_hotkey = enlarged.to_string();
        }
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let content = serde_json::to_string_pretty(&*self.settings.lock().unwrap())
            .map_err(|e| e.to_string())?;

        fs::write(&self.file_path, content).map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub fn set_autostart(enable: bool) -> Result<(), String> {
    unsafe {
        let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Run\0"
            .encode_utf16()
            .collect();
        let app_name: Vec<u16> = "Carbon\0".encode_utf16().collect();

        let mut hkey = std::mem::zeroed();

        let res = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
            None,
        );

        if res.is_err() {
            return Err("Failed to open Registry Run key".to_string());
        }

        if enable {
            if let Ok(exe_path) = std::env::current_exe() {
                let exe_str = format!("\"{}\"\0", exe_path.to_string_lossy());
                let exe_w: Vec<u16> = exe_str.encode_utf16().collect();

                let _ = RegSetValueExW(
                    hkey,
                    PCWSTR(app_name.as_ptr()),
                    0,
                    REG_SZ,
                    Some(std::slice::from_raw_parts(
                        exe_w.as_ptr() as *const u8,
                        exe_w.len() * 2,
                    )),
                );
            }
        } else {
            let _ = RegDeleteValueW(hkey, PCWSTR(app_name.as_ptr()));
        }

        let _ = RegCloseKey(hkey);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_window_material_migration_missing_key() {
        // Simulates an existing settings.json from an older Carbon version without window_material
        let json = r##"{
            "quick_hotkey": "Ctrl+Shift+Z",
            "enlarged_hotkey": "Ctrl+Alt+X",
            "paste_plain_text": false,
            "move_to_top_on_paste": true,
            "start_with_windows": true,
            "retention_days": 30,
            "max_entries": 5000,
            "image_size_limit_mb": 20,
            "accent_color": "#5B7CFA",
            "theme": "dark",
            "ignore_apps": []
        }"##;

        let mut settings: AppSettings = serde_json::from_str(json).expect("should deserialize older settings JSON");
        sanitize_settings(&mut settings);
        assert_eq!(settings.window_material, "acrylic", "missing window_material must default to acrylic");
    }

    #[test]
    fn test_paste_deselect_after_defaults_off_for_older_files() {
        // v32-C: older settings.json has no paste_deselect_after — it must
        // parse (serde default) and stay OFF (C2: no default keystroke).
        let json = r##"{
            "quick_hotkey": "Ctrl+Shift+Z",
            "enlarged_hotkey": "Ctrl+Alt+X",
            "paste_plain_text": false,
            "move_to_top_on_paste": true,
            "start_with_windows": true,
            "retention_days": 30,
            "max_entries": 5000,
            "image_size_limit_mb": 20,
            "accent_color": "#5B7CFA",
            "theme": "dark",
            "ignore_apps": []
        }"##;

        let settings: AppSettings = serde_json::from_str(json).expect("older settings JSON must still parse");
        assert!(!settings.paste_deselect_after, "deselect must default OFF");
    }

    #[test]
    fn test_window_material_sanitization_and_preservation() {
        let cases = vec![
            ("acrylic", "acrylic"),
            ("ACRYLIC", "acrylic"),
            (" Acrylic ", "acrylic"),
            ("mica", "acrylic"),
            ("Mica", "acrylic"),
            ("blur", "acrylic"),
            ("BLUR", "acrylic"),
            ("solid", "solid"),
            ("Solid", "solid"),
            ("invalid_value", "acrylic"),
            ("", "acrylic"),
        ];

        for (input, expected) in cases {
            let mut s = AppSettings::default();
            s.window_material = input.to_string();
            sanitize_settings(&mut s);
            assert_eq!(s.window_material, expected, "input '{}' should sanitize to '{}'", input, expected);
        }
    }
}
