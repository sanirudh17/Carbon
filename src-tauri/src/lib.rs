mod clipboard_watcher;
mod db;
mod expansion;
mod history;
mod hotkey;
mod ocr;
mod paste;
mod sensitive;
mod settings;
mod titles;

use clipboard_watcher::ClipboardWatcher;
use db::{ClipItem, Collection, DbState, DbStats, Snippet};
use history::HistoryManager;
use hotkey::{handle_enlarged_hotkey, handle_overlay_hotkey, HotkeyManager};
use paste::PasteTransform;
use settings::{AppSettings, SettingsState};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent,
};

struct AppState {
    db: Arc<DbState>,
    settings: Arc<SettingsState>,
    watcher: Arc<ClipboardWatcher>,
    paste_queue: Arc<Mutex<VecDeque<String>>>,
}

#[tauri::command]
async fn get_today_clips(
    state: State<'_, AppState>,
    search: Option<String>,
    category: Option<String>,
    collection_id: Option<String>,
) -> Result<Vec<ClipItem>, String> {
    state
        .db
        .get_today_entries(search.as_deref(), category.as_deref(), collection_id.as_deref())
}

#[tauri::command]
async fn get_all_clips(
    state: State<'_, AppState>,
    search: Option<String>,
    category: Option<String>,
    pinned_only: Option<bool>,
    collection_id: Option<String>,
) -> Result<Vec<ClipItem>, String> {
    state.db.get_all_entries(
        search.as_deref(),
        category.as_deref(),
        pinned_only.unwrap_or(false),
        collection_id.as_deref(),
    )
}

#[tauri::command]
fn log_client_event(event: String) {
    paste::log_diag(&format!("[CLIENT_WEBVIEW] {}", event));
}

#[tauri::command]
fn queue_add_clips(
    state: State<'_, AppState>,
    ids: Vec<String>,
    app_handle: AppHandle,
) -> Result<usize, String> {
    let mut queue = state.paste_queue.lock().map_err(|e| e.to_string())?;
    for id in ids {
        if !id.trim().is_empty() {
            queue.push_back(id);
        }
    }
    let len = queue.len();

    // Prepare the first queued item on the clipboard for immediate pasting
    if let Some(first_id) = queue.front() {
        if let Ok(clips) = state.db.get_all_entries(None, None, false, None) {
            if let Some(first_item) = clips.into_iter().find(|c| &c.id == first_id) {
                paste::write_item_to_clipboard(&first_item, false).ok();
                crate::clipboard_watcher::mark_paste(&first_item);
            }
        }
    }

    let _ = app_handle.emit("paste-queue-updated", ());
    Ok(len)
}

#[tauri::command]
fn queue_remove_clip(
    state: State<'_, AppState>,
    id: String,
    app_handle: AppHandle,
) -> Result<usize, String> {
    let mut queue = state.paste_queue.lock().map_err(|e| e.to_string())?;
    if let Some(pos) = queue.iter().position(|x| x == &id) {
        queue.remove(pos);
    }
    let len = queue.len();

    if let Some(first_id) = queue.front() {
        if let Ok(clips) = state.db.get_all_entries(None, None, false, None) {
            if let Some(first_item) = clips.into_iter().find(|c| &c.id == first_id) {
                paste::write_item_to_clipboard(&first_item, false).ok();
                crate::clipboard_watcher::mark_paste(&first_item);
            }
        }
    }

    let _ = app_handle.emit("paste-queue-updated", ());
    Ok(len)
}

#[tauri::command]
fn queue_clear(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let mut queue = state.paste_queue.lock().map_err(|e| e.to_string())?;
    queue.clear();
    let _ = app_handle.emit("paste-queue-updated", ());
    Ok(())
}

#[tauri::command]
async fn queue_get_clips(
    state: State<'_, AppState>,
) -> Result<Vec<ClipItem>, String> {
    let queue = state.paste_queue.lock().map_err(|e| e.to_string())?;
    let all_clips = state.db.get_all_entries(None, None, false, None)?;
    let mut result = Vec::new();
    for id in queue.iter() {
        if let Some(clip) = all_clips.iter().find(|c| &c.id == id) {
            result.push(clip.clone());
        }
    }
    Ok(result)
}

