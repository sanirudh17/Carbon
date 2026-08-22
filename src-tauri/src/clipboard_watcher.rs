use crate::db::{ClipItem, DbState};
use crate::settings::SettingsState;
use crate::titles::format_clean_title;
use image::{ImageBuffer, Rgba};
use regex::Regex;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::BITMAPINFOHEADER;
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, RemoveClipboardFormatListener,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::ProcessStatus::K32GetModuleFileNameExW;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};
use windows::Win32::UI::Shell::DragQueryFileW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowThreadProcessId,
    RegisterClassExW, MSG, WM_CLIPBOARDUPDATE, WM_DESTROY, WNDCLASSEXW, WS_OVERLAPPEDWINDOW,
};

const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;
const CF_DIBV5: u32 = 17;

pub struct ClipboardWatcher {
    pub paused: Arc<AtomicBool>,
}

static LAST_CONTENT_HASH: Mutex<Option<u64>> = Mutex::new(None);
static LAST_CAPTURED_CLIP: Mutex<Option<(String, u64, String)>> = Mutex::new(None);
static RETRY_STATE: Mutex<(u64, u32)> = Mutex::new((0, 0));

pub fn strip_url_tracking_parameters(input: &str) -> String {
    let trimmed = input.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return input.to_string();
    }
    if let Ok(mut url) = url::Url::parse(trimmed) {
        let tracking_keys: std::collections::HashSet<&str> = [
            "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
            "fbclid", "gclid", "gclsrc", "dclid", "msclkid", "zanpid", "mc_cid", "mc_eid",
            "igshid", "si", "ref_src", "ref_url", "_ga", "_gl", "yclid", "_hsenc", "_hsmi"
        ].into_iter().collect();

        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(k, _)| !tracking_keys.contains(k.as_ref()))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();

        if pairs.is_empty() {
            url.set_query(None);
        } else {
            let mut new_query = String::new();
            for (i, (k, v)) in pairs.iter().enumerate() {
                if i > 0 {
                    new_query.push('&');
                }
                new_query.push_str(k);
                if !v.is_empty() {
                    new_query.push('=');
                    new_query.push_str(v);
                }
            }
            url.set_query(Some(&new_query));
        }
        return url.to_string();
    }
    input.to_string()
}

/// Content snapshot of the most recent paste performed by Carbon itself.
/// Used to suppress re-capturing our own clipboard writes (content-equality
/// based, so it also covers re-encoded images and plain-text pastes).
pub struct PasteRecord {
    ts_ms: u64,
    content_type: String,
    text_content: Option<String>,
    file_paths: Option<String>,
    image_width: Option<u32>,
    image_height: Option<u32>,
}

static LAST_PASTE: Mutex<Option<PasteRecord>> = Mutex::new(None);

pub fn mark_paste(item: &ClipItem) {
    let rec = PasteRecord {
        ts_ms: now_ms(),
        content_type: item.content_type.clone(),
        text_content: item.text_content.clone(),
        file_paths: item.file_paths.clone(),
        image_width: item.image_width,
        image_height: item.image_height,
    };
    *LAST_PASTE.lock().unwrap() = Some(rec);
}

