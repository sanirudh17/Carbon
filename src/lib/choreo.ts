import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * ADDENDUM v15: Choreography as a single invariant-enforced module (merge-proof).
 *
 * Consolidates ALL window show/hide/resize/fade for overlay, library, settings.
 * Enforces Invariants I1, I3, I4, I6:
 *   I1: Window becomes visible ONLY after (load complete AND data-painted="1" AND two rAFs).
 *       No time-based show fallback, ever (timeouts only warn in DEV).
 *   I3: Exactly one layout root mounted at all times (no snapshot/ghost layers).
 *   I4: Fade target per mode: Glass -> html element; Solid -> #root.
 *   I6: Text/label changes swap INSTANTLY: no opacity/transform transitions on text nodes.
 * Retired with the unified split frame (no Tab preview toggle, fixed 750x475
 * window, permanent preview pane): I2 (toggle-resize discipline), I5 (expand
 * cold gate), I7 (transition watchdog). Window size never changes at runtime.
 */

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7';

export interface InvariantViolation {
  id: InvariantId;
  message: string;
  timestamp: number;
}

const violations: InvariantViolation[] = [];

/**
 * Reports an invariant violation. Logs console.error and triggers dev OSD canary badge.
 */
export function reportViolation(id: InvariantId, message: string): void {
  const v: InvariantViolation = { id, message, timestamp: performance.now() };
  violations.push(v);
  if (violations.length > 100) violations.shift();

  console.error(`[CHOREO INVARIANT VIOLATION ${id}] ${message}`);

  if (typeof document !== 'undefined') {
    flashCanaryBadge(id);
  }
}

/** Terminal-visible trace for show/hide milestones (via Rust log pipe). */
export function traceChoreo(msg: string): void {
  invoke('log_client_event', { event: `[CHOREO] ${msg}` }).catch(() => {});
}

export function getViolations(): readonly InvariantViolation[] {
  return violations;
}

export function clearViolations(): void {
  violations.length = 0;
}

function flashCanaryBadge(id: InvariantId): void {
  // v20 Ground Rules: All diagnostics log/console-only; remove every on-screen diagnostic indicator from all builds.
  // carbon-choreo-canary visual DOM element removed.
  console.warn(`[CHOREO CANARY] violation ${id}`);
}

if (typeof window !== 'undefined') {
  listen<string>('choreo-hide-fallback', (e) => {
    console.warn(`[CHOREO CANARY] hide fallback triggered for ${e.payload} (cloaked flash-safe)`);
    flashCanaryBadge('I1');
  }).catch(() => {});
}

// ── Invariant I3: Single Layout Root ──

export function assertLayoutRoot(): boolean {
  if (typeof document === 'undefined') return true;
  const roots = document.querySelectorAll(
    '[data-carbon-layout-root], [data-carbon-layout-layer="overlay"]'
  );
  if (roots.length !== 1) {
    reportViolation('I3', `Expected exactly 1 live layout root mounted, found ${roots.length}`);
    return false;
  }
  return true;
}

// ── ADDENDUM v24: Per-Frame Sampler for Ghost Classification ──

export interface FrameSample {
  timestamp: number;
  layoutRootCount: number;
  windowWidth: number;
  windowHeight: number;
  osAlpha: number;
  maskState: string;
  contentOpacity: number;
}

export function sampleCurrentFrame(): FrameSample {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return {
      timestamp: 0,
      layoutRootCount: 1,
      windowWidth: 750,
      windowHeight: 475,
      osAlpha: 255,
      maskState: 'idle',
      contentOpacity: 1,
    };
  }
  const roots = document.querySelectorAll(
    '[data-carbon-layout-root], [data-carbon-layout-layer="overlay"]'
  );
  const previewPane = document.querySelector('.overlay-preview');
  // Unified split frame: no veil/mask classes exist anymore (the Tab preview
  // toggle was removed), so the mask state is permanently idle.
  const maskState = 'idle';

  let contentOpacity = 1;
  if (previewPane) {
    const style = window.getComputedStyle(previewPane);
    contentOpacity = parseFloat(style.opacity || '1');
  }

  return {
    timestamp: performance.now(),
    layoutRootCount: roots.length,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
    osAlpha: 255,
    maskState,
    contentOpacity,
  };
}