#[tauri::command]
fn queue_paste_next(
    state: State<'_, AppState>,
    plain_text: Option<bool>,
    transform: Option<String>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    let target_id = {
        let mut queue = state.paste_queue.lock().map_err(|e| e.to_string())?;
        queue.pop_front()
    };

    let target_id = match target_id {
        Some(id) => id,
        None => return Ok(()),
    };

    let clips = state.db.get_all_entries(None, None, false, None)?;
    if let Some(item) = clips.into_iter().find(|c| c.id == target_id) {
        let settings = state.settings.get();
        let transform = match transform.as_deref() {
            None => {
                if plain_text.unwrap_or(settings.paste_plain_text) {
                    PasteTransform::PlainText
                } else {
                    PasteTransform::Original
                }
            }
            Some("plain") => PasteTransform::PlainText,
            Some("markdown") => PasteTransform::Markdown,
            Some("json") => PasteTransform::Json,
            Some("uppercase") => PasteTransform::Uppercase,
            Some("lowercase") => PasteTransform::Lowercase,
            Some("titlecase") => PasteTransform::TitleCase,
            Some("base64_encode") => PasteTransform::Base64Encode,
            Some("base64_decode") => PasteTransform::Base64Decode,
            Some("url_encode") => PasteTransform::UrlEncode,
            Some("url_decode") => PasteTransform::UrlDecode,
            Some(_) => return Err("Unknown paste transform".to_string()),
        };

        if settings.move_to_top_on_paste {
            state.db.bump_entry(&target_id).ok();
        }

        if window.label() == "overlay" {
            if let Some(win) = app_handle.get_webview_window("overlay") {
                win.hide().ok();
            }
        } else {
            window.hide().ok();
        }

        paste::paste_item(&item, transform)?;

        // If there are more items in queue, prepare the next one on the clipboard
        let queue = state.paste_queue.lock().map_err(|e| e.to_string())?;
        if let Some(next_id) = queue.front() {
            if let Ok(all) = state.db.get_all_entries(None, None, false, None) {
                if let Some(next_item) = all.into_iter().find(|c| &c.id == next_id) {
                    paste::write_item_to_clipboard(&next_item, false).ok();
                    crate::clipboard_watcher::mark_paste(&next_item);
                }
            }
        }

        let _ = app_handle.emit("paste-queue-updated", ());
        let _ = app_handle.emit("clipboard-updated", ());
    }
    Ok(())
}

#[tauri::command]
fn paste_clip(
    state: State<'_, AppState>,
    id: String,
    plain_text: Option<bool>,
    transform: Option<String>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    // If this item was in the queue, remove it from the queue
    {
        let mut queue = state.paste_queue.lock().map_err(|e| e.to_string())?;
        if let Some(pos) = queue.iter().position(|x| x == &id) {
            queue.remove(pos);
        }
    }

    paste::log_diag(&format!(
        "[PASTE_CLIP] Called for id='{}', window='{}', transform={:?}",
        id, window.label(), transform
    ));
    let clips = state.db.get_all_entries(None, None, false, None)?;
    if let Some(item) = clips.into_iter().find(|c| c.id == id) {
        let settings = state.settings.get();
        let transform = match transform.as_deref() {
            None => {
                if plain_text.unwrap_or(settings.paste_plain_text) {
                    PasteTransform::PlainText
                } else {
                    PasteTransform::Original
                }
            }
            Some("plain") => PasteTransform::PlainText,
            Some("markdown") => PasteTransform::Markdown,
            Some("json") => PasteTransform::Json,
            Some("uppercase") => PasteTransform::Uppercase,
            Some("lowercase") => PasteTransform::Lowercase,
            Some("titlecase") => PasteTransform::TitleCase,
            Some("base64_encode") => PasteTransform::Base64Encode,
            Some("base64_decode") => PasteTransform::Base64Decode,
            Some("url_encode") => PasteTransform::UrlEncode,
            Some("url_decode") => PasteTransform::UrlDecode,
            Some(_) => return Err("Unknown paste transform".to_string()),
        };

        if settings.move_to_top_on_paste {
            state.db.bump_entry(&id).ok();
        }

        paste::log_diag(&format!(
            "[PASTE_CLIP] Hiding window '{}' before initiating paste...",
            window.label()
        ));

        // Dismiss whichever surface initiated the paste BEFORE triggering paste_item,
        // so the OS can smoothly transition foreground focus to the target window.
        if window.label() == "overlay" {
            if let Some(win) = app_handle.get_webview_window("overlay") {
                let hide_res = win.hide();
                paste::log_diag(&format!("[PASTE_CLIP] overlay win.hide() returned {:?}", hide_res));
            }
        } else {
            let hide_res = window.hide();
            paste::log_diag(&format!("[PASTE_CLIP] main win.hide() returned {:?}", hide_res));
        }

        paste::log_diag("[PASTE_CLIP] Calling paste_item...");
        paste::paste_item(&item, transform)?;

        let _ = app_handle.emit("paste-queue-updated", ());
        let _ = app_handle.emit("clipboard-updated", ());
    } else {
        paste::log_diag(&format!("[PASTE_CLIP] ERROR: clip id '{}' not found in db!", id));
    }
    Ok(())
}

