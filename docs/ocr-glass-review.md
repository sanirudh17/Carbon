# OCR and glass refinement review

Developed in the isolated `ocr-glass-polish` worktree. The user approved local integration into `main` after the native caption regression fix. No public release or publication is authorized for this pass.

## OCR

Carbon now uses bundled PP-OCRv6 Small with OAR-OCR 0.10 and ONNX Runtime 1.31 CPU. No Python, GPU, system Tesseract or first-use download is required. Build-time asset preparation verifies pinned lengths and SHA-256 hashes; the native build refuses missing or modified resources. The complete runtime, models, dictionary and licenses were verified inside the preview installer (46.5 MiB uncompressed).

The 18 owned synthetic English screenshots cover Consolas/Segoe UI, light/dark, reduced text, full-window images, tall images, code punctuation and randomized test tokens. The native comparison measured mean character error rates of 0.85% for Small and 4.02% for Carbon 0.1.19 Tesseract. Small preserved five exact test tokens; Tesseract preserved two. Neither engine was universally exact. These results do not establish accuracy for handwriting, every language or arbitrary user documents. The reproducible report is `validation/ocr/comparison.json`; its benchmark wall times are debug-profile measurements, not release performance claims.

Earlier packaged-runtime checks loaded ONNX directly from the installer-extracted `ocr` directory, extracted two owned images in about 0.8/1.1 seconds, returned cached text in 8-27 ms, and preserved existing clips/pins/collection memberships during OCR cache migration.

## Material and UI

Reference implementation: Glint 0.2.1 (`material.rs`, `styles/material.css`, `styles/controls.css`) and Seek's continuous neutral glass foundation. Existing Carbon layout and accent choices are preserved.

The first preview exposed a real composition incompatibility: Carbon retained `WS_EX_LAYERED` while visible, whereas Glint's glass windows are non-layered. A successful `DWMWA_SYSTEMBACKDROP_TYPE` assignment did not establish visible glass. The revised source retains cold/stale alpha-zero preparation but releases that style behind a verified cloak before revealing Desktop Acrylic. Solid keeps its alpha animation. Border color is reasserted without recreating the frame on every open. The existing content/settings paint gates and native rounded corners remain.

The revised CSS uses Glint's theme-led glass: a 72% black / 52% white root tint, subtle pane washes, and a separate editing well. Overlay windows inherit the same theme token rather than overriding light mode with a dark tint. The theme remains dominant; backdrop color is a soft detail rather than the window's main color. Settings and secondary actions share centered control geometry; menus share a denser frosted surface. Primary actions use quiet accent surfaces and related colored labels in both themes, without painted top highlight strips. Glass/Solid changes cover controllers before removing a backdrop and activate native material before publishing glass state.

## Native validation after build approval

The user approved native implementation and testing on 2026-10-30. The user subsequently approved local main-branch integration after the caption regression fix; no release or public artifacts were published.

- 210 frontend checks, TypeScript/production frontend compilation, and 57 native tests passed (native source unchanged in the menu follow-up).
- Built NSIS preview `0.1.20-preview.6`. SHA-256: `1636dd209a8e7676b86f5dcc5aa010613e8d6be259f5b183d7bfa5a366b631a0` (39,548,061 bytes).
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
- A recoverable trash view for accidental deletions, with a configurable expiry.
- Optional encryption for stored collections and exported backups.

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

### Caption regression and Settings cleanup

The intermittent screenshot/second-open title bar came from the native caption style remaining on the HWND despite the frameless configuration. The native guard now removes only `WS_CAPTION` at creation and filters `WM_STYLECHANGING` so later framework style regeneration cannot restore it. Resizing and min/max flags are preserved; DWM activation, client acrylic, native rounded corners, and existing first-paint/cloak gates remain.

The packaged preview passed eight forced caption-style restoration, activation/deactivation, and `WM_PRINT` screenshot-repaint cycles on an actually visible main window. Caption bits stayed absent. Resizing and maximize/restore passed. Both themes and both windows retained Desktop Acrylic=3, rounded corners=2, no layered flag while visible, and no standard native frame. The Settings section describing the OCR model is removed; a native DOM check confirms Shortcuts is first and the model is absent. Engine and bundling details remain in README.

References: [Windows caption and sizing styles](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-styles), [STYLESTRUCT changes](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-stylestruct).

### Shared menus, controls, scrollbars, and preview validation

Follow-up UI work uses a shared 4px scrollbar in Carbon's scrollable menus/lists/previews, with a transparent track, subdued theme thumb and hover emphasis; deliberately hidden metadata scrollbars stay hidden. Menus use the same neutral glass tokens and 24px blur as dialog sheets. Dialog and action-menu scrims stay light, with blur on the sheet rather than across the entire window. Destructive actions, passcode fields, and recovery controls use quiet theme surfaces without glow. Labels use a namespaced inner span with cap/alphabetic text trimming, preserving fallback flex centering and avoiding style collisions with captured rich HTML.

Right-clicking a clip row in both windows selects that row and opens the existing Ctrl+K action panel. Browser checks verified keyboard/mouse action parity, no automatic paste/copy/delete on opening, 4px menu scrollbars, context/delete/passcode/recovery glass, and label alignment in both themes. These checks used mocked IPC and synthetic data; they did not change collections or the system clipboard.

