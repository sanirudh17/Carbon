# OCR and glass refinement review

Branch: `ocr-glass-polish`. Main remains at `79d1e2a`. No merge or release is authorized for this pass.

## OCR

Carbon now uses bundled PP-OCRv6 Small with OAR-OCR 0.10 and ONNX Runtime 1.31 CPU. No Python, GPU, system Tesseract or first-use download is required. Build-time asset preparation verifies pinned lengths and SHA-256 hashes; the native build refuses missing or modified resources. The complete runtime, models, dictionary and licenses were verified inside the preview installer (46.5 MiB uncompressed).

The 18 owned synthetic English screenshots cover Consolas/Segoe UI, light/dark, reduced text, full-window images, tall images, code punctuation and randomized test tokens. The native comparison measured mean character error rates of 0.85% for Small and 4.02% for Carbon 0.1.19 Tesseract. Small preserved five exact test tokens; Tesseract preserved two. Neither engine was universally exact. These results do not establish accuracy for handwriting, every language or arbitrary user documents. The reproducible report is `validation/ocr/comparison.json`; its benchmark wall times are debug-profile measurements, not release performance claims.

Earlier packaged-runtime checks loaded ONNX directly from the installer-extracted `ocr` directory, extracted two owned images in about 0.8/1.1 seconds, returned cached text in 8-27 ms, and preserved existing clips/pins/collection memberships during OCR cache migration.

## Material and UI

Reference implementation: Glint 0.2.1 (`material.rs`, `styles/material.css`, `styles/controls.css`) and Seek's continuous neutral glass foundation. Existing Carbon layout and accent choices are preserved.

The first preview exposed a real composition incompatibility: Carbon retained `WS_EX_LAYERED` while visible, whereas Glint's glass windows are non-layered. A successful `DWMWA_SYSTEMBACKDROP_TYPE` assignment did not establish visible glass. The revised source retains cold/stale alpha-zero preparation but releases that style behind a verified cloak before revealing Desktop Acrylic. Solid keeps its alpha animation. Border color is reasserted without recreating the frame on every open. The existing content/settings paint gates and native rounded corners remain.

The revised CSS uses stronger transparency, a 52% black / 54% white root tint, subtle pane washes, and a separate editing well. Settings and secondary actions share centered control geometry; menus share a denser frosted surface. Filled-button labels choose a contrasting black/white foreground without changing the selected accent hue. Glass/Solid changes cover controllers before removing a backdrop and activate native material before publishing glass state.

## Validation and approval boundary

- 172 JavaScript checks pass, including accent contrast and revised reveal-policy contracts.
- TypeScript checking and Rust source parsing pass.
- 56 Rust tests and prior installer/runtime checks passed before the last native composition correction. That final correction has deliberately not been compiled or packaged following the user's request to wait for approval.
- Browser review uses real components and synthetic fixtures. Its backdrop is explicitly a browser simulation; it cannot prove Windows Desktop Acrylic or absence of native startup flashes.
- The final native material correction still requires an approved build and native screenshot/cold-start validation. Earlier preview installers are obsolete for that correction.
- Impeccable's detector reported seven pre-existing warnings: a semantic Markdown quote rule and existing layout/progress transitions. Those unrelated behaviors were preserved. Taste's generic marketing/title, dense desktop metadata, fixture content and permitted dialog-shadow heuristics were not treated as reasons to redesign this native utility.

After approval: build the latest source once, verify packaged OCR assets, test cold/warm opens and mode switching, and compare actual native pixels over a controlled backdrop before proposing a merge.

## Future ideas, not implemented

- Revision history for edited clips, with restore after restarting the app.
- Opt-in OCR search within an Images view, preserving the existing exclusion of images and collection clips from global text search.
- Per-app auto-filing rules and collection-specific retention policies.
