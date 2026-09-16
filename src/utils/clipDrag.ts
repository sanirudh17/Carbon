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