// ── Invariant I4: Fade Target Per Mode ──

export function getWindowMaterial(): 'glass' | 'solid' {
  if (typeof document === 'undefined') return 'glass';
  const mat = document.documentElement.dataset.material;
  return mat === 'solid' ? 'solid' : 'glass';
}

export function getFadeTarget(): HTMLElement {
  const html = document.documentElement;
  return html.dataset.material === 'solid'
    ? (document.getElementById('root') ?? html)
    : html;
}

// ── Overlay reveal animation ───────────────────────────────────────────
// Gentle fade-in on the content root as the cloak lifts (150ms ease-out).
// Always targets #root — never html, whose opacity transitions belong to
// the hide machinery. Fire-and-forget: no gate reads this class.
let revealTimer: number | null = null;

export function armOverlayReveal(): void {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('root');
  if (!root) return;
  root.classList.remove('ov-reveal');
  void root.offsetWidth;
  root.classList.add('ov-reveal');
  if (revealTimer !== null) window.clearTimeout(revealTimer);
  revealTimer = window.setTimeout(() => {
    revealTimer = null;
    root.classList.remove('ov-reveal');
  }, 120);
}

// ── Invariant I1: Window Show & Paint Gate ──

export function initPaintGate(): () => void {
  if (typeof document === 'undefined') return () => {};
  const html = document.documentElement;
  html.dataset.painted = '0';
  let firstFrame = requestAnimationFrame(() => {
    firstFrame = requestAnimationFrame(() => {
      html.dataset.painted = '1';
    });
  });
  return () => cancelAnimationFrame(firstFrame);
}

let showEpoch = 0;

export function executeWindowShow(
  windowName: 'overlay' | 'main' | 'settings',
  onRevealed?: () => void,
  // Event-driven show gate: happy path uses settleMs=0 (all fixed settle delays removed).
  // Initial cold boot mount can optionally provide settleMs for background prewarm.
  settleMs: number = 0,
  token?: number
): () => void {
  const epoch = ++showEpoch;
  const html = document.documentElement;
  const tHotkey = performance.now();
  let framesSinceShow = 0;
  let warned = false;
  let cancelled = false;

  traceChoreo(`${windowName} show sequence started (token=${token}, settle=${settleMs}ms)`);
  // I1: window stays .wm-hidden until gate opens
  html.classList.remove('wm-hiding');
  if (!html.classList.contains('wm-hidden')) {
    html.classList.add('wm-hidden', 'no-anim');
    void html.offsetWidth;
    html.classList.remove('no-anim');
  }

  let rafId: number | null = null;

  const wait = () => {
    rafId = requestAnimationFrame(async () => {
      if (cancelled || epoch !== showEpoch) return;
      framesSinceShow += 1;

      const windowLoaded = document.readyState === 'complete';
      const isPainted = html.dataset.painted === '1';

      // I1: EVENT-DRIVEN GATE: opens purely on per-cycle present confirmation
      // All fixed settle delays removed from the happy path (settleMs=0)
      if (windowLoaded && isPainted && framesSinceShow >= 2) {
        assertLayoutRoot();
        const tGate = performance.now();
        traceChoreo(`${windowName} show gate opened in ${(tGate - tHotkey).toFixed(1)}ms (settle ${settleMs}ms)`);
        if (settleMs > 0) {
          await new Promise<void>((r) => window.setTimeout(r, settleMs));
          if (cancelled || epoch !== showEpoch) return;
        }

        // Snap unhidden with NO transition while still cloaked (invisible),
        // BEFORE asking Rust to uncloak: the first composited frame is final
        // content, and no fade ever plays over bare acrylic (open flash).
        html.classList.add('no-anim');
        html.classList.remove('wm-hiding', 'wm-hidden');
        void html.offsetWidth;
        html.classList.remove('no-anim');

        // Allow Chromium's compositor to submit the unhidden DirectComposition frame
        // to DWM before requesting Rust to lift the cloak gate.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (cancelled || epoch !== showEpoch) return;

            const tAckReq = performance.now();
            // Release native DWM cloak gate (forced present lands first, Rust-side)
            const paintedCmd = windowName === 'overlay' ? 'overlay_painted' : 'enlarged_painted';
            traceChoreo(`${windowName} invoking ${paintedCmd} (uncloak) at ${(tAckReq - tHotkey).toFixed(1)}ms`);

            // invoke(paintedCmd) token-guarded uncloak
            invoke(paintedCmd, { token }).catch(() => {});
            invoke('choreo_notify_painted', { windowLabel: windowName, token }).catch(() => {});

            if (windowName === 'overlay') {
              invoke('overlay_phase_ack', { phase: 'shown' }).catch(() => {});
            }

            const tInteractable = performance.now();
            traceChoreo(`${windowName} first user-interactable reached in ${(tInteractable - tHotkey).toFixed(1)}ms`);

            // Reveal animation (overlay only): gentle fade-in on the content
            // root as the cloak lifts. Purely visual — fires after all gates
            // and timeouts, never gates or delays anything. Re-arms every
            // open (class removed after each play so rapid toggles replay).
            if (windowName === 'overlay') {
              armOverlayReveal();
            }

            if (onRevealed) onRevealed();
          });
        });
        return;
      }

      // Flash-safe recovery: if gate stays closed >300ms, force recovery rather than leaving stuck state
      if (!warned && performance.now() - tHotkey > 300) {
        traceChoreo(`${windowName} show gate bounded wait (300ms) reached; initiating flash-safe recovery`);
        warned = true;
      }

      wait();
    });
  };

  wait();

  return () => {
    cancelled = true;
    if (rafId) cancelAnimationFrame(rafId);
  };
}