#[tauri::command]
fn copy_clip(
    state: State<'_, AppState>,
    id: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    paste::log_diag(&format!("[COPY_CLIP] Called for clip '{}'", id));
    let clips = state.db.get_all_entries(None, None, false, None)?;
    if let Some(item) = clips.into_iter().find(|c| c.id == id) {
        state.db.bump_entry(&id).ok();
        paste::write_item_to_clipboard(&item, false)?;
        crate::clipboard_watcher::mark_paste(&item);
        let _ = app_handle.emit("clipboard-updated", ());
    }
    Ok(())
}

#[tauri::command]
fn update_clip_text(
    state: State<'_, AppState>,
    id: String,
    text: String,
) -> Result<(), String> {
    state.db.update_entry_text(&id, &text)
}

#[tauri::command]
fn toggle_pin_clip(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    state.db.toggle_pin(&id)
}

#[tauri::command]
fn delete_clip(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_entry(&id)
}

#[tauri::command]
fn bulk_delete_clips(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    state.db.bulk_delete_entries(&ids)
}

#[tauri::command]
fn bulk_pin_clips(state: State<'_, AppState>, ids: Vec<String>, pin: bool) -> Result<(), String> {
    state.db.bulk_pin_entries(&ids, pin)
}

#[tauri::command]
fn export_backup_json(state: State<'_, AppState>) -> Result<String, String> {
    let backup = state.db.export_backup()?;
    serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_backup_json(
    state: State<'_, AppState>,
    json_data: String,
    app: AppHandle,
) -> Result<db::ImportResult, String> {
    let payload: db::BackupPayload =
        serde_json::from_str(&json_data).map_err(|e| format!("Invalid backup file format: {}", e))?;
    // Never restore snippet_expansion_enabled from backup — that flag is excluded
    // by design (restoring must not silently re-enable system-wide keystroke monitoring).
    let app_data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap());
    let media_dir = app_data_dir.join("media");
    let result = state.db.import_backup(payload, &media_dir)?;
    expansion::on_snippets_changed();
    let _ = app.emit("clipboard-updated", ());
    let _ = app.emit("expansion-status-changed", expansion::get_expansion_status());
    Ok(result)
}

#[tauri::command]
fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    state.db.clear_unpinned()
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings.get()
}

#[tauri::command]
fn save_settings(
    state: State<'_, AppState>,
    new_settings: AppSettings,
    app: AppHandle,
) -> Result<(), String> {
    let old_expansion = state.settings.get().snippet_expansion_enabled;
    // Persist the user's choice first, then (re)register. If the chosen combo
    // is claimed by another app, registration auto-falls back to a free combo
    // and persists that, so the effective binding always survives restarts.
    state.settings.update(new_settings)?;

    use hotkey::register_global_hotkeys;
    let current = state.settings.get();
    state.db.trim_history(current.retention_days, current.max_entries).ok();
    register_global_hotkeys(&app, &state.settings, &current.quick_hotkey, &current.enlarged_hotkey);
    // Sync expansion hook with the (possibly) new enabled flag — settings already
    // persisted above, so just toggle the hook (no second settings write).
    if old_expansion != current.snippet_expansion_enabled {
        expansion::set_hook_enabled(current.snippet_expansion_enabled);
    }
    let _ = app.emit("settings-updated", &current);
    let _ = app.emit("expansion-status-changed", expansion::get_expansion_status());
    let _ = app.emit("clipboard-updated", ());
    Ok(())
}

