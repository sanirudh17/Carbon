import type { ClipItem } from '../types';

// Local file path -> file:// URL external apps can resolve on drop.
// (Tauri's convertFileSrc asset URLs only work inside our own webviews.)
export const filePathToFileUrl = (p: string) => {
  const normalized = p.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? normalized : `/${normalized}`}`;
};

// Shared drag-out payload so clips dropped onto any external text area or
// image-capable app carry something usable: plain text everywhere, HTML for
// rich targets, and real file:// URLs for images/files/links. Internal
// Carbon drops keep working via the carbon/clip-ids flavor.
export const setClipDragData = (
  e: React.DragEvent | DragEvent,
  item: ClipItem,
  ids?: string[],
) => {
  const dt = e.dataTransfer;
  if (!dt) return;
  const list = ids && ids.length > 0 ? ids : [item.id];
  dt.effectAllowed = 'all';

  const text = item.text_content || item.title || item.id;
  try {
    dt.setData('text/plain', text);
  } catch {}
  try {
    dt.setData('application/json', JSON.stringify({ ids: list, clipId: item.id }));
  } catch {}
  try {
    dt.setData('carbon/clip-ids', JSON.stringify(list));
  } catch {}

  if (item.html_content) {
    try {
      dt.setData('text/html', item.html_content);
    } catch {}
  } else if (item.content_type === 'image' && item.image_path) {
    try {
      dt.setData('text/html', `<img src="${filePathToFileUrl(item.image_path)}" alt="">`);
    } catch {}
  }

  if (item.content_type === 'link') {
    try {
      dt.setData('text/uri-list', text);
    } catch {}
  } else if (item.content_type === 'image' && item.image_path) {
    try {
      dt.setData('text/uri-list', filePathToFileUrl(item.image_path));
    } catch {}
  } else if (item.content_type === 'file' && item.file_paths) {
    try {
      const paths: string[] = JSON.parse(item.file_paths);
      dt.setData('text/uri-list', paths.map(filePathToFileUrl).join('\r\n'));
    } catch {
      try {
        dt.setData('text/plain', item.file_paths);
      } catch {}
    }
  }
};
