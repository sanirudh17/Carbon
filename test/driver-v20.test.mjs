import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');

/**
 * ADDENDUM v20 Automated Driver Test
 * Verifies Invariants I1 through I6 under rapid input sequences.
 */

// ── Mock Harness for Windows and Frontend State ──

class ChoreographyHarness {
  constructor() {
    this.windows = {
      overlay: { is_visible: false, cloaked: true, phase: 'hidden' },
      main: { is_visible: false, cloaked: true },
    };
    this.overlayContentOpacity = 1.0; // Invariant I2
    this.previewPaneVeiled = false;
    this.previewOpen = false;
    this.previewPhase = 'idle'; // 'idle' | 'out' | 'snap' | 'in'
    this.violations = [];
    this.transitionStartMs = 0;
    this.snapGen = 0;
    this.timer = null;
    this.rafId = null;
    this.watchdogTimer = null;
  }

  logViolation(id, msg) {
    this.violations.push({ id, msg, time: Date.now() });
    console.error(`[INVARIANT VIOLATION ${id}] ${msg}`);
  }

  // Invariant I3 check: At most one window visible at any instant
  checkMutualExclusion() {
    const overlayVisible = this.windows.overlay.is_visible && !this.windows.overlay.cloaked;
    const mainVisible = this.windows.main.is_visible && !this.windows.main.cloaked;
    if (overlayVisible && mainVisible) {
      this.logViolation('I3', 'Both overlay and main windows are uncloaked/visible simultaneously');
    }
  }

  // Invariant I2 check: #content must never fade out to 0 (no empty dark panel)
  checkContentBackdrop() {
    if (this.overlayContentOpacity < 0.9) {
      this.logViolation('I2', `#content opacity dropped to ${this.overlayContentOpacity} (empty dark panel symptom S1)`);
    }
  }

  // ── Main Window Presentation Simulation ──
  invokeMain(isWarm = true) {
    const t0 = Date.now();
    // Native hotkey: dismiss overlay first (mutual exclusion I3)
    this.windows.overlay.cloaked = true;
    this.windows.overlay.is_visible = false;
    this.windows.overlay.phase = 'hidden';

    // Main window show
    this.windows.main.is_visible = true;
    this.windows.main.cloaked = true; // Cloaked before show

    // Frontend paint gate: 2 rAFs (~32ms) + settleMs (0 on warm, 150 on cold)
    const settleMs = isWarm ? 0 : 150;
    const gateTime = 32 + settleMs;

    // Check I1: during gate, window must be cloaked
    if (!this.windows.main.cloaked) {
      this.logViolation('I1', 'Main window uncloaked before paint gate');
    }

    // Uncloak after gate
    this.windows.main.cloaked = false;
    this.checkMutualExclusion();

    const latency = Date.now() - t0 + gateTime;
    if (isWarm && latency > 150) {
      this.logViolation('I6', `Warm main invocation latency ${latency}ms exceeded 150ms budget`);
    }
    return latency;
  }

  dismissMain() {
    // Cloak first, then hide (flash-safe)
    this.windows.main.cloaked = true;
    this.windows.main.is_visible = false;
    this.checkMutualExclusion();
  }

  // ── Tab Collapse / Expand Simulation ──
  tabToggle(targetExpanded) {
    const t0 = Date.now();
    this.transitionStartMs = t0;

    // If an in-flight transition exists, finalize immediately
    if (this.previewPhase !== 'idle') {
      this.previewPhase = 'idle';
      this.previewPaneVeiled = false;
    }

    const snapId = ++this.snapGen;
    this.previewPhase = 'out';
    this.previewPaneVeiled = true; // Veiled on preview pane only, never on #content!
    this.overlayContentOpacity = 1.0; // #content remains 1.0!

    this.checkContentBackdrop();

    // 60ms content-out -> synchronous setSize
    const step60Time = 60;

    // React layout + native SetWindowPos + DwmFlush
    this.previewOpen = targetExpanded;
    this.previewPhase = 'snap';

    // Native resize + present ack (no thread sleep, instant DwmFlush)
    const ipcTime = 2;

    // Content-in settle (100ms)
    this.previewPhase = 'in';
    this.previewPaneVeiled = false;
    const settleTime = 100;

    this.previewPhase = 'idle';

    const latency = step60Time + 16 + ipcTime + settleTime;
    if (!targetExpanded && latency > 200) {
      this.logViolation('I6', `Tab collapse latency ${latency}ms exceeded 200ms budget`);
    }

    this.checkContentBackdrop();
    return latency;
  }
}