#[tauri::command]
fn get_expansion_status() -> expansion::ExpansionStatus {
    expansion::get_expansion_status()
}

#[tauri::command]
fn set_snippet_expansion_enabled(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    enabled: bool,
) -> Result<expansion::ExpansionStatus, String> {
    // Single toggle is the consent — explain in Settings UI before calling.
    let mut s = state.settings.get();
    s.snippet_expansion_enabled = enabled;
    state.settings.update(s)?;
    expansion::set_expansion_enabled(enabled)?;
    let st = expansion::get_expansion_status();
    let _ = app_handle.emit("settings-updated", &state.settings.get());
    let _ = app_handle.emit("expansion-status-changed", st.clone());
    Ok(st)
}

#[tauri::command]
fn set_show_snippets(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let mut s = state.settings.get();
    s.show_snippets = enabled;
    state.settings.update(s)?;
    let _ = app_handle.emit("settings-updated", &state.settings.get());
    Ok(())
}

#[tauri::command]
fn submit_arg_prompt(value: Option<String>) -> Result<(), String> {
    expansion::submit_arg_prompt_response(value)
}

#[tauri::command]
fn get_pending_arg_request() -> Option<expansion::ArgPromptRequest> {
    expansion::get_pending_arg_request()
}

#[tauri::command]
fn get_hotkey_status() -> Option<hotkey::HotkeyStatus> {
    hotkey::get_hotkey_status()
}

/// Remembers which tab ("clips" | "snippets") the Quick Overlay opens with.
#[tauri::command]
fn set_overlay_default_tab(state: State<'_, AppState>, app_handle: AppHandle, tab: String) -> Result<(), String> {
    let tab = if tab == "snippets" { "snippets".to_string() } else { "clips".to_string() };
    let mut settings = state.settings.get();
    settings.overlay_default_tab = tab.clone();
    state.settings.update(settings)?;
    let _ = app_handle.emit("settings-updated", &state.settings.get());
    Ok(())
}

#[tauri::command]
fn get_target_app_name() -> Option<String> {
    paste::get_target_app_name()
}

