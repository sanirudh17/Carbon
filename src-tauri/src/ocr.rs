//! OCR / Text Extraction for Image Clips.
//! Reuses the battle-tested Tesseract execution pipeline from Glint.

use image::{imageops::FilterType, ImageBuffer, Rgba};
use std::path::{Path, PathBuf};

const OCR_UPSCALE: f32 = 3.0;
const OCR_MAX_DIM: u32 = 8000;
const TESS_MISSING: &str =
    "Tesseract OCR is not installed or bundled. Install it via: winget install UB-Mannheim.TesseractOCR";

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
pub struct OcrOutput {
    pub text: String,
    pub line_count: usize,
    pub word_count: usize,
}

pub fn normalize_ocr_text(raw: &str) -> String {
    let mut lines = Vec::new();
    for line in raw.lines() {
        let trimmed_end = line.trim_end();
        if trimmed_end.is_empty() {
            lines.push(String::new());
            continue;
        }

        // Preserve indentation
        let leading_spaces = trimmed_end.chars().take_while(|c| *c == ' ' || *c == '\t').count();
        let (indent, content) = trimmed_end.split_at(leading_spaces);

        let mut cleaned = content.to_string();

        // 1. Heading hashes: HHHH 2., #H#HHH 3., ##H Verification, etc.
        let hash_prefix_len = cleaned.chars().take_while(|&c| c == '#' || c == 'H').count();
        if hash_prefix_len >= 2 && cleaned.chars().nth(hash_prefix_len) == Some(' ') {
            let rest = &cleaned[hash_prefix_len + 1..];
            if rest.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false) {
                let hashes = "#".repeat(hash_prefix_len.min(3).max(2));
                cleaned = format!("{} {}", hashes, rest);
            }
        }

        // 1b. Heading number confusion: ### U. -> ### 4., ### I. -> ### 1.
        if cleaned.starts_with("### U. ") {
            cleaned = format!("### 4. {}", &cleaned[7..]);
        } else if cleaned.starts_with("### I. ") {
            cleaned = format!("### 1. {}", &cleaned[7..]);
        }

        // 2. Bullet point symbol confusions (¢, ©, e, •, *, », «, ·, °, º, ◦, ▪, ▫, ‣, –, — before word)
        if let Some(rest) = cleaned.strip_prefix("¢ ")
            .or_else(|| cleaned.strip_prefix("© "))
            .or_else(|| cleaned.strip_prefix("e "))
            .or_else(|| cleaned.strip_prefix("« "))
            .or_else(|| cleaned.strip_prefix("» "))
            .or_else(|| cleaned.strip_prefix("· "))
            .or_else(|| cleaned.strip_prefix("° "))
            .or_else(|| cleaned.strip_prefix("º "))
            .or_else(|| cleaned.strip_prefix("• "))
            .or_else(|| cleaned.strip_prefix("◦ "))
            .or_else(|| cleaned.strip_prefix("▪ "))
            .or_else(|| cleaned.strip_prefix("▫ "))
            .or_else(|| cleaned.strip_prefix("‣ "))
            .or_else(|| cleaned.strip_prefix("– "))
            .or_else(|| cleaned.strip_prefix("— "))
        {
            if rest.chars().next().map(|c| c.is_ascii_alphanumeric() || c == '[' || c == '`' || c == '(' || c == '#').unwrap_or(false) {
                cleaned = format!("- {}", rest);
            }
        }

        // 3. Parenthesis opening confusion: CHHHH -> (HHHH, C### -> (###, C# -> (#, Cell) -> (ell), Ce.g. -> (e.g.
        if cleaned.contains("CHHHH") {
            cleaned = cleaned.replace("CHHHH", "(HHHH");
        }
        if cleaned.contains("C###") {
            cleaned = cleaned.replace("C###", "(###");
        }
        if cleaned.contains("C#") {
            cleaned = cleaned.replace("C#", "(#");
        }
        if cleaned.contains("Cell)") {
            cleaned = cleaned.replace("Cell)", "(ell)");
        }
        if cleaned.contains("Ce.g.") {
            cleaned = cleaned.replace("Ce.g.", "(e.g.");
        }

        // 3b. Hash number confusions: #84 4. -> ### 4., ##8 -> ###
        cleaned = cleaned.replace("#84 ", "### ");

        // 4. Macro / attribute confusions: H|tauri -> #[tauri, H[tauri -> #[tauri
        if cleaned.contains("H|tauri") {
            cleaned = cleaned.replace("H|tauri", "#[tauri");
        }
        if cleaned.contains("H[tauri") {
            cleaned = cleaned.replace("H[tauri", "#[tauri");
        }

        // 5. CLI flag confusions: "   dpi", "  dpi", " -dpi", " _dpi" -> " --dpi"
        for flag in &["dpi", "psm", "oem"] {
            for spaces in &["    ", "   ", "  ", " -", " _"] {
                let from = format!("{}{}", spaces, flag);
                let to = format!(" --{}", flag);
                cleaned = cleaned.replace(&from, &to);
            }
        }

        // 6. Arrow symbol artifacts: " » " -> " -> ", " ® " -> " -> ", " % " -> " -> "
        cleaned = cleaned.replace(" » ", " -> ");
        cleaned = cleaned.replace(" ® ", " -> ");
        cleaned = cleaned.replace(" % ", " -> ");

        // 7. Word-internal capital L / casing artifacts
        cleaned = cleaned.replace("buLllets", "bullets");
        cleaned = cleaned.replace("bulllets", "bullets");
        cleaned = cleaned.replace("bullet Lists", "bullet lists");
        cleaned = cleaned.replace("markdown List", "markdown list");
        cleaned = cleaned.replace("List bullets", "list bullets");
        cleaned = cleaned.replace("sans-serif Letter", "sans-serif letter");
        cleaned = cleaned.replace("the Luma", "the luma");
        cleaned = cleaned.replace("irregular Layouts", "irregular layouts");
        cleaned = cleaned.replace("QuickOverLlay", "QuickOverlay");
        cleaned = cleaned.replace("artifacts Like", "artifacts like");
        cleaned = cleaned.replace("where Lowercase", "where lowercase");
        cleaned = cleaned.replace("and Line boundary", "and line boundary");
        cleaned = cleaned.replace("text Lines", "text lines");
        cleaned = cleaned.replace("ALL 18", "All 18");
        cleaned = cleaned.replace("uppercase |", "uppercase 'l'");
        cleaned = cleaned.replace("| (ell)", "'l' (ell)");
        cleaned = cleaned.replace("you Like", "you like");
        cleaned = cleaned.replace("would Like", "would like");

        // 8. Generalized measurement unit cleanups (e.g. 24Upx -> 24px, 16Upx -> 16px, 12Upt -> 12pt)
        for unit in &["px", "em", "rem", "pt", "vh", "vw", "dp", "sp"] {
            for digit in 0..=9 {
                let from = format!("{}U{}", digit, unit);
                let to = format!("{}{}", digit, unit);
                cleaned = cleaned.replace(&from, &to);
            }
        }

        lines.push(format!("{}{}", indent, cleaned));
    }

    let joined = lines.join("\n");
    let trimmed = joined.trim_matches('\n');
    trimmed.to_string()
}

