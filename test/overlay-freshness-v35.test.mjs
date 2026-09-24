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

test('SYNC - overlay prewarm cache stays fresh on every capture (no stale open)', () => {
  const hotkey = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'), 'utf8');
  assert.ok(
    hotkey.includes('pub(crate) fn note_overlay_clip'),
    'note_overlay_clip must upsert into OVERLAY_PREWARM_CACHE'
  );
  assert.ok(
    hotkey.includes('cache.retain(|c| c.id != item.id);'),
    'note_overlay_clip must dedup by id before insert-at-top'
  );
  const watcher = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'clipboard_watcher.rs'), 'utf8');
  const noteCalls = (watcher.match(/crate::hotkey::note_overlay_clip\(/g) || []).length;
  assert.ok(
    noteCalls >= 3,
    `all three capture emits (merge/bump/insert) must refresh the prewarm cache (found ${noteCalls})`
  );
});

test('SYNC - main prewarm cache stays fresh on every capture (no stale open)', () => {
  const hotkey = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'), 'utf8');
  assert.ok(
    hotkey.includes('pub(crate) fn note_main_clip'),
    'note_main_clip must upsert into MAIN_PREWARM_CACHE'
  );
  assert.ok(
    hotkey.includes('pub(crate) fn commit_main_refresh'),
    'main cache writes must be gen-guarded against clobbering a capture'
  );
  const watcher = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'clipboard_watcher.rs'), 'utf8');
  const noteCalls = (watcher.match(/crate::hotkey::note_main_clip\(/g) || []).length;
  assert.ok(
    noteCalls >= 3,
    `all three capture emits (merge/bump/insert) must refresh the main prewarm cache (found ${noteCalls})`
  );
  const lib = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.ok(
    lib.includes('crate::hotkey::commit_main_refresh'),
    'get_all_clips background/miss-path commits must be gen-guarded'
  );
  assert.doesNotMatch(
    lib,
    /\*crate::hotkey::MAIN_PREWARM_CACHE\.lock\(\)\.unwrap\(\) = Some\(/,
    'unconditional MAIN_PREWARM_CACHE overwrite is banned'
  );
});

test('v37 main push, not poll: clipboard-updated upserts (capture already on open)', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'),
    'utf8'
  );
  const handlerIdx = src.indexOf("listen<ClipItem | null>('clipboard-updated'");
  assert.ok(handlerIdx !== -1, 'main must listen clipboard-updated with a payload');
  // Slice to the next sibling listener — indexOf('});') would stop at the
  // first nested setItems(...) close, before the fetchRef fallback.
  const nextListener = src.indexOf('const unlistenQueue', handlerIdx);
  const handler = src.slice(handlerIdx, nextListener === -1 ? handlerIdx + 2500 : nextListener);
  assert.ok(
    handler.includes('return [{ ...exists, ...item }, ...prev.filter((i) => i.id !== item.id)];'),
    'main must upsert captures to the top (bumps/merges never ignored)'
  );
  assert.ok(
    handler.includes('selectedFilterRef.current'),
    'upsert must gate on the live filter refs (stale closures banned)'
  );
  assert.ok(
    handler.includes('fetchRef.current()'),
    'filtered/search views still fall back to a real refetch'
  );
  // The old path always did a full fetchRef on every capture — that hit the
  // (then-stale) MAIN_PREWARM_CACHE and made the row "pop in" after open.
  assert.doesNotMatch(
    handler,
    /listen<ClipItem \| null>\('clipboard-updated', \(\) => \{\r?\n\s*fetchRef\.current\(\);/,
    'blind full-fetch on capture is banned'
  );
});

test('SYNC - overlay-data never clobbers fresher live-pushed clips', () => {
  const src = readOverlay();
  const handler = src.slice(src.indexOf("safeListen<ClipItem[]>('overlay-data'"));
  assert.ok(handler.includes('snapshotFresher'), 'overlay-data must gate on snapshot freshness');
  assert.ok(
    handler.includes('localHead'),
    'stale open must keep local head when snapshot misses it'
  );
  assert.ok(
    handler.includes('snapHeadNotOlder'),
    'a longer stale snapshot must not swallow a newer live-pushed head'
  );
  assert.ok(
    !/overlay-data[\s\S]{0,400}setItems\(e\.payload\);[\s\S]{0,80}setSelectedIndex\(0\);\s*bumpCacheVersion\(\);/.test(
      handler.replace(/[\s\S]*snapshotFresher[\s\S]*if \(snapshotFresher\)/, '')
    ),
    'unconditional setItems on overlay-data is banned'
  );
});

