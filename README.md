<p align="center">
  <img src="./src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Carbon icon" />
</p>

<h1 align="center">Carbon</h1>

<p align="center">
  <strong>A fast, local-first clipboard manager for Windows.</strong><br/>
  Instant overlay, searchable history, snippets & OCR — everything stays on your machine.
</p>

<p align="center">
  <a href="https://github.com/sanirudh17/Carbon/releases/latest"><img src="https://img.shields.io/github/v/release/sanirudh17/Carbon?label=download&color=2f6feb" alt="Latest release" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f6feb.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078d6.svg" alt="Platform: Windows" />
  <a href="https://v2.tauri.app/"><img src="https://img.shields.io/badge/built%20with-Tauri%20v2-24c8db.svg" alt="Built with Tauri" /></a>
</p>

---

## Overview

Carbon is a local-first clipboard manager for Windows. Press a hotkey to summon a quick overlay anywhere, paste from a searchable history, organize clips into collections, expand snippets system-wide, and extract text from images with bundled Tesseract OCR — all without cloud, accounts, or telemetry.

Carbon keeps everything in a local SQLite database (`carbon_history.db`) with image files on disk. History, snippets, and settings never leave your computer.

## Table of contents

- [Features](#features)
- [Download & install](#download--install)
- [Building from source](#building-from-source)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Privacy](#privacy)
- [License](#license)

## Features

### Quick Overlay (HUD)

Summon with `Ctrl+Shift+Z` (customizable) — a centered overlay appears at your cursor, showing recent clips and snippets. Search, filter by type (text, code, image, files, links, email, color, rich text), and paste with transforms (plain text, markdown, JSON, uppercase/lowercase/title, base64, URL). `Ctrl+V` advances a queued multi-paste. The preview pane is toggleable and remembers its position.

### Library & Enlarged Window

Open the full library with `Ctrl+Alt+X` (customizable) — a searchable, filterable view of all history. Pin favorites, bulk select, manage collections (with optional PIN), and edit clip text inline. Two-way sync: deleting in Explorer or in Carbon stays consistent.

### Snippets & System-wide Expansion

Create snippets with keywords (e.g. `/select`) and dynamic placeholders (`{date}`, `{clipboard}`, `{cursor}`). Enable **snippet expansion** to expand keywords as you type in any app across Windows — private in-memory buffer (256 chars), zero CPU when idle, UIPI-safe in elevated windows.

### Capture Text (OCR)

Extract text from any image clip with a single click, powered by a **bundled Tesseract** engine (no separate install). Preprocessing upscales, enhances contrast, adds white padding, and runs two PSM passes for accuracy; `eng.traineddata` ships inside the installer.

### Collections & Privacy

Organize clips into collections with colors and PIN protection (with recovery code). Optional **ClipMerge** appends rapid successive copies, **strip tracking params** cleans URLs (`utm_*`, `fbclid`, etc.), custom **capture rules** (find/replace, plain or regex), and **sensitive data** detection (credit cards, API keys, JWTs, private keys) with auto-expiry.

### Global Hotkeys

Two swappable global shortcuts (Quick Overlay + Enlarged Window) — `tauri-plugin-global-shortcut` with atomic `unregister_all`/`reapply` and strict rollback. `Ctrl+Alt` combos are handled via `AltGraph` parity (so `M→µ`, `N→ñ` etc. work) and a `WH_KEYBOARD_LL` hook prevents GPU software from stealing focus. Conflicts show inline errors and toast pop-ups.

### Theming & Polish

Dark/light themes with `PNG` app badge at native resolution (dark/light variants), accent swatches + custom color picker, and a theme-aware layered-clipboard icon. All settings persist in `settings.json` and survive restarts.

## Download & install

Download the latest installer from the [**Releases**](https://github.com/sanirudh17/Carbon/releases/latest) page and run it:

| Installer | Notes |
|---|---|
| **`Carbon_0.1.0_x64-setup.exe`** | NSIS installer — single executable, bundles Tesseract OCR. Recommended. |

Everything Carbon needs is bundled — no extra dependencies. The installer is currently unsigned, so Windows SmartScreen may show *“Windows protected your PC”* → **More info → Run anyway**.

**System requirements:** Windows 10 or 11 (64-bit). WebView2 is preinstalled on Windows 11 and auto-installed on Windows 10 if missing.

## Building from source

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ with npm
- [Rust](https://rustup.rs/) stable toolchain
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) — Microsoft C++ Build Tools + WebView2
- PowerShell (for binary fetch)

### 1. Clone and install

```bash
git clone https://github.com/sanirudh17/Carbon.git
cd Carbon
npm install
```

### 2. Fetch the bundled OCR runtime

Tesseract is large (~164 MB) and not committed. Fetch once per machine:

```powershell
# From repository root, copy or fetch tesseract to src-tauri/binaries/tesseract/
# Example: copy from Glint's bundled copy or run your fetch script
```

This populates `src-tauri/binaries/tesseract/` (`tesseract.exe`, DLLs, `tessdata/eng.traineddata`) which `npm run tauri build` bundles via `tauri.conf.json` `bundle.resources: {"binaries/tesseract":"tesseract"}`. Without it the app builds but OCR will report `TESS_MISSING`.

### 3. Run in development

```bash
npm run tauri dev
```

### 4. Build the single executable

```bash
npm run tauri build
# → src-tauri/target/release/bundle/nsis/Carbon_0.1.0_x64-setup.exe
```

### 5. Run the test suite

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

## Tech stack

| Layer | Technology |
|---|---|
| App shell | [Tauri v2](https://v2.tauri.app/) — Rust core + WebView2 |
| Frontend | React 19, TypeScript, Vite, Zustand |
| Database | SQLite (`rusqlite` bundled, WAL) |
| OCR | Tesseract 5 (`eng.traineddata` bundled) |
| Hotkeys | `tauri-plugin-global-shortcut` + `WH_KEYBOARD_LL` hook |
| Clipboard | Windows `Win32_System_DataExchange`, `html2md`, `image` |

## Project structure

```
src/               React + TypeScript frontend (Vite)
  components/      QuickOverlay, EnlargedWindow, Settings, Icons (PNG badge)
  assets/          carbon-badge-dark/light.png (1.2–1.3 MB, theme-aware)
src-tauri/
  src/             Rust core (clipboard_watcher, db, hotkey, shortcuts, expansion, ocr, paste)
  icons/           Generated from dark PNG (128x128@2x, icon.ico/icns, StoreLogo)
  binaries/tesseract/  Bundled OCR runtime (not committed, fetched per-machine)
```

## Privacy

Carbon is **local-first**. No network code, no cloud sync, no accounts, no telemetry. Clipboard history, images, snippets, and settings live in `%APPDATA%/com.carbon.clipboard/` and never leave your disk. Snippet expansion uses a private 256-char in-memory buffer never written to disk.

## License

Released under the [MIT License](./LICENSE). © 2026 Sanirudh ([sanirudh17](https://github.com/sanirudh17)).

Bundled Tesseract is third-party software under [Apache-2.0](https://github.com/tesseract-ocr/tesseract) and remains under its own license. It is fetched per-machine and not part of this repository.

## Acknowledgements

Built with [Tauri](https://v2.tauri.app/) and [Tesseract OCR](https://github.com/tesseract-ocr/tesseract). Icon design from the Carbon layered-clipboard illustration. Inspired by CleanShot X and Glint.