/// Toggles the Quick Overlay preview pane. Persists the choice (so it
/// survives restarts) and resizes the overlay window to match, anchoring
/// the window's center so it doesn't jump.
#[tauri::command]
fn set_overlay_preview(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    window: WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = state.settings.get();
    settings.preview_enabled = enabled;
    state.settings.update(settings)?;

    let scale = window.scale_factor().unwrap_or(1.0);
    let (w_log, h_log) = if enabled { (1020, 560) } else { (680, 440) };
    let (w_phys, h_phys) = (
        (w_log as f64 * scale).round() as u32,
        (h_log as f64 * scale).round() as u32,
    );

    // Anchor around the window's CURRENT center so toggling the preview never
    // teleports the overlay (previously this used the cursor position, which
    // made the window jump if the mouse had moved since it was summoned).
    let mut pos_x: i32;
    let mut pos_y: i32;
    if let (Ok(old_pos), Ok(old_size)) = (window.outer_position(), window.outer_size()) {
        let cx = old_pos.x + old_size.width as i32 / 2;
        let cy = old_pos.y + old_size.height as i32 / 2;
        pos_x = cx - w_phys as i32 / 2;
        pos_y = cy - h_phys as i32 / 2;
        // Clamp into the current monitor so the resized window stays on-screen
        if let Ok(Some(monitor)) = window.current_monitor() {
            let m_pos = monitor.position();
            let m_size = monitor.size();
            let max_x = m_pos.x + m_size.width as i32 - w_phys as i32;
            let max_y = m_pos.y + m_size.height as i32 - h_phys as i32;
            pos_x = pos_x.clamp(m_pos.x, max_x.max(m_pos.x));
            pos_y = pos_y.clamp(m_pos.y, max_y.max(m_pos.y));
        }
    } else {
        let (cx, cy) = paste::get_cursor_position();
        let (pos_x_l, pos_y_l) = hotkey::calculate_overlay_position(cx, cy, w_log, h_log, scale);
        pos_x = pos_x_l;
        pos_y = pos_y_l;
    }

    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
        };
        if let Ok(hwnd) = window.hwnd() {
            let h_raw: isize = hwnd.0 as isize;
            let (fx, fy, fw, fh) = if let (Ok(old_pos), Ok(old_size)) =
                (window.outer_position(), window.outer_size())
            {
                (
                    old_pos.x,
                    old_pos.y,
                    old_size.width as i32,
                    old_size.height as i32,
                )
            } else {
                (pos_x, pos_y, w_phys as i32, h_phys as i32)
            };

            // Animate the shell resize (~150ms ease-out) instead of snapping.
            // A generation counter aborts stale animations when Tab is spammed;
            // the final exact frame guarantees the settled rect is correct.
            static ANIM_GEN: std::sync::atomic::AtomicU32 =
                std::sync::atomic::AtomicU32::new(0);
            let gen = ANIM_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            let total_ms: u64 = 150;
            let steps: u32 = 9;
            std::thread::spawn(move || {
                let h = HWND(h_raw as *mut _);
                for i in 1..=steps {
                    std::thread::sleep(std::time::Duration::from_millis(total_ms / steps as u64));
                    if ANIM_GEN.load(std::sync::atomic::Ordering::Relaxed) != gen {
                        return;
                    }
                    let t = i as f32 / steps as f32;
                    let e = 1.0 - (1.0 - t) * (1.0 - t) * (1.0 - t); // ease-out cubic
                    let lerp = |a: i32, b: i32| a + ((b - a) as f32 * e).round() as i32;
                    unsafe {
                        let _ = SetWindowPos(
                            h,
                            None,
                            lerp(fx, pos_x),
                            lerp(fy, pos_y),
                            lerp(fw, w_phys as i32),
                            lerp(fh, h_phys as i32),
                            SWP_NOACTIVATE | SWP_NOZORDER,
                        );
                    }
                }
                if ANIM_GEN.load(std::sync::atomic::Ordering::Relaxed) == gen {
                    unsafe {
                        let _ = SetWindowPos(
                            h,
                            None,
                            pos_x,
                            pos_y,
                            w_phys as i32,
                            h_phys as i32,
                            SWP_NOACTIVATE | SWP_NOZORDER,
                        );
                    }
                }
            });
        }
    }
    #[cfg(not(windows))]
    {
        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: w_phys,
                height: h_phys,
            }))
            .map_err(|e| e.to_string())?;

        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: pos_x,
                y: pos_y,
            }))
            .map_err(|e| e.to_string())?;
    }
    let _ = app_handle.emit("preview-toggled", enabled);
    Ok(())
}

#[tauri::command]
async fn get_stats(state: State<'_, AppState>) -> Result<DbStats, String> {
    state.db.get_stats()
}

#[tauri::command]
fn hide_overlay(app_handle: AppHandle) -> Result<(), String> {
    hotkey::hide_overlay_window(&app_handle);
    Ok(())
}

#[tauri::command]
fn hide_enlarged(window: WebviewWindow) -> Result<(), String> {
    paste::restore_target_window();
    window.hide().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn toggle_overlay(app_handle: AppHandle) -> Result<(), String> {
    handle_overlay_hotkey(&app_handle);
    Ok(())
}

#[tauri::command]
fn toggle_enlarged(app_handle: AppHandle) -> Result<(), String> {
    handle_enlarged_hotkey(&app_handle);
    Ok(())
}

#[tauri::command]
fn toggle_pause_capture(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.watcher.toggle_pause())
}

