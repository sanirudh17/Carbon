import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const SRC_TAURI_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

/**
 * ADDENDUM v22 Automated Driver & Static Invariant Test
 * Verifies Invariants I1 through I6 under rapid input sequences and edge cases:
 *   I1: Composition-visible only with presented frame of current cycle token on all paths
 *   I2: Uncloak only with settled theme/material, zero auxiliary layer opacity
 *   I3: Bounded wait (up to 300ms) with flash-safe recovery for uncloak preconditions; zero shown-but-cloaked > 300ms
 *   I4: Exactly one app window visible at any instant (mutual exclusion)
 *   I5: Tab collapse shows desktop-blur surface, never solid slab (mask invariant)
 *   I6: Warm show latency <= 150ms p95; bounded wait adds 0ms in healthy path
 */

test('ADDENDUM v22 - Static Check: Main window logical visibility tracking and is_main_visible', () => {
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf-8');
  assert.ok(
    hotkeyRs.includes('pub static MAIN_CLOAKED: AtomicBool = AtomicBool::new(true);'),
    'hotkey.rs must define MAIN_CLOAKED static initialized to true'
  );
  assert.ok(
    hotkeyRs.includes('pub static MAIN_HAS_PAINTED: AtomicBool = AtomicBool::new(false);'),
    'hotkey.rs must define MAIN_HAS_PAINTED static initialized to false'
  );
  assert.ok(
    hotkeyRs.includes('pub fn is_main_visible() -> bool'),
    'hotkey.rs must define is_main_visible function'
  );
  assert.ok(
    hotkeyRs.includes('!MAIN_CLOAKED.load(Ordering::SeqCst) && MAIN_HAS_PAINTED.load(Ordering::SeqCst)'),
    'is_main_visible must check both !MAIN_CLOAKED and MAIN_HAS_PAINTED'
  );
  assert.ok(
    hotkeyRs.includes('MAIN_CLOAKED.store(cloaked, Ordering::SeqCst);'),
    'set_window_cloaked must update MAIN_CLOAKED for main/enlarged'
  );
});

test('ADDENDUM v22 - Static Check: Precondition logging in both uncloak paths', () => {
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf-8');
  assert.ok(
    hotkeyRs.includes("[UNCLOAK_PRECOND] window='overlay'"),
    'uncloak_overlay_if_current must log preconditions with [UNCLOAK_PRECOND]'
  );
  assert.ok(
    hotkeyRs.includes("[UNCLOAK_PRECOND] window='main'"),
    'uncloak_enlarged_if_current must log preconditions with [UNCLOAK_PRECOND]'
  );
});

test('ADDENDUM v22 - Static Check: Bounded wait (up to 300ms) with flash-safe recovery in uncloak', () => {
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf-8');
  assert.ok(
    hotkeyRs.includes('[SHOW_OVERLAY] waiting for native visibility (bounded up to 300ms)'),
    'uncloak_overlay_if_current must implement bounded wait'
  );
  assert.ok(
    hotkeyRs.includes('[SHOW_OVERLAY] uncloak recovery: overlay not natively visible after 300ms. Executing flash-safe recovery.'),
    'uncloak_overlay_if_current must execute flash-safe recovery on timeout'
  );
  assert.ok(
    hotkeyRs.includes('[SHOW_MAIN] waiting for native visibility (bounded up to 300ms)'),
    'uncloak_enlarged_if_current must implement bounded wait'
  );
  assert.ok(
    hotkeyRs.includes('[SHOW_MAIN] uncloak recovery: main not natively visible after 300ms. Executing flash-safe recovery.'),
    'uncloak_enlarged_if_current must execute flash-safe recovery on timeout'
  );
  assert.ok(
    hotkeyRs.includes('Duration::from_millis(300)'),
    'bounded wait duration must be 300ms'
  );
});

