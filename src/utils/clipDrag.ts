import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { startDrag } from '@crabnebula/tauri-plugin-drag';
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

  // NOTE: no text/html on drags, for ANY type. Stored HTML is full-page
  // capture markup (deep nesting, data-URL images, sliced tags) that
  // crashes target tabs/editors on drop — first seen with rich_text,
  // then with HTML-carrying text clips too. Plain text drops universally;
  // same-window Carbon drops resolve via the ids/json flavors above;
  // rich paste (Ctrl+V) still delivers full CF_HTML formatting.

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

/* ═════════════════════════════════════════════════════════════════════
 * OS file drag-out (Glint-proven pattern via @crabnebula/tauri-plugin-drag).
 * Image/file rows leave as REAL files (HDROP, plugin-owned modal loop) so
 * chat upload zones, Explorer, editors, and file-accepting terminals take
 * them. Text-like rows keep the DOM path above (proven in Notepad/chats).
 *
 * Gesture rule (the reliability insight): the OS drag must start while the
 * mouse button is physically held, so initiation rides on pointerdown +
 * movement threshold — NEVER on dragstart (too late / re-entrant) and never
 * on click (no threshold crossed). Rows using this path set
 * draggable={false} so the browser never ALSO starts a DOM drag.
 * ═════════════════════════════════════════════════════════════════════ */

// 1x1 transparent PNG so the OS drag shows just the cursor, never a giant
// ghost. Pre-fetched at module load: it must be ready synchronously
// inside the gesture.
let blankDragIcon: string | null = null;
void invoke<string>('drag_blank_icon').then((p) => {
  blankDragIcon = p;
}).catch(() => {});

/** True from threshold-cross to settle; gates the overlay auto-hide. */
let osDragInFlight = false;

async function setDragFlag(active: boolean): Promise<void> {
  try {
    await invoke('set_drag_active', { active });
  } catch {
    /* diagnostics only — the drag itself is unaffected */
  }
}

/** Arm the backend auto-hide guard for a DOM drag (fire-and-forget). */
export function armDragGuard(): void {
  void setDragFlag(true);
}

/** Release the backend auto-hide guard after a DOM drag settles. */
export function disarmDragGuard(): void {
  void setDragFlag(false);
}

/**
 * Drag real files out into any app. Returns the plugin settlement
 * ('Dropped' | 'Cancelled' | 'error'). Never throws.
 */
export async function dragOutFiles(paths: string[]): Promise<string> {
  if (paths.length === 0) return 'error';
  if (osDragInFlight) {
    console.warn('[drag] OS drag already in flight — ignoring stacked gesture (spam guard)');
    return 'busy';
  }
  osDragInFlight = true;
  // Safety net: a wedged target must only delay overlay auto-hide, never
  // disable it.
  const safety = window.setTimeout(() => {
    if (osDragInFlight) {
      console.warn('[drag] OS drag exceeded 60s — releasing auto-hide guard');
      osDragInFlight = false;
      void setDragFlag(false);
    }
  }, 60_000);
  await setDragFlag(true);
  console.debug(`[drag] OS threshold crossed — starting plugin drag for ${paths.length} file(s)`);
  try {
    let result = 'Cancelled';
    await startDrag(
      { item: paths, icon: blankDragIcon ?? paths[0], mode: 'copy' },
      (e) => {
        result = e.result;
      }
    );
    if (result !== 'Dropped') {
      console.debug(`[drag] OS drag settled: ${result}`);
    }
    return result;
  } catch (err) {
    console.warn('[drag] OS drag failed:', err);
    return 'error';
  } finally {
    window.clearTimeout(safety);
    osDragInFlight = false;
    await setDragFlag(false);
  }
}

/** Resolve the real on-disk paths an image/file clip offers to the OS. */
export function osDragPaths(item: ClipItem): string[] | null {
  // Sensitive clips never expose real files — they keep the DOM decoy path.
  if (item.is_sensitive) return null;
  if (item.content_type === 'image') {
    return item.image_path ? [item.image_path] : null;
  }
  if (item.content_type === 'file') {
    if (!item.file_paths) return item.text_content ? item.text_content.split('\n').filter(Boolean) : null;
    try {
      const paths = JSON.parse(item.file_paths) as unknown;
      if (Array.isArray(paths)) return paths.filter((p): p is string => typeof p === 'string');
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export function shouldOsDrag(item: ClipItem): boolean {
  return osDragPaths(item) !== null;
}

const OS_DRAG_THRESHOLD_PX = 6;

export type OsGestureCleanup = () => void;

/**
 * Attach the press-and-drag gesture to an element (image/file rows).
 * Pointerdown arms; crossing the movement threshold with the button held
 * fires the OS drag once; pointerup disarms (plain click proceeds
 * untouched). Returns a cleanup fn. No preventDefault — clicks, text
 * selection, and scrolling behave exactly as before until the threshold.
 */
export function attachOsFileDrag(
  el: HTMLElement,
  getItem: () => ClipItem | null,
  opts?: { onStart?: (id: string) => void; onSettled?: () => void }
): OsGestureCleanup {
  let sx = 0;
  let sy = 0;
  let armed = false;
  let fired = false;

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    sx = e.clientX;
    sy = e.clientY;
    armed = true;
    fired = false;
  };
  const move = (e: PointerEvent) => {
    if (!armed || fired) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) < OS_DRAG_THRESHOLD_PX) return;
    fired = true;
    armed = false;
    const item = getItem();
    const paths = item ? osDragPaths(item) : null;
    if (!item || !paths || paths.length === 0) {
      return;
    }
    opts?.onStart?.(item.id);
    window.__carbonDraggingClipIds = [item.id];
    try {
      document.getSelection()?.removeAllRanges();
    } catch {}
    void dragOutFiles(paths).finally(() => {
      window.__carbonDraggingClipIds = null;
      opts?.onSettled?.();
    });
  };
  const up = () => {
    armed = false;
  };

  el.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  return () => {
    el.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
}