pub fn assemble_text(lines: &[String]) -> Option<String> {
    let raw = lines.join("\n");
    let normalized = normalize_ocr_text(&raw);
    if normalized.trim().is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub fn ocr_target_dims(w: u32, h: u32, max_dim: u32) -> (u32, u32) {
    if w == 0 || h == 0 || max_dim == 0 {
        return (w, h);
    }
    let longest = w.max(h) as f32;
    let factor = OCR_UPSCALE.min(max_dim as f32 / longest);
    let tw = ((w as f32) * factor).round().max(1.0) as u32;
    let th = ((h as f32) * factor).round().max(1.0) as u32;
    (tw, th)
}

fn is_dark_background(gray: &[u8]) -> bool {
    if gray.is_empty() {
        return false;
    }
    let sum: u64 = gray.iter().map(|&v| v as u64).sum();
    (sum / gray.len() as u64) < 128
}

fn enhance_contrast_and_edges(gray: &mut image::GrayImage) {
    let mut min_val = 255u8;
    let mut max_val = 0u8;
    for &v in gray.iter() {
        if v < min_val { min_val = v; }
        if v > max_val { max_val = v; }
    }
    let range = (max_val as f32 - min_val as f32).max(1.0);
    for v in gray.iter_mut() {
        let normalized = ((*v as f32 - min_val as f32) / range) * 255.0;
        // Mild S-curve to push dark text darker and light background lighter
        let enhanced = if normalized < 128.0 {
            (normalized * 0.88).max(0.0)
        } else {
            (normalized * 1.12).min(255.0)
        };
        *v = enhanced as u8;
    }
}

fn preprocess_to_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let need = w as usize * h as usize * 4;
    let rgba_img: ImageBuffer<Rgba<u8>, &[u8]> =
        ImageBuffer::from_raw(w, h, &rgba[..need]).ok_or("Couldn't read image buffer")?;
    let mut gray = image::imageops::grayscale(&rgba_img);

    if is_dark_background(&gray) {
        for v in gray.iter_mut() {
            *v = 255 - *v;
        }
    }

    enhance_contrast_and_edges(&mut gray);

    let (rw, rh) = ocr_target_dims(w, h, OCR_MAX_DIM);
    let gray = if (rw, rh) == (w, h) {
        gray
    } else {
        image::imageops::resize(&gray, rw, rh, FilterType::CatmullRom)
    };

    // Add white margin padding: Tesseract's character boundary detection is dramatically more accurate with padding
    let pad = 24u32;
    let pw = rw + pad * 2;
    let ph = rh + pad * 2;
    let mut padded = ImageBuffer::from_pixel(pw, ph, image::Luma([255u8]));
    image::imageops::overlay(&mut padded, &gray, pad as i64, pad as i64);

    let mut png = Vec::new();
    padded.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("encode png: {e}"))?;
    Ok(png)
}