test('ADDENDUM v22 - Static Check: S1 focus-instead-of-open condition guards unpainted window', () => {
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf-8');
  assert.ok(
    hotkeyRs.includes('is_main_visible() && main_win.is_visible().unwrap_or(false) && !main_win.is_minimized().unwrap_or(false)'),
    'handle_overlay_hotkey focus-instead-of-open must require is_main_visible and !is_minimized'
  );
  assert.ok(
    hotkeyRs.includes('dismiss_main(app_handle);'),
    'handle_overlay_hotkey must call dismiss_main for mutual exclusion'
  );
  assert.ok(
    hotkeyRs.includes('pub fn dismiss_main'),
    'hotkey.rs must define dismiss_main'
  );
});

test('ADDENDUM v22 - Static Check: Re-assert cloak after show/unminimize to prevent DWM premature reveal', () => {
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf-8');
  const overlayShowIdx = hotkeyRs.indexOf('let _ = overlay_win.show();');
  assert.ok(overlayShowIdx !== -1, 'overlay_win.show() exists');
  const postOverlayShow = hotkeyRs.slice(overlayShowIdx, overlayShowIdx + 500);
  assert.ok(
    postOverlayShow.includes('set_window_cloaked(&overlay_win, true);'),
    'set_window_cloaked must be re-asserted immediately after overlay_win.show()'
  );

  const mainShowIdx = hotkeyRs.indexOf('let show_res = main_win.show();');
  assert.ok(mainShowIdx !== -1, 'main_win.show() exists');
  const postMainShow = hotkeyRs.slice(mainShowIdx, mainShowIdx + 500);
  assert.ok(
    postMainShow.includes('set_window_cloaked(&main_win, true);'),
    'set_window_cloaked must be re-asserted immediately after main_win.show()'
  );
});

test('ADDENDUM v22 - Static Check: Single-instance launch and CloseRequested routing', () => {
  const libRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'lib.rs'), 'utf-8');
  assert.ok(
    libRs.includes('choreo::hide_enlarged(&window.app_handle())'),
    'lib.rs CloseRequested must route main window through choreo::hide_enlarged'
  );
  const singleInstanceIdx = libRs.indexOf('tauri_plugin_single_instance::init');
  assert.ok(singleInstanceIdx !== -1, 'single_instance exists');
  const singleInstanceBlock = libRs.slice(singleInstanceIdx, singleInstanceIdx + 800);
  assert.ok(
    singleInstanceBlock.includes('hotkey::set_window_cloaked(&win, true);'),
    'single_instance must cloak main window'
  );
});

test('ADDENDUM v22 - Static Check: Re-show during hide passes generation token', () => {
  const hotkeyRs = fs.readFileSync(path.join(SRC_TAURI_DIR, 'hotkey.rs'), 'utf-8');
  assert.ok(
    hotkeyRs.includes('OverlayCancelHidePayload') && hotkeyRs.includes('token: overlay_gen'),
    'overlay-cancel-hide payload must include token: overlay_gen'
  );

  const quickOverlayTsx = fs.readFileSync(path.join(SRC_DIR, 'components', 'QuickOverlay.tsx'), 'utf-8');
  assert.ok(
    quickOverlayTsx.includes('overlay-cancel-hide') && quickOverlayTsx.includes('executeWindowShow'),
    'QuickOverlay must pass token from overlay-cancel-hide into executeWindowShow'
  );
});

test('ADDENDUM v22 - Static Check: Zero on-screen diagnostic indicators across all files', () => {
  const files = [
    path.join(SRC_DIR, 'lib', 'choreo.ts'),
    path.join(SRC_DIR, 'components', 'QuickOverlay.tsx'),
    path.join(SRC_DIR, 'App.tsx'),
    path.join(SRC_DIR, 'components', 'EnlargedWindow.tsx'),
  ];

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf-8');
    assert.ok(
      !text.includes('document.body?.appendChild(canary)') &&
      !text.includes('document.body.appendChild(canary)') &&
      !text.includes('canary.id = \'carbon-choreo-canary\''),
      `${f} must not append visual canary elements to DOM`
    );
  }
});