/// True when `item` (just read from the clipboard) matches what Carbon itself
/// pasted within the last few seconds — such writes must not be re-captured.
fn is_own_paste(item: &ClipItem) -> bool {
    let guard = LAST_PASTE.lock().unwrap();
    let Some(rec) = guard.as_ref() else { return false };
    if now_ms().saturating_sub(rec.ts_ms) > 2500 {
        return false;
    }
    match item.content_type.as_str() {
        "image" => {
            rec.content_type == "image"
                && item.image_width == rec.image_width
                && item.image_height == rec.image_height
        }
        "file" => {
            item.file_paths.is_some()
                && item.file_paths.as_deref() == rec.file_paths.as_deref()
        }
        _ => {
            let t = item.text_content.as_deref().unwrap_or("");
            let rt = rec.text_content.as_deref().unwrap_or("");
            !t.is_empty() && t == rt
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl ClipboardWatcher {
    pub fn start(
        app_handle: AppHandle,
        db_state: Arc<DbState>,
        settings_state: Arc<SettingsState>,
        media_dir: PathBuf,
    ) -> Arc<Self> {
        let paused = Arc::new(AtomicBool::new(false));
        let watcher = Arc::new(ClipboardWatcher {
            paused: paused.clone(),
        });

        let watcher_clone = watcher.clone();

        thread::spawn(move || {
            unsafe {
                let instance = GetModuleHandleW(None).unwrap_or_default();
                let class_name: Vec<u16> = "CarbonClipboardWatcherClass\0".encode_utf16().collect();

                let wnd_class = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    lpfnWndProc: Some(wnd_proc),
                    hInstance: instance.into(),
                    lpszClassName: PCWSTR(class_name.as_ptr()),
                    ..Default::default()
                };

                RegisterClassExW(&wnd_class);

                if let Ok(hwnd) = CreateWindowExW(
                    Default::default(),
                    PCWSTR(class_name.as_ptr()),
                    PCWSTR("CarbonClipboardWatcherWindow\0".encode_utf16().collect::<Vec<u16>>().as_ptr()),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    0,
                    0,
                    HWND::default(),
                    None,
                    instance,
                    None,
                ) {
                    if !hwnd.0.is_null() {
                        AddClipboardFormatListener(hwnd).ok();

                        let mut last_seq = 0u32;
                        let mut msg = MSG::default();
                        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                            if msg.message == WM_CLIPBOARDUPDATE {
                                if !watcher_clone.paused.load(Ordering::Relaxed) {
                                    let seq = GetClipboardSequenceNumber();
                                    if seq != last_seq {
                                        last_seq = seq;
                                        let captured = process_clipboard_change(
                                            &app_handle,
                                            &db_state,
                                            &settings_state,
                                            &media_dir,
                                        );
                                        if !captured {
                                            schedule_deferred_retry(
                                                &app_handle,
                                                &db_state,
                                                &settings_state,
                                                &media_dir,
                                            );
                                        }
                                    }
                                }
                            }
                            DispatchMessageW(&msg);
                        }

                        RemoveClipboardFormatListener(hwnd).ok();
                    }
                }
            }
        });

        watcher
    }

    pub fn toggle_pause(&self) -> bool {
        let cur = self.paused.load(Ordering::Relaxed);
        let next = !cur;
        self.paused.store(next, Ordering::Relaxed);
        next
    }
}

extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_DESTROY => {
                RemoveClipboardFormatListener(hwnd).ok();
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

/// If a clipboard change couldn't be read (transient lock, slow owner, delayed
/// rendering), retry a few times in the background instead of silently losing
/// the capture.
fn schedule_deferred_retry(
    app_handle: &AppHandle,
    db_state: &Arc<DbState>,
    settings_state: &Arc<SettingsState>,
    media_dir: &PathBuf,
) {
    let now = now_ms();
    let mut state = RETRY_STATE.lock().unwrap();
    if now.saturating_sub(state.0) > 3000 {
        state.1 = 0;
    }
    if state.1 >= 3 {
        return;
    }
    state.1 += 1;
    state.0 = now;
    drop(state);

    let app = app_handle.clone();
    let db = db_state.clone();
    let settings = settings_state.clone();
    let media = media_dir.clone();
    thread::spawn(move || {
        thread::sleep(std::time::Duration::from_millis(300));
        let _ = process_clipboard_change(&app, &db, &settings, &media);
    });
}

fn process_clipboard_change(
    app_handle: &AppHandle,
    db_state: &DbState,
    settings_state: &SettingsState,
    media_dir: &PathBuf,
) -> bool {
    let settings = settings_state.get();

    // 1. Get foreground window process name
    let source_app = get_foreground_app_name();
    if let Some(ref app_name) = source_app {
        let app_lower = app_name.to_lowercase();
        for ignored in &settings.ignore_apps {
            if app_lower.contains(&ignored.to_lowercase()) {
                return false; // Skip password managers
            }
        }
    }

    unsafe {
        let mut opened = false;
        for _ in 0..25 {
            if OpenClipboard(HWND::default()).is_ok() {
                opened = true;
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }

        if !opened {
            return false;
        }

        let html_format = RegisterClipboardFormatW(
            PCWSTR("HTML Format\0".encode_utf16().collect::<Vec<u16>>().as_ptr()),
        );
        let rtf_format = RegisterClipboardFormatW(
            PCWSTR("Rich Text Format\0".encode_utf16().collect::<Vec<u16>>().as_ptr()),
        );

        let mut item: Option<ClipItem> = None;

        // A. CF_HDROP Files
        if IsClipboardFormatAvailable(CF_HDROP).is_ok() {
            if let Ok(handle) = GetClipboardData(CF_HDROP) {
                let hdrop = windows::Win32::UI::Shell::HDROP(handle.0 as *mut _);
                let file_count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);
                let mut paths = Vec::new();
                let mut total_size = 0u64;
                let mut is_video = false;

                for i in 0..file_count {
                    let len = DragQueryFileW(hdrop, i, None);
                    if len > 0 {
                        let mut buf = vec![0u16; (len + 1) as usize];
                        DragQueryFileW(hdrop, i, Some(&mut buf));
                        let path_str = String::from_utf16_lossy(&buf[..len as usize]);
                        let path = PathBuf::from(&path_str);
                        if let Ok(meta) = fs::metadata(&path) {
                            total_size += meta.len();
                        }

                        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                            let ext_lower = ext.to_lowercase();
                            if matches!(
                                ext_lower.as_str(),
                                "mp4" | "mov" | "mkv" | "webm" | "avi" | "wmv" | "flv"
                            ) {
                                is_video = true;
                            }
                        }

                        paths.push(path_str);
                    }
                }

                if !paths.is_empty() {
                    let title = if paths.len() == 1 {
                        PathBuf::from(&paths[0])
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| paths[0].clone())
                    } else {
                        format!("{} files", paths.len())
                    };

                    let file_paths_json = serde_json::to_string(&paths).unwrap_or_default();
                    let id = uuid_v4();

                    item = Some(ClipItem {
                        id,
                        content_type: "file".to_string(),
                        title,
                        text_content: Some(paths.join("\n")),
                        rtf_content: None,
                        html_content: None,
                        image_path: None,
                        image_width: None,
                        image_height: None,
                        file_paths: Some(file_paths_json),
                        is_video,
                        file_size: total_size,
                        is_pinned: false,
                        source_app: source_app.clone(),
                        created_at: String::new(),
                        updated_at: String::new(),
                        qr_content: None,
                        is_sensitive: false,
                        expires_at: None,
                        ocr_text: None,
                    });
                }
            }
        }
        // B. Image CF_DIB or CF_DIBV5
        else if IsClipboardFormatAvailable(CF_DIB).is_ok()
            || IsClipboardFormatAvailable(CF_DIBV5).is_ok()
        {
            let format = if IsClipboardFormatAvailable(CF_DIBV5).is_ok() {
                CF_DIBV5
            } else {
                CF_DIB
            };

            if let Ok(handle) = GetClipboardData(format) {
                let hglobal = HGLOBAL(handle.0 as *mut _);
                let ptr = GlobalLock(hglobal);
                if !ptr.is_null() {
                    let size = GlobalSize(hglobal);
                    let max_bytes = (settings.image_size_limit_mb as u64) * 1024 * 1024;

                    if (settings.image_size_limit_mb == 0 || (size as u64) <= max_bytes)
                        && size > std::mem::size_of::<BITMAPINFOHEADER>()
                    {
                        let header_ptr = ptr as *const BITMAPINFOHEADER;
                        let header = *header_ptr;

                        let width = header.biWidth.abs() as u32;
                        let height = header.biHeight.abs() as u32;

                        if width > 0 && height > 0 {
                            let data_slice =
                                std::slice::from_raw_parts(ptr as *const u8, size as usize);
                            if let Some(img_buf) = parse_dib_to_image(data_slice, width, height) {
                                fs::create_dir_all(media_dir).ok();
                                let id = uuid_v4();
                                let img_filename = format!("img_{}.png", id);
                                let img_full_path = media_dir.join(&img_filename);

                                if img_buf.save(&img_full_path).is_ok() {
                                    let file_size = fs::metadata(&img_full_path)
                                        .map(|m| m.len())
                                        .unwrap_or(size as u64);

                                    let title = "Image".to_string();
                                    let qr_content = decode_qr_content(&img_buf);

                                    item = Some(ClipItem {
                                        id,
                                        content_type: "image".to_string(),
                                        title,
                                        text_content: None,
                                        rtf_content: None,
                                        html_content: None,
                                        image_path: Some(img_full_path.to_string_lossy().to_string()),
                                        image_width: Some(width),
                                        image_height: Some(height),
                                        file_paths: None,
                                        is_video: false,
                                        file_size,
                                        is_pinned: false,
                                        source_app: source_app.clone(),
                                        created_at: String::new(),
                                        updated_at: String::new(),
                                        qr_content,
                                        is_sensitive: false,
                                        expires_at: None,
                                        ocr_text: None,
                                    });
                                }
                            }
                        }
                    }
                    GlobalUnlock(hglobal).ok();
                }
            }
        }
        // C. CF_UNICODETEXT Text / Link / Email / Color / Code / RichText
        else if IsClipboardFormatAvailable(CF_UNICODETEXT).is_ok() {
            if let Ok(handle) = GetClipboardData(CF_UNICODETEXT) {
                let hglobal = HGLOBAL(handle.0 as *mut _);
                let ptr = GlobalLock(hglobal);
                if !ptr.is_null() {
                    let len = (0..).take_while(|&i| *(ptr as *const u16).add(i) != 0).count();
                    let slice = std::slice::from_raw_parts(ptr as *const u16, len);
                    let mut text = String::from_utf16_lossy(slice);
                    GlobalUnlock(hglobal).ok();

                    if !text.trim().is_empty() {
                        // 1. Capture-time URL tracking parameter stripping
                        if settings.strip_tracking_params {
                            text = strip_url_tracking_parameters(&text);
                        }

                        // 2. User-defined find/replace capture rules
                        for rule in &settings.capture_rules {
                            if rule.enabled && !rule.pattern.is_empty() {
                                if rule.is_regex {
                                    if let Ok(re) = Regex::new(&rule.pattern) {
                                        text = re.replace_all(&text, &rule.replacement).to_string();
                                    }
                                } else {
                                    text = text.replace(&rule.pattern, &rule.replacement);
                                }
                            }
                        }

                        let mut html_content = None;
                        let mut rtf_content = None;

                        if html_format != 0 && IsClipboardFormatAvailable(html_format).is_ok() {
                            if let Ok(h_handle) = GetClipboardData(html_format) {
                                let h_hglobal = HGLOBAL(h_handle.0 as *mut _);
                                let h_ptr = GlobalLock(h_hglobal);
                                if !h_ptr.is_null() {
                                    let h_size = GlobalSize(h_hglobal);
                                    let h_slice =
                                        std::slice::from_raw_parts(h_ptr as *const u8, h_size);
                                    let real_len = h_slice.iter().position(|&b| b == 0).unwrap_or(h_size);
                                    let raw_html = String::from_utf8_lossy(&h_slice[..real_len]).to_string();
                                    if !raw_html.trim().is_empty() {
                                        html_content = Some(raw_html);
                                    }
                                    GlobalUnlock(h_hglobal).ok();
                                }
                            }
                        }

                        if rtf_format != 0 && IsClipboardFormatAvailable(rtf_format).is_ok() {
                            if let Ok(r_handle) = GetClipboardData(rtf_format) {
                                let r_hglobal = HGLOBAL(r_handle.0 as *mut _);
                                let r_ptr = GlobalLock(r_hglobal);
                                if !r_ptr.is_null() {
                                    let r_size = GlobalSize(r_hglobal);
                                    let r_slice =
                                        std::slice::from_raw_parts(r_ptr as *const u8, r_size);
                                    let real_len = r_slice.iter().position(|&b| b == 0).unwrap_or(r_size);
                                    let raw_rtf = String::from_utf8_lossy(&r_slice[..real_len]).to_string();
                                    if !raw_rtf.trim().is_empty() {
                                        rtf_content = Some(raw_rtf);
                                    }
                                    GlobalUnlock(r_hglobal).ok();
                                }
                            }
                        }

                        let content_type = classify_text_content(
                            &text,
                            html_content.as_deref(),
                            rtf_content.as_deref(),
                            source_app.as_deref(),
                        );

                        let title_final = format_clean_title(&text, &content_type);

                        let (is_sensitive, expires_at) = if settings.detect_sensitive_data
                            && crate::sensitive::is_sensitive_text(&text)
                        {
                            let expires = (chrono::Local::now() + chrono::Duration::minutes(5))
                                .format("%Y-%m-%d %H:%M:%S")
                                .to_string();
                            (true, Some(expires))
                        } else {
                            (false, None)
                        };

                        let file_size = text.len() as u64;
                        let id = uuid_v4();

                        item = Some(ClipItem {
                            id,
                            content_type,
                            title: title_final,
                            text_content: Some(text),
                            rtf_content,
                            html_content,
                            image_path: None,
                            image_width: None,
                            image_height: None,
                            file_paths: None,
                            is_video: false,
                            file_size,
                            is_pinned: false,
                            source_app: source_app.clone(),
                            created_at: String::new(),
                            updated_at: String::new(),
                            qr_content: None,
                            is_sensitive,
                            expires_at,
                            ocr_text: None,
                        });
                    }
                }
            }
        }

        CloseClipboard().ok();

        // D. Insert into DB if new & not a duplicate (or our own paste)
        if let Some(mut new_item) = item {
            let own_paste = is_own_paste(&new_item);
            let hash = compute_item_hash(&new_item);
            let mut last_hash = LAST_CONTENT_HASH.lock().unwrap();
            if own_paste {
                // Carbon's own clipboard write: acknowledge it so the next
                // identical external copy is deduped, but don't insert.
                *last_hash = Some(hash);
            } else if *last_hash != Some(hash) {
                *last_hash = Some(hash);

                let now = now_ms();
                let mut merged = false;

                // ClipMerge: check if repeat copy within time window
                if settings.clip_merge_enabled
                    && (new_item.content_type == "text" || new_item.content_type == "code" || new_item.content_type == "link")
                {
                    let last_cap = LAST_CAPTURED_CLIP.lock().unwrap().clone();
                    if let Some((ref last_id, last_ts, ref last_type)) = last_cap {
                        if now.saturating_sub(last_ts) <= settings.clip_merge_window_ms
                            && (last_type == "text" || last_type == "code" || last_type == "link")
                        {
                            if let Some(ref new_txt) = new_item.text_content {
                                if let Ok(merged_item) = db_state.append_to_clip(last_id, new_txt) {
                                    *LAST_CAPTURED_CLIP.lock().unwrap() =
                                        Some((last_id.clone(), now, last_type.clone()));
                                    let _ = app_handle.emit("clipboard-updated", &merged_item);
                                    let _ = app_handle.emit("clip-merged", &merged_item);
                                    merged = true;
                                }
                            }
                        }
                    }
                }

                if !merged {
                    // 1. Try finding and bumping an existing exact duplicate
                    if let Ok(Some(existing_bumped)) = db_state.find_and_bump_duplicate(&new_item) {
                        // If the new capture was an image that created a new file, remove the newly created file
                        // since we are reusing the existing entry's file
                        if let (Some(ref new_p), Some(ref exist_p)) = (&new_item.image_path, &existing_bumped.image_path) {
                            if new_p != exist_p {
                                let _ = fs::remove_file(new_p);
                            }
                        }
                        let _ = db_state.trim_history(settings.retention_days, settings.max_entries);
                        *LAST_CAPTURED_CLIP.lock().unwrap() =
                            Some((existing_bumped.id.clone(), now, existing_bumped.content_type.clone()));
                        let _ = app_handle.emit("clipboard-updated", &existing_bumped);
                    } else if db_state.insert_entry(&mut new_item).is_ok() {
                        let _ = db_state.trim_history(settings.retention_days, settings.max_entries);
                        *LAST_CAPTURED_CLIP.lock().unwrap() =
                            Some((new_item.id.clone(), now, new_item.content_type.clone()));
                        // Notify frontend
                        let _ = app_handle.emit("clipboard-updated", &new_item);
                    }
                }
                crate::paste::set_selected_text_snapshot(None);
            }
            true
        } else {
            false
        }
    }
}