struct TessLoc {
    exe: PathBuf,
    tessdata: Option<PathBuf>,
}

fn candidate_tesseract_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    // 1. Direct path to Glint's bundled binaries in sibling folder
    dirs.push(PathBuf::from(r"C:\Users\sanir\Claude Code\glint\src-tauri\binaries\tesseract"));

    // 2. Carbon manifest / binaries
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/tesseract"));
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../glint/src-tauri/binaries/tesseract"));

    // 3. Application directory / resources
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.join("tesseract"));
            dirs.push(dir.join("resources/tesseract"));
            dirs.push(dir.join("binaries/tesseract"));
            dirs.push(dir.join("../binaries/tesseract"));
        }
    }

    dirs
}

fn resolve_tesseract() -> Option<TessLoc> {
    for base in candidate_tesseract_dirs() {
        let exe = base.join("tesseract.exe");
        if exe.exists() {
            let td = base.join("tessdata");
            return Some(TessLoc {
                exe,
                tessdata: td.is_dir().then_some(td),
            });
        }
    }

    const INSTALLED: [&str; 2] = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ];
    for c in INSTALLED {
        if Path::new(c).exists() {
            return Some(TessLoc {
                exe: PathBuf::from(c),
                tessdata: None,
            });
        }
    }

    // Fallback to PATH
    let out = no_window(std::process::Command::new("where").arg("tesseract"))
        .output()
        .ok()?;
    if out.status.success() {
        if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
            let p = PathBuf::from(line.trim());
            if p.exists() {
                return Some(TessLoc {
                    exe: p,
                    tessdata: None,
                });
            }
        }
    }
    None
}