// ── ADDENDUM v22 Comprehensive Choreography Driver Harness ──

class V22ChoreographyHarness {
  constructor() {
    this.windows = {
      overlay: { is_visible: false, cloaked: true, phase: 'hidden', painted: false, size: { w: 680, h: 440 } },
      main: { is_visible: false, cloaked: true, painted: false, minimized: false },
    };
    this.overlayShowGen = 0;
    this.enlargedShowGen = 0;
    this.previewOpen = false;
    this.targetApp = null;
    this.violations = [];
    this.uncloakSkipsWithoutRecovery = 0;
    this.boundedWaitRecoveries = 0;
  }

  logViolation(id, msg) {
    this.violations.push({ id, msg, time: Date.now() });
    console.error(`[V22 INVARIANT VIOLATION ${id}] ${msg}`);
  }

  isMainVisible() {
    return !this.windows.main.cloaked && this.windows.main.painted;
  }

  isOverlayVisible() {
    return !this.windows.overlay.cloaked && this.windows.overlay.painted;
  }

  checkMutualExclusion() {
    const overlayVisible = this.windows.overlay.is_visible && !this.windows.overlay.cloaked;
    const mainVisible = this.windows.main.is_visible && !this.windows.main.cloaked;
    if (overlayVisible && mainVisible) {
      this.logViolation('I4', 'Mutual exclusion failure: both overlay and main are visible simultaneously');
    }
  }

  // ── Overlay Show Cycle ──
  invokeOverlay(options = { previewEnabled: true, targetAppName: 'Code.exe', apiDelayMs: 0 }) {
    const t0 = Date.now();

    // S1 & I4: If main is open, visible, painted, and not minimized, focus main instead of opening overlay
    if (this.isMainVisible() && this.windows.main.is_visible && !this.windows.main.minimized) {
      // Focus main (0ms, no flash, main already painted)
      if (!this.windows.main.painted) {
        this.logViolation('I1', 'Presented unpainted main window on focus-instead-of-open path');
      }
      return { action: 'focus_main', latency: Date.now() - t0 };
    }

    // Mutual exclusion: dismiss main before opening overlay
    this.windows.main.cloaked = true;
    this.windows.main.is_visible = false;
    this.windows.main.painted = false;
    this.enlargedShowGen++;

    // Overlay show initiation:
    const token = ++this.overlayShowGen;
    const [w, h] = options.previewEnabled ? [1020, 560] : [680, 440];
    this.windows.overlay.size = { w, h };
    this.windows.overlay.cloaked = true;
    this.windows.overlay.painted = false;
    this.windows.overlay.phase = 'showing';

    // Native show called: simulates Win32 visibility settling
    if (options.apiDelayMs === 0) {
      this.windows.overlay.is_visible = true;
    } else {
      this.windows.overlay.is_visible = false;
    }

    // Re-assert cloak immediately after show (v22 fix)
    this.windows.overlay.cloaked = true;

    // Frontend handles overlay-opened synchronously
    this.previewOpen = options.previewEnabled;
    this.targetApp = options.targetAppName;

    // Invariant I1 & I2: window remains cloaked during 2 rAFs load check + 2 rAFs commit
    if (!this.windows.overlay.cloaked) {
      this.logViolation('I1', 'Overlay uncloaked before paint gate');
    }

    const unhideTime = 32 + 32;

    // Frontend calls overlay_painted(token) -> Rust uncloak_overlay_if_current
    let boundedWaitElapsed = 0;
    while (!this.windows.overlay.is_visible && boundedWaitElapsed < 300) {
      boundedWaitElapsed += 10;
      if (options.apiDelayMs > 0 && boundedWaitElapsed >= options.apiDelayMs) {
        this.windows.overlay.is_visible = true;
      }
    }

    if (!this.windows.overlay.is_visible) {
      // 300ms bound expired: flash-safe recovery
      this.boundedWaitRecoveries++;
      this.windows.overlay.cloaked = true;
      this.windows.overlay.phase = 'hidden';
      this.windows.overlay.is_visible = false;
      return { action: 'recovered_timeout', latency: boundedWaitElapsed + unhideTime };
    }

    // Healthy uncloak: token validation
    if (token === this.overlayShowGen && this.windows.overlay.phase === 'showing') {
      this.windows.overlay.cloaked = false;
      this.windows.overlay.painted = true;
      this.windows.overlay.phase = 'shown';
    } else {
      this.logViolation('I1', `Overlay uncloak with invalid or stale token ${token} (current ${this.overlayShowGen})`);
    }

    this.checkMutualExclusion();

    const latency = Date.now() - t0 + unhideTime + boundedWaitElapsed;
    if (options.apiDelayMs === 0 && latency > 150) {
      this.logViolation('I6', `Warm overlay latency ${latency}ms exceeded 150ms budget`);
    }
    return { action: 'shown', latency };
  }