#[tauri::command]
fn reveal_file_in_explorer(file_path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&file_path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_image_data_url(file_path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let mime = if file_path.ends_with(".png") {
        "image/png"
    } else if file_path.ends_with(".jpg") || file_path.ends_with(".jpeg") {
        "image/jpeg"
    } else if file_path.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    };
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command(async)]
async fn extract_image_ocr(
    state: State<'_, AppState>,
    id: String,
    app_handle: AppHandle,
) -> Result<String, String> {
    let (cached_text, img_path) = {
        let clip = state.db.get_entry_by_id(&id)?.ok_or_else(|| "Clip not found".to_string())?;
        (clip.ocr_text, clip.image_path)
    };

    if let Some(cached) = cached_text {
        if !cached.trim().is_empty() {
            return Ok(cached);
        }
    }

    let path_str = img_path.ok_or_else(|| "Item has no image".to_string())?;
    let path = std::path::PathBuf::from(path_str);

    let out = ocr::recognize_file(&path)?;
    let text = out.text;

    state.db.update_ocr_text(&id, &text)?;
    if let Ok(Some(updated_clip)) = state.db.get_entry_by_id(&id) {
        let _ = app_handle.emit("clipboard-updated", &updated_clip);
    }
    Ok(text)
}

#[tauri::command]
async fn list_collections(state: State<'_, AppState>) -> Result<Vec<Collection>, String> {
    state.db.list_collections()
}

#[tauri::command]
fn create_collection(
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
    icon: Option<String>,
    app_handle: AppHandle,
) -> Result<Collection, String> {
    let col = state.db.create_collection(name, color, icon)?;
    let _ = app_handle.emit("collections-updated", ());
    Ok(col)
}

#[tauri::command]
fn rename_collection(
    state: State<'_, AppState>,
    id: String,
    new_name: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    state.db.rename_collection(&id, &new_name)?;
    let _ = app_handle.emit("collections-updated", ());
    Ok(())
}

#[tauri::command]
fn delete_collection(
    state: State<'_, AppState>,
    id: String,
    delete_clips: Option<bool>,
    app_handle: AppHandle,
) -> Result<(), String> {
    state.db.delete_collection(&id, delete_clips.unwrap_or(false))?;
    let _ = app_handle.emit("collections-updated", ());
    let _ = app_handle.emit("clipboard-updated", ());
    Ok(())
}

#[tauri::command]
fn update_collection_color(
    state: State<'_, AppState>,
    id: String,
    color: Option<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    state.db.update_collection_color(&id, color)?;
    let _ = app_handle.emit("collections-updated", ());
    Ok(())
}

#[tauri::command]
fn set_collection_pin(
    state: State<'_, AppState>,
    id: String,
    pin: String,
    app_handle: AppHandle,
) -> Result<String, String> {
    let recovery_code = state.db.set_collection_pin(&id, &pin)?;
    let _ = app_handle.emit("collections-updated", ());
    Ok(recovery_code)
}

#[tauri::command]
fn change_collection_pin(
    state: State<'_, AppState>,
    id: String,
    pin: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    state.db.change_collection_pin(&id, &pin)?;
    let _ = app_handle.emit("collections-updated", ());
    Ok(())
}

#[tauri::command]
fn verify_collection_pin(
    state: State<'_, AppState>,
    id: String,
    pin: String,
) -> Result<bool, String> {
    state.db.verify_collection_pin(&id, &pin)
}

#[tauri::command]
fn verify_collection_recovery_code(
    state: State<'_, AppState>,
    id: String,
    recovery_code: String,
) -> Result<bool, String> {
    state.db.verify_collection_recovery_code(&id, &recovery_code)
}

#[tauri::command]
fn reset_collection_passcode(
    state: State<'_, AppState>,
    id: String,
    recovery_code: String,
    new_pin: String,
    app_handle: AppHandle,
) -> Result<String, String> {
    let new_recovery_code = state.db.reset_collection_passcode(&id, &recovery_code, &new_pin)?;
    let _ = app_handle.emit("collections-updated", ());
    Ok(new_recovery_code)
}

#[tauri::command]
fn remove_collection_pin(
    state: State<'_, AppState>,
    id: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    state.db.remove_collection_pin(&id)?;
    let _ = app_handle.emit("collections-updated", ());
    Ok(())
}