test('v38 main open push, not poll: enlarged-data snapshot lands before the reveal', () => {
  // The main window used to paint whatever stale state the hidden window had
  // and pop the capture in after the focus fetch. Overlay parity: Rust pushes
  // the MAIN_PREWARM_CACHE snapshot on every open. v41: the push rides a
  // background thread (zero hotkey-thread serialization) AFTER the reveal
  // emit — the frontend paint gate holds uncloak until it commits.
  const hotkey = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'), 'utf8');
  assert.ok(
    hotkey.includes('pub(crate) fn push_main_snapshot'),
    'main open must push its prewarm snapshot (overlay-data parity)'
  );
  assert.ok(
    hotkey.includes('pub(crate) fn push_main_snapshot_async'),
    'serialization must leave the hotkey thread (background push)'
  );
  assert.ok(
    hotkey.includes("emit_to(\"main\", \"enlarged-data\""),
    'snapshot must ride a targeted enlarged-data event to the main window'
  );
  assert.doesNotMatch(
    hotkey,
    /fn push_main_snapshot[\s\S]{0,600}(get_all_entries|get_overlay_entries)/,
    'no SQLite on the hotkey thread (fast cache-clone path only)'
  );
  const asyncBody = hotkey.slice(
    hotkey.indexOf('fn push_main_snapshot_async'),
    hotkey.indexOf('fn push_main_snapshot_async') + 500
  );
  assert.ok(
    asyncBody.includes('thread::spawn'),
    'the async push must serialize off-thread'
  );
  const pushCalls = (hotkey.match(/push_main_snapshot_async\(app_handle\)/g) || []).length;
  assert.ok(
    pushCalls >= 2,
    `both enlarged show paths (swap + toggle) must push on open (found ${pushCalls})`
  );
  const lib = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.ok(
    lib.includes('hotkey::push_main_snapshot_async(app)'),
    'second-launch (single-instance) show must push too'
  );
  // Reveal-first ordering: the opened emit must precede the background push
  // so the frontend paint gate starts immediately (it holds for the commit).
  for (const src of [hotkey]) {
    let idx = 0;
    let pairs = 0;
    while ((idx = src.indexOf('push_main_snapshot_async(app_handle)', idx)) !== -1) {
      const window = src.slice(Math.max(0, idx - 600), idx);
      assert.ok(
        window.includes('emit("enlarged-opened"'),
        'the reveal emit must precede the background push at every show site'
      );
      pairs += 1;
      idx += 1;
    }
    assert.ok(pairs >= 2, `expected 2 reveal-then-push sites (found ${pairs})`);
  }

  // Frontend: the snapshot applies with the overlay's freshness guards, only
  // warms the 'all' cache in filtered views, and never yanks selection.
  const main = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'),
    'utf8'
  );
  const dataIdx = main.indexOf("listen<ClipItem[]>('enlarged-data'");
  assert.ok(dataIdx !== -1, 'main must listen enlarged-data');
  const dataEnd = main.indexOf('const unlistenCollections', dataIdx);
  const dataHandler = main.slice(dataIdx, dataEnd === -1 ? dataIdx + 2500 : dataEnd);
  assert.ok(
    dataHandler.includes('snapshotFresher'),
    'enlarged-data must gate on snapshot freshness (overlay parity)'
  );
  assert.ok(
    dataHandler.includes('snapHeadNotOlder'),
    'a longer stale snapshot must not swallow a newer live-pushed head'
  );
  assert.ok(
    /snapshotFresher\s*=[\s\S]{0,300}snapHeadNotOlder/.test(dataHandler),
    'containing the local head is not enough — the snapshot head must not be older'
  );
  assert.ok(
    dataHandler.includes('unfilteredView'),
    'filtered/search views must keep their query (only the all-cache warms)'
  );
  assert.ok(
    dataHandler.includes('selectedItemRef.current'),
    'the open must preserve the user’s row instead of yanking to the top'
  );
  assert.ok(
    dataHandler.includes('editDirtyRef.current'),
    'an uncommitted edit buffer must survive the open snapshot'
  );
});

