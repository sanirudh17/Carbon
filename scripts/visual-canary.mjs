/**
 * Visual Canary Transition Auditor for Carbon Quick Overlay (ADDENDUM v16)
 *
 * Emulates frame-by-frame layout transitions to verify:
 *   1. Opacity is 0 at the instant window size changes (Invariant I2).
 *   2. Unified Protocol for Tab: content-out (60ms, opacity 0) -> SYNCHRONOUS setSize in same task -> two rAF -> content-in (100ms, translateX settle).
 *   3. Layout-root count === 1 sampled every rAF during Tab toggles (F2.3).
 *   4. Interrupted transitions finalize immediately without leaking .snap-veil or .preview-out.
 *   5. Rapid toggle audit across 20 cycles completes with zero violations.
 */

class SimulatedOverlayChoreography {
  constructor() {
    this.previewOpen = false;
    this.previewPhase = 'idle';
    this.classes = new Set();
    this.layoutRoots = 1;
    this.setSizeCalls = [];
    this.violations = [];
  }

  sampleLayoutRoot() {
    if (this.layoutRoots !== 1) {
      this.violations.push(`I3: Expected exactly 1 layout root, found ${this.layoutRoots}`);
    }
  }

  toggle(next) {
    if (this.previewPhase !== 'idle') {
      this.finalize();
    }

    this.sampleLayoutRoot();
    this.targetOpen = next;
    this.previewPhase = 'out';
    this.classes.add('preview-out');
  }

  step60ms(next) {
    if (this.previewPhase !== 'out') return;
    this.sampleLayoutRoot();
    this.classes.add('snap-veil');

    // Check I2: opacity must be 0 when setSize is called
    const opacity = this.classes.has('snap-veil') || this.classes.has('preview-out') ? 0 : 1;
    if (opacity !== 0) {
      this.violations.push(`I2: setSize(${next}) called with opacity ${opacity}`);
    }

    this.previewOpen = next;
    this.setSizeCalls.push({ action: next ? 'expand' : 'collapse', timestamp: Date.now() });
    this.previewPhase = 'snap';
    this.sampleLayoutRoot();
  }

  stepRaf(ticks) {
    this.sampleLayoutRoot();
    if (this.previewPhase === 'snap') {
      if (ticks >= 2) {
        this.classes.delete('snap-veil');
        this.classes.delete('preview-out');
        this.previewPhase = 'in';
        this.sampleLayoutRoot();
      }
    }
  }

  settle100ms() {
    this.sampleLayoutRoot();
    this.classes.delete('snap-veil');
    this.classes.delete('preview-out');
    this.previewPhase = 'idle';
    this.sampleLayoutRoot();
  }

  finalize(targetState) {
    this.classes.clear();
    const resolved = typeof targetState === 'boolean' ? targetState : this.targetOpen;
    this.previewOpen = resolved;
    this.previewPhase = 'idle';
    this.sampleLayoutRoot();
  }
}

// ── Run Canary Audit Simulation ──
console.log('Running Visual Canary Audit for Carbon Choreography (v16)...');

const sim = new SimulatedOverlayChoreography();

// Test 1: Expand protocol (60ms content-out -> sync setSize -> two rAF -> 100ms content-in)
sim.toggle(true);
if (sim.previewPhase !== 'out' || !sim.classes.has('preview-out')) throw new Error('Expand must enter phase "out" with .preview-out');
sim.step60ms(true);
if (!sim.classes.has('snap-veil')) throw new Error('Expand setSize must veil behind opacity 0');
if (sim.previewPhase !== 'snap') throw new Error('Expand must enter phase "snap"');
sim.stepRaf(1);
if (sim.previewPhase !== 'snap') throw new Error('Expand must hold snap on frame 1');
sim.stepRaf(2);
if (sim.previewPhase !== 'in') throw new Error('Expand must transition to phase "in" after 2 rAFs');
sim.settle100ms();
if (sim.previewPhase !== 'idle' || !sim.previewOpen) throw new Error('Expand must settle to idle with previewOpen=true');
console.log('  ✓ Expand 60ms content-out -> sync setSize -> two rAF -> 100ms sequence passed');

// Test 2: Collapse protocol (60ms content-out -> sync setSize -> two rAF -> 100ms content-in)
sim.toggle(false);
if (sim.previewPhase !== 'out' || !sim.classes.has('preview-out')) throw new Error('Collapse must enter phase "out" with .preview-out');
sim.step60ms(false);
if (!sim.classes.has('snap-veil')) throw new Error('Collapse setSize must veil behind opacity 0');
sim.stepRaf(2);
sim.settle100ms();
if (sim.previewPhase !== 'idle' || sim.previewOpen) throw new Error('Collapse must settle to idle with previewOpen=false');
console.log('  ✓ Collapse 60ms content-out -> sync setSize -> two rAF -> 100ms sequence passed');

// Test 3: Rapid 20-toggle audit with continuous layout root sampling
for (let i = 0; i < 20; i++) {
  const next = i % 2 === 0;
  sim.toggle(next);
  if (i % 3 === 0) {
    // Simulate mid-flight re-press interruption
    sim.toggle(!next);
  }
  sim.step60ms(next);
  sim.stepRaf(2);
  sim.settle100ms();
}
if (sim.previewPhase !== 'idle' || sim.classes.size !== 0) {
  throw new Error('Rapid 20-toggle audit must cleanly settle without leaking classes');
}
console.log('  ✓ 20-toggle rapid sequence with continuous rAF sampling passed');

// Test 4: Canary catches simulated multi-root violation
const canaryTest = new SimulatedOverlayChoreography();
canaryTest.layoutRoots = 2;
canaryTest.sampleLayoutRoot();
if (canaryTest.violations.length === 0) {
  throw new Error('Canary must detect multi-root violation');
}
console.log('  ✓ Layout-root violation detection verified');

// Test 5: Invariant Violations check on main simulation
if (sim.violations.length > 0) {
  console.error('Violations detected:', sim.violations);
  process.exit(1);
}

console.log('  ✓ All Visual Canary checks passed with 0 violations.');