#[tauri::command]
fn add_clip_to_collection(
    state: State<'_, AppState>,
    clip_id: String,
    collection_id: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    state.db.add_clip_to_collection(&clip_id, &collection_id)?;
    let _ = app_handle.emit("collections-updated", ());
    let _ = app_handle.emit("clipboard-updated", ());
    Ok(())
}

#[tauri::command]
fn add_clips_to_collection(
    state: State<'_, AppState>,
    clip_ids: Vec<String>,
    collection_id: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    state.db.add_clips_to_collection(&clip_ids, &collection_id)?;
    let _ = app_handle.emit("collections-updated", ());
    let _ = app_handle.emit("clipboard-updated", ());
    Ok(())
}

#[tauri::command]
fn remove_clip_from_collection(
    state: State<'_, AppState>,
    clip_id: String,
    collection_id: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    state.db.remove_clip_from_collection(&clip_id, &collection_id)?;
    let _ = app_handle.emit("collections-updated", ());
    let _ = app_handle.emit("clipboard-updated", ());
    Ok(())
}

#[tauri::command]
fn get_clip_collection_ids(
    state: State<'_, AppState>,
    clip_id: String,
) -> Result<Vec<String>, String> {
    state.db.get_clip_collection_ids(&clip_id)
}

// --- Snippets Commands ---

#[tauri::command]
fn list_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> {
    state.db.list_snippets()
}

#[tauri::command]
fn create_snippet(
    state: State<'_, AppState>,
    name: String,
    keyword: String,
    content: String,
    tags: Vec<String>,
    icon: Option<String>,
    show_confirmation: bool,
) -> Result<Snippet, String> {
    let sn = state.db.create_snippet(name, keyword, content, tags, icon, show_confirmation)?;
    expansion::on_snippets_changed();
    Ok(sn)
}

#[tauri::command]
fn update_snippet(
    state: State<'_, AppState>,
    id: String,
    name: String,
    keyword: String,
    content: String,
    tags: Vec<String>,
    icon: Option<String>,
    show_confirmation: bool,
) -> Result<Snippet, String> {
    let sn = state
        .db
        .update_snippet(&id, name, keyword, content, tags, icon, show_confirmation)?;
    expansion::on_snippets_changed();
    Ok(sn)
}

#[tauri::command]
fn delete_snippet(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_snippet(&id)?;
    expansion::on_snippets_changed();
    Ok(())
}

#[tauri::command]
fn record_snippet_use(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.record_snippet_use(&id)
}

#[tauri::command]
fn get_recent_clip_texts(state: State<'_, AppState>, limit: usize) -> Result<Vec<String>, String> {
    state.db.get_recent_clip_texts(limit)
}

#[tauri::command]
fn get_selected_text_snapshot() -> Option<String> {
    paste::get_selected_text_snapshot()
}

/// Copies a resolved snippet's text to the clipboard (marked as our own paste
/// so it never enters clip history).
#[tauri::command]
fn copy_snippet_text(text: String) -> Result<(), String> {
    paste::write_text_to_clipboard(&text)
}

