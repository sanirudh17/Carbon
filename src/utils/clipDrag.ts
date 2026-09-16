import { convertFileSrc } from '@tauri-apps/api/core';
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
