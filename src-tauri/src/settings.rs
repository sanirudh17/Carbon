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

fn default_expansion_enabled() -> bool {
    true
}

fn default_show_snippets() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSettings {
    pub quick_hotkey: String,
    pub enlarged_hotkey: String,
    pub paste_plain_text: bool,
    pub move_to_top_on_paste: bool,
    pub keep_window_warm: bool,
    pub start_with_windows: bool,
    pub retention_days: u32,
    pub max_entries: u32,
    pub image_size_limit_mb: u32,
    pub accent_color: String,
    pub theme: String,
    pub ignore_apps: Vec<String>,
    /// Quick Overlay: whether the preview pane is shown (persisted).
    #[serde(default = "default_false")]
    pub preview_enabled: bool,
    /// Quick Overlay: which tab opens by default ("clips" | "snippets").
    #[serde(default = "default_overlay_tab")]
    pub overlay_default_tab: String,
    /// Whether sensitive data detection and auto-expiry is enabled.
    #[serde(default = "default_false")]
    pub detect_sensitive_data: bool,
    /// Whether ClipMerge (append-on-repeat-copy within a time window) is enabled.
    #[serde(default = "default_false")]
    pub clip_merge_enabled: bool,
    /// Time window in milliseconds to trigger ClipMerge (e.g. 2500ms).
    #[serde(default = "default_merge_window")]
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
}

fn default_false() -> bool {
    false
}

fn default_overlay_tab() -> String {
    "clips".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            quick_hotkey: "Ctrl+Shift+Z".to_string(),
            enlarged_hotkey: "Ctrl+Alt+X".to_string(),
            paste_plain_text: false,
            move_to_top_on_paste: true,
            keep_window_warm: true,
            start_with_windows: true,
            retention_days: 30,
            max_entries: 5000,
            image_size_limit_mb: 20,
            accent_color: "#5B7CFA".to_string(),
            theme: "dark".to_string(),
            ignore_apps: vec![
                "1Password.exe".to_string(),
                "KeePass.exe".to_string(),
                "KeePassXC.exe".to_string(),
                "Bitwarden.exe".to_string(),
                "Enpass.exe".to_string(),
                "Dashlane.exe".to_string(),
                "LastPass.exe".to_string(),
            ],
            preview_enabled: false,
            overlay_default_tab: "clips".to_string(),
            detect_sensitive_data: false,
            clip_merge_enabled: false,
            clip_merge_window_ms: 2500,
            strip_tracking_params: false,
            capture_rules: Vec::new(),
            snippet_expansion_enabled: true,
            show_snippets: true,
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

    pub fn update(&self, new_settings: AppSettings) -> Result<(), String> {
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
