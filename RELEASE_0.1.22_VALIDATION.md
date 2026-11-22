# Carbon 0.1.22 validation

## Scope and checks

- Merges the UI polish, capture classification, Glint screenshot support, sliding indicators, and syntax highlighting improvements (`ff19a56`) together with Caret-anchored Quick Overlay placement, floating Reorderable Paste Stack Drawer, opt-in universal Smart Content Inspector, `Win+Shift+S` blur fix, and smooth content search (`e9437dd`), plus universal detector expansion, memoization, async image/query offloading, asset-protocol-first thumbnail cleanup, and full Rust warning cleanup.
- 232 frontend checks passed (`npm test`), including multi-tick search debounce race tests, universal Smart Content Inspector coverage across real-world payloads, reveal preparation, rich-text fidelity, drag robustness, and choreography invariants.
- Visual Canary choreography audit passed with 0 violations (`npm run canary`).
- TypeScript strict check passed with 0 errors (`tsc --noEmit`).
- 72 native Rust unit tests passed (`cargo test --lib`) and `cargo check --all-targets` passed with 0 warnings.
- Optimized Windows x64 NSIS release build (`npm run tauri build`) passed with 0 Rust warnings.

## Production package and updater

- Extracted application is x64. Bundled offline PP-OCRv6 Small assets verified (46.5 MiB, pinned sizes and SHA-256 hashes).
- `scripts/verify-embedded-ui.mjs` decompressed the embedded Tauri assets, matched them to production CSS/JS, and verified those compressed bytes inside `src-tauri/target/release/carbon.exe` (dark 68% / light 48% glass tints, painted document backing, native preparation handshake, and absence of the old DOM heartbeat).
- Existing app identifier (`com.carbon.clipboard`), NSIS installer format, passive updater install mode, and signed-updater public key are retained.
- `scripts/verify-release.mjs` passed version locks (`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`), BOM-free UTF-8 `latest.json`, release download URL, matching signature/key ID, cryptographic signature + trusted-comment verification, tamper rejection, and SHA-256 checksums.

| Embedded asset | Source SHA-256 |
|---|---|
| /assets/index-DT9uLmel.js | `3ad52502008c3600ecbc66bbe1f8ce886dcb6fdac280587751704985c64ff11f` |
| /assets/index-BWKcjJ9D.css | `3ee03567e109379f1513ff95d78f4c9112225adcfb9f4f622f05e90e83b12a25` |

Installer: `Carbon_0.1.22_x64-setup.exe`

- Bytes: 39523421
- SHA-256: `7ce3cc4e9449f4fc1ed47121b3ae4863f0bd8cd57c961b2c2b7401d0e83ce4c2`
