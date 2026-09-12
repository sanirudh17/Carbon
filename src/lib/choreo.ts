import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * ADDENDUM v15: Choreography as a single invariant-enforced module (merge-proof).
 *
 * Consolidates ALL window show/hide/resize/fade for overlay, library, settings.
 * Enforces Invariants I1 through I7:
 *   I1: Window becomes visible ONLY after (load complete AND data-painted="1" AND two rAFs).
 *       No time-based show fallback, ever (timeouts only warn in DEV).
 *   I2: Window size may change ONLY while content layer opacity == 0 (content-out complete),
 *       and setSize is SYNCHRONOUS in the same task as the opacity-0 commit.
 *   I3: Exactly one layout root mounted at all times (no snapshot/ghost layers).
 *   I4: Fade target per mode: Glass -> html element; Solid -> #root.
 *   I5: Cold gate (data-painted-<layout>) applies ONLY to the FIRST-EVER expand of a layout.
 *       Collapse is NEVER gated (raster is warm).
 *   I6: Text/label changes swap INSTANTLY: no opacity/transform transitions on text nodes.
 *   I7: Watchdog 250ms force-finalizes stuck states; dev OSD canary flashes red corner.
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
      windowWidth: 680,
      windowHeight: 440,
      osAlpha: 255,
      maskState: 'idle',
      contentOpacity: 1,
    };
  }
  const roots = document.querySelectorAll(
    '[data-carbon-layout-root], [data-carbon-layout-layer="overlay"]'
  );
  const content = document.getElementById('content');
  const previewPane = document.querySelector('.overlay-preview');
  let maskState = 'idle';
  if (previewPane?.classList.contains('preview-out')) {
    maskState = 'out';
  } else if (previewPane?.classList.contains('snap-veil')) {
    maskState = 'snap';
  } else if (content?.classList.contains('kids-veil')) {
    maskState = 'in';
  }

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

// ── Invariants I2, I5, I7 & F2.2: Preview Layout Sizing ──

export type PreviewPhase = 'idle' | 'out' | 'snap' | 'in';

export interface LayoutTransitionController {
  toggle: (targetExpanded: boolean) => void;
  finalize: (targetState?: boolean) => void;
  /** Completes the snap when the native present-ack arrives (gen-guarded). */
  notifySnapPresented: (gen: number) => void;
}

// ── Invariant I3: Mask Lifecycle Helpers ──

function applyMask(el: HTMLElement | null, className: string, phase: string): void {
  if (!el) return;
  el.classList.add(className);
  traceChoreo(`[MASK_LIFECYCLE] add class='${className}' phase='${phase}' at=${performance.now().toFixed(1)}ms`);
}

function removeMask(el: HTMLElement | null, className: string, phase: string): void {
  if (!el) return;
  el.classList.remove(className);
  traceChoreo(`[MASK_LIFECYCLE] remove class='${className}' phase='${phase}' at=${performance.now().toFixed(1)}ms`);
}

export function assertMaskOff(phase: string): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  const content = document.getElementById('content');
  const previewPane = document.querySelector('.overlay-preview');

  const hasMask =
    html.classList.contains('wm-resizing') ||
    content?.classList.contains('kids-veil') ||
    previewPane?.classList.contains('snap-veil');

  if (hasMask && phase === 'idle') {
    reportViolation('I3', `Mask class leaked outside Tab transition in phase='${phase}'`);
    html.classList.remove('wm-resizing');
    content?.classList.remove('kids-veil');
    previewPane?.classList.remove('snap-veil', 'preview-out');
  }
}

/**
 * Creates an invariant-enforced layout transition manager for the overlay preview.
 * Enforces:
 *   I2: setSize called ONLY while content layer opacity == 0, SYNCHRONOUS in same task.
 *   I5: Cold gate applied ONLY on first-ever expand; collapse is NEVER gated.
 *   I7: 400ms watchdog force-finalizes with canary alert if the ack is lost.
 *   F2.2: Collapse: content-out (60ms) -> SYNCHRONOUS setSize(compact) ->
 *     native present-ack -> content-in (100ms). The veil NEVER lifts on a
 *     fixed frame count; it lifts only when Rust confirms the resized raster
 *     actually presented (gen-guarded against Tab-spam reordering).
 */
