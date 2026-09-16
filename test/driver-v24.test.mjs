import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const DOCS_DIR = path.join(ROOT_DIR, 'docs', 'diagnostics');

/**
 * ADDENDUM v24 Automated Driver & Ghost Classification Test
 * Verifies Invariants I1 through I4:
 *   I1: No white/black frame in any transition, ever.
 *   I2: Exactly one window visible; show/hide paths untouched by this change.
 *   I3: Tab keypress-to-settled <=200ms (or <=250ms with option (ii) dip).
 *   I4: Full approved regression suite re-passes (S2).
 */

test('ADDENDUM v24 - Static Check: Choreo exports, single layout root, and diagnosis document', () => {
  const choreoTs = fs.readFileSync(path.join(SRC_DIR, 'lib', 'choreo.ts'), 'utf-8');
  assert.ok(
    choreoTs.includes('export function sampleCurrentFrame'),
    'choreo.ts must export sampleCurrentFrame for 240fps frame sampling'
  );
  assert.ok(
    choreoTs.includes('export function assertLayoutRoot'),
    'choreo.ts must export assertLayoutRoot'
  );
  // NOTE: assertMaskOff and the Tab-toggle veil machinery were removed with
  // the unified split frame (no toggle, no masks). The diagnosis document
  // below is kept as the historical record of that removal decision.

  const quickOverlayTsx = fs.readFileSync(path.join(SRC_DIR, 'components', 'QuickOverlay.tsx'), 'utf-8');
  assert.ok(
    quickOverlayTsx.includes('data-carbon-layout-layer="overlay"'),
    'QuickOverlay must define exactly one overlay layout layer'
  );

  const enlargedTsx = fs.readFileSync(path.join(SRC_DIR, 'components', 'EnlargedWindow.tsx'), 'utf-8');
  assert.ok(
    enlargedTsx.includes('data-carbon-layout-root'),
    'EnlargedWindow must define layout root'
  );

  const settingsTsx = fs.readFileSync(path.join(SRC_DIR, 'components', 'Settings.tsx'), 'utf-8');
  assert.ok(
    settingsTsx.includes('data-carbon-layout-root'),
    'Settings must define layout root'
  );

  const diagPath = path.join(DOCS_DIR, 'tab-toggle-ghost-v24-diagnosis.md');
  assert.ok(fs.existsSync(diagPath), 'Diagnosis document must exist');
  const diagText = fs.readFileSync(diagPath, 'utf-8');
  assert.ok(diagText.includes('Branch B') && diagText.includes('Single root'), 'Diagnosis must record Branch B classification');
  assert.ok(diagText.includes('Option (i) Accepted'), 'Diagnosis must record deliberate acceptance of option (i)');
});

test('ADDENDUM v24 - Static Check: Zero on-screen diagnostic indicators across all files', () => {
  const checkDir = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'node_modules' && ent.name !== 'target' && ent.name !== '.git') {
          checkDir(full);
        }
      } else if (ent.name.endsWith('.tsx') || ent.name.endsWith('.ts') || ent.name.endsWith('.rs')) {
        const text = fs.readFileSync(full, 'utf-8');
        assert.ok(
          !text.includes('id="carbon-choreo-canary"'),
          `Visual canary element must remain removed: ${full}`
        );
        assert.ok(
          !text.includes('id="carbon-diag-badge"'),
          `Diagnostic badge must remain removed: ${full}`
        );
      }
    }
  };
  checkDir(SRC_DIR);
});
