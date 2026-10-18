# Clipboard and presentation fixes

Worktree: `bug-fixes`; main is unchanged.

Changes cover edited-text paste synchronization, duplicate capture prevention before ClipMerge, indexed content search for non-image clips, global collection exclusions, preview search highlights, bounded result rendering, cached search reset, and first-presentation gates for the overlay, main window and snippet argument prompt.

The final corner correction removes the GDI window region and uses `DWMWCP_ROUND`. GDI regions clipped client content while the acrylic compositor still extended into the corners. DWM now owns the complete rounded surface. Original acrylic tint and glass settings remain. Custom CSS window shadows are removed; Windows may retain its native compositor shadow.

Validation on 2026-10-18:

- 171 JavaScript checks passed; 55 Rust tests passed.
- Production installer built with updater-artifact generation disabled for this local build.
- Release runtime checks used synthetic fixtures in a disposable application profile. A copy of the production executable had only its equal-length application identifier changed (8 bytes); the shipped executable and installer were not modified.
- Actual Windows clipboard paste returned edited text. Repeated capture and repeated old pinned-key capture remained single; distinct captures still merged.
- With 2,500 synthetic clips, search highlights, deep-match scrolling, 200/400-result pagination, collection exclusions and membership preservation passed. Measured typing-to-paint was below 7 ms; clearing search restored cached history in about 85 ms on this machine. Production IPC call-count instrumentation was unavailable; debounce behavior is covered by interaction tests.
- The final native-corner correction passed automated checks and compilation. The user subsequently confirmed that the native-corner installer worked correctly. Earlier custom-region screenshot checks did not establish correct acrylic clipping and are superseded by this correction.
- The snippet argument prompt paint handshake is tested; a physical-keyboard first-open check remains unverified because the expansion hook intentionally rejects injected keystrokes.
- Existing already-duplicated clipboard history is not rewritten.

Release version: v0.1.19. Image-preview regression coverage verifies decode-before-display, stale selection suppression, fallback loading, and permanent failure without broken-image UI.
