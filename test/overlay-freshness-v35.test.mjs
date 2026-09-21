import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// v37 — overlay reveal parity with main (snappy open).
// Push, don't poll: captures insert at top immediately even while hidden.
// The gate opens IMMEDIATELY on every open (no wait); the reveal carries
// zero invokes (focus + phase only); ONE guarded idle backstop covers
// cold start and mid-gate captures. No stale rows, no double insert.

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function readOverlay() {
  return fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'QuickOverlay.tsx'),
    'utf8'
  );
}

test('v37 push, not poll: clipboard-updated upserts (bumps move to top, never ignored)', () => {
  const src = readOverlay();
  // The old path returned the previous list untouched for known ids, so
  // dedup bumps / merges never surfaced until reopen.
  assert.doesNotMatch(
    src,
    /if \(prev\.some\(\(i\) => i\.id === item\.id\)\) return prev;/,
    'known-id captures must not be ignored'
  );
  assert.ok(
    src.includes('return [{ ...exists, ...item }, ...prev.filter((i) => i.id !== item.id)];'),
    'bumps/merges of existing ids must move the fresh copy to the top'
  );
});

test('v37 instant gate: no wait, no fetch on the open path', () => {
  const src = readOverlay();
  assert.doesNotMatch(src, /deferShowForFreshness/, 'no deferred show');
  assert.doesNotMatch(src, /settleFreshWait/, 'no push-wait resolver');
  assert.doesNotMatch(src, /FRESH_WAIT_MS/, 'no fresh-wait bound');
  assert.doesNotMatch(src, /justRefreshedRef/, 'no settle flag');
  const defs = (src.match(/const beginOverlayShow = /g) || []).length;
  assert.equal(defs, 1, 'exactly one shared show runner (single settle)');
});

test('v37 reveal carries zero invokes; one guarded idle backstop covers freshness', () => {
  const src = readOverlay();
  const revealIdx = src.indexOf('const afterRevealFresh = () => {');
  assert.ok(revealIdx !== -1, 'reveal callback found');
  const revealEnd = src.indexOf('\n  };', revealIdx);
  const reveal = src.slice(revealIdx, revealEnd);
  assert.ok(reveal.includes('focusSearchInput()'), 'reveal focuses for instant typing');
  assert.doesNotMatch(reveal, /invoke<AppSettings>\('get_settings'\)/, 'no settings round-trip at reveal');
  // Cold start fills immediately; warm opens defer to ONE idle backstop.
  assert.ok(reveal.includes('itemsRef.current.length === 0'), 'cold start still fills immediately');
  assert.ok(reveal.includes('backstopRef.current = window.setTimeout'), 'warm path uses one idle backstop');
  assert.ok(
    reveal.includes("overlayPhaseRef.current !== 'shown'"),
    'backstop must not fire over a closed window'
  );
  assert.ok(reveal.includes('showEpochRef.current'), 'backstop must be epoch-guarded (no stale fire)');
});

test('v37 backstop is cancelled on hide/unmount (never fires over closed UI)', () => {
  const src = readOverlay();
  const clears = (src.match(/if \(backstopRef\.current !== null\) \{\r?\n\s*window\.clearTimeout\(backstopRef\.current\);/g) || []).length;
  assert.ok(clears >= 2, `hide + unmount must disarm the backstop (found ${clears})`);
});
