import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ClipItem } from '../types';
import {
  ClipTileIcon,
  ChevronDownIcon,
  CloseIcon,
  DragHandleIcon,
  getTypeLabel,
} from './Icons';

interface PasteStackDrawerProps {
  items: ClipItem[];
  onClear: () => void;
  onQueueChange?: () => void | Promise<void>;
  compact?: boolean;
  style?: React.CSSProperties;
}

function shortTitle(title: string, max: number): string {
  if (!title) return 'Untitled';
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

function itemSubtitle(item: ClipItem): string {
  if (item.content_type === 'image') {
    if (item.image_width && item.image_height) {
      return `Image · ${item.image_width}×${item.image_height}`;
    }
    return 'Image';
  }
  const typeLabel = getTypeLabel(item.content_type);
  if (item.source_app) {
    const cleanApp = item.source_app.replace(/\.exe$/i, '');
    return `${typeLabel} · ${cleanApp}`;
  }
  return typeLabel;
}

function moveInList<T>(list: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= list.length ||
    toIndex >= list.length
  ) {
    return list;
  }
  const copy = list.slice();
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved);
  return copy;
}

/**
 * Interactive Paste Stack bar + anchored floating frosted drawer shared by
 * QuickOverlay and EnlargedWindow. Uses pointer-event live-reordering instead
 * of HTML5 drag-and-drop so rows shift smoothly in place with zero OS red
 * no-drop cursor and zero noisy drop-line bars.
 */
