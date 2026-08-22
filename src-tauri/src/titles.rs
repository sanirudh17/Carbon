/// Shared title formatting for clipboard entries.
/// Used both at capture time (clipboard_watcher) and for migrating
/// older entries that were stored with verbose raw titles (db.rs).

pub fn format_clean_title(text: &str, content_type: &str) -> String {
    let clean_single_line = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    let sanitized = clean_single_line.trim();
    if sanitized.is_empty() {
        return "Empty clip".to_string();
    }

    match content_type {
        "color" => truncate_str(&sanitized.to_uppercase(), 24),
        "email" => truncate_str(sanitized, 40),
        "code" => truncate_str(sanitized, 40),
        "link" => truncate_str(sanitized, 45),
        "image" => "Image".to_string(),
        "file" => {
            let lines: Vec<&str> = text
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect();
            if lines.len() > 1 {
                format!("{} files", lines.len())
            } else {
                let path = std::path::Path::new(lines.first().copied().unwrap_or(sanitized));
                path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| sanitized.to_string())
            }
        }
        _ => truncate_str(sanitized, 40),
    }
}

pub fn truncate_str(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let mut truncated: String = s.chars().take(max_chars).collect();
        truncated.push('…');
        truncated
    }
}