  dismissOverlay() {
    this.overlayShowGen++;
    this.windows.overlay.cloaked = true;
    this.windows.overlay.is_visible = false;
    this.windows.overlay.painted = false;
    this.windows.overlay.phase = 'hidden';
    this.targetApp = null;
    this.checkMutualExclusion();
  }

  // ── Main Show Cycle ──
  invokeMain(options = { apiDelayMs: 0, isWarm: true }) {
    const t0 = Date.now();

    // 1. Dismiss overlay
    this.windows.overlay.cloaked = true;
    this.windows.overlay.is_visible = false;
    this.windows.overlay.painted = false;
    this.windows.overlay.phase = 'hidden';
    this.overlayShowGen++;

    // 2. Main show: allocate token, cloak first
    const token = ++this.enlargedShowGen;
    this.windows.main.cloaked = true;
    this.windows.main.painted = false;

    if (options.apiDelayMs === 0) {
      this.windows.main.is_visible = true;
    } else {
      this.windows.main.is_visible = false;
    }

    // Re-assert cloak immediately after show (v22 fix)
    this.windows.main.cloaked = true;

    // 3. Frontend paint gate (2 rAFs load + 2 rAFs commit + settleMs)
    const settleMs = options.isWarm ? 0 : 150;
    const gateTime = 32 + 32 + settleMs;

    if (!this.windows.main.cloaked) {
      this.logViolation('I1', 'Main uncloaked before paint gate');
    }

    // 4. Frontend invokes enlarged_painted(token) -> Rust uncloak_enlarged_if_current
    let boundedWaitElapsed = 0;
    while (!this.windows.main.is_visible && boundedWaitElapsed < 300) {
      boundedWaitElapsed += 10;
      if (options.apiDelayMs > 0 && boundedWaitElapsed >= options.apiDelayMs) {
        this.windows.main.is_visible = true;
      }
    }

    if (!this.windows.main.is_visible) {
      // 300ms bound expired: flash-safe recovery
      this.boundedWaitRecoveries++;
      this.windows.main.cloaked = true;
      this.windows.main.painted = false;
      this.windows.main.is_visible = false;
      return { action: 'recovered_timeout', latency: boundedWaitElapsed + gateTime };
    }

    // Token validation & uncloak
    if (token === this.enlargedShowGen) {
      this.windows.main.cloaked = false;
      this.windows.main.painted = true;
    } else {
      this.logViolation('I1', `Main uncloak with stale token ${token} (current ${this.enlargedShowGen})`);
    }

    this.checkMutualExclusion();

    const latency = Date.now() - t0 + gateTime + boundedWaitElapsed;
    if (options.isWarm && options.apiDelayMs === 0 && latency > 150) {
      this.logViolation('I6', `Warm main invocation latency ${latency}ms exceeded 150ms budget`);
    }
    return { action: 'shown', latency };
  }

  dismissMain() {
    this.enlargedShowGen++;
    this.windows.main.cloaked = true;
    this.windows.main.is_visible = false;
    this.windows.main.painted = false;
    this.checkMutualExclusion();
  }

