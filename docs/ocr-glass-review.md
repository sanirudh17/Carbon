# OCR and glass refinement review

Branch: `ocr-glass-polish`. Main remains at `79d1e2a`. No merge or release is authorized for this pass.

## OCR

Carbon now uses bundled PP-OCRv6 Small with OAR-OCR 0.10 and ONNX Runtime 1.31 CPU. No Python, GPU, system Tesseract or first-use download is required. Build-time asset preparation verifies pinned lengths and SHA-256 hashes; the native build refuses missing or modified resources. The complete runtime, models, dictionary and licenses were verified inside the preview installer (46.5 MiB uncompressed).

The 18 owned synthetic English screenshots cover Consolas/Segoe UI, light/dark, reduced text, full-window images, tall images, code punctuation and randomized test tokens. The native comparison measured mean character error rates of 0.85% for Small and 4.02% for Carbon 0.1.19 Tesseract. Small preserved five exact test tokens; Tesseract preserved two. Neither engine was universally exact. These results do not establish accuracy for handwriting, every language or arbitrary user documents. The reproducible report is `validation/ocr/comparison.json`; its benchmark wall times are debug-profile measurements, not release performance claims.

Earlier packaged-runtime checks loaded ONNX directly from the installer-extracted `ocr` directory, extracted two owned images in about 0.8/1.1 seconds, returned cached text in 8-27 ms, and preserved existing clips/pins/collection memberships during OCR cache migration.

## Material and UI

Reference implementation: Glint 0.2.1 (`material.rs`, `styles/material.css`, `styles/controls.css`) and Seek's continuous neutral glass foundation. Existing Carbon layout and accent choices are preserved.

The first preview exposed a real composition incompatibility: Carbon retained `WS_EX_LAYERED` while visible, whereas Glint's glass windows are non-layered. A successful `DWMWA_SYSTEMBACKDROP_TYPE` assignment did not establish visible glass. The revised source retains cold/stale alpha-zero preparation but releases that style behind a verified cloak before revealing Desktop Acrylic. Solid keeps its alpha animation. Border color is reasserted without recreating the frame on every open. The existing content/settings paint gates and native rounded corners remain.

The revised CSS uses Glint's theme-led glass: a 72% black / 52% white root tint, subtle pane washes, and a separate editing well. Overlay windows inherit the same theme token rather than overriding light mode with a dark tint. The theme remains dominant; backdrop color is a soft detail rather than the window's main color. Settings and secondary actions share centered control geometry; menus share a denser frosted surface. Primary actions use quiet accent surfaces and related colored labels in both themes, without painted top highlight strips. Glass/Solid changes cover controllers before removing a backdrop and activate native material before publishing glass state.

## Native validation after build approval

The user approved native implementation and testing on 2026-10-30. Main remains unmerged; no release or public artifacts were published.

- 175 frontend checks, TypeScript/production frontend compilation, and 56 Rust tests passed.
- Built NSIS preview `0.1.20-preview.4`. SHA-256: `616f77f73274d64d68cdba9e16c8f0f54768670ccea6cb4da49a312a7be10482` (39,493,518 bytes).
- Extracted the actual installer and verified all seven pinned OCR runtime/model/dictionary/license files. The running preview loaded ONNX Runtime from that extracted `ocr` directory, not a development cache. Two synthetic screenshots took 760/731ms; cached reads took 4/5ms.
- Four backend show/hide cycles per window and a theme roundtrip passed. Native screenshots then covered main, Quick Overlay, and collection dialogs in dark/light. Windows reported Desktop Acrylic=3, rounded corners=2, no cloak while visible, no layered flag while visible, and standard native frame rendering disabled.
- Image-action labels measured centered to less than 0.5px in both themes. Collection dialogs use a 10% scrim, no full-window CSS blur, and a frosted dialog sheet; the underlying app and desktop remain visible.
- Diagnostic logs contained no FAILED entries during this run. Existing content-paint gates, first-reveal hold, parking, and generation guards remain. These checks and native screenshots do not establish that no display driver can ever flash a frame.
- Tests used the separate `com.carbon.ocr-glass-preview` profile and synthetic fixtures. The production history and installed executable were not replaced. The production startup entry was restored after testing.

### Why the first packaged preview was opaque

