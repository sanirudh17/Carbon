# Carbon 0.1.20

Carbon 0.1.20 brings bundled offline OCR and a consistent glass interface across the library, Quick Overlay, Settings, menus, and editors.

## OCR, included and offline

- Replaces Tesseract with bundled PP-OCRv6 Small, using ONNX Runtime on the CPU. No model download or cloud service is required.
- Improves extraction from tall screenshots with overlapping strips and handles transparent images against a white OCR background.
- Refreshes old OCR caches for the new engine while preserving clipboard history, favorites, snippets, and collection membership.
- Includes model/runtime licenses and verifies bundled assets against pinned sizes and SHA-256 hashes.
- In the retained 18-image synthetic comparison, mean character error was 0.85%, compared with 4.02% for the previous engine. Results depend on the image; this is not a guarantee for every document or language.

## Glass and controls

- Unifies dark and light glass across the sidebar, lists, previews, Quick Overlay, Settings, snippet editor, collection dialogs, and action menus. Solid mode remains available.
- Keeps dark glass dark and light glass light, with quieter field surfaces, balanced dividers, and clearer light-theme separation.
- Restores real desktop acrylic instead of a flat, opaque-looking fill. Preserves native rounded corners and prevents the standard Windows caption from reappearing after activation or screenshots.
- Centers text and icons in buttons, shortcut chips, segmented controls, and the Settings back button. Refines accent, danger, and recovery controls in both themes.
- Uses dark toggle knobs in dark mode and white knobs in light mode.
- Applies one subtle scrollbar treatment throughout: a 5px track, transparent 1px inset, and roughly 3px visible thumb, with dark/light colors based on the previous release. Hidden metadata scrollbars remain hidden.
- Removes OCR engine details from Settings; technical details remain in README.

## Actions and previews

- Right-click any clip in the library or Quick Overlay to open the same actions as Ctrl+K. The clicked clip becomes the action target.
- Adds Reveal in Explorer to Quick Overlay file previews. File/video previews accept structured file paths and older plain-text captures more reliably.
- Improves formatted previews for Office-like and email-like HTML, lists, tables, dark source colors, and malformed clipboard fragments.
- Keeps code, addresses, and links literal rather than accidentally rendering them as Markdown.
- Routes Markdown through the preview sanitizer, rejects obfuscated executable link schemes, and preserves read-only task-checkbox states.
- Keeps Raw and RTF-only fallbacks usable and retains image decode/stale-selection safeguards.

## Snippets and reliability

- Fixes snippet expansion remaining on Starting until Settings is reopened. Startup now refreshes status in place, stops polling once Active, and cancels late updates when leaving or disabling it.
- Shows Not active if startup does not complete within the bounded startup window, instead of displaying Starting indefinitely.
- Preserves existing first-paint, cloak, warm-window, and rapid image-selection safeguards against empty or white preview flashes.

## Validation and installation

- Keeps the existing Windows x64 NSIS installer and signed updater flow.
- Frontend, native, theme, preview-content, packaged glass/menu, and first/repeated opening checks are covered in the validation report.
- Preview coverage is representative; remote/authenticated images and every third-party clipboard format cannot be exhaustively guaranteed.

Detailed validation: [v0.1.20 validation report](https://github.com/sanirudh17/Carbon/blob/v0.1.20/RELEASE_0.1.20_VALIDATION.md).
