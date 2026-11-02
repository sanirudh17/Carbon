# Carbon 0.1.21

A focused fix for first-open and idle-reopen white flashes, with the slightly clearer glass approved in development review.

## White-flash and reveal fixes

- Keeps the document/native backing continuously painted in both Glass and Solid modes. Only the content layer changes opacity; the whole HTML surface no longer fades to transparent.
- Prepares the native composition surface while the window is cloaked, including removing a cold layered-alpha mask and confirming the transparent WebView background, before requesting a fresh renderer frame.
- Waits for a complete post-preparation frame on every open, including subsequent and idle opens. This removes the warm-open shortcut that could acknowledge a frame before it was painted.
- Validates the prepared show generation before revealing. Late, cancelled, or changed-surface acknowledgements cannot reveal the wrong window state.
- Ties recovery to the show generation so a cancelled/older request cannot hide a newer open during rapid shortcuts.
- Uses bounded retries for a lost native handoff; interaction callbacks run after the native reveal succeeds.
- Preserves existing rounded corners, caption suppression, image decode guards, content/settings paint gates, and native off-screen warmth safeguards.

## Approved glass and efficiency

- Slightly reduces the dark and light canvas tint so more desktop background is visible: dark 68%, light 48%. The native acrylic mechanism follows Glint/Typr; the dark tint follows Typr's lighter canvas.
- Keeps the approved layout, accent colors, controls, menus, scrollbar styling, and Solid/accessibility fallbacks unchanged.
- Retains compositor-owned Windows acrylic instead of adding full-window CSS blur, screen capture, or animated reflection layers. Native preparation is limited to opening windows, with no new idle polling loop.
- Replaces the endless JavaScript animation-frame heartbeat and hidden 100ms DOM-write timer with coalesced, two-frame wake pulses. Retains native warmth loops and fresh per-open frame validation.
- Removes whole-document opacity animation, reducing unnecessary composition-surface changes. Native idle/reopen and process-family CPU measurements are recorded in the validation report.

## Validation and packaging

- Covers cold/repeated/idle reveals, cancellation, failed preparation, lost-handoff retries, and both theme/material combinations.
- Retains bundled offline PP-OCRv6 Small, the existing Windows x64 NSIS installer, app identity, and signed-updater key.
- Full verification results: [v0.1.21 validation report](https://github.com/sanirudh17/Carbon/blob/v0.1.21/RELEASE_0.1.21_VALIDATION.md).
