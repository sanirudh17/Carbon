# ADDENDUM v23: Event-Driven Show Gate + OS-Alpha Masking + Mask Lifecycle Diagnosis

## Phase 0: Symptom Register & Observable Phenomena
- **S1 Intermittent white frame when opening either window**: Occurred when time-based gating uncloaked before compositor commit or when DirectComposition swapchain had texture presentation lag on the first frame.
- **S2 Open/close latency regression vs known-good**: Fixed settle delays (`settleMs = 150ms` on main, artificial wait loops) added perceptible delay to every show operation, violating instant-open expectations.
- **S3 Tab flash regression**: Solid slab or double surface appeared when mask classes remained active during layout transition or conflicted with content opacity transitions.
- **S4 Full-window masked-empty surface visible outside Tab protocol**: Mask classes leaked or remained attached outside the strict content-out..content-in transition, exposing a bare desktop-blur slab.
- **S5 Guards**: Guaranteed flash-free hide, strict mutual exclusion (exactly one visible window), and instant zero-fade label swaps.

## Phase 1 & 2: Diagnostic Analysis & Evidence
1. **Time-Based Gating vs Event-Driven Gate (S1 + S2 Unified)**:
   - Fixed settle delays (`settleMs` in `executeWindowShow`, sleep loops in Rust) degraded latency from the ~55-60ms baseline to >200ms.
   - Eliminating all fixed settle delays from the happy path and gating uncloak purely on per-cycle present confirmation restores latency to baseline (<= +20ms p95 delta).
   - 300ms bounded fallback provides flash-safe recovery (stay cloaked/invisible, one retry), never an early uncloak.

2. **Compositor Texture Lag & OS-Alpha Masking (I2)**:
   - When WebView2 notifies `overlay_painted` or `enlarged_painted`, DirectComposition might present with sub-frame compositor latency.
   - Implementing OS-level window alpha masking starting at alpha 0 at uncloak and ramping to 1 over 80-120ms ensures any initial unpainted frame composites at opacity 0, rendering texture lag invisible to the human eye and camera sensors.

3. **Mask Lifecycle & Tab Protocol (I3, I4, S3, S4)**:
   - The desktop-blur mask must be active **strictly** between `content-out` start and `content-in` start within the Tab protocol.
   - The show path never presents a masked-empty window; if content is unready, the window remains cloaked (alpha 0).
   - Whenever content opacity > 0, mask-off is strictly asserted.

4. **Webview Occlusion & Persistent Heartbeat**:
   - Webview arguments `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion` prevent Chromium background suspension.
   - A persistent rAF heartbeat while hidden keeps Chromium's compositor awake and warm.
   - Controller default background color is set to transparent (`ARGB 0,0,0,0`) for frosted glass mode and theme background for solid mode.

## Baseline Benchmark (Last Known-Good Build f464021)
- **Overlay Window (20 runs)**: p50 = 55ms, p95 = 57ms
- **Main Window (20 runs)**: p50 = 57ms, p95 = 62ms
- **Budget Threshold (+20ms p95)**: Overlay <= 77ms, Main <= 82ms
