//! Offline bundled OCR. No recognition-time downloads or external executables.
mod neural;
pub use neural::{initialize, recognize_file};
