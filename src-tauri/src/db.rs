use crate::titles::format_clean_title;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub is_locked: bool,
    pub item_count: usize,
    pub created_at: String,
}

fn generate_pin_salt() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let raw = format!("{}:{}:carbon_salt", nanos, pid);
    let hash = Sha256::digest(raw.as_bytes());
    hex::encode(&hash[0..8])
}

static RECOVERY_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn generate_recovery_code() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let count = RECOVERY_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let raw = format!("{}:{}:{}:carbon_recovery_seed", nanos, pid, count);
    let hash = Sha256::digest(raw.as_bytes());
    let hex_str = hex::encode(hash).to_uppercase();
    format!("{}-{}-{}-{}", &hex_str[0..4], &hex_str[4..8], &hex_str[8..12], &hex_str[12..16])
}

fn normalize_recovery_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_uppercase()
}

fn hash_pin_with_salt(pin: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(pin.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClipItem {
    pub id: String,
    pub content_type: String, // 'text', 'code', 'rich_text', 'image', 'file', 'link', 'email', 'color'
    pub title: String,
    pub text_content: Option<String>,
    pub rtf_content: Option<String>,
    pub html_content: Option<String>,
    pub image_path: Option<String>,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
    pub file_paths: Option<String>, // JSON array string
    pub is_video: bool,
    pub file_size: u64,
    pub is_pinned: bool,
    pub source_app: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Decoded payload from a QR code found in an image clip, if one exists.
    pub qr_content: Option<String>,
    #[serde(default)]
    pub is_sensitive: bool,
    #[serde(default)]
    pub expires_at: Option<String>,
    /// Extracted OCR text for image clips, if one exists or has been scanned.
    #[serde(default)]
    pub ocr_text: Option<String>,
}

/// A user-authored text-expansion snippet. Lives in its own table and is
/// deliberately untouched by retention / clear-history / duplicate-collapsing
/// logic that only ever operates on captured entries.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub keyword: String,
    pub content: String,
    pub tags: Vec<String>,
    pub icon: Option<String>,
    pub use_count: u64,
    pub last_used_at: Option<String>,
    pub show_confirmation: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DbStats {
    pub total_items: u64,
    pub db_size_bytes: u64,
    pub text_count: u64,
    pub code_count: u64,
    pub rich_text_count: u64,
    pub image_count: u64,
    pub file_count: u64,
    pub link_count: u64,
    pub email_count: u64,
    pub color_count: u64,
    pub pinned_count: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BackupEntry {
    pub id: String,
    pub content_type: String,
    pub title: String,
    pub text_content: Option<String>,
    pub rtf_content: Option<String>,
    pub html_content: Option<String>,
    pub image_base64: Option<String>,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
    pub file_paths: Option<String>,
    pub is_video: bool,
    pub file_size: u64,
    pub is_pinned: bool,
    pub source_app: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub qr_content: Option<String>,
    pub ocr_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BackupPayload {
    pub version: u32,
    pub app: String,
    pub exported_at: String,
    pub total_items: usize,
    pub entries: Vec<BackupEntry>,
    /// Snippets are part of the backup, but the system-wide expansion
    /// enabled flag is deliberately never stored here (see settings.rs).
    /// Restoring a backup must never silently re-enable keystroke monitoring.
    #[serde(default)]
    pub snippets: Vec<Snippet>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImportResult {
    pub imported_count: usize,
    pub total_in_file: usize,
}

pub struct DbState {
    pub conn: Mutex<Connection>,
    pub db_path: PathBuf,
}

impl DbState {
    pub fn new(db_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

        // Enable WAL mode for performance & concurrent reads
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| e.to_string())?;

        let state = DbState {
            conn: Mutex::new(conn),
            db_path,
        };

        state.init_tables()?;
        state.refresh_titles()?;
        Ok(state)
    }

    fn init_tables(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                content_type TEXT NOT NULL,
                title TEXT NOT NULL,
                text_content TEXT,
                rtf_content TEXT,
                html_content TEXT,
                image_path TEXT,
                image_width INTEGER,
                image_height INTEGER,
                file_paths TEXT,
                is_video INTEGER DEFAULT 0,
                file_size INTEGER NOT NULL,
                is_pinned INTEGER DEFAULT 0,
                source_app TEXT,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                qr_content TEXT,
                is_sensitive INTEGER DEFAULT 0,
                expires_at TEXT,
                ocr_text TEXT
            );",
            [],
        )
        .map_err(|e| e.to_string())?;

        // Add fields introduced after the first public database schema.
        let mut columns = conn
            .prepare("PRAGMA table_info(entries)")
            .map_err(|e| e.to_string())?;
        let col_names: Vec<String> = columns
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        if !col_names.contains(&"qr_content".to_string()) {
            conn.execute("ALTER TABLE entries ADD COLUMN qr_content TEXT", [])
                .map_err(|e| e.to_string())?;
        }
        if !col_names.contains(&"is_sensitive".to_string()) {
            conn.execute("ALTER TABLE entries ADD COLUMN is_sensitive INTEGER DEFAULT 0", [])
                .map_err(|e| e.to_string())?;
        }
        if !col_names.contains(&"expires_at".to_string()) {
            conn.execute("ALTER TABLE entries ADD COLUMN expires_at TEXT", [])
                .map_err(|e| e.to_string())?;
        }
        if !col_names.contains(&"ocr_text".to_string()) {
            conn.execute("ALTER TABLE entries ADD COLUMN ocr_text TEXT", [])
                .map_err(|e| e.to_string())?;
        }

        // FTS5 Table for fast search
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
                id UNINDEXED,
                title,
                text_content,
                file_paths,
                tokenize='unicode61'
            );",
            [],
        )
        .map_err(|e| e.to_string())?;

        // Triggers to sync FTS5
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
                INSERT INTO entries_fts(id, title, text_content, file_paths)
                VALUES (new.id, new.title, COALESCE(new.text_content, ''), COALESCE(new.file_paths, ''));
            END;",
            [],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
                DELETE FROM entries_fts WHERE id = old.id;
            END;",
            [],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
                DELETE FROM entries_fts WHERE id = old.id;
                INSERT INTO entries_fts(id, title, text_content, file_paths)
                VALUES (new.id, new.title, COALESCE(new.text_content, ''), COALESCE(new.file_paths, ''));
            END;",
            [],
        )
        .map_err(|e| e.to_string())?;

        // Collections table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT,
                icon TEXT,
                pin_hash TEXT,
                pin_salt TEXT,
                recovery_hash TEXT,
                recovery_salt TEXT,
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            );",
            [],
        )
        .map_err(|e| e.to_string())?;

        let mut col_columns = conn
            .prepare("PRAGMA table_info(collections)")
            .map_err(|e| e.to_string())?;
        let col_col_names: Vec<String> = col_columns
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        if !col_col_names.contains(&"recovery_hash".to_string()) {
            conn.execute("ALTER TABLE collections ADD COLUMN recovery_hash TEXT", [])
                .map_err(|e| e.to_string())?;
        }
        if !col_col_names.contains(&"recovery_salt".to_string()) {
            conn.execute("ALTER TABLE collections ADD COLUMN recovery_salt TEXT", [])
                .map_err(|e| e.to_string())?;
        }

        // Clip-Collection Association Table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS clip_collections (
                clip_id TEXT NOT NULL,
                collection_id TEXT NOT NULL,
                added_at TEXT DEFAULT (datetime('now', 'localtime')),
                PRIMARY KEY (clip_id, collection_id),
                FOREIGN KEY (clip_id) REFERENCES entries(id) ON DELETE CASCADE,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );",
            [],
        )
        .map_err(|e| e.to_string())?;

        // Snippets table — user-authored content, fully separate from captured
        // entries so retention/clear-history/duplicate-collapsing never touch it.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS snippets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                keyword TEXT NOT NULL,
                content TEXT NOT NULL,
                tags TEXT DEFAULT '[]',
                icon TEXT,
                use_count INTEGER DEFAULT 0,
                last_used_at TEXT,
                show_confirmation INTEGER DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            );",
            [],
        )
        .map_err(|e| e.to_string())?;

        // Defensive migration for dbs that may predate a column (all current
        // columns, so the full table is always well-formed).
        let mut sn_columns = conn
            .prepare("PRAGMA table_info(snippets)")
            .map_err(|e| e.to_string())?;
        let sn_col_names: Vec<String> = sn_columns
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        for (col, decl) in [
            ("tags", "TEXT DEFAULT '[]'"),
            ("icon", "TEXT"),
            ("use_count", "INTEGER DEFAULT 0"),
            ("last_used_at", "TEXT"),
            ("show_confirmation", "INTEGER DEFAULT 0"),
        ] {
            if !sn_col_names.contains(&col.to_string()) {
                conn.execute(
                    &format!("ALTER TABLE snippets ADD COLUMN {} {}", col, decl),
                    [],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        conn.execute("CREATE INDEX IF NOT EXISTS idx_snippets_name ON snippets(name)", []).ok();
        conn.execute("CREATE INDEX IF NOT EXISTS idx_snippets_keyword ON snippets(keyword)", []).ok();

        // Seed default starter snippets if table is fresh/empty
        let sn_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM snippets", [], |row| row.get(0))
            .unwrap_or(0);
        if sn_count == 0 {
            let _ = conn.execute(
                "INSERT INTO snippets (id, name, keyword, content, tags, icon, show_confirmation) VALUES
                ('snip_select', 'Quote Selection', '/select', '> {selection}', '[\"quote\"]', '💬', 1),
                ('snip_note', 'Meeting Note', '/note', 'Date: {date format=\"YYYY-MM-DD\"}\nTo: {argument name=\"who\" default=\"Team\"}\n\nNotes:\n- {cursor}', '[\"work\"]', '📝', 1),
                ('snip_date', 'Current Date', '/date', '{date format=\"YYYY-MM-DD\"}', '[\"util\"]', '📅', 1),
                ('snip_inner', 'Greeting', '/inner', 'Hello {argument name=\"name\" default=\"there\"}!', '[\"greeting\"]', '👋', 1);",
                [],
            );
        }

        // Fast query indexes for instant sidebar tab loading
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)", []).ok();
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_content_type ON entries(content_type)", []).ok();
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_is_pinned ON entries(is_pinned)", []).ok();
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_expires_at ON entries(expires_at)", []).ok();
        conn.execute("CREATE INDEX IF NOT EXISTS idx_clip_collections_col ON clip_collections(collection_id)", []).ok();

        Ok(())
    }

    /// One-time cleanup for entries captured before title formatting existed:
    /// rewrites verbose/raw titles (long multi-line dumps, 60+ char strings)
    /// with the same clean single-line format used for new captures.
    /// Images and files keep their concise native titles.
    pub fn refresh_titles(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut stmt = conn
            .prepare("SELECT id, content_type, title, text_content FROM entries")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut to_update: Vec<(String, String, String)> = Vec::new(); // (id, clean_title, content_type)
        let mut to_delete: Vec<String> = Vec::new();
        for r in rows {
            let (id, content_type, title, text_content) = r.map_err(|e| e.to_string())?;

            if content_type == "image" && (title.contains(" × ") || title.starts_with("PNG image")) {
                if title != "Image" {
                    to_update.push((id, "Image".to_string(), content_type));
                }
            } else if content_type == "file" && title.contains(" files (") {
                if let Some(idx) = title.find(" files (") {
                    let clean = format!("{} files", &title[..idx]);
                    if clean != title {
                        to_update.push((id, clean, content_type));
                    }
                }
            } else {
                let is_text_based = matches!(
                    content_type.as_str(),
                    "text" | "code" | "rich_text" | "link" | "email" | "color"
                );
                if is_text_based {
                    let source = text_content.as_deref().unwrap_or(&title);
                    let detected_type = crate::clipboard_watcher::classify_text_content(
                        source,
                        None,
                        None,
                        None,
                    );

                    // Legacy rows force-typed "code" by the old terminal
                    // heuristic: prose with no code signals renders as unstyled
                    // plain text under the code view — remove them outright.
                    if content_type == "code"
                        && detected_type == "text"
                        && text_content.as_deref().map_or(false, crate::clipboard_watcher::looks_like_prose)
                    {
                        to_delete.push(id);
                        continue;
                    }

                    let target_type = if content_type == "text" && (detected_type == "link" || detected_type == "email" || detected_type == "color" || detected_type == "file") {
                        detected_type
                    } else {
                        content_type.clone()
                    };

                    let clean = format_clean_title(source, &target_type);
                    if clean != title || target_type != content_type {
                        to_update.push((id, clean, target_type));
                    }
                }
            }
        }
        drop(stmt);

        for (id, clean, new_type) in to_update {
            // The entries_au trigger keeps the FTS index in sync automatically.
            conn.execute(
                "UPDATE entries SET title = ?1, content_type = ?2 WHERE id = ?3",
                params![clean, new_type, id],
            )
            .map_err(|e| e.to_string())?;
        }

        for id in to_delete {
            // The entries_ad trigger removes the matching FTS row.
            conn.execute("DELETE FROM entries WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    pub fn cleanup_expired_entries(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // 1. Securely overwrite expired sensitive entries
        conn.execute(
            "UPDATE entries
             SET title = '••••••••', text_content = '••••••••', rtf_content = NULL, html_content = NULL, qr_content = NULL
             WHERE expires_at IS NOT NULL AND expires_at <= datetime('now', 'localtime')",
            [],
        )
        .map_err(|e| e.to_string())?;

        // 2. Delete expired entries
        conn.execute(
            "DELETE FROM entries
             WHERE expires_at IS NOT NULL AND expires_at <= datetime('now', 'localtime')",
            [],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn insert_entry(&self, item: &mut ClipItem) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // Stamp the item itself so event payloads emitted after insert carry
        // real timestamps (frontends group by created_at).
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        item.created_at = now.clone();
        item.updated_at = now;

        conn.execute(
            "INSERT INTO entries (
                id, content_type, title, text_content, rtf_content, html_content,
                image_path, image_width, image_height, file_paths, is_video, file_size,
                is_pinned, source_app, created_at, updated_at, qr_content, is_sensitive, expires_at, ocr_text
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                item.id,
                item.content_type,
                item.title,
                item.text_content,
                item.rtf_content,
                item.html_content,
                item.image_path,
                item.image_width,
                item.image_height,
                item.file_paths,
                if item.is_video { 1 } else { 0 },
                item.file_size as i64,
                if item.is_pinned { 1 } else { 0 },
                item.source_app,
                item.created_at,
                item.updated_at,
                item.qr_content,
                if item.is_sensitive { 1 } else { 0 },
                item.expires_at,
                item.ocr_text,
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_today_entries(
        &self,
        search: Option<&str>,
        category: Option<&str>,
        collection_id: Option<&str>,
    ) -> Result<Vec<ClipItem>, String> {
        let _ = self.cleanup_expired_entries();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut query = String::from(
            "SELECT id, content_type, title, text_content, rtf_content, html_content,
                    image_path, image_width, image_height, file_paths, is_video, file_size,
                    is_pinned, source_app, created_at, updated_at, qr_content, is_sensitive, expires_at, ocr_text
             FROM entries
             WHERE date(created_at) = date('now', 'localtime')"
        );

        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(col_id) = collection_id {
            if !col_id.trim().is_empty() {
                query.push_str(" AND id IN (SELECT clip_id FROM clip_collections WHERE collection_id = ?)");
                params_vec.push(Box::new(col_id.to_string()));
            }
        }

        if let Some(cat) = category {
            if !cat.is_empty() && cat != "all" {
                query.push_str(" AND content_type = ?");
                params_vec.push(Box::new(cat.to_string()));
            }
        }

        if let Some(s) = search {
            let s_trimmed = s.trim();
            if !s_trimmed.is_empty() {
                query.push_str(" AND (title LIKE ? OR text_content LIKE ? OR file_paths LIKE ? OR ocr_text LIKE ?)");
                let pattern = format!("%{}%", s_trimmed);
                params_vec.push(Box::new(pattern.clone()));
                params_vec.push(Box::new(pattern.clone()));
                params_vec.push(Box::new(pattern.clone()));
                params_vec.push(Box::new(pattern));
            }
        }

        query.push_str(" ORDER BY created_at DESC");

        let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
        let params_slice: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

        let rows = stmt
            .query_map(params_slice.as_slice(), |row| {
                Ok(ClipItem {
                    id: row.get(0)?,
                    content_type: row.get(1)?,
                    title: row.get(2)?,
                    text_content: row.get(3)?,
                    rtf_content: row.get(4)?,
                    html_content: row.get(5)?,
                    image_path: row.get(6)?,
                    image_width: row.get(7)?,
                    image_height: row.get(8)?,
                    file_paths: row.get(9)?,
                    is_video: row.get::<_, i32>(10)? == 1,
                    file_size: row.get::<_, i64>(11)? as u64,
                    is_pinned: row.get::<_, i32>(12)? == 1,
                    source_app: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                    qr_content: row.get(16)?,
                    is_sensitive: row.get::<_, i32>(17)? == 1,
                    expires_at: row.get(18)?,
                    ocr_text: row.get(19)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(|e| e.to_string())?);
        }
        Ok(items)
    }

    pub fn get_all_entries(
        &self,
        search: Option<&str>,
        category: Option<&str>,
        pinned_only: bool,
        collection_id: Option<&str>,
    ) -> Result<Vec<ClipItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut query = String::from(
            "SELECT id, content_type, title, text_content, rtf_content, html_content,
                    image_path, image_width, image_height, file_paths, is_video, file_size,
                    is_pinned, source_app, created_at, updated_at, qr_content, is_sensitive, expires_at, ocr_text
             FROM entries WHERE 1=1"
        );

        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(col_id) = collection_id {
            if !col_id.trim().is_empty() {
                query.push_str(" AND id IN (SELECT clip_id FROM clip_collections WHERE collection_id = ?)");
                params_vec.push(Box::new(col_id.to_string()));
            }
        }

        if pinned_only {
            query.push_str(" AND is_pinned = 1");
        }

        if let Some(cat) = category {
            if !cat.is_empty() && cat != "all" {
                query.push_str(" AND content_type = ?");
                params_vec.push(Box::new(cat.to_string()));
            }
        }

        if let Some(s) = search {
            let s_trimmed = s.trim();
            if !s_trimmed.is_empty() {
                query.push_str(" AND (title LIKE ? OR text_content LIKE ? OR file_paths LIKE ? OR ocr_text LIKE ?)");
                let pattern = format!("%{}%", s_trimmed);
                params_vec.push(Box::new(pattern.clone()));
                params_vec.push(Box::new(pattern.clone()));
                params_vec.push(Box::new(pattern.clone()));
                params_vec.push(Box::new(pattern));
            }
        }

        query.push_str(" ORDER BY created_at DESC");

        let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
        let params_slice: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

        let rows = stmt
            .query_map(params_slice.as_slice(), |row| {
                Ok(ClipItem {
                    id: row.get(0)?,
                    content_type: row.get(1)?,
                    title: row.get(2)?,
                    text_content: row.get(3)?,
                    rtf_content: row.get(4)?,
                    html_content: row.get(5)?,
                    image_path: row.get(6)?,
                    image_width: row.get(7)?,
                    image_height: row.get(8)?,
                    file_paths: row.get(9)?,
                    is_video: row.get::<_, i32>(10)? == 1,
                    file_size: row.get::<_, i64>(11)? as u64,
                    is_pinned: row.get::<_, i32>(12)? == 1,
                    source_app: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                    qr_content: row.get(16)?,
                    is_sensitive: row.get::<_, i32>(17)? == 1,
                    expires_at: row.get(18)?,
                    ocr_text: row.get(19)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(|e| e.to_string())?);
        }
        Ok(items)
    }

    // --- Collections Methods ---

    pub fn list_collections(&self) -> Result<Vec<Collection>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.name, c.color, c.icon, (c.pin_hash IS NOT NULL) AS is_locked,
                        (SELECT COUNT(*) FROM clip_collections cc JOIN entries e ON e.id = cc.clip_id WHERE cc.collection_id = c.id) AS item_count,
                        c.created_at
                 FROM collections c
                 ORDER BY c.created_at ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Collection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    icon: row.get(3)?,
                    is_locked: row.get::<_, i32>(4)? == 1,
                    item_count: row.get::<_, i64>(5)? as usize,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r.map_err(|e| e.to_string())?);
        }
        Ok(list)
    }

    pub fn create_collection(
        &self,
        name: String,
        color: Option<String>,
        icon: Option<String>,
    ) -> Result<Collection, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = format!("col_{}", chrono::Local::now().timestamp_millis());
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

        conn.execute(
            "INSERT INTO collections (id, name, color, icon, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, color, icon, now],
        )
        .map_err(|e| e.to_string())?;

        Ok(Collection {
            id,
            name,
            color,
            icon,
            is_locked: false,
            item_count: 0,
            created_at: now,
        })
    }

    pub fn rename_collection(&self, id: &str, new_name: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE collections SET name = ?1 WHERE id = ?2",
            params![new_name, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_collection(&self, id: &str, delete_clips: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if delete_clips {
            conn.execute(
                "DELETE FROM entries WHERE id IN (SELECT clip_id FROM clip_collections WHERE collection_id = ?1)",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "DELETE FROM clip_collections WHERE collection_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM collections WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_collection_color(&self, id: &str, color: Option<String>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE collections SET color = ?1 WHERE id = ?2",
            params![color, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_collection_pin(&self, id: &str, pin: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let salt = generate_pin_salt();
        let hash = hash_pin_with_salt(pin, &salt);

        let recovery_code = generate_recovery_code();
        let clean_recovery = normalize_recovery_code(&recovery_code);
        let rec_salt = generate_pin_salt();
        let rec_hash = hash_pin_with_salt(&clean_recovery, &rec_salt);

        conn.execute(
            "UPDATE collections SET pin_hash = ?1, pin_salt = ?2, recovery_hash = ?3, recovery_salt = ?4 WHERE id = ?5",
            params![hash, salt, rec_hash, rec_salt, id],
        )
        .map_err(|e| e.to_string())?;

        Ok(recovery_code)
    }

    pub fn change_collection_pin(&self, id: &str, pin: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let salt = generate_pin_salt();
        let hash = hash_pin_with_salt(pin, &salt);
        conn.execute(
            "UPDATE collections SET pin_hash = ?1, pin_salt = ?2 WHERE id = ?3",
            params![hash, salt, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn verify_collection_pin(&self, id: &str, pin: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT pin_hash, pin_salt FROM collections WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let result = stmt.query_row(params![id], |row| {
            let hash: Option<String> = row.get(0)?;
            let salt: Option<String> = row.get(1)?;
            Ok((hash, salt))
        });

        match result {
            Ok((Some(expected_hash), Some(salt))) => {
                let candidate_hash = hash_pin_with_salt(pin, &salt);
                Ok(expected_hash == candidate_hash)
            }
            Ok((None, _)) => Ok(true),
            _ => Err("Collection not found".to_string()),
        }
    }

    pub fn verify_collection_recovery_code(&self, id: &str, recovery_code: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT recovery_hash, recovery_salt FROM collections WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let result = stmt.query_row(params![id], |row| {
            let hash: Option<String> = row.get(0)?;
            let salt: Option<String> = row.get(1)?;
            Ok((hash, salt))
        });

        match result {
            Ok((Some(expected_hash), Some(salt))) => {
                let clean = normalize_recovery_code(recovery_code);
                if clean.is_empty() {
                    return Ok(false);
                }
                let candidate_hash = hash_pin_with_salt(&clean, &salt);
                Ok(expected_hash == candidate_hash)
            }
            _ => Ok(false),
        }
    }

    pub fn reset_collection_passcode(&self, id: &str, recovery_code: &str, new_pin: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT recovery_hash, recovery_salt FROM collections WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let (expected_hash, salt) = stmt
            .query_row(params![id], |row| {
                let hash: Option<String> = row.get(0)?;
                let salt: Option<String> = row.get(1)?;
                Ok((hash, salt))
            })
            .map_err(|_| "Collection not found".to_string())?;

        let expected_hash = expected_hash.ok_or_else(|| "Collection has no recovery code configured".to_string())?;
        let salt = salt.ok_or_else(|| "Collection recovery salt missing".to_string())?;

        let clean = normalize_recovery_code(recovery_code);
        if clean.is_empty() {
            return Err("Invalid recovery code".to_string());
        }
        let candidate_hash = hash_pin_with_salt(&clean, &salt);
        if expected_hash != candidate_hash {
            return Err("Invalid recovery code".to_string());
        }

        let pin_salt = generate_pin_salt();
        let pin_hash = hash_pin_with_salt(new_pin, &pin_salt);

        let new_recovery_code = generate_recovery_code();
        let clean_new_recovery = normalize_recovery_code(&new_recovery_code);
        let new_rec_salt = generate_pin_salt();
        let new_rec_hash = hash_pin_with_salt(&clean_new_recovery, &new_rec_salt);

        conn.execute(
            "UPDATE collections SET pin_hash = ?1, pin_salt = ?2, recovery_hash = ?3, recovery_salt = ?4 WHERE id = ?5",
            params![pin_hash, pin_salt, new_rec_hash, new_rec_salt, id],
        )
        .map_err(|e| e.to_string())?;

        Ok(new_recovery_code)
    }

    pub fn remove_collection_pin(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE collections SET pin_hash = NULL, pin_salt = NULL, recovery_hash = NULL, recovery_salt = NULL WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn add_clip_to_collection(&self, clip_id: &str, collection_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        conn.execute(
            "INSERT OR IGNORE INTO clip_collections (clip_id, collection_id, added_at)
             VALUES (?1, ?2, ?3)",
            params![clip_id, collection_id, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn add_clips_to_collection(&self, clip_ids: &[String], collection_id: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        for cid in clip_ids {
            tx.execute(
                "INSERT OR IGNORE INTO clip_collections (clip_id, collection_id, added_at)
                 VALUES (?1, ?2, ?3)",
                params![cid, collection_id, now],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_clip_from_collection(&self, clip_id: &str, collection_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM clip_collections WHERE clip_id = ?1 AND collection_id = ?2",
            params![clip_id, collection_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_clip_collection_ids(&self, clip_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT collection_id FROM clip_collections WHERE clip_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![clip_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        for r in rows {
            ids.push(r.map_err(|e| e.to_string())?);
        }
        Ok(ids)
    }

    // --- Snippets Methods ---

    fn snippet_from_row(row: &rusqlite::Row) -> rusqlite::Result<Snippet> {
        Ok(Snippet {
            id: row.get(0)?,
            name: row.get(1)?,
            keyword: row.get(2)?,
            content: row.get(3)?,
            tags: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(4)?)
                .unwrap_or_default(),
            icon: row.get(5)?,
            use_count: row.get::<_, i64>(6)? as u64,
            last_used_at: row.get(7)?,
            show_confirmation: row.get::<_, i32>(8)? == 1,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    }

    pub fn list_snippets(&self) -> Result<Vec<Snippet>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, keyword, content, tags, icon, use_count, last_used_at,
                        show_confirmation, created_at, updated_at
                 FROM snippets
                 ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], Self::snippet_from_row).map_err(|e| e.to_string())?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r.map_err(|e| e.to_string())?);
        }
        Ok(list)
    }

    pub fn create_snippet(
        &self,
        name: String,
        keyword: String,
        content: String,
        tags: Vec<String>,
        icon: Option<String>,
        show_confirmation: bool,
    ) -> Result<Snippet, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = format!("snip_{}", chrono::Local::now().timestamp_millis());
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO snippets (id, name, keyword, content, tags, icon, show_confirmation, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                id,
                name,
                keyword,
                content,
                tags_json,
                icon,
                if show_confirmation { 1 } else { 0 },
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(Snippet {
            id,
            name,
            keyword,
            content,
            tags,
            icon,
            use_count: 0,
            last_used_at: None,
            show_confirmation,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn update_snippet(
        &self,
        id: &str,
        name: String,
        keyword: String,
        content: String,
        tags: Vec<String>,
        icon: Option<String>,
        show_confirmation: bool,
    ) -> Result<Snippet, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "UPDATE snippets
             SET name = ?1, keyword = ?2, content = ?3, tags = ?4, icon = ?5,
                 show_confirmation = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                name,
                keyword,
                content,
                tags_json,
                icon,
                if show_confirmation { 1 } else { 0 },
                now,
                id,
            ],
        )
        .map_err(|e| e.to_string())?;

        let mut stmt = conn
            .prepare(
                "SELECT id, name, keyword, content, tags, icon, use_count, last_used_at,
                        show_confirmation, created_at, updated_at
                 FROM snippets WHERE id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let snippet = stmt
            .query_row(params![id], Self::snippet_from_row)
            .map_err(|e| e.to_string())?;
        Ok(snippet)
    }

    pub fn delete_snippet(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_snippet_use(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE snippets
             SET use_count = use_count + 1,
                 last_used_at = datetime('now', 'localtime')
             WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Most recent captured text clips (newest first) — powers the
    /// `{clipboard}` / `{clipboard offset=N}` snippet placeholders.
    pub fn get_recent_clip_texts(&self, limit: usize) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let lim = (limit as i64).clamp(1, 200);
        let mut stmt = conn
            .prepare(
                "SELECT text_content FROM entries
                 WHERE content_type IN ('text','code','rich_text','link','email','color')
                   AND text_content IS NOT NULL AND TRIM(text_content) != ''
                 ORDER BY created_at DESC, rowid DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![lim], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn update_entry_text(&self, id: &str, new_text: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let first_line = new_text
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();

        conn.execute(
            "UPDATE entries
             SET text_content = ?1, title = ?2, updated_at = datetime('now', 'localtime')
             WHERE id = ?3",
            params![new_text, first_line, id],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn toggle_pin(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let current_pinned: i32 = conn
            .query_row("SELECT is_pinned FROM entries WHERE id = ?1", params![id], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        let new_pinned = if current_pinned == 1 { 0 } else { 1 };

        conn.execute(
            "UPDATE entries SET is_pinned = ?1 WHERE id = ?2",
            params![new_pinned, id],
        )
        .map_err(|e| e.to_string())?;

        Ok(new_pinned == 1)
    }

    pub fn bulk_pin_entries(&self, ids: &[String], pin: bool) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let pin_val = if pin { 1 } else { 0 };

        for id in ids {
            tx.execute(
                "UPDATE entries SET is_pinned = ?1 WHERE id = ?2",
                params![pin_val, id],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn bump_entry(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE entries SET created_at = datetime('now', 'localtime') WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn find_and_bump_duplicate(&self, item: &ClipItem) -> Result<Option<ClipItem>, String> {
        let _ = self.cleanup_expired_entries();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut existing_id: Option<String> = None;

        if item.content_type == "image" {
            if let (Some(w), Some(h)) = (item.image_width, item.image_height) {
                let mut stmt = conn
                    .prepare(
                        "SELECT id, image_path FROM entries
                         WHERE content_type = 'image' AND image_width = ?1 AND image_height = ?2 AND file_size = ?3
                         ORDER BY created_at DESC LIMIT 1",
                    )
                    .map_err(|e| e.to_string())?;

                let found = stmt
                    .query_row(params![w, h, item.file_size as i64], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                    })
                    .ok();

                if let Some((id, path)) = found {
                    if let (Some(ref existing_p), Some(ref new_p)) = (path, &item.image_path) {
                        if existing_p == new_p || fs::metadata(existing_p).is_ok() {
                            existing_id = Some(id);
                        }
                    } else {
                        existing_id = Some(id);
                    }
                }
            }
        } else if item.content_type == "file" {
            if let Some(ref fps) = item.file_paths {
                let mut stmt = conn
                    .prepare(
                        "SELECT id FROM entries
                         WHERE content_type = 'file' AND file_paths = ?1
                         ORDER BY created_at DESC LIMIT 1",
                    )
                    .map_err(|e| e.to_string())?;
                existing_id = stmt.query_row(params![fps], |row| row.get(0)).ok();
            }
        } else if item.content_type == "rich_text" {
            if let Some(ref html) = item.html_content {
                let mut stmt = conn
                    .prepare(
                        "SELECT id FROM entries
                         WHERE content_type = 'rich_text' AND html_content = ?1
                         ORDER BY created_at DESC LIMIT 1",
                    )
                    .map_err(|e| e.to_string())?;
                existing_id = stmt.query_row(params![html], |row| row.get(0)).ok();
            }
            if existing_id.is_none() {
                if let Some(ref txt) = item.text_content {
                    let mut stmt = conn
                        .prepare(
                            "SELECT id FROM entries
                             WHERE content_type = 'rich_text' AND text_content = ?1
                             ORDER BY created_at DESC LIMIT 1",
                        )
                        .map_err(|e| e.to_string())?;
                    existing_id = stmt.query_row(params![txt], |row| row.get(0)).ok();
                }
            }
        } else {
            // Text / link / email / color / code
            if let Some(ref txt) = item.text_content {
                if !txt.is_empty() {
                    let mut stmt = conn
                        .prepare(
                            "SELECT id FROM entries
                             WHERE text_content = ?1 AND is_sensitive = 0
                             ORDER BY created_at DESC LIMIT 1",
                        )
                        .map_err(|e| e.to_string())?;
                    existing_id = stmt.query_row(params![txt], |row| row.get(0)).ok();
                }
            }
        }

        if let Some(ref id) = existing_id {
            // Bump the existing entry
            conn.execute(
                "UPDATE entries SET created_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime') WHERE id = ?1",
                params![id],
            )
            .map_err(|e| e.to_string())?;

            // Fetch the updated entry
            let mut stmt = conn
                .prepare(
                    "SELECT id, content_type, title, text_content, rtf_content, html_content,
                            image_path, image_width, image_height, file_paths, is_video, file_size,
                            is_pinned, source_app, created_at, updated_at, qr_content, is_sensitive, expires_at, ocr_text
                     FROM entries WHERE id = ?1",
                )
                .map_err(|e| e.to_string())?;

            let updated_item = stmt
                .query_row(params![id], |row| {
                    Ok(ClipItem {
                        id: row.get(0)?,
                        content_type: row.get(1)?,
                        title: row.get(2)?,
                        text_content: row.get(3)?,
                        rtf_content: row.get(4)?,
                        html_content: row.get(5)?,
                        image_path: row.get(6)?,
                        image_width: row.get(7)?,
                        image_height: row.get(8)?,
                        file_paths: row.get(9)?,
                        is_video: row.get::<_, i32>(10)? == 1,
                        file_size: row.get::<_, i64>(11)? as u64,
                        is_pinned: row.get::<_, i32>(12)? == 1,
                        source_app: row.get(13)?,
                        created_at: row.get(14)?,
                        updated_at: row.get(15)?,
                        qr_content: row.get(16)?,
                        is_sensitive: row.get::<_, i32>(17)? == 1,
                        expires_at: row.get(18)?,
                        ocr_text: row.get(19)?,
                    })
                })
                .map_err(|e| e.to_string())?;

            return Ok(Some(updated_item));
        }

        Ok(None)
    }

    pub fn get_entry_by_id(&self, id: &str) -> Result<Option<ClipItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, content_type, title, text_content, rtf_content, html_content,
                        image_path, image_width, image_height, file_paths, is_video, file_size,
                        is_pinned, source_app, created_at, updated_at, qr_content, is_sensitive, expires_at, ocr_text
                 FROM entries WHERE id = ?1",
            )
            .map_err(|e| e.to_string())?;

        let item = stmt
            .query_row(params![id], |row| {
                Ok(ClipItem {
                    id: row.get(0)?,
                    content_type: row.get(1)?,
                    title: row.get(2)?,
                    text_content: row.get(3)?,
                    rtf_content: row.get(4)?,
                    html_content: row.get(5)?,
                    image_path: row.get(6)?,
                    image_width: row.get(7)?,
                    image_height: row.get(8)?,
                    file_paths: row.get(9)?,
                    is_video: row.get::<_, i32>(10)? == 1,
                    file_size: row.get::<_, i64>(11)? as u64,
                    is_pinned: row.get::<_, i32>(12)? == 1,
                    source_app: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                    qr_content: row.get(16)?,
                    is_sensitive: row.get::<_, i32>(17)? == 1,
                    expires_at: row.get(18)?,
                    ocr_text: row.get(19)?,
                })
            })
            .ok();

        Ok(item)
    }

    pub fn update_ocr_text(&self, id: &str, ocr_text: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE entries SET ocr_text = ?1, updated_at = datetime('now', 'localtime') WHERE id = ?2",
            params![ocr_text, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn append_to_clip(&self, id: &str, new_text: &str) -> Result<ClipItem, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT text_content, content_type FROM entries WHERE id = ?1")
            .map_err(|e| e.to_string())?;

        let (old_text, content_type) = stmt
            .query_row(params![id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let merged_text = match old_text {
            Some(t) if !t.is_empty() => format!("{}\n{}", t, new_text),
            _ => new_text.to_string(),
        };
        let new_title = format_clean_title(&merged_text, &content_type);
        let new_size = merged_text.len() as u64;

        conn.execute(
            "UPDATE entries SET text_content = ?1, title = ?2, file_size = ?3, updated_at = datetime('now', 'localtime') WHERE id = ?4",
            params![merged_text, new_title, new_size as i64, id],
        )
        .map_err(|e| e.to_string())?;

        drop(stmt);
        drop(conn);

        self.get_entry_by_id(id)?
            .ok_or_else(|| "Failed to reload merged clip".to_string())
    }

    pub fn delete_entry(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // Secure overwrite if sensitive
        let is_sensitive: bool = conn
            .query_row(
                "SELECT is_sensitive FROM entries WHERE id = ?1",
                params![id],
                |row| row.get::<_, i32>(0).map(|v| v == 1),
            )
            .unwrap_or(false);

        if is_sensitive {
            conn.execute(
                "UPDATE entries SET title = '••••••••', text_content = '••••••••', rtf_content = NULL, html_content = NULL, qr_content = NULL, ocr_text = NULL WHERE id = ?1",
                params![id],
            )
            .ok();
        }

        // If it has an image path, remove the file
        if let Ok(path) = conn.query_row::<Option<String>, _, _>(
            "SELECT image_path FROM entries WHERE id = ?1",
            params![id],
            |row| row.get(0),
        ) {
            if let Some(p) = path {
                let _ = fs::remove_file(p);
            }
        }

        conn.execute("DELETE FROM entries WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn bulk_delete_entries(&self, ids: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        for id in ids {
            let is_sensitive: bool = tx
                .query_row(
                    "SELECT is_sensitive FROM entries WHERE id = ?1",
                    params![id],
                    |row| row.get::<_, i32>(0).map(|v| v == 1),
                )
                .unwrap_or(false);

            if is_sensitive {
                tx.execute(
                    "UPDATE entries SET title = '••••••••', text_content = '••••••••', rtf_content = NULL, html_content = NULL, qr_content = NULL, ocr_text = NULL WHERE id = ?1",
                    params![id],
                )
                .ok();
            }

            if let Ok(path) = tx.query_row::<Option<String>, _, _>(
                "SELECT image_path FROM entries WHERE id = ?1",
                params![id],
                |row| row.get(0),
            ) {
                if let Some(p) = path {
                    let _ = fs::remove_file(p);
                }
            }

            tx.execute("DELETE FROM entries WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn export_backup(&self) -> Result<BackupPayload, String> {
        use base64::Engine;
        let clips = self.get_all_entries(None, None, false, None)?;
        let mut entries = Vec::with_capacity(clips.len());

        for c in clips {
            if c.is_sensitive {
                continue;
            }

            let mut image_base64 = None;
            if c.content_type == "image" {
                if let Some(ref p) = c.image_path {
                    if let Ok(bytes) = fs::read(p) {
                        image_base64 = Some(base64::engine::general_purpose::STANDARD.encode(&bytes));
                    }
                }
            }

            entries.push(BackupEntry {
                id: c.id,
                content_type: c.content_type,
                title: c.title,
                text_content: c.text_content,
                rtf_content: c.rtf_content,
                html_content: c.html_content,
                image_base64,
                image_width: c.image_width,
                image_height: c.image_height,
                file_paths: c.file_paths,
                is_video: c.is_video,
                file_size: c.file_size,
                is_pinned: c.is_pinned,
                source_app: c.source_app,
                created_at: c.created_at,
                updated_at: c.updated_at,
                qr_content: c.qr_content,
                ocr_text: c.ocr_text,
            });
        }

        let total_items = entries.len();
        // Include snippets in backup (expansion flag intentionally excluded)
        let snippets = self.list_snippets().unwrap_or_default();
        Ok(BackupPayload {
            version: 2,
            app: "Carbon".to_string(),
            exported_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            total_items,
            entries,
            snippets,
        })
    }

    pub fn import_backup(&self, payload: BackupPayload, media_dir: &std::path::Path) -> Result<ImportResult, String> {
        use base64::Engine;
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        fs::create_dir_all(media_dir).ok();

        let total_in_file = payload.entries.len();
        let mut imported_count = 0;

        for entry in payload.entries {
            let mut image_path = None;
            if entry.content_type == "image" {
                if let Some(ref b64) = entry.image_base64 {
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                        let img_name = format!("img_{}.png", entry.id);
                        let full_path = media_dir.join(&img_name);
                        if fs::write(&full_path, bytes).is_ok() {
                            image_path = Some(full_path.to_string_lossy().to_string());
                        }
                    }
                }
            }

            let res = tx.execute(
                "INSERT OR REPLACE INTO entries (
                    id, content_type, title, text_content, rtf_content, html_content,
                    image_path, image_width, image_height, file_paths, is_video, file_size,
                    is_pinned, source_app, created_at, updated_at, qr_content, is_sensitive, expires_at, ocr_text
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 0, NULL, ?18)",
                params![
                    entry.id,
                    entry.content_type,
                    entry.title,
                    entry.text_content,
                    entry.rtf_content,
                    entry.html_content,
                    image_path,
                    entry.image_width,
                    entry.image_height,
                    entry.file_paths,
                    if entry.is_video { 1 } else { 0 },
                    entry.file_size as i64,
                    if entry.is_pinned { 1 } else { 0 },
                    entry.source_app,
                    entry.created_at,
                    entry.updated_at,
                    entry.qr_content,
                    entry.ocr_text,
                ],
            );

            if res.is_ok() {
                imported_count += 1;
            }
        }

        // Import snippets (expansion enabled flag is never stored/restored)
        for sn in payload.snippets {
            let tags_json = serde_json::to_string(&sn.tags).unwrap_or_else(|_| "[]".to_string());
            let _ = tx.execute(
                "INSERT OR REPLACE INTO snippets (id, name, keyword, content, tags, icon, use_count, last_used_at, show_confirmation, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    sn.id,
                    sn.name,
                    sn.keyword,
                    sn.content,
                    tags_json,
                    sn.icon,
                    sn.use_count as i64,
                    sn.last_used_at,
                    if sn.show_confirmation { 1 } else { 0 },
                    sn.created_at,
                    sn.updated_at,
                ],
            );
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(ImportResult {
            imported_count,
            total_in_file,
        })
    }

    pub fn clear_unpinned(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        conn.execute("DELETE FROM entries WHERE is_pinned = 0", [])
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn trim_history(&self, retention_days: u32, max_entries: u32) -> Result<(), String> {
        let _ = self.cleanup_expired_entries();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // 1. Delete entries older than retention_days if retention_days > 0
        if retention_days > 0 {
            let cutoff = format!("-{} days", retention_days);
            if let Ok(mut stmt) = conn.prepare(
                "SELECT image_path FROM entries WHERE is_pinned = 0 AND created_at < datetime('now', 'localtime', ?1)",
            ) {
                if let Ok(rows) = stmt.query_map(params![cutoff], |row| row.get::<_, Option<String>>(0)) {
                    for path in rows.flatten().flatten() {
                        let _ = fs::remove_file(path);
                    }
                }
            }

            conn.execute(
                "DELETE FROM entries WHERE is_pinned = 0 AND created_at < datetime('now', 'localtime', ?1)",
                params![cutoff],
            )
            .map_err(|e| e.to_string())?;
        }

        // 2. Enforce max_entries count limit (keep youngest non-pinned)
        if max_entries > 0 {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT image_path FROM entries WHERE is_pinned = 0 AND id NOT IN (
                    SELECT id FROM (
                        SELECT id FROM entries WHERE is_pinned = 0 ORDER BY created_at DESC LIMIT ?1
                    )
                )",
            ) {
                if let Ok(rows) = stmt.query_map(params![max_entries], |row| row.get::<_, Option<String>>(0)) {
                    for path in rows.flatten().flatten() {
                        let _ = fs::remove_file(path);
                    }
                }
            }

            conn.execute(
                "DELETE FROM entries WHERE is_pinned = 0 AND id NOT IN (
                    SELECT id FROM (
                        SELECT id FROM entries WHERE is_pinned = 0 ORDER BY created_at DESC LIMIT ?1
                    )
                )",
                params![max_entries],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    pub fn get_stats(&self) -> Result<DbStats, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let total_items: u64 = conn
            .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
            .unwrap_or(0);

        let pinned_count: u64 = conn
            .query_row("SELECT COUNT(*) FROM entries WHERE is_pinned = 1", [], |row| row.get(0))
            .unwrap_or(0);

        let get_count = |ctype: &str| -> u64 {
            conn.query_row(
                "SELECT COUNT(*) FROM entries WHERE content_type = ?1",
                params![ctype],
                |row| row.get(0),
            )
            .unwrap_or(0)
        };

        let db_size_bytes = fs::metadata(&self.db_path)
            .map(|m| m.len())
            .unwrap_or(0);

        Ok(DbStats {
            total_items,
            db_size_bytes,
            text_count: get_count("text"),
            code_count: get_count("code"),
            rich_text_count: get_count("rich_text"),
            image_count: get_count("image"),
            file_count: get_count("file"),
            link_count: get_count("link"),
            email_count: get_count("email"),
            color_count: get_count("color"),
            pinned_count,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trim_history_max_entries_and_retention() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("carbon_test_{}", ts));
        let db_path = temp_dir.join("test.db");
        let db = DbState::new(db_path).unwrap();

        // Insert 10 items
        for i in 1..=10 {
            let mut item = ClipItem {
                id: format!("item-{}", i),
                content_type: "text".to_string(),
                title: format!("Title {}", i),
                text_content: Some(format!("Content {}", i)),
                rtf_content: None,
                html_content: None,
                image_path: None,
                image_width: None,
                image_height: None,
                file_paths: None,
                is_video: false,
                file_size: 0,
                is_pinned: i == 1, // Pin the first item
                source_app: None,
                created_at: String::new(),
                updated_at: String::new(),
                qr_content: None,
                is_sensitive: false,
                expires_at: None,
                ocr_text: None,
            };
            db.insert_entry(&mut item).unwrap();
        }

        // Trim with max_entries = 5
        db.trim_history(0, 5).unwrap();

        let remaining = db.get_all_entries(None, None, false, None).unwrap();
        // Pinned item (item-1) + 5 youngest unpinned items = 6 total
        assert!(remaining.iter().any(|i| i.id == "item-1" && i.is_pinned));
        assert_eq!(remaining.len(), 6);

        // Test retention days: create a dummy image and an old entry
        let dummy_img_path = temp_dir.join("test_img.png");
        fs::write(&dummy_img_path, b"fake png bytes").unwrap();
        assert!(dummy_img_path.exists());

        let mut old_item = ClipItem {
            id: "old-item".to_string(),
            content_type: "image".to_string(),
            title: "Old Image".to_string(),
            text_content: None,
            rtf_content: None,
            html_content: None,
            image_path: Some(dummy_img_path.to_string_lossy().to_string()),
            image_width: Some(100),
            image_height: Some(100),
            file_paths: None,
            is_video: false,
            file_size: 14,
            is_pinned: false,
            source_app: None,
            created_at: "2020-01-01 00:00:00".to_string(),
            updated_at: "2020-01-01 00:00:00".to_string(),
            qr_content: None,
            is_sensitive: false,
            expires_at: None,
            ocr_text: None,
        };
        db.insert_entry(&mut old_item).unwrap();
        // Overwrite created_at to old date in database
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE entries SET created_at = '2020-01-01 00:00:00' WHERE id = 'old-item'", []).unwrap();
        }

        // Trim with retention_days = 30
        db.trim_history(30, 0).unwrap();

        // Check that old item was deleted from DB and dummy image file was removed from disk
        let after_retention = db.get_all_entries(None, None, false, None).unwrap();
        assert!(!after_retention.iter().any(|i| i.id == "old-item"));
        assert!(!dummy_img_path.exists());

        // Clean up
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_duplicate_collapsing() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("carbon_dup_test_{}", ts));
        let db_path = temp_dir.join("test.db");
        let db = DbState::new(db_path).unwrap();

        // 1. Insert a pinned text item
        let mut item1 = ClipItem {
            id: "url-1".to_string(),
            content_type: "link".to_string(),
            title: "https://example.com".to_string(),
            text_content: Some("https://example.com".to_string()),
            rtf_content: None,
            html_content: None,
            image_path: None,
            image_width: None,
            image_height: None,
            file_paths: None,
            is_video: false,
            file_size: 19,
            is_pinned: true, // Pinned!
            source_app: Some("chrome.exe".to_string()),
            created_at: "2026-01-01 10:00:00".to_string(),
            updated_at: "2026-01-01 10:00:00".to_string(),
            qr_content: None,
            is_sensitive: false,
            expires_at: None,
            ocr_text: None,
        };
        db.insert_entry(&mut item1).unwrap();

        // 2. Simulate re-copying the exact same URL
        let new_copy = ClipItem {
            id: "url-new".to_string(),
            content_type: "link".to_string(),
            title: "https://example.com".to_string(),
            text_content: Some("https://example.com".to_string()),
            rtf_content: None,
            html_content: None,
            image_path: None,
            image_width: None,
            image_height: None,
            file_paths: None,
            is_video: false,
            file_size: 19,
            is_pinned: false,
            source_app: Some("chrome.exe".to_string()),
            created_at: String::new(),
            updated_at: String::new(),
            qr_content: None,
            is_sensitive: false,
            expires_at: None,
            ocr_text: None,
        };

        let bumped = db.find_and_bump_duplicate(&new_copy).unwrap();
        assert!(bumped.is_some());
        let bumped_item = bumped.unwrap();
        assert_eq!(bumped_item.id, "url-1");
        assert_eq!(bumped_item.is_pinned, true); // Pin status preserved!

        // Total count remains 1, no duplicate row
        let all = db.get_all_entries(None, None, false, None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "url-1");
        assert_eq!(all[0].is_pinned, true);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_bulk_delete_and_pin() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("carbon_bulk_test_{}", ts));
        let db_path = temp_dir.join("test.db");
        let db = DbState::new(db_path).unwrap();

        for i in 1..=4 {
            let mut item = ClipItem {
                id: format!("item-{}", i),
                content_type: "text".to_string(),
                title: format!("Title {}", i),
                text_content: Some(format!("Content {}", i)),
                rtf_content: None,
                html_content: None,
                image_path: None,
                image_width: None,
                image_height: None,
                file_paths: None,
                is_video: false,
                file_size: 0,
                is_pinned: false,
                source_app: None,
                created_at: String::new(),
                updated_at: String::new(),
                qr_content: None,
                is_sensitive: false,
                expires_at: None,
                ocr_text: None,
            };
            db.insert_entry(&mut item).unwrap();
        }

        // Bulk pin item-2 and item-3
        db.bulk_pin_entries(&["item-2".to_string(), "item-3".to_string()], true).unwrap();
        let all = db.get_all_entries(None, None, false, None).unwrap();
        assert!(all.iter().find(|i| i.id == "item-2").unwrap().is_pinned);
        assert!(all.iter().find(|i| i.id == "item-3").unwrap().is_pinned);
        assert!(!all.iter().find(|i| i.id == "item-1").unwrap().is_pinned);

        // Bulk delete item-1 and item-2
        db.bulk_delete_entries(&["item-1".to_string(), "item-2".to_string()]).unwrap();
        let remaining = db.get_all_entries(None, None, false, None).unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().any(|i| i.id == "item-3"));
        assert!(remaining.iter().any(|i| i.id == "item-4"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_export_and_import_backup() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("carbon_export_test_{}", ts));
        let db_path = temp_dir.join("test.db");
        let media_dir = temp_dir.join("media");
        fs::create_dir_all(&media_dir).unwrap();

        let db = DbState::new(db_path).unwrap();

        let dummy_img = media_dir.join("img_1.png");
        fs::write(&dummy_img, b"fake_png_data").unwrap();

        let mut item1 = ClipItem {
            id: "1".to_string(),
            content_type: "image".to_string(),
            title: "Image 1".to_string(),
            text_content: None,
            rtf_content: None,
            html_content: None,
            image_path: Some(dummy_img.to_string_lossy().to_string()),
            image_width: Some(50),
            image_height: Some(50),
            file_paths: None,
            is_video: false,
            file_size: 13,
            is_pinned: true,
            source_app: None,
            created_at: "2026-08-15 12:00:00".to_string(),
            updated_at: "2026-08-15 12:00:00".to_string(),
            qr_content: None,
            is_sensitive: false,
            expires_at: None,
            ocr_text: None,
        };
        db.insert_entry(&mut item1).unwrap();

        // Export
        let backup = db.export_backup().unwrap();
        assert_eq!(backup.total_items, 1);
        assert!(backup.entries[0].image_base64.is_some());

        // Clear DB
        db.bulk_delete_entries(&["1".to_string()]).unwrap();
        assert_eq!(db.get_all_entries(None, None, false, None).unwrap().len(), 0);

        // Import into clean DB
        let restore_media = temp_dir.join("restored_media");
        let result = db.import_backup(backup, &restore_media).unwrap();
        assert_eq!(result.imported_count, 1);

        let restored = db.get_all_entries(None, None, false, None).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, "1");
        assert_eq!(restored[0].is_pinned, true);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_append_to_clip() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("carbon_append_test_{}", ts));
        let db_path = temp_dir.join("test.db");
        let db = DbState::new(db_path).unwrap();

        let mut item = ClipItem {
            id: "merge-1".to_string(),
            content_type: "text".to_string(),
            title: "Line 1".to_string(),
            text_content: Some("Line 1".to_string()),
            rtf_content: None,
            html_content: None,
            image_path: None,
            image_width: None,
            image_height: None,
            file_paths: None,
            is_video: false,
            file_size: 6,
            is_pinned: false,
            source_app: None,
            created_at: String::new(),
            updated_at: String::new(),
            qr_content: None,
            is_sensitive: false,
            expires_at: None,
            ocr_text: None,
        };
        db.insert_entry(&mut item).unwrap();

        let merged = db.append_to_clip("merge-1", "Line 2").unwrap();
        assert_eq!(merged.text_content, Some("Line 1\nLine 2".to_string()));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_collections_and_pin_lock() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("carbon_col_test_{}", ts));
        let db_path = temp_dir.join("test.db");
        let db = DbState::new(db_path).unwrap();

        // 1. Create a collection
        let col = db.create_collection("Work Vault".to_string(), None, None).unwrap();
        assert_eq!(col.name, "Work Vault");
        assert_eq!(col.is_locked, false);

        // 2. Insert two clips and add to collection
        for i in 1..=2 {
            let mut item = ClipItem {
                id: format!("clip-{}", i),
                content_type: "text".to_string(),
                title: format!("Doc {}", i),
                text_content: Some(format!("Content {}", i)),
                rtf_content: None,
                html_content: None,
                image_path: None,
                image_width: None,
                image_height: None,
                file_paths: None,
                is_video: false,
                file_size: 10,
                is_pinned: false,
                source_app: None,
                created_at: String::new(),
                updated_at: String::new(),
                qr_content: None,
                is_sensitive: false,
                expires_at: None,
                ocr_text: None,
            };
            db.insert_entry(&mut item).unwrap();
        }

        db.add_clips_to_collection(&["clip-1".to_string(), "clip-2".to_string()], &col.id).unwrap();

        let in_col = db.get_all_entries(None, None, false, Some(&col.id)).unwrap();
        assert_eq!(in_col.len(), 2);

        let list = db.list_collections().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].item_count, 2);

        // 3. Test PIN lock & Recovery code generation
        let recovery_code = db.set_collection_pin(&col.id, "1234").unwrap();
        assert!(!recovery_code.is_empty());
        let updated_list = db.list_collections().unwrap();
        assert_eq!(updated_list[0].is_locked, true);

        // Verify correct PIN
        assert_eq!(db.verify_collection_pin(&col.id, "1234").unwrap(), true);
        // Verify wrong PIN
        assert_eq!(db.verify_collection_pin(&col.id, "9999").unwrap(), false);

        // Verify Recovery Code (works with / without dashes, case-insensitive)
        assert_eq!(db.verify_collection_recovery_code(&col.id, &recovery_code).unwrap(), true);
        assert_eq!(db.verify_collection_recovery_code(&col.id, &recovery_code.to_lowercase()).unwrap(), true);
        assert_eq!(db.verify_collection_recovery_code(&col.id, &recovery_code.replace("-", "")).unwrap(), true);
        assert_eq!(db.verify_collection_recovery_code(&col.id, "WRONG-CODE-1234-5678").unwrap(), false);

        // Test Reset with Recovery Code
        let new_recovery_code = db.reset_collection_passcode(&col.id, &recovery_code, "5678").unwrap();
        assert!(!new_recovery_code.is_empty());
        assert_eq!(db.verify_collection_pin(&col.id, "5678").unwrap(), true);
        assert_eq!(db.verify_collection_pin(&col.id, "1234").unwrap(), false);
        assert_eq!(db.verify_collection_recovery_code(&col.id, &new_recovery_code).unwrap(), true);

        // Test Update Collection Color
        db.update_collection_color(&col.id, Some("#3B82F6".to_string())).unwrap();
        let list_after_color = db.list_collections().unwrap();
        assert_eq!(list_after_color[0].color, Some("#3B82F6".to_string()));

        // 4. Remove a clip from collection
        db.remove_clip_from_collection("clip-1", &col.id).unwrap();
        let after_removal = db.get_all_entries(None, None, false, Some(&col.id)).unwrap();
        assert_eq!(after_removal.len(), 1);
        assert_eq!(after_removal[0].id, "clip-2");
        // Clip-1 still exists in main history!
        let all = db.get_all_entries(None, None, false, None).unwrap();
        assert_eq!(all.len(), 2);

        // 5. Delete collection (without deleting clips)
        db.delete_collection(&col.id, false).unwrap();
        let final_cols = db.list_collections().unwrap();
        assert_eq!(final_cols.len(), 0);
        let final_all = db.get_all_entries(None, None, false, None).unwrap();
        assert_eq!(final_all.len(), 2); // Clips untouched!

        let _ = fs::remove_dir_all(temp_dir);
    }
}
