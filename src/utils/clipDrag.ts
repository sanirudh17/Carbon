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
  const list = ids && ids.length > 0 ? ids : [item.id];
  dt.effectAllowed = 'all';

  const text = item.text_content || item.title || item.id || 'carbon-clip';
  dt.setData('text/plain', text);
  dt.setData('application/json', JSON.stringify({ ids: list, clipId: item.id }));
  dt.setData('carbon/clip-ids', JSON.stringify(list));

  if (item.html_content) {
    dt.setData('text/html', item.html_content);
  }

  if (item.content_type === 'link') {
    dt.setData('text/uri-list', text);
  } else if (item.content_type === 'image' && item.image_path) {
    dt.setData('text/uri-list', convertFileSrc(item.image_path));
  } else if (item.content_type === 'file' && item.file_paths) {
    try {
      const paths: string[] = JSON.parse(item.file_paths);
      dt.setData('text/uri-list', paths.map((p) => 'file:///' + p.replace(/\\/g, '/')).join('\r\n'));
    } catch {
      dt.setData('text/plain', item.file_paths);
    }
  }
};

/**
 * Image/file rows leave through native OLE (chat upload zones, Explorer,
 * editors need real HDROP/DIB/descriptor formats); text-like rows keep the
 * DOM drag (Chromium synthesizes text flavors, plus internal flavors).
 */
export function shouldNativeDrag(item: ClipItem): boolean {
  return item.content_type === 'image' || item.content_type === 'file';
}

/**
 * Starts a native OLE drag for an image/file clip. The browser fires
 * dragstart only after its own movement threshold, so calling this from
 * onDragStart preserves native threshold behavior. preventDefault cancels
 * the DOM drag (no dragend will fire — callers must clean up in `finally`).
 * Resolves with the negotiated drop effect ('copy' expected).
 */
export async function beginNativeDrag(
  e: React.DragEvent | DragEvent,
  item: ClipItem
): Promise<string> {
  e.preventDefault();
  e.stopPropagation();
  // B4 gesture hygiene: no DOM selection bleed, no coexistence with a
  // WebView text selection while the OS owns the gesture.
  try {
    document.getSelection()?.removeAllRanges();
  } catch {}
  document.documentElement.classList.add('native-dragging');
  try {
    const effect = await invoke<string>('begin_native_drag', { id: item.id });
    if (effect !== 'copy') {
      console.warn(`[drag] native drop settled with effect='${effect}' (expected 'copy')`);
    }
    return effect;
  } finally {
    document.documentElement.classList.remove('native-dragging');
  }
}
