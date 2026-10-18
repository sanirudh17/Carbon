import { invoke } from '@tauri-apps/api/core';
import type { ClipItem } from '../types';

/**
 * ADDENDUM v35 W1.2 — single source of truth for entry edits.
 * One edit-buffer + commit path shared by overlay and main windows.
 * Blur (or click-outside) commit writes to store + DB and the Rust side
 * broadcasts `entry-updated` to ALL windows; every preview and list row
 * updates from that event.
 */

export const ENTRY_UPDATED_EVENT = 'entry-updated';

export type EntrySourceWindow = 'overlay' | 'main';

// Blur starts saving before the subsequent click/Enter handler runs. Keep
// that write reachable even after the component has cleared its dirty buffer.
const pendingWrites = new Map<string, Promise<void>>();

export async function waitForEntryText(id: string): Promise<void> {
  await pendingWrites.get(id);
}

export function entryTitleFor(text: string, fallback = ''): string {
  const first = text.split('\n')[0]?.trim() ?? '';
  return first || fallback;
}

/** Shared commit path: invoke + diagnostic log (W1.1; v36 A3 adds ms). */
export async function commitEntryText(
  id: string,
  text: string,
  source: EntrySourceWindow
): Promise<void> {
  const bytes = new Blob([text]).size;
  const t0 = performance.now();
  try {
    const previous = pendingWrites.get(id);
    const write = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
      await invoke('update_clip_text', { id, text });
    });
    pendingWrites.set(id, write);
    await write;
    if (pendingWrites.get(id) === write) pendingWrites.delete(id);
    const ms = (performance.now() - t0).toFixed(1);
    invoke('log_client_event', {
      event: `[EDIT] source=${source} committed id=${id} chars=${text.length} bytes=${bytes} ms=${ms}`,
    }).catch(() => {});
  } catch (err) {
    const ms = (performance.now() - t0).toFixed(1);
    invoke('log_client_event', {
      event: `[EDIT] source=${source} commit FAILED id=${id} ms=${ms} err=${err}`,
    }).catch(() => {});
    throw err;
  }
}

/**
 * Apply an `entry-updated` payload to a cached list: replace text/title/
 * timestamps for the matching row so list meta (length/bytes) re-renders.
 * Unknown ids are left untouched (fresh rows arrive via clipboard-updated).
 */
export function applyEntryUpdatedToList(prev: ClipItem[], updated: Partial<ClipItem> & { id: string }): ClipItem[] {
  let touched = false;
  const next = prev.map((i) => {
    if (i.id !== updated.id) return i;
    touched = true;
    return {
      ...i,
      ...updated,
    };
  });
  return touched ? next : prev;
}