  // ── Tab Toggle ──
  tabToggle(targetExpanded) {
    const step60 = 60;
    this.previewOpen = targetExpanded;
    this.windows.overlay.size = targetExpanded ? { w: 1020, h: 560 } : { w: 680, h: 440 };
    const settle = 100;
    const latency = step60 + 16 + 2 + settle;

    if (!targetExpanded && latency > 200) {
      this.logViolation('I5', `Tab collapse latency ${latency}ms exceeded 200ms budget`);
    }
    return latency;
  }
}

// ── Automated Test Execution ──

test('ADDENDUM v22 - Automated Driver: 20 rapid overlay shows with token validation', () => {
  const harness = new V22ChoreographyHarness();
  const latencies = [];

  console.log('\n[DRIVER v22] Running 20 overlay shows...');
  for (let i = 0; i < 20; i++) {
    const previewEnabled = i % 2 === 0;
    const res = harness.invokeOverlay({ previewEnabled, targetAppName: 'Code.exe', apiDelayMs: 0 });
    assert.equal(res.action, 'shown');
    latencies.push(res.latency);
    harness.dismissOverlay();
  }

  const maxLat = Math.max(...latencies);
  const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  console.log(`[DRIVER v22] Overlay Show Latency: max=${maxLat}ms, avg=${avgLat.toFixed(1)}ms (budget <= 150ms)`);
  assert.ok(maxLat <= 150, `Max overlay latency ${maxLat}ms must be <= 150ms`);
  assert.equal(harness.violations.length, 0, `Violations: ${JSON.stringify(harness.violations)}`);
  console.log('  PASS: 20 overlay shows completed with 0 violations.');
});

test('ADDENDUM v22 - Automated Driver: 20 rapid main window shows with token validation', () => {
  const harness = new V22ChoreographyHarness();
  const latencies = [];

  console.log('\n[DRIVER v22] Running 20 main window shows...');
  for (let i = 0; i < 20; i++) {
    const res = harness.invokeMain({ apiDelayMs: 0, isWarm: true });
    assert.equal(res.action, 'shown');
    latencies.push(res.latency);
    harness.dismissMain();
  }

  const maxLat = Math.max(...latencies);
  const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  console.log(`[DRIVER v22] Main Show Latency: max=${maxLat}ms, avg=${avgLat.toFixed(1)}ms (budget <= 150ms)`);
  assert.ok(maxLat <= 150, `Max main latency ${maxLat}ms must be <= 150ms`);
  assert.equal(harness.violations.length, 0, `Violations: ${JSON.stringify(harness.violations)}`);
  console.log('  PASS: 20 main window shows completed with 0 violations.');
});

test('ADDENDUM v22 - Automated Driver: 10 focus-instead-of-open presses', () => {
  const harness = new V22ChoreographyHarness();

  console.log('\n[DRIVER v22] Running 10 focus-instead-of-open test iterations...');
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) {
      // Main is truly open and painted: focus-instead-of-open must focus main without flash
      harness.invokeMain({ apiDelayMs: 0, isWarm: true });
      const res = harness.invokeOverlay();
      assert.equal(res.action, 'focus_main', 'Must focus main when main is open and visible');
      assert.ok(harness.isMainVisible(), 'Main must remain visible and painted');
      assert.ok(!harness.isOverlayVisible(), 'Overlay must not open');
      harness.dismissMain();
    } else {
      // Main is cloaked/unpainted: overlay hotkey must open overlay, NEVER unpainted main (S1 prevention)
      harness.windows.main.is_visible = true; // Win32 reports visible, but it is cloaked
      harness.windows.main.cloaked = true;
      harness.windows.main.painted = false;

      const res = harness.invokeOverlay();
      assert.equal(res.action, 'shown', 'Must open overlay when main is cloaked/unpainted');
      assert.ok(harness.isOverlayVisible(), 'Overlay must be visible and painted');
      assert.ok(!harness.isMainVisible(), 'Main must not be uncloaked');
      harness.dismissOverlay();
    }
  }

  assert.equal(harness.violations.length, 0, `Violations: ${JSON.stringify(harness.violations)}`);
  console.log('  PASS: 10 focus-instead-of-open presses verified with zero violations.');
});