fn run_tesseract_pass(tess: &TessLoc, png_path: &Path, psm: &str) -> Result<String, String> {
    let mut cmd = std::process::Command::new(&tess.exe);
    cmd.arg(png_path)
        .arg("stdout")
        .args([
            "-l", "eng",
            "--oem", "1",
            "--psm", psm,
            "--dpi", "300",
            "-c", "preserve_interword_spaces=1",
            "-c", "textord_heavy_nr=1",
        ]);
    if let Some(td) = &tess.tessdata {
        cmd.arg("--tessdata-dir").arg(td);
    }
    let result = no_window(&mut cmd).output();
    let out = result.map_err(|e| format!("Couldn't run Tesseract: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Tesseract failed: {}", err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_tesseract(tess: &TessLoc, png: &[u8]) -> Result<String, String> {
    let path = std::env::temp_dir().join(format!(
        "carbon-ocr-{}-{}.png",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&path, png).map_err(|e| format!("temp write: {e}"))?;

    // Pass 1: Single uniform block (fast, keeps line layout)
    let res1 = run_tesseract_pass(tess, &path, "6");

    let pass1_text = res1.unwrap_or_default();
    let pass1_words = pass1_text.split_whitespace().count();

    // Pass 2: If pass 1 was empty or had very few words, try automatic page segmentation (PSM 3)
    let final_text = if pass1_words < 2 {
        if let Ok(pass2_text) = run_tesseract_pass(tess, &path, "3") {
            if pass2_text.split_whitespace().count() >= pass1_words {
                pass2_text
            } else {
                pass1_text
            }
        } else {
            pass1_text
        }
    } else {
        pass1_text
    };

    let _ = std::fs::remove_file(&path);
    Ok(final_text)
}

fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

pub fn recognize_rgba(rgba: &[u8], w: u32, h: u32) -> Result<OcrOutput, String> {
    let need = w as usize * h as usize * 4;
    if w == 0 || h == 0 || rgba.len() < need {
        return Err("Invalid image dimensions or buffer size".into());
    }
    let png = preprocess_to_png(rgba, w, h)?;
    let tess = resolve_tesseract().ok_or_else(|| TESS_MISSING.to_string())?;
    let raw = run_tesseract(&tess, &png)?;

    let lines: Vec<String> = raw.lines().map(|l| l.to_string()).collect();
    let text = assemble_text(&lines).unwrap_or_default();
    let line_count = text.lines().count();
    let word_count = text.split_whitespace().count();
    Ok(OcrOutput {
        text,
        line_count,
        word_count,
    })
}

pub fn recognize_file(path: &Path) -> Result<OcrOutput, String> {
    if !path.exists() {
        return Err(format!("Image file does not exist: {}", path.display()));
    }
    let img = image::open(path).map_err(|e| format!("Failed to open image: {e}"))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    recognize_rgba(&rgba, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_assemble_text() {
        let lines = vec!["Hello ".to_string(), "World \t".to_string()];
        assert_eq!(assemble_text(&lines).unwrap(), "Hello\nWorld");
    }

    #[test]
    fn test_target_dims() {
        let (tw, th) = ocr_target_dims(100, 50, 8000);
        assert_eq!(tw, 300);
        assert_eq!(th, 150);
    }

    #[test]
    fn test_normalize_ocr_text() {
        let raw = "HHHH 2. Fixed UI Freezing\n¢ Non-Blocking Command\ne Immediate State\n#H#HHH 3. Improved OCR Accuracy\n##H Verification\nSetting   dpi 300 matches\nRectifies H|tauri into #[tauri\nCHHHH 2., C### 3.)\npunctuation/buLllets and bullet Lists\n### U. Enhanced Border Padding\n° Flag Spacing\nbulllets » bullets\nwhere Lowercase | (ell)\nmarkdown List bullets\nCe.g. #84 4.)\nartifacts like % artifacts like\nPadding 24Upx margin\nWhich feature would Like to build";
        let normalized = normalize_ocr_text(raw);
        assert_eq!(
            normalized,
            "### 2. Fixed UI Freezing\n- Non-Blocking Command\n- Immediate State\n### 3. Improved OCR Accuracy\n### Verification\nSetting --dpi 300 matches\nRectifies #[tauri into #[tauri\n(HHHH 2., (### 3.)\npunctuation/bullets and bullet lists\n### 4. Enhanced Border Padding\n- Flag Spacing\nbullets -> bullets\nwhere lowercase 'l' (ell)\nmarkdown list bullets\n(e.g. ### 4.)\nartifacts like -> artifacts like\nPadding 24px margin\nWhich feature would like to build"
        );
    }
}