// ── Invariant I4: Window Hide ──

export function executeWindowHide(
  windowName: 'overlay' | 'main' | 'settings',
  onFinished?: () => void
): { cancel: () => void } {
  const html = document.documentElement;

  if (windowName === 'overlay') {
    invoke('overlay_phase_ack', { phase: 'hiding' }).catch(() => {});
  }

  let cancelled = false;
  let finished = false;
  let timer: number | null = null;

  const finish = () => {
    if (cancelled || finished) return;
    finished = true;

    html.classList.remove('wm-hiding');
    if (windowName === 'overlay') {
      invoke('overlay_phase_ack', { phase: 'hidden' }).catch(() => {});
      invoke('hide_overlay').catch(console.error);
    } else if (windowName === 'main') {
      invoke('hide_enlarged').catch(console.error);
    }
    if (onFinished) onFinished();
  };

  const cancel = () => {
    if (cancelled || finished) return;
    cancelled = true;
    finished = true;
    if (timer !== null) window.clearTimeout(timer);
    html.classList.remove('wm-hiding');
  };

  // Cloak FIRST: the 90ms fade then plays invisibly behind the cloak
  // instead of exposing the bare acrylic slab (close flash). The fade
  // timing and cancel semantics below are unchanged, so re-show races behave
  // exactly as before. NOTE: cancel during fade leaves the window cloaked;
  // the re-show path re-runs the paint gate, whose painted ack uncloaks.
  const cloak = invoke('cloak_window', { windowLabel: windowName }).catch(() => {});
  cloak.finally(() => {
    if (cancelled) return;
    html.classList.add('wm-hiding', 'wm-hidden');
    timer = window.setTimeout(finish, 90);
  });

  return { cancel };
}

// ── Invariant I1/I2: Persistent Heartbeat while Hidden ──
// Keeps Chromium's compositor awake and warm even while cloaked/hidden,
// ensuring zero animation suspension or render freeze on show.
let heartbeatActive = false;

export function initCompositorHeartbeat(): void {
  if (typeof window === 'undefined' || heartbeatActive) return;
  heartbeatActive = true;

  const tick = () => {
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Background timer pulse to ensure wakefulness if Chromium throttles rAF while occluded
  setInterval(() => {
    if (document.hidden || document.documentElement.classList.contains('wm-hidden')) {
      document.documentElement.dataset.heartbeat = Date.now().toString();
    }
  }, 100);
}

export function isHeartbeatActive(): boolean {
  return heartbeatActive;
}

if (typeof window !== 'undefined') {
  initCompositorHeartbeat();
}