/// Decode the first QR code in an image while its pixels are already in memory.
/// The payload is stored with the clip, so previews never rescan an image.
fn decode_qr_content(image: &ImageBuffer<Rgba<u8>, Vec<u8>>) -> Option<String> {
    let (width, height) = image.dimensions();
    let grayscale = image
        .pixels()
        .map(|pixel| {
            let [red, green, blue, _] = pixel.0;
            ((u32::from(red) * 299 + u32::from(green) * 587 + u32::from(blue) * 114)
                / 1000) as u8
        })
        .collect::<Vec<_>>();

    let mut decoder = quircs::Quirc::default();
    for code in decoder.identify(width as usize, height as usize, &grayscale) {
        let Ok(code) = code else { continue };
        let Ok(decoded) = code.decode() else { continue };
        let payload = String::from_utf8_lossy(&decoded.payload).trim().to_string();
        if !payload.is_empty() {
            return Some(payload);
        }
    }

    None
}

fn compute_item_hash(item: &ClipItem) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    item.content_type.hash(&mut hasher);
    item.title.hash(&mut hasher);
    if let Some(ref txt) = item.text_content {
        txt.hash(&mut hasher);
    }
    if let Some(ref fps) = item.file_paths {
        fps.hash(&mut hasher);
    }
    item.file_size.hash(&mut hasher);
    if let Some(w) = item.image_width {
        w.hash(&mut hasher);
    }
    if let Some(h) = item.image_height {
        h.hash(&mut hasher);
    }
    hasher.finish()
}