Carbon's old frameless paint hook swallowed `WM_NCACTIVATE`. The revised hook forwards activation with `lParam=-1` to preserve activation processing while suppressing classic non-client repaint. Standard DWM caption rendering is disabled independently with `DWMWA_NCRENDERING_POLICY`; client acrylic and native rounded corners remain enabled. Native and WebView background colors are now prepared together, following Glint's complete surface update. The real-window result shows blurred colors from content behind Carbon instead of the identical `(29,29,29)` pixels seen across the old preview. No simulated backdrop is used in the packaged app.

Reference: [Microsoft WM_NCACTIVATE contract](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-ncactivate). The earlier browser captures were useful for typography and pane tones, but were not proof of native glass.

## Future ideas, not implemented

- Revision history for edited clips, with restore after restarting the app.
- Opt-in OCR search within an Images view, preserving the existing exclusion of images and collection clips from global text search.
- Per-app auto-filing rules and collection-specific retention policies.

## Surface and button refinement

Dark navigation, list, and preview panes share a 2.5% white wash; content wells use the same small lift instead of a dark slab. Snippet fields share the well token. The snippet input remains transparent over its syntax backdrop, preventing duplicate glyph painting. Preview text uses regular weight, and light mode uses softer neutral text colors. Button labels use medium weight and centered line boxes. Secondary actions carry a restrained accent tint; filled actions retain an opaque accent center for contrast with thin glass highlights at their edges. Solid, reduced-transparency, and forced-color modes retain their fallbacks.

Browser review covered main, Quick Overlay, snippet editor, and Settings in both themes. All eight combinations rendered; snippet input transparency and button centering/weight assertions passed (maximum text-box center difference 0.25px). TypeScript validation and 172 existing frontend checks passed. This remains browser simulation; no native build was performed for this refinement.

### Light-theme follow-up

The approved dark theme is unchanged. Light glass uses a 52% white root tint with lighter pane washes, 16% neutral dividers, and a 70% white snippet sheet. Blur lives on the snippet sheet rather than both the sheet and outer scrim. Setting labels use semibold while hints use regular, softer gray text. Light actions use a pale accent fill and related colored ink; contrast checks cover every shipped accent and both hover states. Button line boxes retain centered layout with a half-pixel optical lift for light-mode Segoe labels. Eight screen/theme combinations, TypeScript, and all 172 frontend checks passed. Native verification remains pending build approval.

### Inner divider balance

The sidebar edge is quieter (8% neutral in light, 5% white in dark). Main and Quick Overlay preview dividers now paint a single pixel inside the existing pane (19% neutral in light, 13% white in dark), without changing layout widths or introducing a window perimeter border. The old tests that required invisible inner dividers now reflect the requested visible divider while retaining reveal/hide assertions. Browser checks confirmed unchanged 480px main and 450px overlay preview widths, non-interactive absolute dividers, and zero body border in both themes. All 172 frontend checks passed. Native presentation, timing, masking, and material code were untouched; no packaged build was performed.

### Dark picker continuity

The dark Quick Overlay now applies its pane wash once to the content parent, including the search header and footer, with transparent list and preview children. This removes the separate darker header band without adding another tint layer. Dark preview dividers match the sidebar at 5% white. Light divider strength remains 19% neutral. All 172 frontend checks pass; four browser theme/window checks confirm unchanged pane geometry and inner divider colors. This CSS-only refinement does not change native presentation or flash-prevention behavior.

### Dark Settings controls

Dark Settings now matches the light-mode heading/hint weight hierarchy (600/400). Its update action uses a quiet accent wash and accent-colored label, removing the black text and bright background-image strip. Toggle knobs are explicitly dark in dark mode and white in light mode for both on/off states; inactive tracks and forced-color fallbacks keep the knob distinguishable. Browser assertions checked both themes, heading/hint weights, all nine knobs including both states, and the absence of a background image on the dark update action. All 172 frontend checks pass. No native presentation code, build, or merge was involved.

### Shared button treatment

The approved dark Settings accent treatment is now the shared primary/accent button style across editors, prompts, collections, main/Quick Overlay actions, and update banners. Light actions retain the approved pale accent fill and colored ink. Removed the background-image highlight strips from both themes and the secondary button inset highlight. Browser assertions verified matching computed styles in Settings, snippet editor, and argument prompt in both themes, with no image strip, no inset shadow, and no black action labels. All 172 frontend checks pass. Window presentation and flash-prevention code remain unchanged; no native build or merge was performed.
