import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ADDENDUM v35 W2 — overlay freshness (no stale cache on show).
// Push, don't poll: captures insert at top immediately even while hidden.
// Belt-and-braces: stale cache awaits the in-flight push (<=150ms) before
// uncloak; timeout uncloaks with cache (single settle, no double flash).

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function readOverlay() {
  return fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'QuickOverlay.tsx'),
    'utf8'
  );
}

test('W2.1 push, not poll: clipboard-updated upserts (bumps move to top, never ignored)', () => {
  const src = readOverlay();
  // The old path returned the previous list untouched for known ids, so
  // dedup bumps / merges never surfaced until reopen.
  assert.doesNotMatch(
    src,
    /if \(prev\.some\(\(i\) => i\.id === item\.id\)\) return prev;/,
    'known-id captures must not be ignored'
  );
  assert.ok(
    src.includes('lastCaptureRef.current = { id: item.id, at: Date.now() }'),
    'every capture must stamp the last-capture id+timestamp (push, even while hidden)'
  );
  assert.ok(
    src.includes('return [{ ...exists, ...item }, ...prev.filter((i) => i.id !== item.id)];'),
    'bumps/merges of existing ids must move the fresh copy to the top'
  );
});

test('W2.2 stale show-gate: bounded push-wait (<=150ms), single settle, cache fallback', () => {
  const src = readOverlay();
  assert.ok(src.includes('FRESH_WAIT_MS = 150'), 'wait must be bounded at <=150ms');
  // Staleness predicate: last capture id missing from the cached list.
  assert.ok(
    src.includes('!cached.some((i) => i.id === lastCap.id)'),
    'show must compare last capture against the cached newest entries'
  );
  // Single settle: exactly one shared show runner; the timer is cleared on
  // resolve so a late push can never re-show (no double flash).
  const defs = src.match(/const beginOverlayShow = /g) || [];
  assert.equal(defs.length, 1, 'exactly one shared show runner (single settle)');
  assert.ok(
    src.includes('window.clearTimeout(freshTimerRef.current)'),
    'resolving the wait must disarm the timeout'
  );
  assert.ok(
    src.includes('uncloaking with cache'),
    'timeout must uncloak with cache and insert on arrival'
  );
  // No fetch invoke may contend with the gate on either path.
  assert.ok(
    src.includes('await the in-flight push (<=150ms) before uncloaking') ||
      src.includes('awaiting push <='), 
    'stale path must await pushes, not fetch'
  );
});

test('W2 post-reveal: no redundant refetch after a fresh settle (no delayed pop-in)', () => {
  const src = readOverlay();
  assert.ok(
    src.includes('if (!justRefreshedRef.current || itemsRef.current.length === 0)'),
    'post-reveal must skip the list refetch when the wait just settled fresh data'
  );
});
