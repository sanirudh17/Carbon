A focused reliability and UX release delivering universal text drag-and-drop across terminals, coding agents, Electron CLI hosts, and GPUI applications (Pebrel, Seek, Zed), distinct 3-mode Quick Overlay placement, reliable opt-in post-drop deselection in web search bars, and native drag hot-path hardening.

### Highlights

- **Universal text drag-and-drop (terminals, coding agents, Electron CLI hosts, GPUI apps)** — Dragging `text`, `code`, `link`, `email`, `rich_text`, or `color` clips now works seamlessly into Windows Terminal, PowerShell, Claude Code, OpenCode, Codex, Orca, VS Code, Cursor, Windsurf, Pebrel, Seek, and Zed. Targets that reject `CF_UNICODETEXT` or return a phantom `DROPEFFECT_COPY` without reading text formats cleanly fall back to clipboard staging, drop-point pane focusing, and target-native paste chords (`Ctrl+V`, `Ctrl+Shift+V`, or `Shift+Insert`).
- **GPUI compatibility (Pebrel, Seek, Zed)** — Immune to out-of-process WebView2 async `GetData` timing on fast drags, eliminates clipboard lock contention with GPUI's zero-retry `OpenClipboard(None)` via paste sequence tracking (`LAST_PASTE_SEQ`), automatically dismisses Quick Overlay on image, file, and text drops, transfers foreground focus cleanly, and supports compact top search bars like Seek.
- **Consistent native drag cursor feedback** — Unifies `GiveFeedback` cursor rendering with drop delivery and displays Windows' native `ole32.dll` COPY drag cursor (arrow + small drag square + plus badge) over eligible fallback targets like Orca and Windows Terminal while keeping honest no-drop feedback over non-text areas in standalone browsers, Desktop, and Taskbar.
- **Distinct Center, Caret, and Cursor Quick Overlay placement** — Restores all three independent overlay placement modes in `Settings -> Behavior`.
- **Reliable opt-in post-paste / post-drop deselect** — Adds `KEYEVENTF_EXTENDEDKEY` on arrow keys, wires `paste_deselect_after` into OLE text drops, covers modern Chromium/Gecko browsers (Chrome, Edge, Comet, Dia, Zen, Arc, Brave, Firefox, etc.), and uses two-pass Windows UI Automation selection verification for SPA search bars such as YouTube.
- **Performance & resource hardening** — Fixes an `OpenProcess` handle leak in `get_window_exe_name` (switching to `PROCESS_QUERY_LIMITED_INFORMATION` + `QueryFullProcessImageNameW` + RAII `CloseHandle`), adds a lock-free root-HWND cache in `GiveFeedback`, and ensures `CoUninitialize` cleanup in UIA probes.

### Packaging & Verification

- Retains bundled offline PP-OCRv6 Small, Windows x64 NSIS installer (`Carbon_0.1.23_x64-setup.exe`), app identity, and signed-updater flow (`latest.json` + `SHA256SUMS`).
