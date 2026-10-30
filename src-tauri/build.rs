fn main() {
    use sha2::{Digest, Sha256};
    let manifest: serde_json::Value = serde_json::from_str(include_str!("resources/ocr/manifest.json")).expect("OCR manifest");
    for file in manifest["files"].as_array().expect("OCR assets") {
        let path = std::path::Path::new("binaries/ocr").join(file["name"].as_str().unwrap());
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = std::fs::read(&path).unwrap_or_else(|_| panic!("Missing bundled OCR asset: {}. Run npm run prepare:ocr", path.display()));
        assert_eq!(bytes.len() as u64, file["bytes"].as_u64().unwrap(), "Invalid OCR asset size");
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), file["sha256"].as_str().unwrap(), "Invalid OCR asset checksum");
    }
    println!("cargo:rerun-if-changed=resources/ocr/manifest.json");
    tauri_build::build()
}
