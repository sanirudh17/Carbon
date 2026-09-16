import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { ClipItem } from '../types';

// Exact same drag-out payload as the main window (EnlargedWindow): plain
// text everywhere, HTML for rich targets, and URI lists for links / images /
// files, plus the internal carbon/clip-ids flavor for Carbon-to-Carbon drops.
export const setClipDragData = (
  e: React.DragEvent | DragEvent,
  item: ClipItem,
  ids?: string[],
) => {
  const dt = e.dataTransfer;
  if (!dt) return;
  // Crash-safety without behavior change: a throwing DataTransfer
  // (rejected custom type, quota on huge HTML) must never abort the
  // gesture mid-payload — set every flavor independently so one bad
  // flavor can't starve the rest, and never let an exception escape
  // dragstart (that kills the whole drag: blocked circle everywhere).
  // Success-path payload is byte-identical to the proven main behavior.
  const safeSet = (k: string, v: string) => {
    try {
      dt.setData(k, v);
    } catch (err) {
      console.warn(`[drag] setData('${k}') failed, continuing with the rest:`, err);
    }
  };
  try {
    const list = ids && ids.length > 0 ? ids : [item.id];
    try {
      dt.effectAllowed = 'all';
    } catch {}

    const text = item.text_content || item.title || item.id || 'carbon-clip';
    safeSet('text/plain', text);
    safeSet('application/json', JSON.stringify({ ids: list, clipId: item.id }));
    safeSet('carbon/clip-ids', JSON.stringify(list));

    if (item.html_content) {
      safeSet('text/html', item.html_content);
    }

    if (item.content_type === 'link') {
      safeSet('text/uri-list', text);
    } else if (item.content_type === 'image' && item.image_path) {
      safeSet('text/uri-list', convertFileSrc(item.image_path));
    } else if (item.content_type === 'file' && item.file_paths) {
      try {
        const paths: string[] = JSON.parse(item.file_paths);
        safeSet('text/uri-list', paths.map((p) => 'file:///' + p.replace(/\\/g, '/')).join('\r\n'));
      } catch {
        safeSet('text/plain', item.file_paths);
      }
    }
  } catch (err) {
    console.warn('[drag] drag payload setup failed partway, keeping partial transfer:', err);
  }
};

/* ═════════════════════════════════════════════════════════════════════
 * Native OLE drag-out (v30 conformance contract).
 * Covered types (text/code/link/email/image/file, non-sensitive) leave
 * through the backend's contract-conformant DoDragDrop (real HDROP/HTML/
 * unicode mediums); everything else keeps the DOM path above. The browser
 * fires dragstart only after its own movement threshold; preventDefault
 * cancels the DOM drag (no dragend fires — callers clean up in `finally`).
 * Sensitive clips never leave natively (DOM decoy only).
 * ═════════════════════════════════════════════════════════════════════ */

const NATIVE_DRAG_TYPES = new Set(['text', 'code', 'link', 'email', 'image', 'file']);

export function shouldNativeDrag(item: ClipItem): boolean {
  return !item.is_sensitive && NATIVE_DRAG_TYPES.has(item.content_type);
}

export async function beginNativeDrag(
  e: React.DragEvent | DragEvent,
  item: ClipItem
): Promise<string> {
  e.preventDefault();
  e.stopPropagation();
  try {
    document.getSelection()?.removeAllRanges();
  } catch {}
  try {
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
  } catch {}
  console.debug(`[drag] native threshold crossed for '${item.id}' (${item.content_type})`);
  try {
    const effect = await invoke<string>('begin_native_drag', { id: item.id });
    if (effect !== 'copy') {
      console.warn(`[drag] native drop settled with effect='${effect}' (expected 'copy')`);
    }
    return effect;
  } catch (err) {
    console.warn('[drag] native drag failed:', err);
    return 'error';
  }
}
