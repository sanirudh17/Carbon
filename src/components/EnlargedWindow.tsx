import React, { useEffect, useState, useRef, memo, useCallback, useMemo } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ClipItem, Collection, DbStats, AppSettings, Snippet } from '../types';
import { collectionColorFor, normalizeCollectionColor } from '../utils/collections';
import { ClipPreview, ClipMetaStrip, getQrCopyLabel, getSpecificTypeLabel, isMarkdownContent, appDisplayName } from './ClipPreview';
import { getActionsForClip, getPasteActionsForClip, handleClipKeyDown, ClipActionHandlers } from '../utils/clipActions';
import { matchesHotkeyCombo } from '../utils/hotkeys';
import { setClipDragData } from '../utils/clipDrag';
import { SnippetsView } from './SnippetsView';
import {
  SearchIcon,
  BrandBadgeIcon,
  AllIcon,
  TextIcon,
  CodeIcon,
  RichTextIcon,
  ImageIcon,
  FilesIcon,
  LinksIcon,
  EmailIcon,
  ColorsIcon,
  StarIcon,
  CopyIcon,
  HollowClipboardIcon,
  DeleteIcon,
  QueueIcon,
  DragHandleIcon,
  SettingsIcon,
  ChevronLeftIcon,
  CheckIcon,
  FolderIcon,
  LockIcon,
  UnlockIcon,
  PlusIcon,
  EditIcon,
  OcrIcon,
  SnippetIcon,
  getTypeIcon,
  getTypeColor,
} from './Icons';

declare global {
  interface Window {
    __carbonSetData?: (data: ClipItem[]) => void;
    __carbonInitialData?: ClipItem[];
    __carbonSetSnippets?: (data: Snippet[]) => void;
    __carbonInitialSnippets?: Snippet[];
  }
}

const emptyDragImg = typeof Image !== 'undefined' ? new Image() : null;
if (emptyDragImg) {
  emptyDragImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
}

interface DateGroup {
  label: string;
  items: ClipItem[];
}

function groupItemsByDate(items: ClipItem[]): DateGroup[] {
  const groups: { [key: string]: ClipItem[] } = {};
  const order: string[] = [];

  const now = new Date();
  const todayStr = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();

  items.forEach((item) => {
    let label = 'Older';
    if (item.created_at) {
      const d = new Date(item.created_at);
      if (!isNaN(d.getTime())) {
        if (d.toDateString() === todayStr) {
          label = 'Today';
        } else if (d.toDateString() === yesterdayStr) {
          label = 'Yesterday';
        } else {
          label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        }
      }
    }

    if (!groups[label]) {
      groups[label] = [];
      order.push(label);
    }
    groups[label].push(item);
  });

  return order.map((label) => ({ label, items: groups[label] }));
}