pub fn is_rich_html(html: &str) -> bool {
    let lower = html.to_lowercase();
    let tags = [
        "<b", "<strong", "<i", "<em", "<u", "<s", "<strike", "<del",
        "<h1", "<h2", "<h3", "<h4", "<h5", "<h6",
        "<ul", "<ol", "<li", "<table", "<tr", "<td", "<th",
        "<blockquote", "<hr", "<a ", "<font", "style=", "class=",
        "<mark", "<sub", "<sup", "<p", "<div", "<span"
    ];
    tags.iter().any(|&tag| lower.contains(tag))
}

pub fn classify_text_content(
    text: &str,
    html: Option<&str>,
    rtf: Option<&str>,
    source_app: Option<&str>,
) -> String {
    let trimmed = text.trim();

    // 1. Color hex/rgb/hsl (only for short single strings)
    if trimmed.len() <= 32 && !trimmed.contains('\n') {
        let hex_re = Regex::new(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$").unwrap();
        let rgb_re = Regex::new(r"^(rgb|rgba|hsl|hsla)\([0-9%.,\s]+\)$").unwrap();
        if hex_re.is_match(trimmed) || rgb_re.is_match(trimmed) {
            return "color".to_string();
        }
    }

    // 2. Email (only for single words)
    if trimmed.len() <= 120 && !trimmed.contains('\n') && !trimmed.contains(' ') {
        let email_re = Regex::new(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$").unwrap();
        if email_re.is_match(trimmed) {
            return "email".to_string();
        }
    }

    // 3. Link / URL (single URL)
    if !trimmed.contains('\n') && !trimmed.contains(' ') && !trimmed.contains('\t') {
        let is_url_prefix = trimmed.starts_with("http://")
            || trimmed.starts_with("https://")
            || trimmed.starts_with("ftp://")
            || trimmed.starts_with("www.")
            || trimmed.starts_with("localhost:")
            || trimmed.starts_with("127.0.0.1:");

        let domain_re = Regex::new(r"^(?i)([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,24}(:\d+)?(/.*)?$").unwrap();
        let ip_re = Regex::new(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(/.*)?$").unwrap();

        if is_url_prefix || domain_re.is_match(trimmed) || ip_re.is_match(trimmed) {
            return "link".to_string();
        }
    }

    // 3.5 Absolute Windows/UNC paths (one or more lines) pointing to items
    // that exist on disk -> treat as file captures ("Copy as path" flows,
    // terminal path copies). Checked before rich/code so paths copied from
    // terminals are not swallowed by the code-app heuristic.
    {
        let lines: Vec<&str> = trimmed
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        if !lines.is_empty() && lines.len() <= 32 {
            let path_re =
                Regex::new(r#"^(?:[A-Za-z]:[\\/].+|\\\\[^\\\r\n]+\\.*)$"#).unwrap();
            if lines.iter().all(|l| path_re.is_match(l)) {
                let all_exist = lines.iter().all(|l| {
                    let normalized = l.replace('/', "\\");
                    std::fs::metadata(&normalized).is_ok() || std::fs::metadata(l).is_ok()
                });
                if all_exist {
                    return "file".to_string();
                }
            }
        }
    }

    // 4. Rich text: If genuine HTML or RTF was captured
    let has_rich_html = html.map_or(false, is_rich_html);
    let has_rich_rtf = rtf.map_or(false, |r| r.contains("\\b") || r.contains("\\i") || r.contains("\\ul") || r.contains("\\par"));

    if has_rich_html || has_rich_rtf {
        return "rich_text".to_string();
    }

    // 5. Code detection
    let is_code_app = source_app.map_or(false, |app| {
        let app_l = app.to_lowercase();
        app_l.contains("code") || app_l.contains("devenv") || app_l.contains("idea") || app_l.contains("sublime") || app_l.contains("wt.exe")
    });

    let code_keywords = [
        "const ", "let ", "var ", "function ", "import ", "export ", "class ", "def ", "fn ", "pub ",
        "return ", "if (", "for (", "while (", "SELECT ", "INSERT INTO ", "UPDATE ", "DELETE FROM ",
        "struct ", "interface ", "async ", "await ", "std::", "fmt.", "::", "=>", "->"
    ];

    let contains_code_keyword = code_keywords.iter().any(|k| trimmed.contains(k));
    let has_braces_and_semis = (trimmed.contains('{') && trimmed.contains('}'))
        || (trimmed.contains(';') && trimmed.lines().count() > 1);

    if is_code_app || contains_code_keyword || has_braces_and_semis {
        return "code".to_string();
    }

    "text".to_string()
}

fn get_foreground_app_name() -> Option<String> {
    unsafe {
        let mut hwnd = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
        let ignored_exes = [
            "carbon.exe",
            "glint.exe",
            "typr.exe",
            "taskhostw.exe",
            "dwm.exe",
        ];

        for _ in 0..3 {
            if hwnd.0.is_null() {
                break;
            }

            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != 0 {
                if let Ok(process_handle) = OpenProcess(
                    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                    false,
                    pid,
                ) {
                    let mut buf = vec![0u16; 1024];
                    let len = K32GetModuleFileNameExW(process_handle, None, &mut buf);
                    if len > 0 {
                        let path_str = String::from_utf16_lossy(&buf[..len as usize]);
                        let path = PathBuf::from(path_str);
                        if let Some(file_name) = path.file_name() {
                            let name = file_name.to_string_lossy().to_string();
                            let lower = name.to_lowercase();
                            if !ignored_exes.iter().any(|ig| lower.contains(ig)) {
                                return Some(name);
                            }
                        }
                    }
                }
            }

            // If the foreground window was an ignored background tool, check window next in Z-order
            hwnd = windows::Win32::UI::WindowsAndMessaging::GetWindow(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::GW_HWNDNEXT,
            ).unwrap_or_default();
        }
    }
    None
}

fn parse_dib_to_image(data: &[u8], width: u32, height: u32) -> Option<ImageBuffer<Rgba<u8>, Vec<u8>>> {
    if data.len() < std::mem::size_of::<BITMAPINFOHEADER>() {
        return None;
    }

    let header_size = unsafe { *(data.as_ptr() as *const u32) } as usize;
    if data.len() < header_size {
        return None;
    }

    let pixel_data = &data[header_size..];
    let mut img = ImageBuffer::new(width, height);

    let bpp = unsafe { *(data.as_ptr().add(14) as *const u16) };
    if bpp != 24 && bpp != 32 {
        return None;
    }

    let bytes_per_pixel = (bpp / 8) as usize;
    let row_stride = ((width as usize * bytes_per_pixel + 3) / 4) * 4;

    for y in 0..height {
        let src_y = height - 1 - y; // DIB rows are bottom-up
        let row_start = src_y as usize * row_stride;

        for x in 0..width {
            let pixel_start = row_start + (x as usize * bytes_per_pixel);
            if pixel_start + bytes_per_pixel <= pixel_data.len() {
                let b = pixel_data[pixel_start];
                let g = pixel_data[pixel_start + 1];
                let r = pixel_data[pixel_start + 2];
                let a = if bytes_per_pixel == 4 {
                    pixel_data[pixel_start + 3]
                } else {
                    255
                };
                img.put_pixel(x, y, Rgba([r, g, b, if a == 0 && bytes_per_pixel == 4 { 255 } else { a }]));
            }
        }
    }

    Some(img)
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let rand_val: u64 = rand_simple();
    format!("{:x}-{:x}-4{:03x}-{:x}", nanos, rand_val & 0xffff, (rand_val >> 16) & 0xfff, rand_val >> 28)
}

fn rand_simple() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEED: AtomicU64 = AtomicU64::new(123456789);
    let mut val = SEED.fetch_add(0x9E3779B97F4A7C15, Ordering::Relaxed);
    val = (val ^ (val >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    val = (val ^ (val >> 27)).wrapping_mul(0x94D049BB133111EB);
    val ^ (val >> 31)
}

#[allow(dead_code)]
fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_url_tracking_parameters() {
        let dirty = "https://example.com/product?id=123&utm_source=twitter&utm_medium=social&fbclid=IwAR123&page=1";
        let cleaned = strip_url_tracking_parameters(dirty);
        assert_eq!(cleaned, "https://example.com/product?id=123&page=1");

        let all_tracking = "https://example.com/?utm_source=newsletter&gclid=xyz";
        let cleaned2 = strip_url_tracking_parameters(all_tracking);
        assert_eq!(cleaned2, "https://example.com/");

        let non_url = "Just some random text with utm_source=123";
        assert_eq!(strip_url_tracking_parameters(non_url), non_url);
    }
}