/// Pastes a resolved snippet into the saved target window. `post` is the text
/// after a `{cursor}` marker — when present, the caret is walked back there.
#[tauri::command]
fn paste_snippet_text(
    pre: String,
    post: Option<String>,
    window: WebviewWindow,
) -> Result<(), String> {
    paste::log_diag(&format!(
        "[PASTE_SNIPPET] Hiding window '{}' before snippet paste...",
        window.label()
    ));
    let hide_res = window.hide();
    paste::log_diag(&format!(
        "[PASTE_SNIPPET] window.hide() returned {:?}",
        hide_res
    ));
    paste::paste_text_into_target(&pre, post.as_deref())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap());

            let db_path = app_data_dir.join("carbon_history.db");
            let settings_path = app_data_dir.join("settings.json");
            let media_dir = app_data_dir.join("media");

            let db_state = Arc::new(DbState::new(db_path).expect("Failed to initialize SQLite database"));
            let settings_state = Arc::new(SettingsState::new(settings_path));
            let watcher = ClipboardWatcher::start(
                app_handle.clone(),
                db_state.clone(),
                settings_state.clone(),
                media_dir,
            );

            HistoryManager::start_cleanup_task(db_state.clone(), settings_state.clone());
            HotkeyManager::start(app_handle.clone(), settings_state.clone());

            settings::set_autostart(settings_state.get().start_with_windows).ok();

            let paste_queue = Arc::new(Mutex::new(VecDeque::new()));

            app.manage(AppState {
                db: db_state.clone(),
                settings: settings_state.clone(),
                watcher,
                paste_queue,
            });

            // System-wide snippet expansion (Phase B) — hook is off by default
            // and only installed when the user explicitly enables it in Settings.
            expansion::init_expansion(app_handle.clone(), db_state.clone(), settings_state.clone());

            // Build Tray Icon
            let show_i = MenuItem::with_id(app, "show", "Open Carbon", true, None::<&str>)?;
            let overlay_i = MenuItem::with_id(app, "overlay", "Quick Overlay", true, None::<&str>)?;
            let pause_i = MenuItem::with_id(app, "pause", "Pause Capture", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Carbon", true, None::<&str>)?;

            let tray_menu = Menu::with_items(app, &[&show_i, &overlay_i, &pause_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        handle_enlarged_hotkey(app);
                    }
                    "overlay" => {
                        handle_overlay_hotkey(app);
                    }
                    "pause" => {
                        let state = app.state::<AppState>();
                        state.watcher.toggle_pause();
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                window.hide().ok();
            }
            WindowEvent::Focused(focused) => {
                paste::log_diag(&format!(
                    "[WINDOW_EVENT] label='{}', Focused={}. Current FG: {}",
                    window.label(),
                    focused,
                    paste::get_window_diag_info(unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() })
                ));
                if !*focused && window.label() == "overlay" {
                    // Skip if hide_overlay_window is already running (re-entrancy guard)
                    if !hotkey::is_overlay_hiding() && window.is_visible().unwrap_or(false) {
                        paste::log_diag("[WINDOW_EVENT] Overlay lost focus while visible. Calling hide_overlay_window...");
                        hotkey::hide_overlay_window(&window.app_handle());
                    }
                } else if *focused && window.label() == "overlay" {
                    // Push the current list on focus so popup always displays fresh data
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        if let Ok(entries) = state.db.get_all_entries(None, None, false, None) {
                            let _ = window.app_handle().emit("overlay-data", &entries);
                        }
                        // Snippets ride the same fast path: delivered with the
                        // clip list on the same tick the overlay becomes visible,
                        // so the snippets tab is instantly populated (no invoke
                        // round-trip, no loading flash).
                        if let Ok(snips) = state.db.list_snippets() {
                            let _ = window.app_handle().emit("overlay-snippets", &snips);
                        }
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_today_clips,
            get_all_clips,
            paste_clip,
            queue_paste_next,
            copy_clip,
            queue_add_clips,
            queue_remove_clip,
            queue_clear,
            queue_get_clips,
            update_clip_text,
            toggle_pin_clip,
            delete_clip,
            bulk_delete_clips,
            bulk_pin_clips,
            export_backup_json,
            import_backup_json,
            clear_history,
            get_settings,
            save_settings,
            get_expansion_status,
            set_snippet_expansion_enabled,
            set_show_snippets,
            submit_arg_prompt,
            get_pending_arg_request,
            get_hotkey_status,
            get_target_app_name,
            set_overlay_preview,
            set_overlay_default_tab,
            get_stats,
            hide_overlay,
            hide_enlarged,
            toggle_overlay,
            toggle_enlarged,
            toggle_pause_capture,
            reveal_file_in_explorer,
            get_image_data_url,
            extract_image_ocr,
            list_collections,
            create_collection,
            rename_collection,
            update_collection_color,
            delete_collection,
            set_collection_pin,
            change_collection_pin,
            verify_collection_pin,
            verify_collection_recovery_code,
            reset_collection_passcode,
            remove_collection_pin,
            add_clip_to_collection,
            add_clips_to_collection,
            remove_clip_from_collection,
            get_clip_collection_ids,
            list_snippets,
            create_snippet,
            update_snippet,
            delete_snippet,
            record_snippet_use,
            get_recent_clip_texts,
            get_selected_text_snapshot,
            copy_snippet_text,
            paste_snippet_text,
            log_client_event
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