test('v39 main open paints fresh: uncloak waits for the head-changing commit', () => {
  // The choreo gate uncloaks once dataset.painted==='1' (mount-stamped), but
  // a heavy main-list commit can land AFTER the instant 2-rAF gate — first
  // frame stale, capture pops in. The open snapshot / live capture must
  // reset the gate on head change and re-stamp only after the commit lands.
  const main = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'),
    'utf8'
  );
  assert.ok(
    main.includes('openPaintPendingRef'),
    'a pending-open-paint flag must couple data commits to the paint gate'
  );
  assert.ok(
    main.includes("document.documentElement.dataset.painted = '0'"),
    'a head-changing snapshot/capture must reset the paint gate'
  );
  const commitFxIdx = main.indexOf('Commit-accurate re-stamp');
  assert.ok(commitFxIdx !== -1, 'a commit-accurate re-stamp effect must exist');
  const commitFx = main.slice(commitFxIdx, commitFxIdx + 1200);
  assert.ok(
    commitFx.includes('[items]'),
    'the re-stamp must run post-commit (items effect, not a timer guess)'
  );
  assert.ok(
    commitFx.includes('requestAnimationFrame'),
    'the re-stamp must let Chromium submit the frame first'
  );
  assert.ok(
    commitFx.includes('setTimeout'),
    'an rAF stall while cloaked must still release the gate (bounded)'
  );
  // Both push paths arm the gate — the open snapshot and the live upsert —
  // and only on real head changes (no cost when already fresh).
  const clipIdx = main.indexOf("listen<ClipItem | null>('clipboard-updated'");
  const clipHandler = main.slice(clipIdx, main.indexOf('const unlistenQueue', clipIdx));
  assert.ok(
    clipHandler.includes('awaitOpenPaint()'),
    'live captures that move the head must arm the paint gate'
  );
  assert.ok(
    clipHandler.includes('prevHead'),
    'the live path must compare against the previous head (no-op when unchanged)'
  );
  const dataIdx = main.indexOf("listen<ClipItem[]>('enlarged-data'");
  const dataHandler = main.slice(dataIdx, main.indexOf('const unlistenCollections', dataIdx));
  assert.ok(
    dataHandler.includes('awaitOpenPaint()'),
    'the open snapshot must arm the paint gate on head change'
  );
});

test('v40 main open stays instant: identical snapshots never commit', () => {
  // v39 fixed the pop-in by gating uncloak on the commit — but every open
  // then paid full-list commits (snapshot + refetch) even with zero changes.
  // Identical payloads must be render-free: same array back, same selection
  // objects, no gate.
  const main = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'),
    'utf8'
  );
  assert.ok(
    main.includes('function sameClipList('),
    'a cheap snapshot equality helper must exist'
  );
  const dataIdx = main.indexOf("listen<ClipItem[]>('enlarged-data'");
  const dataHandler = main.slice(dataIdx, main.indexOf('const unlistenCollections', dataIdx));
  assert.ok(
    dataHandler.includes('sameClipList(snap, local)'),
    'the open snapshot must bail out when already displayed'
  );
  const fetchIdx = main.indexOf('const fetchItems = async');
  const fetchBody = main.slice(fetchIdx, main.indexOf('const fetchRef = useRef', fetchIdx));
  assert.ok(
    fetchBody.includes('sameClipList(prev, list) ? prev : list'),
    'identical refetches must keep the previous array (memo rows bail out)'
  );
  assert.ok(
    fetchBody.includes('setSelectedItem((cur)'),
    'identical refetches must preserve the selection object (preview bails out)'
  );
  const clipIdx = main.indexOf("listen<ClipItem | null>('clipboard-updated'");
  const clipHandler = main.slice(clipIdx, main.indexOf('const unlistenQueue', clipIdx));
  assert.ok(
    clipHandler.includes('return prev;'),
    'echo pushes of the unchanged head must skip the commit'
  );
});