The 34-case content matrix covers Office-like and Gmail-like HTML, dark sources, tables/lists, legacy colors, low contrast, malformed HTML, Unicode and CF_HTML byte offsets, missing-image context, Markdown, Raw/RTF fallbacks, literal code/link/email text, files, colors, empty content and sensitive masking. It found and fixed unintended Markdown rendering of code/address-like content, Markdown bypassing HTML sanitization, and obfuscated executable URL schemes. Disabled task checkboxes retain their state. All 210 frontend checks pass. This is a representative regression matrix, not a guarantee for every external application, authenticated image source or arbitrary clipboard payload.

References: [Chrome scrollbar styling](https://developer.chrome.com/docs/css-ui/scrollbar-styling), [Chrome precise text alignment](https://developer.chrome.com/blog/css-text-box-trim).

The final preview.6 installer was extracted and all seven pinned OCR assets verified. Packaged checks passed for mouse-opened actions in main and Quick Overlay, both themes, 4px scrollbar width, 24px menu blur, mild scrims, non-layered glass, native corners/caption suppression, key/segmented label alignment, and the opaque/no-blur Solid fallback. Installed Carbon was running during this review and retained its shortcuts; the isolated preview uses Ctrl+Shift+J/L to avoid that conflict. Production history and installed files were left unchanged. No public release was published.

### Final list, scrollbar, and snippet-startup refinements

The approved reference now informs the dark list/sidebar: a slightly lifted charcoal wash and 12px rounded rows, preserving the existing layout, accents, and native glass. Shared scrollbars are 3px in both directions. Their explicit colors are charcoal `#30343a` in dark mode and pale `#d8dde3` in light mode, with theme-specific hover colors and a transparent track. The prior translucent white thumb was correctly custom-styled but appeared gray over dark surfaces. Hidden metadata scrollbars remain hidden; browser checks confirm standard scrollbar properties do not override the custom width.

Snippet startup uses live events plus a bounded 200ms status refresh for up to seven seconds. Active stops the refresh; unmount/disable cancels late updates. A delayed enable reply cannot overwrite an already received Active status. If the hook remains unavailable, Settings reports Not active rather than Starting indefinitely. Tests cover missed events, transient IPC errors, the startup deadline, and cancellation. The Settings back arrow is centered on both axes.

Quick Overlay file previews now expose Reveal in Explorer using the existing native command. Shared path parsing supports structured-only captures, CRLF text fallbacks, malformed/non-array JSON, and filters invalid array members. The main preview uses that parser as well. Browser checks validate the exact mocked Reveal command without launching Explorer or touching private files.

All 216 frontend tests pass. The bounded browser review passed startup status recovery without navigation, back-arrow centering, 3px themed scrollbars, Quick Overlay Reveal, right-click/Ctrl+K parity, and existing menu/dialog glass in both themes. Native reveal/cloak, background-color, caption, and decode-before-render safeguards were not changed. Per-app paste defaults and clip revision history remain deferred; this pass adds no new paste policy or revision-storage behavior.

The final preview.8 installer passed seven bundled OCR asset size/SHA-256 pins. Native checks passed for both themes/windows: 3px scrollbar width, exact theme/hover colors, menu glass and Solid fallback, button/key alignment, non-layered glass, caption suppression and native corners. Enabling snippets reached Active in the same Settings view in 112ms; the back-arrow center offset was zero on both axes. The first/repeated/stale opening exercise used 13 Quick Overlay openings and sampled 102 visible frames, detecting zero white capture-pane frames. Sampling can miss very brief artifacts; no claim is made that a rare sub-frame flash is impossible. No native presentation code was changed.

Preview.8 installer: 39,530,422 bytes; SHA-256 `b6090c3cc59133c65f0837bd1dd77567e34753e1a973e4aac7e0a835c877bf11`. It is an isolated local preview, with Ctrl+Shift+J/L shortcuts.

### Restore the published scrollbar reference

The subsequent user review preferred the previous GitHub version over the 3px variant. A fresh origin/tag comparison confirmed v0.1.19 (`1136b2b5d515279ea5199904775bd014591256a2`) used a 6px track, 1px transparent inset, 4px visible thumb, 4px rounding, dark `#26282e` and light `#c9c9d1`. Those dimensions/colors now replace the 3px variant throughout Carbon, including action menus. Hover remains theme-correct: dark `#33363e`, light `#b7b7c3`. Explicit content-box clipping and selector specificity preserve the inset in normal/hover states and both themes. Deliberately hidden metadata scrollbars remain hidden. Browser checks confirm the released geometry, correct colors, and unchanged startup/Reveal/centering behavior.

### Published release styling

The final user request reduces the shared track to 5px with the same 1px transparent inset, making the visible thumb roughly 3px. This supersedes the earlier 6px reference geometry. Both panes and all shared scroll surfaces use it. Native checks passed with the final CSS applied to both isolated windows; the production v0.1.20 assets include that same rule. See RELEASE_0.1.20_VALIDATION.md for release evidence.
