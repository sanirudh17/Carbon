# Carbon 0.1.21 validation

## Scope and checks

- Fixes first/idle reopen composition: document backing stays painted, native mask/background changes finish under a verified cloak before a new renderer frame, and only the current prepared generation can reveal.
- Ties recovery to its show generation, preventing an older request from resetting a newer open. Adds bounded retry and acknowledgement handling; cancelled and failed handoffs remain hidden.
- Replaces continuous JavaScript animation-frame/100ms DOM-write heartbeat work with coalesced two-frame wake pulses. Native warmth safeguards remain.
- Includes the approved dark 68% / light 48% glass tint. Layout, colors, controls, scrollbars, native corners/caption safeguards, and Solid/accessibility fallbacks are preserved.
- 222 frontend checks passed, including controlled-frame cold/warm/cancel/retry and idle pulse tests. TypeScript passed in the production build.
- 59 native tests passed. The optimized Windows x64 NSIS build passed.
- Both source and production CSS passed 24 real-browser theme/material/window/show-hide states: document opacity stays one, content alone hides, glass tints match, Solid stays opaque.
- Native development checks exercised five opens per window, including a 95-second hidden interval. After the efficiency change, 335 visible samples across both windows contained zero white-panel samples. Sampling can miss very short artifacts.
- Native diagnostics recorded 6 main and 5 overlay preparations, 11 native reveal messages, and 0 changed-surface rejections. Frame ordering is also covered by controlled renderer tests; the protected native bridge was not intercepted for command timing.
- Interactive testing used an isolated development profile. Production history was not used for test fixtures.

## Efficiency comparison

Single comparative development run on this Windows host, app plus WebView2 family, normalized across 12 logical processors. Capture was paused in both runs to isolate rendering work. Ten processes remained stable in each sample. These are CPU observations, not a per-GPU or whole-production-workload guarantee.

| State | Before wake-driven pulses | After | Sample |
|---|---:|---:|---|
| Hidden idle | 1.9254% | 0.0082% | 95 seconds |
| Visible idle | 0.6356% | 0.0234% | approximately 11 seconds |

The transparency uses the existing Windows compositor acrylic, with no full-window CSS backdrop filter on html, body, or root, no screenshot/reflection layer, and no added idle polling loop. Native per-open preparation and the original warmth safeguards remain.

## Production package and updater

- Extracted application is x64. All seven bundled OCR model/runtime/dictionary/license assets match their pinned sizes and SHA-256 values.
- `verify-embedded-ui.mjs` decompressed the actual Tauri embedded assets, matched them to production CSS/JS, and found those exact compressed bytes in the extracted executable. Approved tints, painted document backing, native preparation command, and absence of the old DOM heartbeat were verified.
- Existing app identifier, NSIS format, updater install mode, and updater public key are retained. Installer Authenticode status remains unsigned as before; the separate updater signature is verified.
- Local updater verification passed versions/locks, URL, BOM-free UTF-8, key ID, installer and trusted-comment signatures, tamper rejection, and all checksums.

| Embedded asset | Source SHA-256 |
|---|---|
| /assets/index-84bTph5m.js | `efa144de37117ddf77425ef0c02c7fb2e69ab326033c12ba7a8649beea5d35cf` |
| /assets/index-DgztAxbF.css | `15eb8d74371751033ff2d586c33366675743454fececd340142f4ae5f93b0ab1` |

Installer: `Carbon_0.1.21_x64-setup.exe`

- Bytes: 39540537
- SHA-256: `c88330c1f6ff947d1be084d398fed1d383b99d7255d63c1dbe964377847e5a97`

Public verification is recorded after publication.

## Public verification

Verified 2026-11-02T11:05:22+00:00.

- Published: https://github.com/sanirudh17/Carbon/releases/tag/v0.1.21
- Release source commit: `dce7fbacf46f363df6df11c3c2918426ebf0c45c`; main and the annotated tag were pushed.
- All four assets were downloaded anonymously and matched local bytes and SHA-256 hashes. The stable updater endpoint served the identical v0.1.21 manifest.
- Signature/trusted-comment verification, tamper rejection, version/manifest checks, and checksums passed again against the public downloads.

| Asset | Bytes | SHA-256 |
|---|---:|---|
| Carbon_0.1.21_x64-setup.exe | 39540537 | `c88330c1f6ff947d1be084d398fed1d383b99d7255d63c1dbe964377847e5a97` |
| Carbon_0.1.21_x64-setup.exe.sig | 416 | `fb086c4ec0c558473e09f91a993622bb30402a081abac83875ba884f8a194a90` |
| latest.json | 3594 | `b71ca499c5390d374a67f90119cef80e3da25528becb369841352f7e52679c4a` |
| SHA256SUMS | 273 | `771b1453e3bd29e76c9810f8985a0c4c87887b3a3af48aede1380642d07ce021` |