export function createPreviewLayoutController(options: {
  previewPaneRef: React.RefObject<HTMLDivElement | null>;
  previewOpenRef: React.MutableRefObject<boolean>;
  targetPreviewOpenRef: React.MutableRefObject<boolean>;
  previewPhaseRef: React.MutableRefObject<PreviewPhase>;
  setPreviewOpen: (open: boolean) => void;
  setPreviewPhase: (phase: PreviewPhase) => void;
  recordTransition?: (from: PreviewPhase, to: PreviewPhase, trigger: string) => void;
}): LayoutTransitionController {
  let timerId: number | null = null;
  let rafId: number | null = null;
  let watchdogId: number | null = null;
  let sampleRafId: number | null = null;
  let lastSentSize: boolean | null = null;
  // Monotonic snap id: ack-driven reveal honors only the latest snap, so a
  // stale present-ack from Tab spam can never unveil an obsolete transition.
  let snapGen = 0;

  const startLayoutRootSampling = () => {
    if (sampleRafId) cancelAnimationFrame(sampleRafId);
    const sample = () => {
      assertLayoutRoot();
      if (options.previewPhaseRef.current !== 'idle') {
        sampleRafId = requestAnimationFrame(sample);
      } else {
        sampleRafId = null;
      }
    };
    sampleRafId = requestAnimationFrame(sample);
  };

  // Dedicated central setSize call: ONLY called within choreo.ts.
  // Returns true when a native resize was actually requested (an ack will
  // follow); false when deduped (pixels unchanged, reveal immediately).
  const setWindowPreviewSize = (expanded: boolean, gen: number): boolean => {
    if (lastSentSize === expanded) return false;
    lastSentSize = expanded;

    // Verify Invariant I2: content layer opacity must be 0
    const pane = options.previewPaneRef.current;
    if (pane) {
      const style = window.getComputedStyle(pane);
      const isVeiled =
        pane.classList.contains('snap-veil') ||
        pane.classList.contains('preview-out') ||
        options.previewPhaseRef.current === 'out' ||
        options.previewPhaseRef.current === 'snap';
      if (!isVeiled && style.opacity !== '0' && parseFloat(style.opacity) > 0.05) {
        reportViolation(
          'I2',
          `Window size change called while content layer opacity is not 0 (opacity=${style.opacity})`
        );
      }
    }

    // Call Rust native resize via choreo shim. Rust settles, presents, then
    // emits the preview-toggled ack carrying our gen. If the invoke itself
    // fails, drop the dedup mark so the next toggle retries natively.
    invoke('set_overlay_preview', { enabled: expanded, gen }).catch((err) => {
      console.error(err);
      lastSentSize = null;
    });
    return true;
  };

  const finalize = (targetState?: boolean) => {
    if (timerId) {
      window.clearTimeout(timerId);
      timerId = null;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (watchdogId) {
      traceChoreo(`[WATCHDOG_FINALIZE] force-finalizing stuck state at=${performance.now().toFixed(1)}ms`);
      window.clearTimeout(watchdogId);
      watchdogId = null;
    }
    if (sampleRafId) {
      cancelAnimationFrame(sampleRafId);
      sampleRafId = null;
    }

    removeMask(document.documentElement, 'wm-resizing', 'finalize');
    if (options.previewPaneRef.current) {
      removeMask(options.previewPaneRef.current, 'snap-veil', 'finalize');
      removeMask(options.previewPaneRef.current, 'preview-out', 'finalize');
    }
    removeMask(document.getElementById('content'), 'kids-veil', 'finalize');

    const prevPhase = options.previewPhaseRef.current;
    if (typeof targetState === 'boolean') {
      options.previewOpenRef.current = targetState;
      options.targetPreviewOpenRef.current = targetState;
      options.setPreviewOpen(targetState);
      if (targetState) {
        setWindowPreviewSize(true, snapGen);
      } else {
        setWindowPreviewSize(false, snapGen);
      }
    }

    options.previewPhaseRef.current = 'idle';
    options.setPreviewPhase('idle');
    if (options.recordTransition) {
      options.recordTransition(prevPhase, 'idle', `finalize(${targetState})`);
    }
    assertMaskOff('idle');
    assertLayoutRoot();
  };

  const toggle = (next: boolean) => {
    // If an in-flight transition exists, instantly finalize current phase first
    if (options.previewPhaseRef.current !== 'idle') {
      finalize();
    }

    const isReduced =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (isReduced) {
      finalize(next);
      return;
    }

    options.targetPreviewOpenRef.current = next;

    // F2.3: layout-root count === 1 sampled every rAF during Tab toggles
    startLayoutRootSampling();

    // Invariant I5 & I7: 250ms watchdog (was 600ms in legacy) force-finalizes if ack is lost.
    const WATCHDOG_MS = 250;
    if (watchdogId) window.clearTimeout(watchdogId);
    watchdogId = window.setTimeout(() => {
      reportViolation('I7', 'Preview transition watchdog triggered (>250ms, ack lost?)');
      traceChoreo('[WATCHDOG_FINALIZE] watchdog triggered >250ms, executing flash-safe recovery');
      finalize(next);
    }, WATCHDOG_MS);

    // This snap's generation: only its own present-ack may unveil it.
    const snapId = ++snapGen;

    // F2 Protocol: content-out (60ms, opacity 0) -> SYNCHRONOUS setSize in
    // same task -> native present-ack -> content-in (100ms, translateX
    // settle). The veil NEVER lifts on a fixed frame count; it lifts only
    // when Rust confirms the resized raster actually presented.
    const prev = options.previewPhaseRef.current;
    options.previewPhaseRef.current = 'out';
    options.setPreviewPhase('out');
    options.previewPaneRef.current?.classList.add('preview-out');
    applyMask(options.previewPaneRef.current, 'preview-out', 'out');
    if (options.recordTransition) {
      options.recordTransition(prev, 'out', next ? 'expand-out' : 'collapse-out');
    }

    // Step 1: Wait 60ms content-out so content layer reaches opacity 0
    timerId = window.setTimeout(() => {
      // Step 2: Content layer opacity is 0. Commit the React layout first so
      // Chromium lays out the target geometry, THEN resize natively on the
      // next frame while still veiled (I2: resize still happens only while
      // the veil holds).
      options.previewPaneRef.current?.classList.add('snap-veil');
      applyMask(options.previewPaneRef.current, 'snap-veil', 'snap');
      options.previewOpenRef.current = next;
      options.setPreviewOpen(next);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const sent = setWindowPreviewSize(next, snapId);

      options.previewPhaseRef.current = 'snap';
      options.setPreviewPhase('snap');
      if (options.recordTransition) {
        options.recordTransition('out', 'snap', next ? 'expand-snap' : 'collapse-snap');
      }

      // Step 3: reveal on the native present-ack (notifySnapPresented). No
      // fixed rAF wait: resizes repaint asynchronously, and 2 rAFs routinely
      // beat the new raster (the black Tab flash). If the resize was deduped
      // (pixels unchanged), reveal immediately — no ack will come.
      if (!sent) {
        beginContentIn(next, snapId);
      }
      });
    }, 60);
  };

  // Step 4: Content-in (100ms, translateX settle). Idempotent: only the
  // current snap, while still awaiting its present, may begin it.
  const beginContentIn = (next: boolean, snapId: number) => {
    if (options.previewPhaseRef.current !== 'snap') return;
    if (snapId !== snapGen) return;
    const html = document.documentElement;

    // Invariant I5: Cold gate applies ONLY to first-ever expand
    const isColdExpand = next && html.getAttribute('data-painted-expanded') !== '1';
    if (isColdExpand) {
      html.setAttribute('data-painted-expanded', '1');
    }

    // Lift veil and preview-out — onto presented pixels (ack) or unchanged
    // pixels (deduped resize), never onto an unpainted surface.
    options.previewPaneRef.current?.classList.remove('snap-veil', 'preview-out');
    removeMask(options.previewPaneRef.current, 'snap-veil', 'in');
    removeMask(options.previewPaneRef.current, 'preview-out', 'in');
    const contentEl = document.getElementById('content');
    contentEl?.classList.add('kids-veil');
    applyMask(contentEl, 'kids-veil', 'in');
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    rafId = requestAnimationFrame(() => {
      rafId = null;
      contentEl?.classList.remove('kids-veil');
      removeMask(document.getElementById('content'), 'kids-veil', 'in-commit');
    });

    options.previewPhaseRef.current = 'in';
    options.setPreviewPhase('in');
    if (options.recordTransition) {
      options.recordTransition('snap', 'in', next ? 'expand-in' : 'collapse-in');
    }

    timerId = window.setTimeout(() => {
      removeMask(document.getElementById('content'), 'kids-veil', 'idle');
      options.previewPhaseRef.current = 'idle';
      options.setPreviewPhase('idle');
      if (watchdogId) {
        window.clearTimeout(watchdogId);
        watchdogId = null;
      }
      timerId = null;
      assertMaskOff('idle');
      assertLayoutRoot();
    }, 100);
  };

  // Called by the preview-toggled ack listener when Rust confirms the resized
  // raster presented. Stale acks (superseded snaps) are ignored.
  const notifySnapPresented = (gen: number) => {
    if (options.previewPhaseRef.current !== 'snap') return;
    if (gen !== snapGen) return;
    if (timerId) {
      window.clearTimeout(timerId);
      timerId = null;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    beginContentIn(options.targetPreviewOpenRef.current, gen);
  };

  return { toggle, finalize, notifySnapPresented };
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