test('v41 main opens overlay-fast: no blocking work on the show path', () => {
  // The overlay opens in ~35ms; the main window stacked a 32-120ms rewarm
  // present cycle + full-history serialization on the hotkey thread, so
  // rapid toggles queued and presses felt swallowed. Both must leave the
  // show path: background push (v38) + recency-skipped rewarm.
  const hotkey = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'), 'utf8');
  assert.ok(
    hotkey.includes('LAST_MAIN_REVEAL_MS'),
    'successful uncloaks must stamp a reveal clock'
  );
  assert.ok(
    hotkey.includes('note_main_revealed()'),
    'the uncloak path must record fresh pixels'
  );
  assert.ok(
    hotkey.includes('fn main_reveal_age_ms'),
    'the show path must be able to ask how stale the surface is'
  );
  const vib = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'vibrancy.rs'), 'utf8');
  const rewarmIdx = vib.indexOf('pub fn rewarm_main_surface');
  assert.ok(rewarmIdx !== -1, 'rewarm helper found');
  const rewarmBody = vib.slice(rewarmIdx, rewarmIdx + 1500);
  assert.ok(
    rewarmBody.includes('main_surface_warm()'),
    'rewarm must consult the shared warm predicate (reveal + warmth clocks)'
  );
  assert.ok(
    rewarmBody.includes('main_surface_warm()'),
    'a live surface must skip the present cycle (rapid toggles stay fast)'
  );
  // Frontend: with the push behind the reveal, the open itself arms the
  // paint gate when stale (bounded) — otherwise a slow snapshot could lose
  // the race and paint stale. v42 narrows this to version-gated arming.
  const main = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'),
    'utf8'
  );
  const gateIdx = main.indexOf('Open-gate arm');
  assert.ok(gateIdx !== -1, 'open-gate arm found');
  const gateBody = main.slice(gateIdx, gateIdx + 1600);
  assert.ok(
    gateBody.includes("'enlarged-opened'"),
    'enlarged-opened must arm the paint gate'
  );
  assert.ok(
    gateBody.includes("dataset.painted = '0'"),
    'the arm must hold uncloak until the snapshot commits'
  );
  assert.ok(
    gateBody.includes('setTimeout'),
    'the arm must be bounded (cold opens with no snapshot still reveal)'
  );
});

test('v42 main opens overlay-fast: version-gated arming, masked reveal', () => {
  // v41 armed the gate on EVERY open and waited for the background snapshot
  // even when already fresh. Overlay-A2 parity: the reveal carries the store
  // version and the gate holds only when the store moved past the applied
  // cache — fresh opens never wait. The reveal keeps the 100ms cold-frame
  // mask (a 30ms trial reflashed on skipped-rewarm opens); it is threaded,
  // so it never costs open latency.
  const hotkey = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'), 'utf8');
  assert.ok(
    hotkey.includes('pub store_version: u64,'),
    'the enlarged-opened payload must carry the store version'
  );
  const payloadUses = (hotkey.match(/store_version: crate::db::store_version\(\)/g) || []).length;
  const lib = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const libUses = (lib.match(/store_version: crate::db::store_version\(\)/g) || []).length;
  assert.ok(
    payloadUses + libUses >= 3,
    `all three enlarged show sites must send the version (found ${payloadUses + libUses})`
  );
  assert.ok(
    hotkey.includes('ramp_window_alpha(win.clone(), 0, 255, ramp_ms, expected_token, false)'),
    'the main reveal must use the adaptive ramp (warm pop, cold mask)'
  );
  // v43 pins the settle-then-ramp order in the uncloak path (own test below);
  // the ordering assertion lives there, not here.
  const main = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'),
    'utf8'
  );
  assert.ok(
    main.includes('mainCacheVersionRef'),
    'main must track its applied-cache version (overlay cacheVersionRef parity)'
  );
  assert.ok(
    main.includes('lastMainStoreVersionRef'),
    'main must track the last observed store version'
  );
  const gateIdx = main.indexOf('Open-gate arm');
  const gateBody = main.slice(gateIdx, gateIdx + 1600);
  assert.ok(
    gateBody.includes('store_version'),
    'the arm must read the version off the reveal payload'
  );
  assert.ok(
    /raw > mainCacheVersionRef\.current/.test(gateBody),
    'the gate must hold only when the store moved past the applied cache'
  );
  // Bumps (+1 per observed mutation) and syncs (full re-reads) — the false-
  // fresh lead the overlay comments warn about must not exist here either.
  assert.ok(
    main.includes('mainCacheVersionRef.current += 1'),
    'applied pushes/edits must bump the cache version'
  );
  assert.ok(
    main.includes('syncMainCacheVersion'),
    'full re-reads must sync (not blind-increment) the cache version'
  );
});