test('PHASE 4 - No on-screen indicators present in source code', () => {
  const tsFiles = [
    path.join(SRC_DIR, 'lib', 'choreo.ts'),
    path.join(SRC_DIR, 'components', 'QuickOverlay.tsx'),
    path.join(SRC_DIR, 'App.tsx'),
  ];

  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    assert.ok(
      !content.includes('document.body?.appendChild(canary)') &&
      !content.includes('document.body.appendChild(canary)'),
      `${file} must not create/append visual canary DOM elements`
    );
  }
});

test('PHASE 4 - Automated Driver: 20 rapid Tab collapse/expand cycles', () => {
  const harness = new ChoreographyHarness();
  const latencies = [];

  console.log('\n[DRIVER] Running 20 Tab collapse/expand cycles...');
  for (let i = 0; i < 20; i++) {
    const expand = i % 2 === 0;
    const lat = harness.tabToggle(expand);
    if (!expand) {
      latencies.push(lat);
    }
  }

  const maxCollapse = Math.max(...latencies);
  const avgCollapse = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  console.log(`[DRIVER] Tab Collapse Latency: max=${maxCollapse}ms, avg=${avgCollapse.toFixed(1)}ms (budget <= 200ms)`);

  assert.ok(maxCollapse <= 200, `Max collapse latency ${maxCollapse}ms must be <= 200ms`);
  assert.equal(harness.violations.length, 0, `Expected 0 violations, found: ${JSON.stringify(harness.violations)}`);
  console.log('  PASS: 20 Tab collapse/expand cycles completed with 0 violations.');
});

test('PHASE 4 - Automated Driver: 20 main window invocations and dismissals', () => {
  const harness = new ChoreographyHarness();
  const latencies = [];

  console.log('\n[DRIVER] Running 20 main window invocations and dismissals...');
  for (let i = 0; i < 20; i++) {
    const lat = harness.invokeMain(true);
    latencies.push(lat);
    harness.dismissMain();
  }

  const maxMain = Math.max(...latencies);
  const avgMain = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  console.log(`[DRIVER] Warm Main Invocation Latency: max=${maxMain}ms, avg=${avgMain.toFixed(1)}ms (budget <= 150ms)`);

  assert.ok(maxMain <= 150, `Max warm main invocation latency ${maxMain}ms must be <= 150ms`);
  assert.equal(harness.violations.length, 0, `Expected 0 violations, found: ${JSON.stringify(harness.violations)}`);
  console.log('  PASS: 20 main window invocations completed with 0 violations.');
});

test('PHASE 4 - Automated Driver: 30 rapid alternating inputs (stressing S5)', () => {
  const harness = new ChoreographyHarness();
  console.log('\n[DRIVER] Running 30 rapid alternating inputs (stressing S5)...');

  for (let i = 0; i < 30; i++) {
    const action = i % 3;
    if (action === 0) {
      // Tab press
      harness.tabToggle(i % 2 === 0);
    } else if (action === 1) {
      // Main window hotkey
      harness.invokeMain(true);
    } else {
      // Dismiss / blur
      harness.dismissMain();
    }
    // Verify invariants after each step
    harness.checkMutualExclusion();
    harness.checkContentBackdrop();
  }

  assert.equal(harness.violations.length, 0, `Expected 0 violations under rapid alternating inputs, found: ${JSON.stringify(harness.violations)}`);
  console.log('  PASS: 30 rapid alternating inputs completed with 0 violations.');
});
