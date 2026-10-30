//! Explicit native comparison; does not access clipboard history or user media.
#[path = "../src/ocr/neural.rs"]
mod neural;
#[allow(dead_code)]
#[path = "../../validation/ocr/tesseract_baseline.rs"]
mod baseline;
use std::{path::PathBuf, time::Instant};

fn normalized(value: &str) -> String { value.split_whitespace().collect::<Vec<_>>().join(" ") }
fn distance(a: &str, b: &str) -> usize {
    let b: Vec<_> = b.chars().collect();
    let mut previous: Vec<_> = (0..=b.len()).collect();
    for (i, x) in a.chars().enumerate() {
        let mut next = vec![i + 1];
        for (j, y) in b.iter().enumerate() {
            next.push((next[j] + 1).min(previous[j+1] + 1).min(previous[j] + usize::from(x != *y)));
        }
        previous = next;
    }
    previous[b.len()]
}
fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    let root = PathBuf::from(args.get(1).ok_or("usage: ocr-comparison FIXTURE_DIR REPORT_FILE")?);
    let cases: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(root.join("fixtures.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    neural::initialize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/ocr"));
    let mut records = Vec::new();
    for engine in ["tesseract-carbon-0.1.19", "ppocrv6-small"] {
        for (index, case) in cases.iter().enumerate() {
            let file = case["file"].as_str().unwrap();
            let start = Instant::now();
            let text = if engine == "ppocrv6-small" { neural::recognize_file(&root.join(file))?.text }
                else { baseline::recognize_file(&root.join(file))?.text };
            let elapsed = start.elapsed().as_secs_f64() * 1000.;
            let actual = normalized(&text);
            let expected = normalized(case["expected"].as_str().unwrap());
            let cer = distance(&expected, &actual) as f64 / expected.chars().count() as f64;
            let record = serde_json::json!({"engine":engine,"file":file,"ms":elapsed,"cold":index==0,
                "cer":cer,"exact_token":case["exact_token"].as_str().map(|token|actual.contains(token)),"text":text});
            println!("{engine} {file}: CER={:.2}% time={elapsed:.0}ms", cer*100.);
            records.push(record);
        }
    }
    let mut summary = serde_json::Map::new();
    for engine in ["tesseract-carbon-0.1.19", "ppocrv6-small"] {
        let rows: Vec<_> = records.iter().filter(|r| r["engine"] == engine).collect();
        let warm: Vec<_> = rows.iter().filter(|r| r["cold"] == false).collect();
        summary.insert(engine.into(), serde_json::json!({"samples":rows.len(),
            "mean_cer":rows.iter().map(|r|r["cer"].as_f64().unwrap()).sum::<f64>()/rows.len() as f64,
            "warm_mean_ms":warm.iter().map(|r|r["ms"].as_f64().unwrap()).sum::<f64>()/warm.len() as f64,
            "exact_token_matches":rows.iter().filter(|r|r["exact_token"]==true).count()}));
    }
    let report = serde_json::json!({"pipeline":"Native Carbon Rust, ONNX Runtime CPU; synthetic English screenshots only", "summary":summary,"results":records});
    let output = args.get(2).ok_or("Missing report filename")?;
    std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).map_err(|e| e.to_string())?;
    println!("{}", report["summary"]);
    Ok(())
}
