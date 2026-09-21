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

export function entryTitleFor(text: string, fallback = ''): string {
  const first = text.split('\n')[0]?.trim() ?? '';
  return first || fallback;
}

/** Shared commit path: invoke + diagnostic log (W1.1). */
export async function commitEntryText(
  id: string,
  text: string,
  source: EntrySourceWindow
): Promise<void> {
  const bytes = new Blob([text]).size;
  try {
    await invoke('update_clip_text', { id, text });
    invoke('log_client_event', {
      event: `[EDIT] window=${source} committed id=${id} chars=${text.length} bytes=${bytes}`,
    }).catch(() => {});
  } catch (err) {
    invoke('log_client_event', {
      event: `[EDIT] window=${source} commit FAILED id=${id} err=${err}`,
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
      text_content: updated.text_content !== undefined ? updated.text_content : i.text_content,
      title: updated.title !== undefined ? updated.title : i.title,
      updated_at: (updated as ClipItem).updated_at ?? i.updated_at,
    };
  });
  return touched ? next : prev;
}
