//! Bundled PP-OCRv6 Small; lazy, serialized ONNX Runtime CPU inference.
use oar_ocr::{core::config::OrtSessionConfig, domain::tasks::TextDetectionConfig,
    prelude::*, processors::LimitType};
use std::{path::{Path, PathBuf}, sync::{Mutex, OnceLock}};

const MAX_PIXELS: u64 = 40_000_000;
const TILE_HEIGHT: u32 = 1024;
const OVERLAP: u32 = 128;
static ROOT: OnceLock<PathBuf> = OnceLock::new();
static ENGINE: Mutex<Option<OAROCR>> = Mutex::new(None);

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
pub struct OcrOutput {
    pub text: String,
    pub line_count: usize,
    pub word_count: usize,
}

pub fn initialize(resources: PathBuf) { let _ = ROOT.set(resources); }

fn resource_root() -> Result<PathBuf, String> {
    let root = ROOT.get().cloned().unwrap_or_else(||
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/ocr"));
    for name in ["onnxruntime.dll", "pp-ocrv6_small_det.onnx", "pp-ocrv6_small_rec.onnx", "ppocrv6_dict.txt"] {
        if !root.join(name).is_file() {
            return Err("The bundled OCR files are missing. Reinstall Carbon to restore text extraction.".into());
        }
    }
    Ok(root)
}

fn validate_buffer(rgba: &[u8], w: u32, h: u32) -> Result<(), String> {
    let pixels = u64::from(w) * u64::from(h);
    if pixels == 0 || pixels > MAX_PIXELS || pixels * 4 != rgba.len() as u64 {
        return Err("Choose an image of up to 40 megapixels for text extraction.".into());
    }
    Ok(())
}

fn strips(height: u32) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    let mut top = 0;
    while top < height {
        let bottom = (top + TILE_HEIGHT).min(height);
        out.push((top, bottom));
        if bottom == height { break; }
        top = bottom - OVERLAP;
    }
    out
}

fn assemble_text(lines: Vec<String>) -> OcrOutput {
    // Preserve literal identifiers, punctuation, C#, percentages and flags.
    let text = lines.iter().map(|line| line.trim_end())
        .filter(|line| !line.trim().is_empty()).collect::<Vec<_>>().join("\n");
    OcrOutput { line_count: text.lines().count(), word_count: text.split_whitespace().count(), text }
}

pub fn recognize_rgba(rgba: &[u8], w: u32, h: u32) -> Result<OcrOutput, String> {
    validate_buffer(rgba, w, h)?;
    let mut guard = ENGINE.lock().map_err(|_| "Restart Carbon to reset text extraction.")?;
    if guard.is_none() {
        let root = resource_root()?;
        ort::init_from(root.join("onnxruntime.dll")).map_err(|e| format!("Could not load the bundled OCR runtime: {e}"))?.commit();
        let threads = std::thread::available_parallelism().map_or(2, |n| n.get().min(4));
        *guard = Some(OAROCRBuilder::new(root.join("pp-ocrv6_small_det.onnx"),
            root.join("pp-ocrv6_small_rec.onnx"), root.join("ppocrv6_dict.txt"))
            .ort_session(OrtSessionConfig::new().with_intra_threads(threads).with_inter_threads(1))
            .text_detection_config(TextDetectionConfig {
                limit_side_len: Some(4096), limit_type: Some(LimitType::Max),
                max_side_len: Some(4096), box_threshold: 0.5, unclip_ratio: 1.6,
                ..Default::default()
            }).return_word_box(false).build().map_err(|e| format!("Could not load the bundled OCR model: {e}"))?);
    }
    let mut lines = Vec::new();
    for (top, bottom) in strips(h) {
        // Hidden RGB values of transparent pixels must not invent visible text.
        let image = image::RgbImage::from_fn(w, bottom - top, |x, y| {
            let p = &rgba[((y + top) as usize * w as usize + x as usize) * 4..];
            image::Rgb(std::array::from_fn(|c|
                ((p[c] as u32 * p[3] as u32 + 255 * (255 - p[3] as u32)) / 255) as u8))
        });
        let results = guard.as_ref().unwrap().predict(vec![image]).map_err(|e| format!("Text extraction failed: {e}"))?;
        for result in results {
            for region in result.text_regions {
                let center = (region.bounding_box.y_min() + region.bounding_box.y_max()) / 2.;
                // Split each overlap at its midpoint, retaining one copy.
                if top > 0 && center < (OVERLAP / 2) as f32 ||
                   bottom < h && center >= (bottom - top - OVERLAP / 2) as f32 { continue; }
                if region.confidence.unwrap_or(0.) >= 0.5 {
                    if let Some(text) = region.text { lines.push(text.to_string()); }
                }
            }
        }
    }
    Ok(assemble_text(lines))
}

pub fn recognize_file(path: &Path) -> Result<OcrOutput, String> {
    // Reject oversized inputs before allocating a decompressed RGBA image.
    let reader = image::ImageReader::open(path).map_err(|e| format!("Could not open the image: {e}"))?
        .with_guessed_format().map_err(|e| e.to_string())?;
    let (w, h) = reader.into_dimensions().map_err(|e| format!("Could not read image dimensions: {e}"))?;
    if u64::from(w) * u64::from(h) > MAX_PIXELS || w == 0 || h == 0 {
        return Err("Choose an image of up to 40 megapixels for text extraction.".into());
    }
    let image = image::open(path).map_err(|e| format!("Could not decode the image: {e}"))?.to_rgba8();
    recognize_rgba(image.as_raw(), w, h)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_identifiers_and_punctuation_are_preserved() {
        let out = assemble_text(vec!["C# 25% --dpi 300  ".into(), "  Hello  World".into(), "".into()]);
        assert_eq!(out.text, "C# 25% --dpi 300\n  Hello  World");
        assert_eq!((out.line_count, out.word_count), (2, 6));
    }
    #[test]
    fn dimensions_are_bounded_before_runtime_loading() {
        assert!(validate_buffer(&[], 0, 1).is_err());
        assert!(validate_buffer(&[0; 3], 1, 1).is_err());
        assert!(validate_buffer(&[], u32::MAX, u32::MAX).is_err());
        assert!(validate_buffer(&[0; 4], 1, 1).is_ok());
    }
    #[test]
    fn strips_cover_tall_images_with_symmetric_overlap() {
        let slices = strips(3000);
        assert_eq!(slices.first(), Some(&(0, 1024)));
        assert_eq!(slices.last().unwrap().1, 3000);
        for pair in slices.windows(2) { assert_eq!(pair[0].1 - pair[1].0, OVERLAP); }
        assert!(strips(0).is_empty());
        assert_eq!(strips(64), vec![(0, 64)]);
    }
}