export const PasteStackDrawer: React.FC<PasteStackDrawerProps> = ({
  items,
  onClear,
  onQueueChange,
  compact = false,
  style,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [dragState, setDragState] = useState<{ fromIndex: number; currentIndex: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const activeDragRef = useRef<{
    fromIndex: number;
    currentIndex: number;
    startY: number;
    active: boolean;
  } | null>(null);

  const handleReorder = useCallback(
    async (fromIndex: number, toIndex: number) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= items.length ||
        toIndex >= items.length
      ) {
        return;
      }
      try {
        await invoke('queue_reorder', { fromIndex, toIndex });
        await onQueueChange?.();
      } catch (err) {
        console.error('queue_reorder failed:', err);
      }
    },
    [items.length, onQueueChange],
  );

  const handleRemoveAt = useCallback(
    async (index: number) => {
      try {
        await invoke('queue_remove_at', { index });
        await onQueueChange?.();
      } catch (err) {
        console.error('queue_remove_at failed:', err);
      }
    },
    [onQueueChange],
  );

  const handleReverse = useCallback(async () => {
    try {
      await invoke('queue_reverse');
      await onQueueChange?.();
    } catch (err) {
      console.error('queue_reverse failed:', err);
    }
  }, [onQueueChange]);

  useEffect(() => {
    if (!expanded) return;
    const onPointerDownOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', onPointerDownOutside, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDownOutside, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [expanded]);

  useEffect(() => {
    if (items.length === 0 && expanded) {
      setExpanded(false);
    }
  }, [items.length, expanded]);

  useEffect(() => {
    return () => {
      document.body.classList.remove('paste-stack-dragging');
    };
  }, []);

  const displayItems = useMemo(() => {
    if (!dragState) return items;
    return moveInList(items, dragState.fromIndex, dragState.currentIndex);
  }, [items, dragState]);

  const beginRowPointerDrag = (idx: number, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || items.length < 2) return;
    if ((e.target as HTMLElement).closest('button')) return;

    e.preventDefault();
    activeDragRef.current = {
      fromIndex: idx,
      currentIndex: idx,
      startY: e.clientY,
      active: false,
    };

    const computeSlotIndex = (clientY: number): number => {
      let target = items.length - 1;
      for (let i = 0; i < items.length; i++) {
        const el = rowRefs.current[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          target = i;
          return target;
        }
      }
      return target;
    };

    const onMove = (ev: PointerEvent) => {
      const st = activeDragRef.current;
      if (!st) return;
      if (!st.active && Math.abs(ev.clientY - st.startY) >= 4) {
        st.active = true;
        document.body.classList.add('paste-stack-dragging');
        setDragState({ fromIndex: st.fromIndex, currentIndex: st.currentIndex });
      }
      if (!st.active) return;
      const nextSlot = computeSlotIndex(ev.clientY);
      if (nextSlot !== st.currentIndex) {
        st.currentIndex = nextSlot;
        setDragState({ fromIndex: st.fromIndex, currentIndex: nextSlot });
      }
    };

    const finishDrag = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', finishDrag, true);
      window.removeEventListener('pointercancel', finishDrag, true);
      document.body.classList.remove('paste-stack-dragging');

      const st = activeDragRef.current;
      activeDragRef.current = null;
      setDragState(null);

      if (st && st.active && st.currentIndex !== st.fromIndex) {
        void handleReorder(st.fromIndex, st.currentIndex);
      }
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', finishDrag, true);
    window.addEventListener('pointercancel', finishDrag, true);
  };

  if (items.length === 0) return null;

  return (
    <div
      ref={wrapRef}
      className={`paste-stack-wrap ${expanded ? 'is-open' : ''} ${compact ? 'is-compact' : ''}`}
      style={style}
    >
      <div
        className="paste-stack-bar"
        onClick={() => setExpanded((prev) => !prev)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((prev) => !prev);
          }
        }}
        title={expanded ? 'Close paste stack drawer' : 'Click to view & reorder paste stack'}
      >
        <div className="paste-stack-bar-left">
          <span className="queue-tag">Stack ({items.length})</span>
          <span className="queue-dot">·</span>
          <div className="queue-next-meta" title={displayItems[0]?.title}>
            <span>Next:</span>
            <span className="queue-next-title">
              {shortTitle(displayItems[0]?.title || '', compact ? 24 : 36)}
            </span>
          </div>
        </div>
        <div className="paste-stack-bar-right">
          {!compact && <span className="queue-auto-hint">Ctrl+V pastes in order</span>}
          <button
            type="button"
            className={`paste-stack-btn ${expanded ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => !prev);
            }}
          >
            <span className="carbon-control-label">{expanded ? 'Done' : 'Reorder'}</span>
            <ChevronDownIcon className={`paste-stack-chevron ${expanded ? 'open' : ''}`} size={13} />
          </button>
          <button
            type="button"
            className="paste-stack-btn danger"
            title="Clear paste stack"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
              onClear();
            }}
          >
            <span className="carbon-control-label">Clear</span>
          </button>
        </div>
      </div>

      {expanded && (
        <div
          className="paste-stack-drawer"
          onClick={(e) => e.stopPropagation()}
          role="region"
          aria-label="Paste stack order"
        >
          <div className="paste-stack-drawer-head">
            <span className="paste-stack-drawer-hint">
              Drag rows or use arrows · <strong>#1</strong> pastes on next Ctrl+V
            </span>
            {items.length > 1 && (
              <button
                type="button"
                className="paste-stack-btn small"
                onClick={() => void handleReverse()}
                title="Reverse stack order (FIFO ↔ LIFO)"
              >
                <span className="carbon-control-label">Reverse order</span>
              </button>
            )}
          </div>
          <div className="paste-stack-list">
            {displayItems.map((item, idx) => {
              const isDraggedSlot = dragState !== null && dragState.currentIndex === idx;

              return (
                <div
                  key={`${item.id}-${idx}`}
                  ref={(el) => {
                    rowRefs.current[idx] = el;
                  }}
                  className={`paste-stack-row ${idx === 0 ? 'is-next' : ''} ${isDraggedSlot ? 'is-dragging' : ''}`}
                  onPointerDown={(e) => beginRowPointerDrag(idx, e)}
                >
                  <span className="paste-stack-grip" aria-hidden="true">
                    <DragHandleIcon size={13} />
                  </span>
                  <span className={`paste-stack-pos ${idx === 0 ? 'is-next' : ''}`}>#{idx + 1}</span>
                  <span className={`paste-stack-ic ${item.content_type === 'image' ? 'is-thumb' : ''}`}>
                    <ClipTileIcon item={item} />
                  </span>
                  <div className="paste-stack-meta">
                    <span className="paste-stack-title" title={item.title}>
                      {shortTitle(item.title, compact ? 32 : 48)}
                    </span>
                    <span className="paste-stack-sub">{itemSubtitle(item)}</span>
                  </div>
                  <div className="paste-stack-row-actions">
                    <button
                      type="button"
                      className="paste-stack-icon-btn"
                      disabled={idx === 0}
                      title="Move up"
                      aria-label={`Move slot ${idx + 1} up`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleReorder(idx, idx - 1);
                      }}
                    >
                      <ChevronDownIcon className="paste-stack-arrow-up" size={13} />
                    </button>
                    <button
                      type="button"
                      className="paste-stack-icon-btn"
                      disabled={idx === items.length - 1}
                      title="Move down"
                      aria-label={`Move slot ${idx + 1} down`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleReorder(idx, idx + 1);
                      }}
                    >
                      <ChevronDownIcon size={13} />
                    </button>
                    <button
                      type="button"
                      className="paste-stack-icon-btn danger"
                      title="Remove from stack"
                      aria-label={`Remove slot ${idx + 1}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRemoveAt(idx);
                      }}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
