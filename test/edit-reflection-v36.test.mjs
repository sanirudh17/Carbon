import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ADDENDUM v36 A — edit reflection + versioned freshness.
// A1: blur AND save-key commit in both windows; entry-updated reflects
//     overlay->overlay, overlay->main, main->overlay in place.
// A2: store version > cache version → refresh before uncloak (<=50ms),
//     else single post-show settle. No stale rows, no double insert.
// A3: commit log carries (source, ms); show logs cache/store versions.

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function readOverlay() {
  return fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'QuickOverlay.tsx'),
    'utf8'
  );
}

function readMain() {
  return fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'EnlargedWindow.tsx'),
    'utf8'
  );
}

test('A1 overlay commits on blur AND save-key via the shared path', () => {
  const src = readOverlay();
  assert.ok(src.includes('onBlur={handleContentBlurCommit}'), 'overlay textarea commits on blur');
  assert.ok(src.includes("commitPendingEdit('save-key')"), 'overlay textarea commits on save-key');
  assert.ok(src.includes('commitEntryText('), 'overlay uses the shared commit path');
});

test('A1 main commits on blur AND save-key via the shared path', () => {
  const src = readMain();
  assert.ok(src.includes('onBlur={handleContentBlurCommit}'), 'main textarea commits on blur');
  assert.ok(src.includes("commitPendingEdit('save-key')"), 'main textarea commits on save-key');
  assert.ok(src.includes('commitEntryText('), 'main uses the shared commit path');
});

test('A1 edit matrix: both windows apply entry-updated in place', () => {
  const overlay = readOverlay();
  const main = readMain();
  for (const [name, src] of [['overlay', overlay], ['main', main]]) {
    assert.ok(
      src.includes('ENTRY_UPDATED_EVENT'),
      `${name} must listen the shared entry-updated broadcast`
    );
    assert.ok(
      src.includes('applyEntryUpdatedToList'),
      `${name} must update row+preview in place from the broadcast`
    );
  }
  const entryEdit = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'lib', 'entryEdit.ts'),
    'utf8'
  );
  assert.ok(entryEdit.includes('update_clip_text'), 'shared path writes store+DB');
});

test('A2 store version rides the open payload (Rust)', () => {
  const hotkey = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'),
    'utf8'
  );
  assert.ok(hotkey.includes('store_version'), 'overlay-opened payload must carry store_version');
  assert.ok(
    hotkey.includes('crate::db::store_version()'),
    'payload version must come from the monotonic store counter'
  );
  const db = fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'db.rs'),
    'utf8'
  );
  assert.ok(db.includes('static STORE_VERSION'), 'DB must own the monotonic store version');
  const bumps = (db.match(/bump_store_version\(\);/g) || []).length;
  assert.ok(bumps >= 6, `every list mutation must bump (found ${bumps})`);
});

test('A2 overlay compares versions and refreshes bounded-50ms before uncloak', () => {
  const src = readOverlay();
  assert.ok(src.includes('SHOW_REFRESH_MS = 50'), 'pre-uncloak refresh bounded at 50ms');
  assert.ok(
    src.includes('storeVersion > cacheVersion'),
    'staleness must be store version > cache version'
  );
  assert.ok(
    src.includes('refreshStaleBeforeShow(storeVersion, token)'),
    'stale cache must refresh before uncloak'
  );
  const defs = (src.match(/const beginOverlayShow = /g) || []).length;
  assert.equal(defs, 1, 'exactly one shared show runner (single settle, no double insert)');
  assert.ok(
    src.includes('if (!justRefreshedRef.current || itemsRef.current.length === 0)'),
    'post-show must not refetch after a fresh settle (single settle)'
  );
});

test('A3 commit log carries source+ms; show logs cache/store versions', () => {
  const entryEdit = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'lib', 'entryEdit.ts'),
    'utf8'
  );
  assert.ok(entryEdit.includes('source=${source}'), 'commit log must carry source window');
  assert.ok(entryEdit.includes('ms=${ms}'), 'commit log must carry milliseconds');
  const src = readOverlay();
  assert.ok(
    src.includes('cache_version=${cacheVersion} store_version=${storeVersion}'),
    'every show must log cache version and store version'
  );
});