test('v43 main uncloak settles one frame before ramping (no residual flash)', () => {
  // The rare leftover white open-flash: WebView2 presents on its own cadence,
  // so the pre-uncloak present can leave DWM one frame behind on
  // skipped-rewarm opens. The uncloak must flush, hold alpha 0 for ~one
  // frame, and flush again BEFORE the ramp starts — invisible (alpha is 0),
  // ~20ms, and the ramp's token guard still cancels mid-settle hides.
  const hotkey = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'), 'utf8');
  const uncloakIdx = hotkey.indexOf('fn uncloak_enlarged_if_current');
  assert.ok(uncloakIdx !== -1, 'main uncloak path found');
  const body = hotkey.slice(uncloakIdx, uncloakIdx + 12000);
  const uncloakedAt = body.indexOf('set_window_cloaked(&win, false)');
  const settledAt = body.indexOf('from_millis(20)');
  const rampAt = body.indexOf('ramp_window_alpha(win.clone(), 0, 255, ramp_ms');
  assert.ok(uncloakedAt !== -1 && settledAt !== -1 && rampAt !== -1, 'settle step must exist');
  assert.ok(
    uncloakedAt < settledAt && settledAt < rampAt,
    'order must be uncloak -> 20ms settle -> ramp (never ramp on an unflushed frame)'
  );
});

test('v44 long-idle opens stay warm: background warmth loop, race-proof', () => {
  // After minutes idle the surface decayed cold: rare white flash + surprise
  // fade. A background loop re-presents the hidden surface every 45s so
  // opens stay on the warm path — and it can never disturb a live show.
  const vib = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'vibrancy.rs'), 'utf8');
  assert.ok(vib.includes('pub fn spawn_main_warmth_loop'), 'warmth loop spawner must exist');
  const loopIdx = vib.indexOf('pub fn spawn_main_warmth_loop');
  const loopBody = vib.slice(loopIdx, loopIdx + 2500);
  assert.ok(loopBody.includes('MAIN_WARM_LOOP_MS'), 'the loop must tick on the warm period');
  assert.ok(loopBody.includes('try_lock'), 'the loop must skip ticks while a show holds the cycle');
  assert.ok(loopBody.includes('MAIN_CLOAKED'), 'the loop must leave revealed windows alone');
  assert.ok(loopBody.includes('note_main_warm'), 'successful refreshes must stamp the warmth clock');
  // The cycle itself: generation-guarded, bool result, raced windows are
  // restored but never hidden or re-cloaked (no swallowed opens, no lies).
  assert.ok(
    vib.includes('gen_guard: Option<u64>'),
    'the present cycle must take a show-generation guard'
  );
  const cycIdx = vib.indexOf('fn offscreen_present_cycle');
  const cycBody = vib.slice(cycIdx, cycIdx + 8000);
  assert.ok(cycBody.includes('-> bool'), 'the cycle must report whether it genuinely presented');
  assert.ok(cycBody.includes('!crate::hotkey::MAIN_CLOAKED'), 'a mid-cycle reveal must abort the tail');
  // Show sites hold the cycle across the native ops; warmth + reveal clocks
  // feed one shared predicate.
  const hotkey = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'), 'utf8');
  const holds = (hotkey.match(/hold_present_cycle\(\)/g) || []).length;
  assert.ok(holds >= 2, `both hotkey show paths must hold the cycle (found ${holds})`);
  const lib = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.ok(lib.includes('hold_present_cycle()'), 'second-launch show must hold the cycle too');
  assert.ok(lib.includes('spawn_main_warmth_loop'), 'setup must start the warmth loop');
  assert.ok(hotkey.includes('fn main_surface_warm'), 'one shared warm predicate must exist');
});
