# Carbon 0.1.20 validation

- Version sources: package.json, package-lock.json (root and package), Cargo.toml, Cargo.lock, and tauri.conf.json agree on 0.1.20.
- Frontend: 216 tests passed; TypeScript noEmit passed.
- Native: 57 library tests passed.
- Bundled OCR: seven model/runtime/dictionary/license files verified by pinned byte count and SHA-256 after extracting the production installer. Native application PE architecture is x64.
- Retained OCR comparison: 18 synthetic English screenshots per engine; mean character error 0.85% for PP-OCRv6 Small and 4.02% for the previous Tesseract pipeline. This does not establish universal accuracy.
- Browser/native checks: startup status changes to Active without navigation; back-arrow center offset zero on both axes. Native status reached Active in 112 ms.
- Shared final scrollbar: 5px track, authored 1px transparent inset (pixel-rounded at Windows scaling), roughly 3px visible thumb. Dark/light colors follow the previous release, with light hover kept light. Native library/Quick Overlay menu, glass/Solid, caption/corner, and centered-control checks passed in both themes. The final CSS was applied to both isolated native preview windows and is present in the production build assets.
- Opening regression exercise: 13 first/repeated/stale Quick Overlay openings; 245 visible capture-pane samples, zero white-panel samples. Sampling can miss very short artifacts. Native presentation safeguards were preserved.
- Preview validation uses the representative formatted/plain/code/email/file/color/masked matrix; remote/authenticated images and every third-party clipboard format are not exhaustively covered.
- Production installer resources and signature were checked directly. Interactive native testing used the isolated preview profile; production clipboard history was not used for test fixtures.
- Updater: the existing public key is retained. The installer signature and trusted-comment signature verify cryptographically; a modified installer is rejected. latest.json is BOM-free UTF-8, has the correct version/URL/signature, and all release checksums match.
- Packaging remains Windows x64 NSIS with the existing installer identity and updater install mode. Authenticode status remains unsigned, as documented in README; the updater signature is separate.

## Local installer

- File: Carbon_0.1.20_x64-setup.exe
- Bytes: 39537518
- SHA-256: `c92e2c260869d9f296a8464abf0270259d3c14f6d190cb7df0933ccea71030bf`

## Release checks

`node scripts/verify-release.mjs 0.1.20 .validation/release` passed, including signature verification, tamper rejection, manifest validation, versions, and checksums. Signing used the existing external key without printing credentials. Public artifact verification is recorded after publication.

## Public verification

Verified 2026-10-31T05:23:15+00:00.

- Published release: https://github.com/sanirudh17/Carbon/releases/tag/v0.1.20
- Release tag source commit: `23d9be9d1c305fd299ed6953b1091cab6118ac79`; main was fast-forwarded and pushed with the annotated tag.
- All four assets were downloaded anonymously from the public release and matched local bytes and SHA-256 hashes.
- The stable releases/latest/download/latest.json endpoint returned the identical v0.1.20 manifest.
- The verifier passed again against the downloaded assets, including cryptographic signature verification, trusted-comment verification, tamper rejection, versions, manifest URL/BOM, and checksums.

| Asset | Bytes | SHA-256 |
|---|---:|---|
| Carbon_0.1.20_x64-setup.exe | 39537518 | `c92e2c260869d9f296a8464abf0270259d3c14f6d190cb7df0933ccea71030bf` |
| Carbon_0.1.20_x64-setup.exe.sig | 416 | `af378366b45df732c17cefa6ec26916eb539703a07a07ed54e49f819fd31a8ea` |
| latest.json | 4707 | `9a3f44c94d3e6d4ba8180ceb0fceded20dda7f3cb1e716cf0bcba5e84f8bc8f8` |
| SHA256SUMS | 273 | `b486d559a4a6e3dee74af037aa8c7fbd458b20c3adfaf383329a1ccdaba89dcc` |

The isolated preview was left open with capture enabled, normal main-window stacking, and the original installed-app startup registration restored. Production history was not changed for validation.