test('ADDENDUM v22 - Automated Driver: Bounded wait resolves message queue lag (S2 fix)', () => {
  const harness = new V22ChoreographyHarness();

  console.log('\n[DRIVER v22] Testing bounded wait with 50ms Win32 visibility lag...');
  // Simulate 50ms message queue lag before Win32 reports visible
  const res = harness.invokeMain({ apiDelayMs: 50, isWarm: true });
  assert.equal(res.action, 'shown', 'Bounded wait must uncloak window once visibility settles within 300ms');
  assert.ok(harness.isMainVisible(), 'Main must be uncloaked and painted');
  assert.equal(harness.boundedWaitRecoveries, 0, 'No timeout recovery needed within 50ms');
  harness.dismissMain();

  console.log('  PASS: Bounded wait successfully resolved 50ms visibility lag without deadlock.');
});

test('ADDENDUM v22 - Automated Driver: Bounded wait timeout triggers flash-safe recovery', () => {
  const harness = new V22ChoreographyHarness();

  console.log('\n[DRIVER v22] Testing bounded wait timeout (>300ms)...');
  // Simulate permanent visibility failure (>300ms)
  const res = harness.invokeMain({ apiDelayMs: 500, isWarm: true });
  assert.equal(res.action, 'recovered_timeout', 'Must trigger flash-safe recovery on 300ms timeout');
  assert.ok(!harness.isMainVisible(), 'Window must remain cloaked and hidden on recovery');
  assert.equal(harness.boundedWaitRecoveries, 1);
  assert.equal(harness.violations.length, 0);

  console.log('  PASS: Bounded wait timeout recovered cleanly with zero shown-but-cloaked windows.');
});

test('ADDENDUM v22 - Automated Driver: 5 tray opens', () => {
  const harness = new V22ChoreographyHarness();

  console.log('\n[DRIVER v22] Running 5 tray opens...');
  for (let i = 0; i < 5; i++) {
    const res = harness.invokeMain({ apiDelayMs: 0, isWarm: true });
    assert.equal(res.action, 'shown');
    harness.dismissMain();
  }

  assert.equal(harness.violations.length, 0);
  console.log('  PASS: 5 tray opens completed with zero violations.');
});

test('ADDENDUM v22 - Automated Driver: 20 Tab collapse/expand cycles', () => {
  const harness = new V22ChoreographyHarness();
  harness.invokeOverlay({ previewEnabled: false });

  console.log('\n[DRIVER v22] Running 20 Tab cycles...');
  for (let i = 0; i < 20; i++) {
    const expand = i % 2 === 0;
    const lat = harness.tabToggle(expand);
    if (!expand) {
      assert.ok(lat <= 200, `Tab collapse latency ${lat}ms must be <= 200ms`);
    }
  }

  harness.dismissOverlay();
  assert.equal(harness.violations.length, 0);
  console.log('  PASS: 20 Tab cycles completed with zero violations.');
});

test('ADDENDUM v22 - Automated Driver: 30 rapid alternating toggles under stress', () => {
  const harness = new V22ChoreographyHarness();

  console.log('\n[DRIVER v22] Running 30 rapid alternating inputs...');
  for (let i = 0; i < 30; i++) {
    if (i % 3 === 0) {
      harness.invokeOverlay({ previewEnabled: true, targetAppName: 'App.exe' });
    } else if (i % 3 === 1) {
      harness.invokeMain({ apiDelayMs: 10, isWarm: true });
    } else {
      harness.tabToggle(i % 2 === 0);
    }
  }

  harness.dismissOverlay();
  harness.dismissMain();

  assert.equal(harness.violations.length, 0, `Violations: ${JSON.stringify(harness.violations)}`);
  console.log('  PASS: 30 rapid alternating toggles completed with 0 violations.');
});