// ── Memoized list row: keeps keyboard-navigation and clicking renders O(1) ────────
const EnlargedRow = memo(function EnlargedRow({
  item,
  index,
  isSelected,
  isMultiSelected,
  isDragging,
  queueIdx,
  onRowClick,
  onDragStart,
  onDragEnd,
}: {
  item: ClipItem;
  index: number;
  isSelected: boolean;
  isMultiSelected: boolean;
  isDragging: boolean;
  queueIdx: number;
  onRowClick: (item: ClipItem, idx: number, e: React.MouseEvent) => void;
  onDragStart: (item: ClipItem, e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const tint = getTypeColor(item.content_type);
  return (
    <div
      id={`enlarged-row-${index}`}
      draggable={true}
      onDragStart={(e) => onDragStart(item, e)}
      onDragEnd={onDragEnd}
      className={`row ${isSelected ? 'selected' : ''} ${isMultiSelected ? 'multi-selected' : ''} ${isDragging ? 'is-dragging' : ''} ${queueIdx >= 0 ? 'in-queue' : ''}`}
      onClick={(e) => onRowClick(item, index, e)}
    >
      <div
        className="type-icon"
        style={{
          background: `color-mix(in srgb, ${tint} var(--tint-alpha), transparent)`,
          color: tint,
        }}
      >
        {getTypeIcon(item.content_type)}
      </div>
      <div className="row-body">
        <div className="row-title">
          {item.is_pinned && <span className="pin-star" style={{ color: '#F59E0B' }}>★</span>}
          {queueIdx >= 0 && (
            <span className="queue-pos-badge" title={`Position #${queueIdx + 1} in paste queue`}>
              #{queueIdx + 1}
            </span>
          )}
          {item.is_sensitive ? (
            <span className="sensitive-title-masked">
              <LockIcon /> Sensitive Clip
            </span>
          ) : (
            constrainTitle(item.title)
          )}
        </div>
        <div className="row-snippet">
          {item.is_sensitive
            ? '••••••••••••••••••••••••••••'
            : item.text_content
            ? item.text_content.replace(/\s+/g, ' ').slice(0, 90)
            : item.source_app || item.content_type}
        </div>
      </div>

      <div className="row-right">
        <div className="drag-handle" title="Drag and drop clip">
          <DragHandleIcon />
        </div>
        <div className="row-meta">
          <span className="row-time">{formatTimeAgo(item.created_at)}</span>
          <span className="row-size">{formatBytes(item.file_size)}</span>
        </div>
      </div>
    </div>
  );
});

interface EnlargedWindowProps {
  onOpenSettings: () => void;
}

export const EnlargedWindow: React.FC<EnlargedWindowProps> = ({ onOpenSettings }) => {
  const [items, setItems] = useState<ClipItem[]>(() => (typeof window !== 'undefined' && window.__carbonInitialData) || []);
  const [initialLoaded, setInitialLoaded] = useState(() => Boolean(typeof window !== 'undefined' && window.__carbonInitialData && window.__carbonInitialData.length > 0));
  const [search, setSearch] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string>('');
  const [selectedFilter, setSelectedFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'clips' | 'snippets'>('clips');
  const [showSnippets, setShowSnippets] = useState(true);
  const [snippetCreateSignal, setSnippetCreateSignal] = useState(0);
  const [sourceAppFilter, setSourceAppFilter] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<ClipItem | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  // Pure-DOM toggle, exactly like clipboard-preview.html: flips the class directly
  // so the 180ms width animation never competes with a React re-render of the window.
  const toggleSidebar = useCallback(() => {
    sidebarRef.current?.classList.toggle('collapsed');
  }, []);
  const [editingContent, setEditingContent] = useState('');

  // Keep editingContent in sync with selectedItem text_content so the edit pane
  // never shows empty content when a valid text item is selected
  useEffect(() => {
    setEditingContent(selectedItem?.text_content || '');
  }, [selectedItem?.id, selectedItem?.text_content]);
  // A newly selected clip gets fresh (unfocused) scroll state
  useEffect(() => {
    setImgFocused(false);
    setPreviewFocused(false);
  }, [selectedItem?.id]);
  const [zoom100, setZoom100] = useState(false);
  // True after clicking the preview image: arrow keys scroll inside long
  // captures instead of jumping clips (hard stop at the scroll edge).
  // Cleared on selection change or Escape.
  const [imgFocused, setImgFocused] = useState(false);
  // Same rule for the rendered rich/markdown preview: clicking inside it
  // focuses the pane so arrows scroll long documents instead of moving
  // the list selection.
  const [previewFocused, setPreviewFocused] = useState(false);
  const previewRenderRef = useRef<HTMLDivElement>(null);
  const [counts, setCounts] = useState<{ [key: string]: number }>({});
  const [snippetsCount, setSnippetsCount] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionPanelOpen, setActionPanelOpen] = useState(false);
  const [actionIndex, setActionIndex] = useState(0);
  const [renderMode, setRenderMode] = useState(true);
  const [pasteMenuOpen, setPasteMenuOpen] = useState(false);

  // Collections State
  const [collections, setCollections] = useState<Collection[]>([]);
  const [unlockedCollectionIds, setUnlockedCollectionIds] = useState<Set<string>>(new Set());
  const unlockedCollectionIdsRef = useRef(unlockedCollectionIds);
  unlockedCollectionIdsRef.current = unlockedCollectionIds;
  const [dropTargetColId, setDropTargetColId] = useState<string | null>(null);

  // Modals & Context Menus State
  const [createColModalOpen, setCreateColModalOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [renameColModal, setRenameColModal] = useState<{ col: Collection; newName: string } | null>(null);
  const [changeColorModal, setChangeColorModal] = useState<{ col: Collection; color: string } | null>(null);
  const [verifyChangePinModal, setVerifyChangePinModal] = useState<{ col: Collection } | null>(null);
  const [verifyChangePinInput, setVerifyChangePinInput] = useState('');
  const [verifyChangePinError, setVerifyChangePinError] = useState('');
  const [pinModal, setPinModal] = useState<{ col: Collection; mode: 'set' | 'change' } | null>(null);
  const [pinModalInput, setPinModalInput] = useState('');
  const [pinModalConfirm, setPinModalConfirm] = useState('');
  const [pinModalError, setPinModalError] = useState('');
  const [recoveryCodeModal, setRecoveryCodeModal] = useState<{ col: Collection; code: string; isReset: boolean } | null>(null);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [resetPasscodeModal, setResetPasscodeModal] = useState<{ col: Collection } | null>(null);
  const [resetRecoveryCodeInput, setResetRecoveryCodeInput] = useState('');
  const [resetNewPinInput, setResetNewPinInput] = useState('');
  const [resetConfirmPinInput, setResetConfirmPinInput] = useState('');
  const [resetPasscodeError, setResetPasscodeError] = useState('');
  const [deleteColConfirm, setDeleteColConfirm] = useState<Collection | null>(null);
  const [removePinModal, setRemovePinModal] = useState<{ col: Collection } | null>(null);
  const [removePinInput, setRemovePinInput] = useState('');
  const [removePinError, setRemovePinError] = useState('');
  const [addToColModalOpen, setAddToColModalOpen] = useState(false);
  const [pendingAddClips, setPendingAddClips] = useState<string[] | null>(null);
  const [colContextMenu, setColContextMenu] = useState<{ x: number; y: number; col: Collection } | null>(null);
  const [deleteColClipsToo, setDeleteColClipsToo] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeActionRef = useRef<HTMLDivElement>(null);
  const imgWrapperRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const hasDraggedRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  useEffect(() => {
    if (actionPanelOpen && activeActionRef.current) {
      activeActionRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [actionIndex, actionPanelOpen]);

  const isCollection = selectedFilter.startsWith('col_');
  const currentCollectionId = isCollection ? selectedFilter.replace('col_', '') : null;
  const currentCollection = collections.find((c) => c.id === currentCollectionId);
  const isCurrentCollectionLocked = Boolean(
    isCollection && currentCollection?.is_locked && !unlockedCollectionIds.has(currentCollection.id)
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!zoom100 || !imgWrapperRef.current) return;
    if (e.button !== 0) return;
    e.preventDefault();

    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: imgWrapperRef.current.scrollLeft,
      scrollTop: imgWrapperRef.current.scrollTop,
    };

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (_) {}
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || !imgWrapperRef.current) return;
    e.preventDefault();

    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasDraggedRef.current = true;
    }

    imgWrapperRef.current.scrollLeft = dragStartRef.current.scrollLeft - dx;
    imgWrapperRef.current.scrollTop = dragStartRef.current.scrollTop - dy;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (_) {}
  };

  // Load image data URL reliably without blank placeholder
  useEffect(() => {
    if (selectedItem?.content_type === 'image' && selectedItem.image_path) {
      invoke<string>('get_image_data_url', { filePath: selectedItem.image_path })
        .then((url) => setImageDataUrl(url))
        .catch(() => setImageDataUrl(''));
    } else {
      setImageDataUrl('');
    }
  }, [selectedItem?.id, selectedItem?.image_path, selectedItem?.content_type]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedIndexRef = useRef<number>(-1);
  const [bulkConfirmDelete, setBulkConfirmDelete] = useState<boolean>(false);
  const [pasteQueue, setPasteQueue] = useState<ClipItem[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const fetchCollections = async () => {
    try {
      const list = await invoke<Collection[]>('list_collections');
      setCollections(list || []);
    } catch (err) {
      console.error('Failed to fetch collections:', err);
    }
  };

  const fetchQueue = async () => {
    try {
      const q = await invoke<ClipItem[]>('queue_get_clips');
      setPasteQueue(q || []);
    } catch (err) {
      console.error('Failed to fetch paste queue in enlarged window:', err);
    }
  };

  const fetchCounts = async () => {
    try {
      const stats = await invoke<DbStats>('get_stats');
      if (stats) {
        setCounts({
          all: stats.total_items,
          pinned: stats.pinned_count,
          text: stats.text_count,
          code: stats.code_count,
          rich_text: stats.rich_text_count,
          image: stats.image_count,
          file: stats.file_count,
          link: stats.link_count,
          email: stats.email_count,
          color: stats.color_count,
        });
      }
    } catch (err) {
      console.error('Failed to fetch stats counts:', err);
    }
  };

  const allCachedItemsRef = useRef<ClipItem[]>([]);

  const fetchItems = async (filterOverride?: string, unlockedIdsOverride?: Set<string>) => {
    try {
      const activeFilter = filterOverride !== undefined ? filterOverride : selectedFilter;
      const isCol = activeFilter.startsWith('col_');
      const colId = isCol ? activeFilter.replace('col_', '') : null;
      const isPinned = activeFilter === 'pinned';
      const category = !isCol && activeFilter !== 'all' && activeFilter !== 'pinned' ? activeFilter : null;
      const currentUnlocked = unlockedIdsOverride !== undefined ? unlockedIdsOverride : unlockedCollectionIdsRef.current;

      if (isCol && colId) {
        const foundCol = collections.find((c) => c.id === colId);
        if (foundCol?.is_locked && !currentUnlocked.has(colId)) {
          setItems([]);
          setSelectedItem(null);
          setEditingContent('');
          return;
        }
      }

      const res = await invoke<ClipItem[]>('get_all_clips', {
        search: search.trim() ? search : null,
        category,
        pinnedOnly: isPinned,
        collectionId: colId,
      });

      let list = res || [];
      if (activeFilter === 'all' && !search.trim() && !colId) {
        allCachedItemsRef.current = list;
      }
      if (sourceAppFilter) {
        list = list.filter(
          (i) => i.source_app && i.source_app.toLowerCase() === sourceAppFilter.toLowerCase()
        );
      }
      setItems(list);
      setInitialLoaded(true);

      if (list.length > 0) {
        setSelectedIndex((prev) => {
          const nextIdx = prev < list.length ? prev : 0;
          setSelectedItem(list[nextIdx]);
          setEditingContent(list[nextIdx].text_content || '');
          return nextIdx;
        });
      } else {
        setSelectedItem(null);
        setEditingContent('');
      }
    } catch (err) {
      console.error('Failed to fetch enlarged clips:', err);
      setInitialLoaded(true);
    }
  };

  // Keep the latest fetch reachable from long-lived listeners so event
  // refreshes respect the current search/filter state.
  const fetchRef = useRef<() => void>(() => {});
  // Full snippet list, cached so the Snippets section renders instantly on
  // open (no IPC wait); SnippetsView still refreshes silently in background.
  const [snippetsCache, setSnippetsCache] = useState<Snippet[]>([]);
  const loadSnippetCache = useCallback(() => {
    invoke<Snippet[]>('list_snippets')
      .then((list) => {
        const arr = Array.isArray(list) ? list : [];
        setSnippetsCache(arr);
        setSnippetsCount(arr.length);
      })
      .catch(() => setSnippetsCount(0));
  }, []);
  fetchRef.current = () => {
    fetchItems();
    fetchCollections();
    fetchCounts();
    fetchQueue();
    loadSnippetCache();
  };

  const handleSelectFilter = (filterKey: string) => {
    if (selectedFilter === filterKey && viewMode === 'clips') return;
    setViewMode('clips');
    setSelectedFilter(filterKey);
    setSelectedIds(new Set());
    setBulkConfirmDelete(false);
    setPinInput('');
    setPinError(false);

    // Optimistic instantaneous in-memory filter (0ms visual switch)
    if (allCachedItemsRef.current.length > 0) {
      const isCol = filterKey.startsWith('col_');
      const isPinned = filterKey === 'pinned';
      const category = !isCol && filterKey !== 'all' && filterKey !== 'pinned' ? filterKey : null;

      if (!isCol) {
        let immediateList = allCachedItemsRef.current;
        if (isPinned) {
          immediateList = immediateList.filter((i) => i.is_pinned);
        } else if (category) {
          immediateList = immediateList.filter((i) => i.content_type === category);
        }
        if (sourceAppFilter) {
          immediateList = immediateList.filter(
            (i) => i.source_app && i.source_app.toLowerCase() === sourceAppFilter.toLowerCase()
          );
        }
        setItems(immediateList);
        if (immediateList.length > 0) {
          setSelectedIndex(0);
          setSelectedItem(immediateList[0]);
          setEditingContent(immediateList[0].text_content || '');
        } else {
          setSelectedItem(null);
          setEditingContent('');
        }
      }
    }

    fetchItems(filterKey);
  };

  useEffect(() => {
    setSelectedIds(new Set());
    setBulkConfirmDelete(false);
    setPinInput('');
    setPinError(false);
    fetchItems();
  }, [search, selectedFilter, sourceAppFilter]);

  useEffect(() => {
    fetchCounts();
    fetchCollections();
    fetchQueue();
    loadSnippetCache();

    window.__carbonSetData = (data: ClipItem[]) => {
      if (Array.isArray(data)) {
        setItems(data);
        setInitialLoaded(true);
        allCachedItemsRef.current = data;
        if (data.length > 0) {
          setSelectedIndex(0);
          setSelectedItem(data[0]);
          setEditingContent(data[0].text_content || '');
        }
      }
    };

    window.__carbonSetSnippets = (data: Snippet[]) => {
      if (Array.isArray(data)) {
        setSnippetsCache(data);
        setSnippetsCount(data.length);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [hotkeys, setHotkeys] = useState<{ overlay: string; enlarged: string }>({ overlay: 'Ctrl+Shift+Z', enlarged: 'Ctrl+Alt+X' });

  // Show/hide Snippets section & hotkeys sync
  useEffect(() => {
    const apply = (s: AppSettings) => {
      if (s) {
        if (s.quick_hotkey || s.enlarged_hotkey) {
          setHotkeys({
            overlay: s.quick_hotkey || 'Ctrl+Shift+Z',
            enlarged: s.enlarged_hotkey || 'Ctrl+Alt+X',
          });
        }
        if (typeof s.show_snippets === 'boolean') {
          setShowSnippets(s.show_snippets);
          if (!s.show_snippets) {
            setViewMode((prev) => (prev === 'snippets' ? 'clips' : prev));
          }
        }
      }
    };
    invoke<AppSettings>('get_settings').then(apply).catch(() => {});
    let unlisten: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    listen<AppSettings>('settings-updated', (e) => apply(e.payload)).then((fn) => {
      unlisten = fn;
    });
    listen<{ overlay?: string; enlarged?: string }>('hotkey-status', (e) => {
      if (e.payload) {
        setHotkeys({
          overlay: e.payload.overlay || 'Ctrl+Shift+Z',
          enlarged: e.payload.enlarged || 'Ctrl+Alt+X',
        });
      }
    }).then((fn) => {
      unlistenStatus = fn;
    });
    return () => {
      unlisten?.();
      unlistenStatus?.();
    };
  }, []);

  // Auto-scroll selected row into view (rAF-coalesced so rapid arrow
  // holds supersede in-flight scrolls instead of piling up)
  useEffect(() => {
    if (items.length === 0 || selectedIndex < 0 || selectedIndex >= items.length) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`enlarged-row-${selectedIndex}`);
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
      }
    });
    const target = items[selectedIndex];
    if (target && target.id !== selectedItem?.id) {
      setSelectedItem(target);
      setEditingContent(target.text_content || '');
      setRenderMode(true);
    }
    return () => cancelAnimationFrame(raf);
  }, [selectedIndex, items, selectedItem?.id]);

  useEffect(() => {
    const unlistenUpdated = listen('clipboard-updated', () => {
      fetchRef.current();
    });

    const unlistenQueue = listen('queue-updated', () => {
      fetchQueue();
    });

    const unlistenCollections = listen('collections-updated', () => {
      fetchCollections();
      fetchItems();
    });

    // Refresh clips whenever window gets focus
    let unlistenFocus: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          fetchRef.current();
        }
      })
      .then((unlisten) => {
        unlistenFocus = unlisten;
      });

    return () => {
      unlistenUpdated.then((fn) => fn());
      unlistenQueue.then((fn) => fn());
      unlistenCollections.then((fn) => fn());
      unlistenFocus?.();
    };
  }, []);

  const handleDragStart = useCallback((item: ClipItem, e: React.DragEvent) => {
    const ids = selectedIds.size > 1 && selectedIds.has(item.id)
      ? Array.from(selectedIds)
      : [item.id];
    setDraggingId(item.id);
    window.__carbonDraggingClipIds = ids;

    if (e.dataTransfer && emptyDragImg && e.dataTransfer.setDragImage) {
      try {
        e.dataTransfer.setDragImage(emptyDragImg, 0, 0);
      } catch {}
    }

    // Shared payload: plain text + HTML + real file:// URLs so external
    // apps (editors, browsers, chat) accept the drop, not just Carbon.
    setClipDragData(e, item, ids);
  }, [selectedIds]);

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setDropTargetColId(null);
    window.__carbonDraggingClipIds = null;
  }, []);

  const handleRowClick = useCallback((item: ClipItem, idx: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) {
          next.delete(item.id);
        } else {
          next.add(item.id);
        }
        return next;
      });
      lastClickedIndexRef.current = idx;
      setSelectedIndex(idx);
      setSelectedItem(item);
      setEditingContent(item.text_content || '');
      setRenderMode(true);
    } else if (e.shiftKey) {
      const anchor = lastClickedIndexRef.current >= 0 ? lastClickedIndexRef.current : selectedIndex;
      const start = Math.min(anchor, idx);
      const end = Math.max(anchor, idx);
      const next = new Set<string>();
      for (let i = start; i <= end; i++) {
        if (items[i]) next.add(items[i].id);
      }
      setSelectedIds(next);
      setSelectedIndex(idx);
      setSelectedItem(item);
      setEditingContent(item.text_content || '');
      setRenderMode(true);
    } else {
      setSelectedIds(new Set([item.id]));
      lastClickedIndexRef.current = idx;
      setSelectedIndex(idx);
      setSelectedItem(item);
      setEditingContent(item.text_content || '');
      setRenderMode(true);
    }
  }, [items, selectedIndex]);

  // Group once per items change — toggling the sidebar must not regroup the list
  const dateGroups = useMemo(() => groupItemsByDate(items), [items]);

  const handleSelectAll = () => {
    if (items.length === 0) return;
    const all = new Set<string>();
    items.forEach((i) => all.add(i.id));
    setSelectedIds(all);
    setBulkConfirmDelete(false);
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
    setBulkConfirmDelete(false);
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    try {
      const ids = Array.from(selectedIds);
      await invoke('bulk_delete_clips', { ids });
      setSelectedIds(new Set());
      setBulkConfirmDelete(false);
      await fetchItems();
      await fetchQueue();
    } catch (err) {
      console.error('Failed to bulk delete items:', err);
    }
  };

  const handleBulkPin = async () => {
    if (selectedIds.size === 0) return;
    try {
      const ids = Array.from(selectedIds);
      const selectedItems = items.filter((i) => selectedIds.has(i.id));
      const allPinned = selectedItems.length > 0 && selectedItems.every((i) => i.is_pinned);
      const targetPin = !allPinned;

      await invoke('bulk_pin_clips', { ids, pin: targetPin });
      await fetchItems();
    } catch (err) {
      console.error('Failed to bulk pin items:', err);
    }
  };

  const handleBulkCopy = async () => {
    if (selectedIds.size === 0) return;
    try {
      const selectedItems = items.filter((i) => selectedIds.has(i.id));
      const combinedText = selectedItems
        .map((i) => i.text_content || i.title || '')
        .filter(Boolean)
        .join('\n\n');

      if (combinedText) {
        await navigator.clipboard.writeText(combinedText);
      }
    } catch (err) {
      console.error('Failed to bulk copy items:', err);
    }
  };

  const handleQueueBulk = async () => {
    if (selectedIds.size === 0) return;
    try {
      const ids = Array.from(selectedIds);
      await invoke('queue_add_clips', { ids });
      fetchQueue();
    } catch (err) {
      console.error('Failed to queue bulk items:', err);
    }
  };

  const handleQueueClip = async (item: ClipItem) => {
    try {
      await invoke('queue_add_clips', { ids: [item.id] });
      fetchQueue();
    } catch (err) {
      console.error('Failed to queue clip in enlarged window:', err);
    }
  };

  const handleClearQueue = async () => {
    try {
      await invoke('queue_clear');
      fetchQueue();
    } catch (err) {
      console.error('Failed to clear queue in enlarged window:', err);
    }
  };

  const handlePaste = async (item: ClipItem, plainText?: boolean, transform?: string) => {
    try {
      await invoke('paste_clip', { id: item.id, plainText: plainText ?? false, transform });
    } catch (err) {
      console.error('Failed to paste clip in enlarged window:', err);
    }
  };

  const handleTogglePin = async (item: ClipItem) => {
    try {
      const newPin = await invoke<boolean>('toggle_pin_clip', { id: item.id });
      // Keep the global cache in sync so the Favorites filter (which does
      // an optimistic in-memory filter from allCachedItemsRef) shows the
      // item instantly without waiting for a refetch or restart.
      allCachedItemsRef.current = allCachedItemsRef.current.map((i) =>
        i.id === item.id ? { ...i, is_pinned: newPin } : i
      );
      // In the Favorites tab, unfavoriting should remove the row instantly
      // instead of leaving it until the next tab switch.
      if (selectedFilter === 'pinned' && !newPin) {
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        if (selectedItem?.id === item.id) {
          setSelectedItem(null);
          setEditingContent('');
        }
        // Keep selection valid after removal
        setSelectedIndex((prev) => {
          const len = items.length;
          if (len <= 1) return 0;
          return prev >= len - 1 ? Math.max(0, len - 2) : prev;
        });
      } else {
        setItems((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, is_pinned: newPin } : i))
        );
        if (selectedItem?.id === item.id) {
          setSelectedItem((prev) => (prev ? { ...prev, is_pinned: newPin } : null));
        }
      }
      fetchCounts();
      // No fetchItems() — the optimistic cache update is enough for instant
      // feedback; the next filter switch or clipboard-updated event will
      // refetch fresh data. Avoiding an extra get_all_clips prevents the
      // 500ms skeleton you saw on first favorite.
    } catch (err) {
      console.error('Failed to toggle pin:', err);
    }
  };

  const handleDelete = async (item: ClipItem) => {
    try {
      await invoke('delete_clip', { id: item.id });
      fetchItems();
    } catch (err) {
      console.error('Failed to delete clip:', err);
    }
  };

  const handleContentEdit = async (newText: string) => {
    setEditingContent(newText);
    if (selectedItem) {
      const updatedItem = {
        ...selectedItem,
        text_content: newText,
        title: newText.split('\n')[0].trim() || selectedItem.title,
      };
      setSelectedItem(updatedItem);
      try {
        await invoke('update_clip_text', { id: selectedItem.id, text: newText });
        setItems((prev) =>
          prev.map((i) =>
            i.id === selectedItem.id
              ? { ...i, text_content: newText, title: updatedItem.title }
              : i
          )
        );
      } catch (err) {
        console.error('Failed to update text content:', err);
      }
    }
  };

  const handleCopyOnly = async (item: ClipItem) => {
    try {
      await invoke('copy_clip', { id: item.id });
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
      if (item.text_content) {
        await navigator.clipboard.writeText(item.text_content).catch(console.error);
      }
    }
  };

  const handleRevealFile = async (filePath: string) => {
    try {
      await invoke('reveal_file_in_explorer', { filePath });
    } catch (err) {
      console.error('Failed to reveal file:', err);
    }
  };

  const activeTint = selectedItem ? getTypeColor(selectedItem.content_type) : 'var(--tint-text)';

  const handleCopyDecodedQr = async (item: ClipItem) => {
    if (!item.qr_content) return;
    try {
      await navigator.clipboard.writeText(item.qr_content);
    } catch (err) {
      console.error('Failed to copy decoded QR content:', err);
    }
  };

  const handleExtractOrCopyOcr = async (item: ClipItem) => {
    try {
      const text = item.ocr_text && item.ocr_text.trim()
        ? item.ocr_text
        : await invoke<string>('extract_image_ocr', { id: item.id });

      if (text && text.trim()) {
        await navigator.clipboard.writeText(text).catch(console.error);
        setItems((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, ocr_text: text } : i))
        );
        if (selectedItem?.id === item.id) {
          setSelectedItem((prev) => (prev ? { ...prev, ocr_text: text } : null));
        }
      }
    } catch (err) {
      console.error('Failed to extract/copy OCR:', err);
    }
  };

  // Collections Operations
  const handleAddClipsToCollection = async (clipIds: string[], collectionId: string) => {
    if (clipIds.length === 0) return;
    try {
      await invoke('add_clips_to_collection', { clipIds, collectionId });
      await fetchCollections();
      await fetchItems();
    } catch (err) {
      console.error('Failed to add clips to collection:', err);
    }
  };

  // Ctrl+K "Add to Collection": add straight to the only collection, jump
  // straight into create when none exist, and only show the picker when a
  // choice actually needs to be made.
  const handleOpenAddToCollection = () => {
    const ids = selectedIds.size > 1
      ? Array.from(selectedIds)
      : selectedItem
      ? [selectedItem.id]
      : [];
    if (ids.length === 0) return;
    if (collections.length === 0) {
      setPendingAddClips(ids);
      setNewColName('');
      setCreateColModalOpen(true);
    } else if (collections.length === 1) {
      handleAddClipsToCollection(ids, collections[0].id);
    } else {
      setAddToColModalOpen(true);
    }
  };

  const handleRemoveFromCollection = async (item: ClipItem) => {
    if (!currentCollectionId) return;
    try {
      await invoke('remove_clip_from_collection', { clipId: item.id, collectionId: currentCollectionId });
      await fetchCollections();
      await fetchItems();
    } catch (err) {
      console.error('Failed to remove clip from collection:', err);
    }
  };

  const handleCreateCollectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newColName.trim()) return;
    try {
      const chosenColor = collectionColorFor(newColName.trim());
      const newCol = await invoke<Collection>('create_collection', {
        name: newColName.trim(),
        color: chosenColor,
        icon: null,
      });
      setCreateColModalOpen(false);
      setNewColName('');
      if (newCol) {
        if (pendingAddClips && pendingAddClips.length > 0) {
          await handleAddClipsToCollection(pendingAddClips, newCol.id);
          setPendingAddClips(null);
        }
        await fetchCollections();
        handleSelectFilter(`col_${newCol.id}`);
      } else {
        await fetchCollections();
      }
    } catch (err) {
      console.error('Failed to create collection:', err);
    }
  };

  const handleRenameCollectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameColModal || !renameColModal.newName.trim()) return;
    try {
      await invoke('rename_collection', {
        id: renameColModal.col.id,
        newName: renameColModal.newName.trim(),
      });
      setRenameColModal(null);
      fetchCollections();
    } catch (err) {
      console.error('Failed to rename collection:', err);
    }
  };

  const handleChangeColorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!changeColorModal) return;
    try {
      await invoke('update_collection_color', {
        id: changeColorModal.col.id,
        color: changeColorModal.color,
      });
      setChangeColorModal(null);
      fetchCollections();
    } catch (err) {
      console.error('Failed to update collection color:', err);
    }
  };

  const handleVerifyChangePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifyChangePinModal || !verifyChangePinInput) return;
    try {
      const verified = await invoke<boolean>('verify_collection_pin', {
        id: verifyChangePinModal.col.id,
        pin: verifyChangePinInput,
      });
      if (verified) {
        const targetCol = verifyChangePinModal.col;
        setVerifyChangePinModal(null);
        setVerifyChangePinInput('');
        setVerifyChangePinError('');
        // After correct entry, show the change password pop-up!
        setPinModal({ col: targetCol, mode: 'change' });
        setPinModalInput('');
        setPinModalConfirm('');
        setPinModalError('');
      } else {
        setVerifyChangePinError('Incorrect passcode. Please try again.');
      }
    } catch (err) {
      console.error('Failed to verify current passcode:', err);
      setVerifyChangePinError('Failed to verify passcode');
    }
  };

  const handleSetPinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pinModal) return;
    if (!pinModalInput || pinModalInput.length < 4) {
      setPinModalError('Passcode must be at least 4 characters');
      return;
    }
    if (pinModalInput !== pinModalConfirm) {
      setPinModalError('Passcodes do not match');
      return;
    }
    try {
      if (pinModal.mode === 'change') {
        await invoke('change_collection_pin', { id: pinModal.col.id, pin: pinModalInput });
        setPinModal(null);
        setPinModalInput('');
        setPinModalConfirm('');
        setPinModalError('');
        fetchCollections();
      } else {
        const targetCol = pinModal.col;
        const recoveryCode = await invoke<string>('set_collection_pin', { id: targetCol.id, pin: pinModalInput });
        setPinModal(null);
        setPinModalInput('');
        setPinModalConfirm('');
        setPinModalError('');
        setRecoveryCopied(false);
        setRecoveryCodeModal({ col: targetCol, code: recoveryCode, isReset: false });
        fetchCollections();
      }
    } catch (err) {
      console.error('Failed to set PIN:', err);
      setPinModalError('Failed to save passcode');
    }
  };

  const handleResetPasscodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPasscodeModal) return;
    if (!resetRecoveryCodeInput.trim()) {
      setResetPasscodeError('Please enter your recovery code');
      return;
    }
    if (!resetNewPinInput || resetNewPinInput.length < 4) {
      setResetPasscodeError('New passcode must be at least 4 characters');
      return;
    }
    if (resetNewPinInput !== resetConfirmPinInput) {
      setResetPasscodeError('New passcodes do not match');
      return;
    }
    try {
      const targetCol = resetPasscodeModal.col;
      const newRecoveryCode = await invoke<string>('reset_collection_passcode', {
        id: targetCol.id,
        recoveryCode: resetRecoveryCodeInput.trim(),
        newPin: resetNewPinInput,
      });
      const nextUnlocked = new Set(unlockedCollectionIdsRef.current).add(targetCol.id);
      unlockedCollectionIdsRef.current = nextUnlocked;
      setUnlockedCollectionIds(nextUnlocked);
      setResetPasscodeModal(null);
      setResetRecoveryCodeInput('');
      setResetNewPinInput('');
      setResetConfirmPinInput('');
      setResetPasscodeError('');
      setRecoveryCopied(false);
      setRecoveryCodeModal({ col: targetCol, code: newRecoveryCode, isReset: true });
      await fetchCollections();
      await fetchItems(undefined, nextUnlocked);
    } catch (err: any) {
      console.error('Failed to reset passcode:', err);
      const msg = typeof err === 'string' ? err : err?.message || 'Invalid recovery code. Please check and try again.';
      setResetPasscodeError(msg.includes('Invalid recovery code') ? 'Invalid recovery code. Please check and try again.' : msg);
    }
  };

  const handleUnlockPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentCollectionId || !pinInput) return;
    try {
      const verified = await invoke<boolean>('verify_collection_pin', {
        id: currentCollectionId,
        pin: pinInput,
      });
      if (verified) {
        const nextUnlocked = new Set(unlockedCollectionIdsRef.current).add(currentCollectionId);
        unlockedCollectionIdsRef.current = nextUnlocked;
        setUnlockedCollectionIds(nextUnlocked);
        setPinInput('');
        setPinError(false);
        await fetchItems(undefined, nextUnlocked);
      } else {
        setPinError(true);
      }
    } catch (err) {
      console.error('PIN verification error:', err);
      setPinError(true);
    }
  };

  const handleRemovePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!removePinModal || !removePinInput) return;
    try {
      const verified = await invoke<boolean>('verify_collection_pin', {
        id: removePinModal.col.id,
        pin: removePinInput,
      });
      if (verified) {
        await invoke('remove_collection_pin', { id: removePinModal.col.id });
        const nextUnlocked = new Set(unlockedCollectionIdsRef.current).add(removePinModal.col.id);
        unlockedCollectionIdsRef.current = nextUnlocked;
        setUnlockedCollectionIds(nextUnlocked);
        setRemovePinModal(null);
        setRemovePinInput('');
        setRemovePinError('');
        await fetchCollections();
        await fetchItems(undefined, nextUnlocked);
      } else {
        setRemovePinError('Incorrect passcode. Please try again.');
      }
    } catch (err) {
      console.error('Failed to verify/remove passcode:', err);
      setRemovePinError('Failed to verify passcode');
    }
  };

  const actionHandlers: ClipActionHandlers = {
    onPaste: (item, plainText, transform) => handlePaste(item, plainText, transform),
    onTogglePin: (item) => handleTogglePin(item),
    onCopy: (item) => handleCopyOnly(item),
    onDelete: (item) => handleDelete(item),
    onQueue: (item) => handleQueueClip(item),
    onExtractOcr: (item) => handleExtractOrCopyOcr(item),
    onAddToCollection: () => handleOpenAddToCollection(),
    onRemoveFromCollection: (item) => handleRemoveFromCollection(item),
    isInCollection: isCollection,
  };

  const modalActions = selectedItem ? getActionsForClip(selectedItem, null, actionHandlers) : [];
  const pasteActions = selectedItem ? getPasteActionsForClip(selectedItem, null, actionHandlers) : [];

  // Frame-locked arrow navigation: rapid key auto-repeat accumulates into
  // at most one index step per animation frame, so holding an arrow key
  // produces smooth continuous scrolling instead of bursts/jumps.
  const navAccumRef = useRef(0);
  const navRafRef = useRef<number | null>(null);

  const flushNavAccum = () => {
    navRafRef.current = null;
    const steps = navAccumRef.current;
    if (steps === 0) return;
    navAccumRef.current = 0;
    setSelectedIndex((prev) => {
      if (items.length === 0) return prev;
      const next = (prev + steps) % items.length;
      return next < 0 ? next + items.length : next;
    });
  };

  useEffect(() => () => {
    if (navRafRef.current !== null) cancelAnimationFrame(navRafRef.current);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent | KeyboardEvent) => {
    // Global hotkey toggles (Ctrl+Alt+X hides enlarged, Ctrl+Shift+Z switches to overlay)
    if (matchesHotkeyCombo(e, hotkeys.enlarged || 'Ctrl+Alt+X')) {
      e.preventDefault();
      e.stopPropagation();
      if (window.__carbonRequestEnlargedHide) {
        window.__carbonRequestEnlargedHide();
      } else {
        invoke('hide_enlarged').catch(console.error);
      }
      return;
    }
    if (matchesHotkeyCombo(e, hotkeys.overlay || 'Ctrl+Shift+Z')) {
      e.preventDefault();
      e.stopPropagation();
      invoke('toggle_overlay').catch(console.error);
      return;
    }

    // Snippets view owns its own keyboard handling.
    if (viewMode === 'snippets') return;

    const target = e.target as HTMLElement;
    const isTextarea = target && target.tagName === 'TEXTAREA';
    const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

    // If typing inside textarea (e.g. edit section in preview), do not hijack Enter, Shift+Enter, or navigation
    if (isTextarea) {
      if (e.key === 'Escape') {
        (target as HTMLTextAreaElement).blur();
      }
      return;
    }

    // Priority: Shift+Enter queues currently selected item(s) when not typing in textarea
    if (!isTextarea && e.shiftKey && e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setActionPanelOpen(false);
      setPasteMenuOpen(false);
      if (selectedIds.size > 1) {
        handleQueueBulk();
      } else if (selectedItem) {
        handleQueueClip(selectedItem);
      }
      return;
    }

    // Quick Q key to queue when not typing inside an input field
    if (!isInput && (e.key === 'q' || e.key === 'Q') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setActionPanelOpen(false);
      setPasteMenuOpen(false);
      if (selectedIds.size > 1) {
        handleQueueBulk();
      } else if (selectedItem) {
        handleQueueClip(selectedItem);
      }
      return;
    }

    if (actionPanelOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActionIndex((prev) => (prev + 1) % modalActions.length);
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActionIndex((prev) => (prev - 1 + modalActions.length) % modalActions.length);
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setActionPanelOpen(false);
        return;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const act = modalActions[actionIndex];
        if (act) {
          act.handler();
          setActionPanelOpen(false);
        }
        return;
      }

      // If user triggers any shortcut while Ctrl+K modal is open, execute and close modal
      if (selectedItem && selectedIds.size <= 1 && handleClipKeyDown(e, selectedItem, actionHandlers)) {
        setActionPanelOpen(false);
        setPasteMenuOpen(false);
        return;
      }
    }

    // Ctrl+A select all items
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !isInput) {
      e.preventDefault();
      handleSelectAll();
      return;
    }

    // Delete / Del key for single or bulk delete. While focus sits in an
    // input, only bail when there is actually text to edit — an empty
    // search bar must not swallow Delete (same reliability rule as the
    // Quick Overlay).
    if (e.key === 'Delete' || e.key === 'Del') {
      if (isInput) {
        const el = target as HTMLInputElement;
        const hasText = (el.value?.length ?? 0) > 0;
        const hasSelection = (el.selectionStart ?? 0) !== (el.selectionEnd ?? 0);
        if (hasText || hasSelection) return;
      }
      if (selectedIds.size > 1) {
        e.preventDefault();
        setBulkConfirmDelete(true);
        return;
      }
    }

    // Enter to paste: if in search input, allow pressing Enter to paste selected item
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (selectedItem && selectedIds.size <= 1) {
        e.preventDefault();
        handlePaste(selectedItem, false);
        return;
      }
    }

    // Focused long-image scroll: after clicking the preview image, Up/Down
    // scroll inside it instead of jumping clips. At the scroll edge the key
    // is consumed (hard stop) — the preview stays put so an overshoot never
    // swaps the whole capture. Esc (or picking another clip) releases focus.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && imgFocused && imgWrapperRef.current && selectedItem?.content_type === 'image') {
      const el = imgWrapperRef.current;
      const step = Math.max(120, Math.round(el.clientHeight * 0.6)) * (e.key === 'ArrowDown' ? 1 : -1);
      const canScroll =
        e.key === 'ArrowDown'
          ? el.scrollTop + el.clientHeight < el.scrollHeight - 2
          : el.scrollTop > 2;
      e.preventDefault();
      if (canScroll) {
        el.scrollBy({ top: step });
      }
      return;
    }

    // Focused rich/markdown preview scroll: after clicking inside the
    // rendered document, Up/Down scroll it instead of jumping clips. Same
    // hard stop at the edge — focus stays until Esc or another selection.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && previewFocused && previewRenderRef.current) {
      const el = previewRenderRef.current;
      const step = Math.max(120, Math.round(el.clientHeight * 0.6)) * (e.key === 'ArrowDown' ? 1 : -1);
      const canScroll =
        e.key === 'ArrowDown'
          ? el.scrollTop + el.clientHeight < el.scrollHeight - 2
          : el.scrollTop > 2;
      e.preventDefault();
      if (canScroll) {
        el.scrollBy({ top: step });
      }
      return;
    }

    // Focused long-image scroll (horizontal): after clicking the preview
    // image, Left/Right pan inside it instead of jumping clips. Hard stop
    // at the edge, same as vertical. Only applies while focused — unfocused
    // Left/Right keeps the "slider" list navigation in the block below.
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && imgFocused && imgWrapperRef.current && selectedItem?.content_type === 'image') {
      const el = imgWrapperRef.current;
      const step = Math.max(120, Math.round(el.clientWidth * 0.6)) * (e.key === 'ArrowRight' ? 1 : -1);
      const canScroll =
        e.key === 'ArrowRight'
          ? el.scrollLeft + el.clientWidth < el.scrollWidth - 2
          : el.scrollLeft > 2;
      e.preventDefault();
      if (canScroll) {
        el.scrollBy({ left: step });
      }
      return;
    }

    // Focused rich/markdown preview scroll (horizontal): after clicking
    // inside the rendered document, Left/Right pan wide tables and diagrams
    // instead of jumping clips. Hard stop at the edge, same as vertical.
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && previewFocused && previewRenderRef.current) {
      const el = previewRenderRef.current;
      const step = Math.max(120, Math.round(el.clientWidth * 0.6)) * (e.key === 'ArrowRight' ? 1 : -1);
      const canScroll =
        e.key === 'ArrowRight'
          ? el.scrollLeft + el.clientWidth < el.scrollWidth - 2
          : el.scrollLeft > 2;
      e.preventDefault();
      if (canScroll) {
        el.scrollBy({ left: step });
      }
      return;
    }

    // Arrow navigation works anywhere (frame-locked for smooth holds).
    // Left/Right swap the selected clip too (wrapping) — same "slider"
    // interaction as the Quick Overlay previews and the snippets view.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      setImgFocused(false);
      setPreviewFocused(false);
      e.preventDefault();
      if (items.length > 0) {
        navAccumRef.current += e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
        if (navRafRef.current === null) {
          navRafRef.current = requestAnimationFrame(flushNavAccum);
        }
      }
      return;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (items.length > 0) {
        setActionIndex(0);
        setActionPanelOpen(true);
      }
      return;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Hierarchical Esc: a focused preview is an inner mode, so the first
      // Esc only releases focus (arrows navigate again) instead of hiding
      // the window — same as exiting zoom before exiting a viewer.
      if (imgFocused || previewFocused) {
        setImgFocused(false);
        setPreviewFocused(false);
        return;
      }
      if (isInput) {
        target.blur();
        return;
      }
      if (bulkConfirmDelete) {
        setBulkConfirmDelete(false);
        return;
      }
      if (selectedIds.size > 1) {
        setSelectedIds(new Set());
        return;
      }
      setPasteMenuOpen(false);
      if (window.__carbonRequestEnlargedHide) {
        window.__carbonRequestEnlargedHide();
      } else {
        invoke('hide_enlarged').catch(console.error);
      }
      return;
    }

    // Clip actions
    if (selectedItem && selectedIds.size <= 1 && handleClipKeyDown(e, selectedItem, actionHandlers)) {
      setActionPanelOpen(false);
      setPasteMenuOpen(false);
      return;
    }
  };

  const handleKeyDownRef = useRef<(e: React.KeyboardEvent | KeyboardEvent) => void>(() => {});
  handleKeyDownRef.current = handleKeyDown;

  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      handleKeyDownRef.current(e);
    };
    window.addEventListener('keydown', onGlobalKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown, true);
    };
  }, []);

  return (
    <div
      className="enlarged"
      tabIndex={0}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
    >
      {/* Sidebar */}
      <div
        ref={sidebarRef}
        className="sidebar"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
      >
        <div className="brand">
          <div className="brand-mark brand-badge" title="Carbon">
            <BrandBadgeIcon className="brand-badge-svg" />
          </div>
          <span className="brand-name hide-when-collapsed">Carbon</span>
        </div>

        <button
          className={`side-item ${selectedFilter === 'all' ? 'active' : ''}`}
          onClick={() => handleSelectFilter('all')}
          title="All items"
        >
          <span className="side-ic">
            <AllIcon />
          </span>
          <span className="hide-when-collapsed">All items</span>
          <span className="count hide-when-collapsed">{counts.all || 0}</span>
        </button>

        <button
          className={`side-item ${selectedFilter === 'pinned' ? 'active' : ''}`}
          onClick={() => handleSelectFilter('pinned')}
          title="Favorites"
        >
          <span className="side-ic" style={{ color: '#F59E0B' }}>
            <StarIcon filled={selectedFilter === 'pinned'} />
          </span>
          <span className="hide-when-collapsed">Favorites</span>
          <span className="count hide-when-collapsed">{counts.pinned || 0}</span>
        </button>

        <div className="side-label">Types</div>

        <button
          className={`side-item ${selectedFilter === 'text' ? 'active' : ''}`}
          onClick={() => handleSelectFilter('text')}
          title="Text"
        >
          <span className="side-ic" style={{ color: 'var(--tint-text)' }}>
            <TextIcon />
          </span>
          <span className="hide-when-collapsed">Text</span>
          <span className="count hide-when-collapsed">{counts.text || 0}</span>
        </button>

        <button
          className={`side-item ${selectedFilter === 'code' ? 'active' : ''}`}
          onClick={() => handleSelectFilter('code')}
          title="Code"
        >
          <span className="side-ic" style={{ color: 'var(--tint-code)' }}>
            <CodeIcon />
          </span>
          <span className="hide-when-collapsed">Code</span>
          <span className="count hide-when-collapsed">{counts.code || 0}</span>
        </button>

        <button
          className={`side-item ${selectedFilter === 'rich_text' ? 'active' : ''}`}
          onClick={() => handleSelectFilter('rich_text')}
          title="Rich text"
        >
          <span className="side-ic" style={{ color: 'var(--tint-rich)' }}>
            <RichTextIcon />
          </span>
          <span className="hide-when-collapsed">Rich text</span>
          <span className="count hide-when-collapsed">{counts.rich_text || 0}</span>
        </button>

        <button
          className={`side-item ${selectedFilter === 'image' ? 'active' : ''}`}
          onClick={() => handleSelectFilter('image')}
          title="Images"
        >
          <span className="side-ic" style={{ color: 'var(--tint-image)' }}>
            <ImageIcon />
          </span>
          <span className="hide-when-collapsed">Images</span>
          <span className="count hide-when-collapsed">{counts.image || 0}</span>
        </button>

        <button
          className={`side-item ${selectedFilter === 'file' ? 'active' : ''}`}
          onClick={() => handleSelectFilter('file')}
          title="Files"
        >
          <span className="side-ic" style={{ color: 'var(--tint-files)' }}>
            <FilesIcon />
          </span>
          <span className="hide-when-collapsed">Files</span>
          <span className="count hide-when-collapsed">{counts.file || 0}</span>
        </button>

        <button
          className={`side-item ${selectedFilter === 'link' ? 'active' : ''}`}
          onClick={() => handleSelectFilter('link')}
          title="Links"
        >
          <span className="side-ic" style={{ color: 'var(--tint-link)' }}>
            <LinksIcon />
          </span>
          <span className="hide-when-collapsed">Links</span>
          <span className="count hide-when-collapsed">{counts.link || 0}</span>
        </button>

        <button
          className={`side-item ${selectedFilter === 'email' ? 'active' : ''}`}
          onClick={() => handleSelectFilter('email')}
          title="Email"
        >
          <span className="side-ic" style={{ color: 'var(--tint-email)' }}>
            <EmailIcon />
          </span>
          <span className="hide-when-collapsed">Email</span>
          <span className="count hide-when-collapsed">{counts.email || 0}</span>
        </button>

        <button
          className={`side-item ${selectedFilter === 'color' ? 'active' : ''}`}
          onClick={() => handleSelectFilter('color')}
          title="Colors"
        >
          <span className="side-ic" style={{ color: 'var(--tint-color)' }}>
            <ColorsIcon />
          </span>
          <span className="hide-when-collapsed">Colors</span>
          <span className="count hide-when-collapsed">{counts.color || 0}</span>
        </button>

        {showSnippets && (
          <>
            {/* Snippets Section Header */}
            <div className="side-section-header">
              <span className="side-section-title hide-when-collapsed">Snippets</span>
              <button
                className="side-add-btn"
                title="Create new snippet"
                onClick={() => {
                  setSelectedFilter('__snippets__');
                  setViewMode('snippets');
                  setSnippetCreateSignal((n) => n + 1);
                }}
              >
                <PlusIcon size={12} />
              </button>
            </div>

            <button
              className={`side-item ${viewMode === 'snippets' ? 'active' : ''}`}
              onClick={() => {
                // Deactivate every clips-mode highlight so only the Snippets
                // tab is lit while this section is open.
                setSelectedFilter('__snippets__');
                setViewMode('snippets');
              }}
          title="Snippets"
        >
          <span className="side-ic" style={{ color: 'var(--accent-text)' }}>
            <SnippetIcon />
          </span>
          <span className="hide-when-collapsed">Snippets</span>
          <span className="count hide-when-collapsed">{snippetsCount}</span>
        </button>
          </>
        )}

        {/* Collections Section Header */}
        <div className="side-section-header">
          <span className="side-section-title hide-when-collapsed">Collections</span>
          <button
            className="side-add-btn"
            title="Create new collection"
            onClick={() => {
              setNewColName('');
              setCreateColModalOpen(true);
            }}
          >
            <PlusIcon size={12} />
          </button>
        </div>

        <div
          className="side-collections-list"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
        >
          {collections.map((col) => {
            const isColActive = selectedFilter === `col_${col.id}`;
            const isColLocked = col.is_locked && !unlockedCollectionIds.has(col.id);
            const isDropTarget = dropTargetColId === col.id;

            return (
              <div
                key={col.id}
                role="button"
                tabIndex={0}
                className={`side-item collection-item ${isColActive ? 'active' : ''} ${isDropTarget ? 'drop-target' : ''}`}
                onClick={() => handleSelectFilter(`col_${col.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelectFilter(`col_${col.id}`);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setColContextMenu({
                    x: Math.min(e.clientX, window.innerWidth - 240),
                    y: Math.min(e.clientY, window.innerHeight - 300),
                    col,
                  });
                }}
                onDragEnter={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'copy';
                  setDropTargetColId(col.id);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'copy';
                  if (dropTargetColId !== col.id) {
                    setDropTargetColId(col.id);
                  }
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                  if (dropTargetColId === col.id) {
                    setDropTargetColId(null);
                  }
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTargetColId(null);
                  let ids: string[] = window.__carbonDraggingClipIds || (selectedIds.size > 1 ? Array.from(selectedIds) : (draggingId ? [draggingId] : []));
                  if (!ids || ids.length === 0) {
                    try {
                      const carbonData = e.dataTransfer.getData('carbon/clip-ids');
                      if (carbonData) ids = JSON.parse(carbonData);
                    } catch {}
                  }
                  if (!ids || ids.length === 0) {
                    try {
                      const json = e.dataTransfer.getData('application/json');
                      if (json) {
                        const parsed = JSON.parse(json);
                        if (parsed.ids) ids = parsed.ids;
                        else if (parsed.clipId) ids = [parsed.clipId];
                      }
                    } catch {}
                  }
                  if (!ids || ids.length === 0) {
                    try {
                      const textData = e.dataTransfer.getData('text/plain');
                      if (textData) {
                        const match = items.find((i) => i.id === textData || i.text_content === textData || i.title === textData);
                        if (match) ids = [match.id];
                      }
                    } catch {}
                  }
                  if (ids && ids.length > 0) {
                    await handleAddClipsToCollection(ids, col.id);
                    setSelectedFilter(`col_${col.id}`);
                  }
                  window.__carbonDraggingClipIds = null;
                  setDraggingId(null);
                }}
                title={col.name}
              >
                <span className={`side-ic col-side-ic ${col.is_locked ? 'has-lock-state' : ''}`} style={{ color: normalizeCollectionColor(col.color) || collectionColorFor(col.name) }}>
                  {col.is_locked ? (
                    isColLocked ? (
                      <>
                        <FolderIcon className="folder-default-glyph" />
                        <LockIcon className="lock-hover-glyph" />
                      </>
                    ) : (
                      <>
                        <FolderIcon className="folder-default-glyph" />
                        <UnlockIcon className="lock-hover-glyph" />
                      </>
                    )
                  ) : (
                    <FolderIcon />
                  )}
                </span>
                <span className="hide-when-collapsed collection-name">{col.name}</span>
                <div className="collection-meta hide-when-collapsed">
                  <span className="count">{col.item_count}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="side-footer">
          <button
            className="side-item"
            onClick={onOpenSettings}
            title="Settings"
          >
            <span className="side-ic">
              <SettingsIcon />
            </span>
            <span className="hide-when-collapsed">Settings</span>
          </button>
          <button
            className="side-collapse"
            title="Toggle sidebar"
            onClick={toggleSidebar}
          >
            <ChevronLeftIcon className="icon chev" />
          </button>
        </div>
      </div>

      {/* Snippets view replaces the clip browser entirely when active */}
      {viewMode === 'snippets' && showSnippets ? (
        <SnippetsView createSignal={snippetCreateSignal} initialSnippets={snippetsCache} />
      ) : (
        <>
          {/* Main Content Area */}
          <div className="enlarged-main">
        {isCurrentCollectionLocked ? (
          <div className="col-locked-screen">
            <div className="col-locked-card">
              <div className="col-locked-icon">
                <LockIcon />
              </div>
              <h3 className="col-locked-title">{currentCollection?.name || 'Collection'} is Locked</h3>
              <p className="col-locked-subtitle">Enter your passcode to unlock and view its clips</p>

              <form onSubmit={handleUnlockPin} className="col-pin-form">
                <div className="pin-input-group">
                  <input
                    type="password"
                    className={`passcode-input ${pinError ? 'input-error pin-error' : ''}`}
                    placeholder="••••"
                    maxLength={12}
                    value={pinInput}
                    onChange={(e) => {
                      setPinInput(e.target.value);
                      setPinError(false);
                    }}
                    autoFocus
                  />
                </div>
                {pinError && <div className="pin-error-msg">Incorrect passcode. Try again.</div>}
                <div className="col-pin-actions">
                  <button type="submit" className="btn primary" disabled={!pinInput}>
                    Unlock Collection
                  </button>
                </div>
              </form>

              <div className="col-locked-footer-links">
                <button
                  type="button"
                  className="col-forgot-pin-link"
                  onClick={() => {
                    if (currentCollection) {
                      setResetPasscodeModal({ col: currentCollection });
                      setResetRecoveryCodeInput('');
                      setResetNewPinInput('');
                      setResetConfirmPinInput('');
                      setResetPasscodeError('');
                    }
                  }}
                >
                  Forgot passcode?
                </button>
                <span className="col-footer-sep">•</span>
                <button
                  type="button"
                  className="col-forgot-pin-link subtle"
                  onClick={() => {
                    if (currentCollection) {
                      setRemovePinModal({ col: currentCollection });
                      setRemovePinInput('');
                      setRemovePinError('');
                    }
                  }}
                >
                  Remove lock
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="main-top">
              <div className="searchbar">
                <span className="search-ic">
                  <SearchIcon />
                </span>
                {sourceAppFilter && (
                  <span className="search-app-pill" title={`Filtered by ${sourceAppFilter}`}>
                    {appDisplayName(sourceAppFilter)}
                    <button
                      className="search-app-pill-x"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSourceAppFilter(null);
                      }}
                      title="Clear application filter"
                    >
                      ✕
                    </button>
                  </span>
                )}
                <input
                  ref={searchInputRef}
                  className={sourceAppFilter ? 'has-filter-pill' : ''}
                  placeholder="Search clipboard..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    className="searchbar-clear-btn"
                    onClick={() => setSearch('')}
                    title="Clear search query"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="total">{items.length} {items.length === 1 ? 'item' : 'items'}</div>
            </div>

            {pasteQueue.length > 0 && (
              <div className="queue-banner" style={{ margin: '0 16px 14px 16px' }}>
                <div className="queue-banner-left">
                  <span className="queue-tag">Queue ({pasteQueue.length})</span>
                  <span className="queue-dot">·</span>
                  <div className="queue-next-meta" title={pasteQueue[0]?.title}>
                    <span>Next:</span>
                    <span className="queue-next-title">{constrainTitle(pasteQueue[0]?.title || '', 42)}</span>
                  </div>
                </div>
                <div className="queue-banner-right">
                  <span className="queue-auto-hint">Ctrl+V pastes in order</span>
                  <button
                    className="queue-clear-btn"
                    title="Clear paste queue (Esc)"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClearQueue();
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

            {/* Items List */}
            <div className="main-list">
              {items.length === 0 ? (
                initialLoaded ? (
                  <div className="empty">
                    <div className="big">No entries found</div>
                    <div className="sub">Nothing matched your current filter and search query</div>
                  </div>
                ) : null
              ) : (
                (() => {
                  const groups = dateGroups;
                  let globalIdx = 0;

                  return groups.map((group) => (
                    <div key={group.label} className="date-group">
                      <div className="date-group-label">{group.label}</div>
                      {group.items.map((item) => {
                        const currentIdx = globalIdx++;
                        const isMultiSelected = selectedIds.has(item.id);
                        const isSelected = selectedIds.size > 1 ? isMultiSelected : (selectedIndex === currentIdx || selectedItem?.id === item.id);
                        const queueIdx = pasteQueue.findIndex((q) => q.id === item.id);

                        return (
                          <EnlargedRow
                            key={item.id}
                            item={item}
                            index={currentIdx}
                            isSelected={isSelected}
                            isMultiSelected={selectedIds.size > 1 && isMultiSelected}
                            isDragging={draggingId === item.id}
                            queueIdx={queueIdx}
                            onRowClick={handleRowClick}
                            onDragStart={handleDragStart}
                            onDragEnd={handleDragEnd}
                          />
                        );
                      })}
                    </div>
                  ));
                })()
              )}
            </div>
          </>
        )}
      </div>

      {/* Type-Specific Preview Pane or Bulk Action Pane */}
      <div className={`preview ${!isCurrentCollectionLocked && (selectedItem || selectedIds.size > 1) ? 'open' : ''}`}>
        {!isCurrentCollectionLocked && (
          selectedIds.size > 1 ? (
            <div className="preview-inner bulk-preview-panel">
            <div className="preview-head">
              <span className="preview-kind" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                <span style={{ fontSize: 15, marginRight: 6 }}>📦</span>
                {selectedIds.size} items selected
              </span>
              <div className="preview-actions">
                <button className="act" title="Deselect All (Esc)" onClick={handleClearSelection}>
                  ✕
                </button>
              </div>
            </div>

            <div className="preview-body" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {bulkConfirmDelete ? (
                <div className="bulk-confirm-box">
                  <div className="bulk-confirm-title">
                    ⚠️ Delete {selectedIds.size} items?
                  </div>
                  <div className="bulk-confirm-desc">
                    This will permanently remove all {selectedIds.size} selected items from your clipboard history.
                  </div>
                  <div className="bulk-confirm-actions">
                    <button className="btn subtle" onClick={() => setBulkConfirmDelete(false)}>
                      Cancel
                    </button>
                    <button className="btn danger" onClick={handleBulkDelete}>
                      Confirm Delete ({selectedIds.size})
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bulk-action-content">
                  <div className="bulk-buttons-row">
                    <button className="btn subtle" onClick={() => setAddToColModalOpen(true)}>
                      <FolderIcon />
                      <span>Add to Collection ({selectedIds.size})</span>
                    </button>
                    <button className="btn subtle" onClick={handleQueueBulk}>
                      <QueueIcon />
                      <span>Queue all ({selectedIds.size})</span>
                    </button>
                    <button className="btn subtle" onClick={handleBulkPin}>
                      <StarIcon filled={items.filter(i => selectedIds.has(i.id)).length > 0 && items.filter(i => selectedIds.has(i.id)).every(i => i.is_pinned)} />
                      <span>{items.filter(i => selectedIds.has(i.id)).length > 0 && items.filter(i => selectedIds.has(i.id)).every(i => i.is_pinned) ? 'Unstar all' : 'Star all'}</span>
                    </button>
                    <button className="btn subtle" onClick={handleBulkCopy}>
                      <CopyIcon />
                      <span>Copy all text</span>
                    </button>
                    <button className="btn danger" onClick={() => setBulkConfirmDelete(true)}>
                      <DeleteIcon />
                      <span>Delete {selectedIds.size} items</span>
                    </button>
                  </div>

                  <div className="bulk-items-summary">
                    <div className="bulk-summary-header">
                      <span className="bulk-summary-heading">Selected entries ({selectedIds.size})</span>
                      <span className="bulk-summary-meta">
                        {formatBytes(items.filter(i => selectedIds.has(i.id)).reduce((acc, curr) => acc + (curr.file_size || 0), 0))}
                      </span>
                    </div>

                    <div className="bulk-items-list">
                      {items.filter(i => selectedIds.has(i.id)).map(item => {
                        const tint = getTypeColor(item.content_type);
                        return (
                          <div key={item.id} className="bulk-item-card">
                            <div
                              className="bulk-card-icon"
                              style={{
                                background: `color-mix(in srgb, ${tint} 16%, transparent)`,
                                color: tint,
                              }}
                            >
                              {getTypeIcon(item.content_type)}
                            </div>
                            <div className="bulk-card-body">
                              <div className="bulk-card-title">
                                {item.is_pinned && <span style={{ color: '#F59E0B', marginRight: 4 }}>★</span>}
                                {item.is_sensitive ? 'Sensitive Clip' : constrainTitle(item.title, 42)}
                              </div>
                              <div className="bulk-card-sub">
                                <span className="bulk-card-type">{getSpecificTypeLabel(item)}</span>
                                <span className="bulk-card-dot">·</span>
                                <span>{formatTimeAgo(item.created_at)}</span>
                                {item.file_size > 0 && (
                                  <>
                                    <span className="bulk-card-dot">·</span>
                                    <span>{formatBytes(item.file_size)}</span>
                                  </>
                                )}
                              </div>
                            </div>
                            <button
                              className="bulk-card-remove"
                              title="Deselect this item"
                              onClick={(e) => {
                                e.stopPropagation();
                                const next = new Set(selectedIds);
                                next.delete(item.id);
                                setSelectedIds(next);
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="preview-foot">
              <CheckIcon />
              {selectedIds.size} items selected · Press Del to delete batch, Esc to deselect
            </div>
          </div>
        ) : selectedItem ? (
          <div className="preview-inner">
            <div className="preview-head">
              <span className="preview-kind" style={{ color: activeTint }}>
                {getTypeIcon(selectedItem.content_type)}
                {getSpecificTypeLabel(selectedItem)}
              </span>
              {selectedItem &&
                (selectedItem.content_type === 'rich_text' ||
                  (Boolean(selectedItem.text_content) && isMarkdownContent(selectedItem.text_content!))) && (
                <div className="seg" style={{ marginRight: 4 }}>
                  <button
                    className={`seg-btn ${renderMode ? 'active' : ''}`}
                    onClick={() => setRenderMode(true)}
                  >
                    Render
                  </button>
                  <button
                    className={`seg-btn ${!renderMode ? 'active' : ''}`}
                    onClick={() => setRenderMode(false)}
                  >
                    Raw
                  </button>
                </div>
              )}
              <div className="preview-actions">
                <div className="paste-dropdown-wrapper">
                  <button
                    className="act"
                    title="Paste options"
                    onClick={() => setPasteMenuOpen(!pasteMenuOpen)}
                  >
                    <HollowClipboardIcon />
                  </button>
                  {pasteMenuOpen && (
                    <div className="paste-dropdown-menu">
                      {pasteActions.map((act) => (
                        <div
                          key={act.id}
                          className="paste-menu-item"
                          onClick={() => {
                            act.handler();
                            setPasteMenuOpen(false);
                          }}
                        >
                          <span>{act.label}</span>
                          {act.shortcut ? <span className="key">{act.shortcut}</span> : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  className="act"
                  title="Add to paste queue (Shift+Enter)"
                  onClick={() => handleQueueClip(selectedItem)}
                >
                  <QueueIcon />
                </button>
                {selectedItem.content_type === 'image' && (
                  <button
                    className="act"
                    title={selectedItem.ocr_text ? 'Copy extracted text (Ctrl+Shift+T)' : 'Extract text with OCR (Ctrl+Shift+T)'}
                    onClick={() => handleExtractOrCopyOcr(selectedItem)}
                  >
                    <OcrIcon />
                  </button>
                )}
                <button
                  className="act"
                  title={selectedItem.is_pinned ? 'Unstar' : 'Star'}
                  onClick={() => handleTogglePin(selectedItem)}
                >
                  <StarIcon filled={selectedItem.is_pinned} />
                </button>
                <button className="act" title="Copy" onClick={() => handleCopyOnly(selectedItem)}>
                  <CopyIcon />
                </button>
                <button className="act danger" title="Delete" onClick={() => handleDelete(selectedItem)}>
                  <DeleteIcon />
                </button>
              </div>
            </div>

            <div className="preview-body">
              {/* Image Preview */}
              {selectedItem.content_type === 'image' && selectedItem.image_path ? (
                <div className="preview-media">
                  <div
                    ref={imgWrapperRef}
                    className={`preview-image-wrapper ${zoom100 ? 'zoomed' : ''} ${imgFocused ? 'img-focused' : ''}`}
                    tabIndex={0}
                    title={imgFocused ? 'Focused — arrow keys scroll the image (Esc to release)' : 'Click to focus, then arrow keys scroll'}
                    onClick={() => setImgFocused(true)}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                  >
                    <img
                      src={imageDataUrl || convertFileSrc(selectedItem.image_path)}
                      alt="Clipboard image preview"
                      className={zoom100 ? 'zoom-100' : ''}
                      draggable={false}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!hasDraggedRef.current) {
                          setZoom100(!zoom100);
                        }
                        hasDraggedRef.current = false;
                      }}
                      title={zoom100 ? 'Click to fit or drag to pan' : 'Click for 100% zoom'}
                    />
                  </div>
                  <div className="set-hint">
                    {selectedItem.image_width} × {selectedItem.image_height} px · {formatBytes(selectedItem.file_size)}
                  </div>
                  <div style={{ display: 'flex', gap: 6, width: '100%', justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button className="btn subtle" onClick={() => setZoom100(!zoom100)}>
                      {zoom100 ? 'Fit to pane' : '100% Zoom'}
                    </button>
                    <button className="btn subtle" onClick={() => handleCopyOnly(selectedItem)}>
                      Copy Image
                    </button>
                    {selectedItem.qr_content && (
                      <button className="btn subtle" onClick={() => handleCopyDecodedQr(selectedItem)}>
                        <CopyIcon /> {getQrCopyLabel(selectedItem.qr_content)}
                      </button>
                    )}
                    <button className="btn subtle" onClick={() => handleExtractOrCopyOcr(selectedItem)}>
                      <OcrIcon /> {selectedItem.ocr_text ? 'Copy Extracted Text' : 'Extract Text (OCR)'}
                    </button>
                  </div>
                </div>
              ) : selectedItem.content_type === 'file' ? (
                /* File / Video Preview */
                <div className="preview-media">
                  {selectedItem.is_video && selectedItem.text_content ? (
                    <div className="preview-video-wrapper">
                      <video controls src={convertFileSrc(selectedItem.text_content.split('\n')[0])} />
                    </div>
                  ) : null}

                  <div className="preview-file-card">
                    <div className="preview-file-title">{selectedItem.title}</div>
                    <div className="preview-file-meta">
                      Size: {formatBytes(selectedItem.file_size)}
                    </div>
                    {selectedItem.text_content && (
                      <div className="preview-file-meta mono" style={{ wordBreak: 'break-all' }}>
                        {selectedItem.text_content}
                      </div>
                    )}
                    {selectedItem.text_content && (
                      <button
                        className="btn subtle"
                        style={{ marginTop: 8 }}
                        onClick={() => handleRevealFile(selectedItem.text_content!.split('\n')[0])}
                      >
                        <FolderIcon /> Reveal in Explorer
                      </button>
                    )}
                  </div>
                </div>
              ) : (selectedItem.content_type === 'rich_text' ||
                  (Boolean(selectedItem.text_content) && isMarkdownContent(selectedItem.text_content!))) &&
                renderMode ? (
                /* Read-only RENDERED preview (Rich text & Markdown). Toggle to Raw to edit the source. */
                <div
                  className={`preview-render ${previewFocused ? 'preview-focused' : ''}`}
                  ref={previewRenderRef}
                  tabIndex={0}
                  title={previewFocused ? 'Focused — arrow keys scroll the document (Esc to release)' : 'Click to focus, then arrow keys scroll'}
                  onClick={() => setPreviewFocused(true)}
                >
                  <ClipPreview item={selectedItem} forceRaw={false} />
                </div>
              ) : (
                /* Editable Text / Code / Link / Email / Color Preview */
                <div style={{ padding: 14, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  {selectedItem.content_type === 'color' && (
                    <div
                      className="color-swatch-box"
                      style={{ background: selectedItem.title }}
                    >
                      {selectedItem.title}
                    </div>
                  )}

                  <textarea
                    className="preview-edit"
                    spellCheck={false}
                    value={editingContent}
                    onChange={(e) => handleContentEdit(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Escape') {
                        e.currentTarget.blur();
                      }
                    }}
                  />
                </div>
              )}
            </div>

            <ClipMetaStrip item={selectedItem} onFilterByApp={(app) => setSourceAppFilter(app)} />

            <div className="preview-foot">
              <CheckIcon />
              {selectedItem.content_type === 'image' || selectedItem.content_type === 'file'
                ? 'Press Enter to paste item'
                : renderMode && (selectedItem.content_type === 'rich_text' || (selectedItem.text_content && isMarkdownContent(selectedItem.text_content)))
                  ? 'Read-only rendered preview — Enter pastes this content'
                  : 'Edits save to history — Enter pastes this content'}
            </div>
          </div>
        ) : null)}
          </div>
        </>
      )}

      {/* Action Panel Modal Overlay (Ctrl+K) */}
      {actionPanelOpen && selectedItem && (
        <div className="action-modal-overlay" onClick={() => setActionPanelOpen(false)}>
          <div className="action-modal" onClick={(e) => e.stopPropagation()}>
            {modalActions.map((act, i) => (
              <div
                key={act.id}
                ref={i === actionIndex ? activeActionRef : undefined}
                className={`action-item ${i === actionIndex ? 'selected' : ''} ${act.danger ? 'danger' : ''}`}
                onClick={() => {
                  act.handler();
                  setActionPanelOpen(false);
                }}
                onMouseEnter={() => setActionIndex(i)}
              >
                <span className="action-item-left">
                  {act.icon} {act.label}
                </span>
                {act.shortcut ? <span className="key">{act.shortcut}</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create Collection Modal */}
      {createColModalOpen && (
        <div className="modal-backdrop" onClick={() => setCreateColModalOpen(false)}>
          <div className="modal-card create-col-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-head-icon" style={{ color: collectionColorFor(newColName) }}>
                <FolderIcon />
              </span>
              <span className="modal-title">New Collection</span>
              <button className="modal-close-btn" onClick={() => setCreateColModalOpen(false)}>✕</button>
            </div>
            <form onSubmit={handleCreateCollectionSubmit}>
              <div className="modal-body">
                <div className="modal-field">
                  <label className="modal-label">Collection Name</label>
                  <div className="col-name-input-wrap">
                    <input
                      type="text"
                      className="modal-input"
                      placeholder="e.g. Work Snippets, Design Tokens..."
                      value={newColName}
                      onChange={(e) => setNewColName(e.target.value)}
                      autoFocus
                    />
                    <span
                      className="col-name-dot"
                      style={{ background: collectionColorFor(newColName) }}
                    />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn subtle" onClick={() => setCreateColModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={!newColName.trim()}>
                  Create Collection
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Change Collection Color Modal */}
      {changeColorModal && (
        <div className="modal-backdrop" onClick={() => setChangeColorModal(null)}>
          <div className="modal-card change-color-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-head-icon" style={{ color: changeColorModal.color }}>
                <ColorsIcon />
              </span>
              <span className="modal-title">Change Color &mdash; {changeColorModal.col.name}</span>
              <button className="modal-close-btn" onClick={() => setChangeColorModal(null)}>✕</button>
            </div>
            <form onSubmit={handleChangeColorSubmit}>
              <div className="modal-body color-picker-modal-body">
                {/* Live Color Card */}
                <div className="color-live-preview-bar">
                  <div
                    className="color-live-dot"
                    style={{ background: changeColorModal.color, boxShadow: `0 0 14px ${changeColorModal.color}66` }}
                  />
                  <span className="color-live-hex">{changeColorModal.color.toUpperCase()}</span>
                  <label className="color-picker-native-btn" title="Open Custom Color Picker">
                    <input
                      type="color"
                      className="col-native-color-input"
                      value={changeColorModal.color}
                      onChange={(e) => setChangeColorModal({ ...changeColorModal, color: e.target.value })}
                    />
                    <PlusIcon size={12} />
                  </label>
                </div>

                {/* Horizontal Spectrum Slider */}
                <div className="color-slider-section">
                  <div className="color-slider-label">Hue Slider</div>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={hexToHsl(changeColorModal.color).h}
                    onChange={(e) => {
                      const h = Number(e.target.value);
                      const hex = hslToHex(h, 80, 56);
                      setChangeColorModal({ ...changeColorModal, color: hex });
                    }}
                    className="color-hue-slider"
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn subtle" onClick={() => setChangeColorModal(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn primary">
                  Save Color
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Rename Collection Modal */}
      {renameColModal && (
        <div className="modal-backdrop" onClick={() => setRenameColModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-head-icon"><EditIcon /></span>
              <span className="modal-title">Rename Collection</span>
              <button className="modal-close-btn" onClick={() => setRenameColModal(null)}>✕</button>
            </div>
            <form onSubmit={handleRenameCollectionSubmit}>
              <div className="modal-body">
                <label className="modal-label">Name</label>
                <input
                  type="text"
                  className="modal-input"
                  value={renameColModal.newName}
                  onChange={(e) => setRenameColModal({ ...renameColModal, newName: e.target.value })}
                  autoFocus
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn subtle" onClick={() => setRenameColModal(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={!renameColModal.newName.trim()}>
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Verify Current Passcode (Step 1 for Change Passcode) */}
      {verifyChangePinModal && (
        <div className="modal-backdrop" onClick={() => setVerifyChangePinModal(null)}>
          <div className="modal-card small-pin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-head-icon" style={{ color: verifyChangePinModal.col.color || collectionColorFor(verifyChangePinModal.col.name) }}>
                <LockIcon />
              </span>
              <span className="modal-title">Verify Current Passcode</span>
              <button
                className="modal-close-btn"
                onClick={() => {
                  setVerifyChangePinModal(null);
                  setVerifyChangePinInput('');
                  setVerifyChangePinError('');
                }}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleVerifyChangePinSubmit}>
              <div className="modal-body">
                <p className="modal-desc">
                  Enter your current passcode for <b>&ldquo;{verifyChangePinModal.col.name}&rdquo;</b> to proceed:
                </p>
                <div className="modal-field">
                  <input
                    type="password"
                    className={`passcode-input ${verifyChangePinError ? 'input-error pin-error' : ''}`}
                    placeholder="••••"
                    maxLength={12}
                    value={verifyChangePinInput}
                    onChange={(e) => {
                      setVerifyChangePinInput(e.target.value);
                      setVerifyChangePinError('');
                    }}
                    autoFocus
                  />
                </div>
                {verifyChangePinError && <div className="pin-error-msg">{verifyChangePinError}</div>}
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn subtle"
                  onClick={() => {
                    setVerifyChangePinModal(null);
                    setVerifyChangePinInput('');
                    setVerifyChangePinError('');
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={!verifyChangePinInput}>
                  Continue
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Set / Change Passcode Modal (Step 2) */}
      {pinModal && (
        <div className="modal-backdrop" onClick={() => setPinModal(null)}>
          <div className="modal-card pin-setup-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-head-icon" style={{ color: pinModal.col.color || collectionColorFor(pinModal.col.name) }}>
                <LockIcon />
              </span>
              <span className="modal-title">{pinModal.mode === 'change' ? 'Change Passcode' : 'Lock with Passcode'}</span>
              <button
                className="modal-close-btn"
                onClick={() => {
                  setPinModal(null);
                  setPinModalInput('');
                  setPinModalConfirm('');
                  setPinModalError('');
                }}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSetPinSubmit}>
              <div className="modal-body">
                <p className="modal-desc">
                  {pinModal.mode === 'change' ? (
                    <>Enter a new passcode for <b>&ldquo;{pinModal.col.name}&rdquo;</b>.</>
                  ) : (
                    <>Protect <b>&ldquo;{pinModal.col.name}&rdquo;</b> with a passcode. Clips will remain hidden until unlocked.</>
                  )}
                </p>
                <div className="modal-form-fields">
                  <div className="modal-field">
                    <label className="modal-label">{pinModal.mode === 'change' ? 'New Passcode' : 'Passcode'}</label>
                    <input
                      type="password"
                      className={`passcode-input ${pinModalError ? 'input-error pin-error' : ''}`}
                      placeholder="••••"
                      maxLength={12}
                      value={pinModalInput}
                      onChange={(e) => {
                        setPinModalInput(e.target.value);
                        setPinModalError('');
                      }}
                      autoFocus
                    />
                  </div>
                  <div className="modal-field">
                    <label className="modal-label">{pinModal.mode === 'change' ? 'Confirm New Passcode' : 'Confirm Passcode'}</label>
                    <input
                      type="password"
                      className={`passcode-input ${pinModalError ? 'input-error pin-error' : ''}`}
                      placeholder="••••"
                      maxLength={12}
                      value={pinModalConfirm}
                      onChange={(e) => {
                        setPinModalConfirm(e.target.value);
                        setPinModalError('');
                      }}
                    />
                  </div>
                </div>
                {pinModalError && <div className="pin-error-msg">{pinModalError}</div>}
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn subtle"
                  onClick={() => {
                    setPinModal(null);
                    setPinModalInput('');
                    setPinModalConfirm('');
                    setPinModalError('');
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  disabled={!pinModalInput || !pinModalConfirm}
                >
                  {pinModal.mode === 'change' ? 'Update Passcode' : 'Set Lock'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Save Recovery Code Modal */}
      {recoveryCodeModal && (
        <div className="modal-backdrop">
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-head-icon" style={{ color: '#F59E0B' }}>
                <LockIcon />
              </span>
              <span className="modal-title">
                {recoveryCodeModal.isReset ? 'New Recovery Code' : 'Save Your Recovery Code'}
              </span>
            </div>
            <div className="modal-body">
              <div className="recovery-warning-banner">
                <span>⚠️</span>
                <div>
                  <b>Important:</b> This is the <b>only time</b> this recovery code will be shown. If you ever forget your passcode, this code is required to recover access to <b>&ldquo;{recoveryCodeModal.col.name}&rdquo;</b>.
                </div>
              </div>

              <div className="recovery-display-box">
                <div className="recovery-code-badge">{recoveryCodeModal.code}</div>
                <button
                  type="button"
                  className={`recovery-copy-btn ${recoveryCopied ? 'copied' : ''}`}
                  onClick={() => {
                    navigator.clipboard.writeText(recoveryCodeModal.code);
                    setRecoveryCopied(true);
                    setTimeout(() => setRecoveryCopied(false), 2000);
                  }}
                >
                  {recoveryCopied ? (
                    <>
                      <CheckIcon size={12} /> Copied to Clipboard
                    </>
                  ) : (
                    <>
                      <CopyIcon /> Copy Recovery Code
                    </>
                  )}
                </button>
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setRecoveryCodeModal(null);
                  setRecoveryCopied(false);
                }}
              >
                I Have Saved My Code
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Collection Passcode Modal */}
      {resetPasscodeModal && (
        <div className="modal-backdrop" onClick={() => setResetPasscodeModal(null)}>
          <div className="modal-card pin-setup-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-head-icon" style={{ color: resetPasscodeModal.col.color || collectionColorFor(resetPasscodeModal.col.name) }}>
                <LockIcon />
              </span>
              <span className="modal-title">Reset Passcode &mdash; {resetPasscodeModal.col.name}</span>
              <button
                className="modal-close-btn"
                onClick={() => {
                  setResetPasscodeModal(null);
                  setResetRecoveryCodeInput('');
                  setResetNewPinInput('');
                  setResetConfirmPinInput('');
                  setResetPasscodeError('');
                }}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleResetPasscodeSubmit}>
              <div className="modal-body">
                <p className="modal-desc">
                  Enter the recovery code for <b>&ldquo;{resetPasscodeModal.col.name}&rdquo;</b> and set a new passcode.
                </p>
                <div className="modal-form-fields">
                  <div className="modal-field">
                    <label className="modal-label">Recovery Code</label>
                    <input
                      type="text"
                      className={`recovery-code-input ${resetPasscodeError.toLowerCase().includes('recovery') ? 'input-error' : ''}`}
                      placeholder="XXXX-XXXX-XXXX-XXXX"
                      value={resetRecoveryCodeInput}
                      onChange={(e) => {
                        setResetRecoveryCodeInput(e.target.value);
                        setResetPasscodeError('');
                      }}
                      autoFocus
                    />
                  </div>
                  <div className="modal-field">
                    <label className="modal-label">New Passcode</label>
                    <input
                      type="password"
                      className={`passcode-input ${resetPasscodeError.toLowerCase().includes('passcode') ? 'input-error pin-error' : ''}`}
                      placeholder="••••"
                      maxLength={12}
                      value={resetNewPinInput}
                      onChange={(e) => {
                        setResetNewPinInput(e.target.value);
                        setResetPasscodeError('');
                      }}
                    />
                  </div>
                  <div className="modal-field">
                    <label className="modal-label">Confirm New Passcode</label>
                    <input
                      type="password"
                      className={`passcode-input ${resetPasscodeError.toLowerCase().includes('passcode') ? 'input-error pin-error' : ''}`}
                      placeholder="••••"
                      maxLength={12}
                      value={resetConfirmPinInput}
                      onChange={(e) => {
                        setResetConfirmPinInput(e.target.value);
                        setResetPasscodeError('');
                      }}
                    />
                  </div>
                </div>
                {resetPasscodeError && <div className="pin-error-msg">{resetPasscodeError}</div>}
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn subtle"
                  onClick={() => {
                    setResetPasscodeModal(null);
                    setResetRecoveryCodeInput('');
                    setResetNewPinInput('');
                    setResetConfirmPinInput('');
                    setResetPasscodeError('');
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  disabled={!resetRecoveryCodeInput.trim() || !resetNewPinInput || !resetConfirmPinInput}
                >
                  Reset &amp; Unlock
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Collection Confirmation Modal */}
      {deleteColConfirm && (
        <div className="modal-backdrop" onClick={() => setDeleteColConfirm(null)}>
          <div className="modal-card delete-col-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-head-icon modal-head-danger"><DeleteIcon /></span>
              <span className="modal-title">Delete Collection</span>
              <button
                className="modal-close-btn"
                onClick={() => {
                  setDeleteColConfirm(null);
                  setDeleteColClipsToo(false);
                }}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-desc">
                Are you sure you want to delete <b>&ldquo;{deleteColConfirm.name}&rdquo;</b>? This removes the collection grouping.
              </p>
              {(deleteColConfirm.item_count || 0) > 0 && (
                <label className="delete-clips-toggle-row">
                  <input
                    type="checkbox"
                    className="delete-clips-checkbox"
                    checked={deleteColClipsToo}
                    onChange={(e) => setDeleteColClipsToo(e.target.checked)}
                  />
                  <div className="delete-clips-label-col">
                    <span className="delete-clips-label-title">Also delete clips inside</span>
                    <span className="delete-clips-label-hint">
                      Permanently delete the {deleteColConfirm.item_count}{' '}
                      {deleteColConfirm.item_count === 1 ? 'clip' : 'clips'} from history
                    </span>
                  </div>
                </label>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn subtle"
                onClick={() => {
                  setDeleteColConfirm(null);
                  setDeleteColClipsToo(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn danger-solid"
                onClick={async () => {
                  const id = deleteColConfirm.id;
                  const delClips = (deleteColConfirm.item_count || 0) > 0 && deleteColClipsToo;
                  setDeleteColConfirm(null);
                  setDeleteColClipsToo(false);
                  if (selectedFilter === `col_${id}`) setSelectedFilter('all');
                  await invoke('delete_collection', { id, deleteClips: delClips });
                  fetchCollections();
                  fetchItems();
                }}
              >
                {(deleteColConfirm.item_count || 0) > 0 && deleteColClipsToo
                  ? 'Delete Collection & Clips'
                  : 'Delete Collection'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Passcode Lock Confirmation Modal */}
      {removePinModal && (
        <div className="modal-backdrop" onClick={() => setRemovePinModal(null)}>
          <div className="modal-card remove-pin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-head-icon"><UnlockIcon /></span>
              <span className="modal-title">Remove Passcode Lock</span>
              <button
                className="modal-close-btn"
                onClick={() => {
                  setRemovePinModal(null);
                  setRemovePinInput('');
                  setRemovePinError('');
                }}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleRemovePinSubmit}>
              <div className="modal-body">
                <p className="modal-desc">
                  Enter the passcode for <b>&ldquo;{removePinModal.col.name}&rdquo;</b> to unlock and remove protection.
                </p>
                <div className="modal-field">
                  <label className="modal-label">Passcode</label>
                  <input
                    type="password"
                    className={`passcode-input ${removePinError ? 'input-error pin-error' : ''}`}
                    placeholder="••••"
                    maxLength={12}
                    value={removePinInput}
                    onChange={(e) => {
                      setRemovePinInput(e.target.value);
                      setRemovePinError('');
                    }}
                    autoFocus
                  />
                </div>
                {removePinError && <div className="pin-error-msg">{removePinError}</div>}
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn subtle"
                  onClick={() => {
                    setRemovePinModal(null);
                    setRemovePinInput('');
                    setRemovePinError('');
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={!removePinInput}>
                  Remove Lock
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add to Collection Modal */}
      {addToColModalOpen && (
        <div className="modal-backdrop" onClick={() => setAddToColModalOpen(false)}>
          <div className="modal-card add-to-col-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-head-icon"><FolderIcon /></span>
              <span className="modal-title">
                Add {selectedIds.size > 1 ? `${selectedIds.size} items` : 'clip'} to Collection
              </span>
              <button className="modal-close-btn" onClick={() => setAddToColModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body col-selection-list">
              {collections.length === 0 ? (
                <div className="col-empty-hint">No collections yet. Create your first collection below:</div>
              ) : (
                collections.map((col) => {
                  const colColor = col.color || collectionColorFor(col.name);
                  return (
                    <button
                      key={col.id}
                      className="col-select-row"
                      onClick={() => {
                        const ids = selectedIds.size > 1 ? Array.from(selectedIds) : (selectedItem ? [selectedItem.id] : []);
                        handleAddClipsToCollection(ids, col.id);
                        setAddToColModalOpen(false);
                      }}
                    >
                      <span className="col-select-icon" style={{ color: colColor }}>
                        {col.is_locked ? <LockIcon /> : <FolderIcon />}
                      </span>
                      <span className="col-select-name">{col.name}</span>
                      <span className="col-select-count">{col.item_count}</span>
                    </button>
                  );
                })
              )}
              <button
                className="col-select-row create-new-col-btn"
                onClick={() => {
                  const ids = selectedIds.size > 1 ? Array.from(selectedIds) : (selectedItem ? [selectedItem.id] : []);
                  setPendingAddClips(ids);
                  setAddToColModalOpen(false);
                  setNewColName('');
                  setCreateColModalOpen(true);
                }}
              >
                <span className="col-select-icon" style={{ color: 'var(--accent)' }}>
                  <PlusIcon />
                </span>
                <span className="col-select-name">Create New Collection...</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Collection Context Menu */}
      {colContextMenu && (
        <div
          className="context-menu-backdrop"
          onClick={() => setColContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setColContextMenu(null); }}
        >
          <div
            className="context-menu-popover"
            style={{ top: colContextMenu.y, left: colContextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="context-menu-header">
              <span
                className="context-menu-dot"
                style={{ background: colContextMenu.col.color || collectionColorFor(colContextMenu.col.name) }}
              />
              <span className="context-menu-title">{colContextMenu.col.name}</span>
            </div>
            <button
              className="context-menu-item"
              onClick={() => {
                setRenameColModal({ col: colContextMenu.col, newName: colContextMenu.col.name });
                setColContextMenu(null);
              }}
            >
              <span className="cm-ic"><EditIcon /></span> Rename
            </button>
            <button
              className="context-menu-item"
              onClick={() => {
                setChangeColorModal({ col: colContextMenu.col, color: colContextMenu.col.color || collectionColorFor(colContextMenu.col.name) });
                setColContextMenu(null);
              }}
            >
              <span className="cm-ic"><ColorsIcon /></span> Change Color
            </button>
            {colContextMenu.col.is_locked ? (
              <>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    setVerifyChangePinModal({ col: colContextMenu.col });
                    setVerifyChangePinInput('');
                    setVerifyChangePinError('');
                    setColContextMenu(null);
                  }}
                >
                  <span className="cm-ic"><LockIcon /></span> Change Passcode
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    setResetPasscodeModal({ col: colContextMenu.col });
                    setResetRecoveryCodeInput('');
                    setResetNewPinInput('');
                    setResetConfirmPinInput('');
                    setResetPasscodeError('');
                    setColContextMenu(null);
                  }}
                >
                  <span className="cm-ic"><LockIcon /></span> Reset with Recovery Code
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    setRemovePinModal({ col: colContextMenu.col });
                    setRemovePinInput('');
                    setRemovePinError('');
                    setColContextMenu(null);
                  }}
                >
                  <span className="cm-ic"><UnlockIcon /></span> Remove Passcode
                </button>
                {unlockedCollectionIds.has(colContextMenu.col.id) && (
                  <button
                    className="context-menu-item"
                    onClick={() => {
                      setUnlockedCollectionIds((prev) => {
                        const next = new Set(prev);
                        next.delete(colContextMenu.col.id);
                        return next;
                      });
                      setColContextMenu(null);
                    }}
                  >
                    <span className="cm-ic"><LockIcon /></span> Lock Now
                  </button>
                )}
              </>
            ) : (
              <button
                className="context-menu-item"
                onClick={() => {
                  setPinModal({ col: colContextMenu.col, mode: 'set' });
                  setColContextMenu(null);
                }}
              >
                <span className="cm-ic"><LockIcon /></span> Lock with Passcode
              </button>
            )}
            <div className="context-menu-divider" />
            <button
              className="context-menu-item danger"
              onClick={() => {
                setDeleteColConfirm(colContextMenu.col);
                setColContextMenu(null);
              }}
            >
              <span className="cm-ic"><DeleteIcon /></span> Delete Collection
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

function constrainTitle(title: string, max = 36): string {
  if (!title) return title;
  return title.length > max ? title.slice(0, max - 1).trimEnd() + '…' : title;
}

function formatTimeAgo(dateStr: string): string {
  if (!dateStr) return 'just now';
  const d = new Date(dateStr.replace(' ', 'T'));
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);

  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let c = (hex || '').replace('#', '');
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  const num = parseInt(c, 16);
  if (isNaN(num) || c.length !== 6) return { h: 250, s: 80, l: 60 };
  const r = (num >> 16) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}
