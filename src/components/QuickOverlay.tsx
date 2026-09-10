import React, { useEffect, useLayoutEffect, useState, useRef, memo, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ClipItem, HotkeyStatus, AppSettings, Collection, Snippet } from '../types';
import { ClipPreview, ClipMetaStrip, getSpecificTypeLabel, isMarkdownContent, appDisplayName } from './ClipPreview';
import { getActionsForClip, handleClipKeyDown, ClipActionHandlers } from '../utils/clipActions';
import { matchesHotkeyCombo } from '../utils/hotkeys';
import { setClipDragData } from '../utils/clipDrag';
import { collectionColorFor, normalizeCollectionColor } from '../utils/collections';
import {
  filterSnippets,
  snippetBucketFor,
  SNIPPET_BUCKET_ORDER,
  formatSnippetLastUsed,
  highlightSnippetTokens,
  ArgumentSpec,
} from '../utils/snippets';
import { useSnippetFlow } from '../utils/useSnippetFlow';
import { SnippetArgPrompt } from './SnippetArgPrompt';
import {
  SearchIcon,
  CopyIcon,
  LockIcon,
  FolderIcon,
  PlusIcon,
  PasteIcon,
  EditIcon,
  DeleteIcon,
  FilterIcon,
  StarIcon,
  DragHandleIcon,
  snippetIconFor,
  getTypeIcon,
  getTypeColor,
} from './Icons';
import type { ContentType } from '../types';
import { SnippetEditorModal } from './SnippetEditorModal';
import { Dropdown } from './Dropdown';

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

// ── Memoized overlay row: keeps keyboard-navigation renders O(1) ─────
const OverlayRow = memo(function OverlayRow({
  item,
  index,
  isSelected,
  isDragging,
  queueIdx,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  item: ClipItem;
  index: number;
  isSelected: boolean;
  isDragging: boolean;
  queueIdx: number;
  onSelect: (idx: number) => void;
  onDragStart: (item: ClipItem, e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const tint = getTypeColor(item.content_type);
  return (
    <div
      id={`overlay-row-${index}`}
      draggable={true}
      onDragStart={(e) => onDragStart(item, e)}
      onDragEnd={onDragEnd}
      className={`row ${isSelected ? 'selected' : ''} ${isDragging ? 'is-dragging' : ''} ${queueIdx >= 0 ? 'in-queue' : ''}`}
      onClick={() => onSelect(index)}
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
            ? item.text_content.replace(/\s+/g, ' ').slice(0, 75)
            : item.source_app || item.content_type}
        </div>
      </div>

      <div className="row-right">
        <div className="drag-handle" title="Drag and drop clip">
          <DragHandleIcon />
        </div>
        <div className="row-meta">
          <span className="row-time">{formatTimeAgo(item.created_at)}</span>
        </div>
      </div>
    </div>
  );
});

export const QuickOverlay: React.FC = () => {
  // Last-used tab wins: reopen where you left off (persisted per summon).
  const [tab, setTab] = useState<'clips' | 'snippets'>(() => {
    if (typeof window !== 'undefined') {
      try {
        const last = localStorage.getItem('carbon_overlay_tab');
        if (last === 'snippets' || last === 'clips') return last;
      } catch {}
    }
    return 'clips';
  });
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const [items, setItems] = useState<ClipItem[]>(() => (typeof window !== 'undefined' && window.__carbonInitialData) || []);
  const [initialLoaded, setInitialLoaded] = useState(() => Boolean(typeof window !== 'undefined' && window.__carbonInitialData && window.__carbonInitialData.length > 0));
  const [pasteQueue, setPasteQueue] = useState<ClipItem[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [addToColModalOpen, setAddToColModalOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [showCreateInline, setShowCreateInline] = useState(false);
  const [search, setSearch] = useState('');
  // Application filter chip in the searchbar (same behavior as the main app:
  // click the APPLICATION value in the preview to filter, ✕ to clear).
  const [sourceAppFilter, setSourceAppFilter] = useState<string | null>(null);
  // Content-type category filter for the overlay's clips list ('__all__' = no filter)
  const [typeFilter, setTypeFilter] = useState<string>('__all__');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [renderMode, setRenderMode] = useState<boolean>(true);
  const [editingContent, setEditingContent] = useState<string>('');
  const [actionPanelOpen, setActionPanelOpen] = useState(false);
  const [actionIndex, setActionIndex] = useState(0);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [previewOpen, setPreviewOpen] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      if (window.__carbonSettings && typeof window.__carbonSettings.preview_enabled === 'boolean') {
        return window.__carbonSettings.preview_enabled;
      }
      try {
        const cached = localStorage.getItem('carbon_preview_enabled');
        if (cached !== null) return cached === 'true';
      } catch {}
    }
    return true;
  });
  const previewOpenRef = useRef(previewOpen);
  previewOpenRef.current = previewOpen;
  const targetPreviewOpenRef = useRef<boolean>(previewOpen);

  // F3 Preview state machine: idle | out | snap | in
  type PreviewPhase = 'idle' | 'out' | 'snap' | 'in';
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>('idle');
  const previewPhaseRef = useRef<PreviewPhase>('idle');
  const previewTimerRef = useRef<number | null>(null);
  const previewRafRef = useRef<number | null>(null);
  const watchdogTimerRef = useRef<number | null>(null);

  const getFadeTarget = () =>
    document.documentElement.dataset.material === 'solid'
      ? document.getElementById('root') ?? document.documentElement
      : document.documentElement;

  const assertSingleLiveLayout = () => {
    if (!import.meta.env.DEV) return;
    const layers = document.querySelectorAll('[data-carbon-layout-layer="overlay"]');
    if (layers.length !== 1) {
      console.error(`[overlay] expected one live layout layer; found ${layers.length}`);
    }
    if (document.documentElement.classList.contains('wm-resizing') && previewPhaseRef.current === 'idle') {
      console.error('[overlay] wm-resizing leaked after preview transition');
    }
  };

  // Sends the preview size native, deduped: rapid Tab spam otherwise issues
  // a native resize per keystroke (each reallocates the surface → jank and
  // flash storms). REVERT NOTE (resize-storm fix): to revert, delete this
  // helper and call invoke('set_overlay_preview', ...) directly again.
  const sendPreviewSize = (enabled: boolean) => {
    if (lastSentPreviewRef.current === enabled) return;
    lastSentPreviewRef.current = enabled;
    invoke('set_overlay_preview', { enabled }).catch(console.error);
  };

  // F3 Single-live-layout: instantly finalize current phase (clear timers, settle state to target)
  const finalizeTransition = useCallback((targetState?: boolean) => {
    if (previewTimerRef.current) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    if (previewRafRef.current) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
    if (watchdogTimerRef.current) {
      window.clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    document.documentElement.classList.remove('wm-resizing');
    previewPaneRef.current?.classList.remove('snap-veil'); // REVERT: preview flash rework (veil cleanup on interrupt)

    const resolvedTarget = typeof targetState === 'boolean' ? targetState : targetPreviewOpenRef.current;
    previewOpenRef.current = resolvedTarget;
    targetPreviewOpenRef.current = resolvedTarget;
    setPreviewOpen(resolvedTarget);
    sendPreviewSize(resolvedTarget);

    previewPhaseRef.current = 'idle';
    setPreviewPhase('idle');
    requestAnimationFrame(assertSingleLiveLayout);
  }, []);
  const [showSnippets, setShowSnippets] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      if (window.__carbonSettings && typeof window.__carbonSettings.show_snippets === 'boolean') {
        return window.__carbonSettings.show_snippets;
      }
      try {
        const cached = localStorage.getItem('carbon_show_snippets');
        if (cached !== null) return cached === 'true';
      } catch {}
    }
    return true;
  });
  const [targetApp, setTargetApp] = useState<string | null>(null);

  // ── Snippets tab state ────────────────────────────────────────────
  const [snSnippets, setSnSnippets] = useState<Snippet[]>(() => (typeof window !== 'undefined' && window.__carbonInitialSnippets) || []);
  const [snInitialLoaded, setSnInitialLoaded] = useState(() => Boolean(typeof window !== 'undefined' && window.__carbonInitialSnippets));
  const [snSearch, setSnSearch] = useState('');
  const [snTagFilter, setSnTagFilter] = useState('__all__');
  const [snSelectedId, setSnSelectedId] = useState<string | null>(null);
  const [snEditorTarget, setSnEditorTarget] = useState<{ snippet: Snippet | null } | null>(null);
  const [snArgPrompt, setSnArgPrompt] = useState<(ArgumentSpec & { resolvedDefault?: string }) | null>(null);
  const [snArgValue, setSnArgValue] = useState('');
  const [snActionOpen, setSnActionOpen] = useState(false);
  const [snActionIndex, setSnActionIndex] = useState(0);
  const [snPill, setSnPill] = useState<{ text: string; error?: boolean } | null>(null);
  const snResolverRef = useRef<((value: string | null) => void) | null>(null);
  const snSearchInputRef = useRef<HTMLInputElement>(null);
  const snPillTimerRef = useRef<number | null>(null);
  const snNavAccumRef = useRef(0);
  const snNavRafRef = useRef<number | null>(null);
  const snFilteredRef = useRef<Snippet[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeActionRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (actionPanelOpen && activeActionRef.current) {
      activeActionRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [actionIndex, actionPanelOpen]);

  const fetchCollections = async () => {
    try {
      const cols = await invoke<Collection[]>('list_collections');
      setCollections(cols || []);
    } catch (err) {
      console.error('Failed to fetch collections in overlay:', err);
    }
  };

  const fetchQueue = async () => {
    try {
      const q = await invoke<ClipItem[]>('queue_get_clips');
      setPasteQueue(q || []);
    } catch (err) {
      console.error('Failed to fetch paste queue:', err);
    }
  };

  const fetchItems = async () => {
    try {
      const res = await invoke<ClipItem[]>('get_all_clips', {
        search: search.trim() ? search : null,
        category: null,
        pinnedOnly: false,
        collectionId: null,
      });
      setItems(res || []);
      setInitialLoaded(true);
      setSelectedIndex(0);
    } catch (err) {
      console.error('Failed to fetch clips:', err);
      setInitialLoaded(true);
    }
  };

  const fetchRef = useRef<() => void>(() => {});
  fetchRef.current = () => {
    fetchItems();
    fetchCollections();
    fetchQueue();
  };
  const fetchLatest = () => {
    fetchRef.current();
  };

  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    fetchItems();
  }, [search]);

  // ── Snippets tab: data + derived state ────────────────────────────
  const fetchSnippets = async () => {
    try {
      const list = await invoke<Snippet[]>('list_snippets');
      if (Array.isArray(list)) {
        setSnSnippets(list);
        setSnSelectedId((prev) => {
          if (list.length === 0) return null;
          return prev && list.some((s) => s.id === prev) ? prev : list[0].id;
        });
      }
    } catch (err) {
      console.error('Failed to fetch snippets:', err);
    } finally {
      setSnInitialLoaded(true);
    }
  };

  useEffect(() => {
    fetchSnippets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snAllTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of snSnippets) for (const t of s.tags || []) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [snSnippets]);

  // Distinct content-type categories present in the clipboard history —
  // feeds the Raycast-style "All Types" filter box in the overlay's clips
  // searchbar (mirrors the main window's sidebar type filters).
  const typeFilterOptions = useMemo(() => {
    const ORDER = ['text', 'code', 'rich_text', 'image', 'file', 'link', 'email', 'color'];
    const LABELS: Record<string, string> = {
      text: 'Text',
      code: 'Code',
      rich_text: 'Rich Text',
      image: 'Image',
      file: 'File',
      link: 'Link',
      email: 'Email',
      color: 'Color',
    };
    const present = new Set<string>(items.map((i) => String(i.content_type)));
    return ORDER.filter((t) => present.has(t)).map((t) => ({
      value: t,
      label: LABELS[t],
      icon: (
        <span style={{ color: getTypeColor(t as ContentType), display: 'inline-flex' }}>
          {getTypeIcon(t as ContentType)}
        </span>
      ),
    }));
  }, [items]);

  const snFiltered = useMemo(
    () => filterSnippets(snSnippets, snSearch, snTagFilter),
    [snSnippets, snSearch, snTagFilter]
  );
  snFilteredRef.current = snFiltered;

  const snGrouped = useMemo(() => {
    const map = new Map<string, Snippet[]>();
    for (const s of snFiltered) {
      const bucket = snippetBucketFor(s.last_used_at || s.created_at);
      if (!map.has(bucket)) map.set(bucket, []);
      map.get(bucket)!.push(s);
    }
    return SNIPPET_BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({ label: b, items: map.get(b)! }));
  }, [snFiltered]);

  const snSelected = useMemo(
    () => snSnippets.find((s) => s.id === snSelectedId) ?? null,
    [snSnippets, snSelectedId]
  );

  // Client-side application + content-type filters (mirrors EnlargedWindow semantics)
  const displayItems = useMemo(() => {
    let out = items;
    if (sourceAppFilter) {
      out = out.filter(
        (i) => i.source_app && i.source_app.toLowerCase() === sourceAppFilter.toLowerCase()
      );
    }
    if (typeFilter === 'pinned') {
      out = out.filter((i) => i.is_pinned);
    } else if (typeFilter !== '__all__') {
      out = out.filter((i) => String(i.content_type) === typeFilter);
    }
    return out;
  }, [items, sourceAppFilter, typeFilter]);

  // Reset highlight when the filter changes so Enter/preview stay valid
  useEffect(() => {
    setSelectedIndex(0);
  }, [sourceAppFilter, typeFilter]);

  // Clips-tab behavior: the highlighted row is always a valid row of the
  // filtered list (keeps Enter instantly usable and the preview populated).
  useEffect(() => {
    if (snFiltered.length === 0) {
      setSnSelectedId(null);
      return;
    }
    if (!snSelectedId || !snFiltered.some((s) => s.id === snSelectedId)) {
      setSnSelectedId(snFiltered[0].id);
    }
  }, [snFiltered, snSelectedId]);

  // Auto-scroll the highlighted snippet row into view.
  useEffect(() => {
    if (!snSelectedId) return;
    const raf = requestAnimationFrame(() => {
      document.getElementById(`sn-ov-row-${snSelectedId}`)?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [snSelectedId]);

  const showSnPill = (text: string, error = false) => {
    if (snPillTimerRef.current) window.clearTimeout(snPillTimerRef.current);
    setSnPill({ text, error });
    snPillTimerRef.current = window.setTimeout(() => setSnPill(null), 4200);
  };

  const snPromptArgument = useCallback((spec: ArgumentSpec & { resolvedDefault?: string }) => {
    return new Promise<string | null>((resolve) => {
      snResolverRef.current = resolve;
      setSnArgValue(spec.resolvedDefault ?? spec.defaultValue ?? '');
      setSnArgPrompt(spec);
    });
  }, []);

  const snCloseArgPrompt = useCallback((value: string | null) => {
    const resolver = snResolverRef.current;
    snResolverRef.current = null;
    setSnArgPrompt(null);
    if (resolver) resolver(value);
  }, []);

  const { useSnippet } = useSnippetFlow({
    snippets: snSnippets,
    promptArgument: snPromptArgument,
    onConfirm: (text) => showSnPill(text),
    onError: (text) => showSnPill(text, true),
    onUsed: () => fetchSnippets(),
  });

  const handleSnDelete = (snip: Snippet) => {
    // Optimistic: remove from the list instantly, persist in the background.
    setSnSnippets((prev) => prev.filter((s) => s.id !== snip.id));
    setSnSelectedId((prev) => (prev === snip.id ? null : prev));
    showSnPill(`Deleted "${snip.name}"`);
    invoke('delete_snippet', { id: snip.id }).catch((err) => {
      console.error('Failed to delete snippet:', err);
      showSnPill('Could not delete the snippet', true);
      fetchSnippets();
    });
  };

  const snActions = useMemo(() => {
    const snip = snSelected;
    if (!snip) return [];
    return [
      {
        id: 'paste',
        label: 'Paste',
        shortcut: 'Enter',
        icon: <PasteIcon />,
        handler: () => useSnippet(snip, 'paste'),
      },
      {
        id: 'copy',
        label: 'Copy to Clipboard',
        shortcut: 'Ctrl+C',
        icon: <CopyIcon />,
        handler: () => useSnippet(snip, 'copy'),
      },
      {
        id: 'edit',
        label: 'Edit Snippet',
        shortcut: 'E',
        icon: <EditIcon />,
        handler: () => setSnEditorTarget({ snippet: snip }),
      },
      {
        id: 'delete',
        label: 'Delete Snippet',
        shortcut: 'Del',
        icon: <DeleteIcon />,
        danger: true,
        handler: () => handleSnDelete(snip),
      },
    ];
  }, [snSelected, useSnippet]);

  const flushSnNavAccum = () => {
    snNavRafRef.current = null;
    const steps = snNavAccumRef.current;
    if (steps === 0) return;
    snNavAccumRef.current = 0;
    const list = snFilteredRef.current;
    if (list.length === 0) return;
    setSnSelectedId((prev) => {
      const curIdx = prev ? list.findIndex((s) => s.id === prev) : -1;
      const base = curIdx === -1 ? 0 : curIdx;
      const next = (base + steps) % list.length;
      return list[next < 0 ? next + list.length : next].id;
    });
  };

  useEffect(() => () => {
    if (snNavRafRef.current !== null) cancelAnimationFrame(snNavRafRef.current);
  }, []);

  const snHighlighted = useMemo(
    () => (snSelected ? highlightSnippetTokens(snSelected.content) : []),
    [snSelected]
  );
  const SnSelectedIcon = snSelected ? snippetIconFor(snSelected.icon) : null;

  // Auto-scroll selected row into view & sync editing state
  // (rAF-coalesced: rapid arrow holds supersede in-flight scrolls)
  useEffect(() => {
    if (displayItems.length === 0 || selectedIndex < 0 || selectedIndex >= displayItems.length) {
      setEditingContent('');
      return;
    }
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`overlay-row-${selectedIndex}`);
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
      }
    });
    const item = displayItems[selectedIndex];
    if (item) {
      setEditingContent(item.text_content || '');
    }
    return () => cancelAnimationFrame(raf);
  }, [selectedIndex, displayItems]);

  // Render-mode must sync BEFORE paint (useLayoutEffect): scrolling through
  // items right after toggling Raw otherwise paints one stale raw-text frame
  // before the rendered preview commits. The main window resets render mode
  // synchronously inside its selection handlers; here layout-phase sync is
  // the equivalent guarantee.
  useLayoutEffect(() => {
    const item = displayItems[selectedIndex];
    if (!item) return;
    setRenderMode(
      item.content_type === 'rich_text' ||
        Boolean(item.html_content) ||
        (Boolean(item.text_content) && isMarkdownContent(item.text_content || ''))
    );
  }, [selectedIndex, displayItems]);

  const logClient = (msg: string) => {
    invoke('log_client_event', { event: msg }).catch(() => {});
  };

  const loadTargetApp = () => {
    invoke<string | null>('get_target_app_name')
      .then((name) => {
        logClient(`loadTargetApp resolved name: ${name}`);
        setTargetApp(name);
      })
      .catch((err) => {
        logClient(`loadTargetApp error: ${err}`);
      });
  };

  const focusSearchInput = () => {
    setTimeout(() => {
      const input =
        tabRef.current === 'snippets' ? snSearchInputRef.current : searchInputRef.current;
      input?.focus();
      input?.select();
    }, 40);
  };

  // Empty search bar + Left/Right toggles focus between the two tabs'
  // search bars — the only tab switch the arrows do. It never touches
  // the list. (focusSearchInput reads refs, so calling it here is safe.)
  const switchTab = (next: 'clips' | 'snippets') => {
    if (tabRef.current === next) return;
    if (next === 'snippets' && !showSnippets) return;
    tabRef.current = next;
    setTab(next);
    // Remember for the next summon: the overlay reopens where it was left.
    try { localStorage.setItem('carbon_overlay_tab', next); } catch {}
    setSnActionOpen(false);
    setActionPanelOpen(false);
    focusSearchInput();
  };

  // Stable row-select handler for memoized rows (identity never changes)
  const handleSelectRow = useCallback((idx: number) => {
    setSelectedIndex(idx);
    focusSearchInput();
  }, []);

  // Drag-out: exact mirror of the main window — same payload, same empty
  // drag image, same dragging highlight. Sensitive clips only expose their
  // masked label, never the secret.
  const handleOverlayDragStart = useCallback((item: ClipItem, e: React.DragEvent) => {
    if (item.is_sensitive) {
      e.dataTransfer.effectAllowed = 'copy';
      try {
        e.dataTransfer.setData('text/plain', 'Sensitive Clip');
      } catch {}
      return;
    }
    setDraggingId(item.id);
    window.__carbonDraggingClipIds = [item.id];

    if (e.dataTransfer && emptyDragImg && e.dataTransfer.setDragImage) {
      try {
        e.dataTransfer.setDragImage(emptyDragImg, 0, 0);
      } catch {}
    }

    setClipDragData(e, item);
  }, []);

  const handleOverlayDragEnd = useCallback(() => {
    setDraggingId(null);
    window.__carbonDraggingClipIds = null;
  }, []);

  // ── Settings-driven behavior ───────────────────────────────────────
  // Preview visibility and snippet availability sync live (settings-updated
  // fires in every window). The active TAB is never forced here: the overlay
  // reopens on the last-used tab (see switchTab persistence) — the old
  // "Overlay opens on" default has been removed.
  const applyOverlaySettings = useCallback((s: AppSettings) => {
    if (!s) return;
    if (typeof s.preview_enabled === 'boolean') {
      setPreviewOpen(s.preview_enabled);
      try { localStorage.setItem('carbon_preview_enabled', String(s.preview_enabled)); } catch {}
    }
    if (typeof s.show_snippets === 'boolean') {
      setShowSnippets(s.show_snippets);
      try { localStorage.setItem('carbon_show_snippets', String(s.show_snippets)); } catch {}
      if (!s.show_snippets) {
        tabRef.current = 'clips';
        setTab('clips');
        return;
      }
    }
  }, []);

  // ── Show/hide choreography (state machine: hidden|showing|shown|hiding) ──
  // The overlay window is warm (hidden, never destroyed), so body-class state
  // survives across shows. HIDE: fade #root out via body.is-hidden (70ms),
  // then the native hide() runs on transitionend (80ms timeout fallback).
  // SHOW: the window is shown while the mask is still on; two rAF ticks
  // guarantee one presented painted frame before the mask lifts (100ms fade).
  // Hide is idempotent: a re-press while fading does NOT cancel (the
  // cancel path exists only so an actual show can abort an in-flight fade);
  // the mask stays ON whenever the window is invisible, so a re-press or a
  // stale timeout rAF can never remove it while hidden (no rebound reveal).
  const overlayPhaseRef = useRef<'hidden' | 'showing' | 'shown' | 'hiding'>('hidden');
  const pendingHideRef = useRef<{ cancel: () => void } | null>(null);
  // Bumped on every overlay-opened; each show's rAF chain only lifts the mask
  // for its own epoch, so overlapping shows under hotkey spam can't fight.
  const showEpochRef = useRef(0);
  // Last time a hide fully completed (finish()). The open path compares it
  // against now to detect cold opens after a long idle (see COLD_IDLE_MS).
  const lastHideAtRef = useRef(performance.now());
  // First Tab snap needs a longer present window (see below).
  const previewSnappedOnceRef = useRef(false);
  // Direct handle to the preview pane element for the snap veil.
  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  // Last preview size sent native: skips redundant SetWindowPos storms when
  // Tab is spammed (each native resize reallocates the DWM surface).
  const lastSentPreviewRef = useRef<boolean | null>(null);

  const requestHide = (gen?: number | null) => {
    // Tell Rust this generation is handled: its 250ms fallback only fires if
    // the webview never acknowledged (e.g. a crashed renderer).
    if (typeof gen === 'number') invoke('overlay_hide_ack', { gen }).catch(() => {});

    // Already fading out: keep the fade (restart semantics would re-run the
    // fade anyway). Crucially, never lift the mask while invisible.
    if (pendingHideRef.current) return;

    const html = document.documentElement;
    const isGlassClose = html.dataset.material === 'glass';
    // In glass the fade target is #root (it owns the opacity rule); the
    // stylesheet forces `transition: none` there, so without the inline
    // override below the mask would snap instead of fading.
    const fadeTarget = isGlassClose
      ? (document.getElementById('root') ?? document.documentElement)
      : getFadeTarget();
    // REVERT NOTE (close-blink fix): this override plus the REMOVED
    // synchronous glass finish() at the end of requestHide make glass closes
    // fade 80ms (like solid), softening the hard-cut DWM teardown blink on
    // every close. To revert: delete this setProperty block AND the
    // removeProperty lines in finish/cancel below, and restore
    // `if (html.dataset.material === 'glass') finish();` at the end.
    if (isGlassClose) {
      fadeTarget.style.setProperty('transition', 'opacity 80ms linear', 'important');
    }
    overlayPhaseRef.current = 'hiding';
    invoke('overlay_phase_ack', { phase: 'hiding' }).catch(() => {});
    html.classList.add('wm-hiding', 'wm-hidden');
    let cancelled = false;
    let finished = false;
    const finish = () => {
      if (cancelled || finished) return;
      finished = true;
      pendingHideRef.current = null;
      fadeTarget.style.removeProperty('transition'); // REVERT: glass close-fade cleanup (see above)
      lastHideAtRef.current = performance.now();
      overlayPhaseRef.current = 'hidden';
      invoke('overlay_phase_ack', { phase: 'hidden' }).catch(() => {});
      fadeTarget.removeEventListener('transitionend', onEnd);
      html.classList.remove('wm-hiding');
      // Blur/paste may have hidden the window mid-fade — only call the native
      // hide (which restores focus to the target app) if we are still visible.
      // The mask class stays ON while invisible; the show path lifts it.
      getCurrentWindow()
        .isVisible()
        .then((vis) => {
          if (vis) invoke('hide_overlay').catch(console.error);
        })
        .catch(() => invoke('hide_overlay').catch(console.error));
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === fadeTarget && e.propertyName === 'opacity') finish();
    };
    fadeTarget.addEventListener('transitionend', onEnd);
    const timer = window.setTimeout(finish, 100); // 90ms fade + slack
    pendingHideRef.current = {
      // Only the show path calls cancel: abort the fade WITHOUT lifting the
      // mask (the show handler lifts it itself after two presented frames).
      cancel: () => {
        if (cancelled || finished) return;
        cancelled = true;
        finished = true;
        window.clearTimeout(timer);
        fadeTarget.removeEventListener('transitionend', onEnd);
        fadeTarget.style.removeProperty('transition'); // REVERT: glass close-fade cleanup (see above)
        html.classList.remove('wm-hiding');
        pendingHideRef.current = null;
      },
    };
  };

  useEffect(() => {
    logClient('QuickOverlay mounted.');
    invoke<AppSettings>('get_settings')
      .then(applyOverlaySettings)
      .catch(() => {});

    loadTargetApp();
    focusSearchInput();

    window.__carbonSetData = (data: ClipItem[]) => {
      if (Array.isArray(data)) {
        setItems(data);
        setInitialLoaded(true);
        setSelectedIndex(0);
      }
    };

    window.__carbonSetSnippets = (data: Snippet[]) => {
      if (Array.isArray(data)) {
        setSnSnippets(data);
        setSnInitialLoaded(true);
        setSnSelectedId((prev) => {
          if (data.length === 0) return null;
          return prev && data.some((s) => s.id === prev) ? prev : data[0].id;
        });
      }
    };

    const safeListen = <T,>(
      event: string,
      handler: (e: { payload: T }) => void
    ) =>
      listen<T>(event, handler).catch((err) => {
        console.error(`[overlay] listen('${event}') failed:`, err);
        return () => {};
      });

    const unlistenUpdated = safeListen<ClipItem | null>('clipboard-updated', (e) => {
      const item = e.payload;
      if (item && typeof item === 'object' && item.id) {
        if (searchRef.current.trim()) {
          fetchLatest();
        } else {
          setItems((prev) => {
            if (prev.some((i) => i.id === item.id)) return prev;
            return [item, ...prev];
          });
          setSelectedIndex(0);
        }
      } else {
        fetchLatest();
      }
    });

    const unlistenData = safeListen<ClipItem[]>('overlay-data', (e) => {
      if (Array.isArray(e.payload)) {
        setItems(e.payload);
        setInitialLoaded(true);
        setSelectedIndex(0);
      }
    });

    // Snippets arrive on the same tick as the clip list (pushed by Rust on
    // overlay focus) — the snippets tab is populated instantly with no
    // invoke round-trip. The invoke refresh on open stays as a fallback.
    const unlistenSnData = safeListen<Snippet[]>('overlay-snippets', (e) => {
      if (Array.isArray(e.payload)) {
        const list = e.payload;
        setSnSnippets(list);
        setSnInitialLoaded(true);
        setSnSelectedId((prev) => {
          if (list.length === 0) return null;
          return prev && list.some((s) => s.id === prev) ? prev : list[0].id;
        });
      }
    });

    const unlistenOpened = safeListen('overlay-opened', () => {
      logClient('Received overlay-opened event.');
      // ── Show choreography (F1) ──
      // Cancel any in-flight fade-hide (a toggle re-press mid-fade), keep the
      // wm-hidden mask on, wait TWO presented frames (guarantees one painted
      // present after show()), then lift the mask -> 100ms fade-in. The rAF
      // chain is guarded by a show epoch: a stale chain from an earlier show
      // (hotkey spam) can never lift a NEWER show's mask — each lift only
      // applies to its own epoch, so a quick hide after the double rAF can't
      // be undone by leftover callbacks (no rebound reveal).
      const showEpoch = (showEpochRef.current += 1);
      if (pendingHideRef.current) pendingHideRef.current.cancel();
      overlayPhaseRef.current = 'showing';
      invoke('overlay_phase_ack', { phase: 'showing' }).catch(() => {});
      finalizeTransition(previewOpenRef.current);

      const html = document.documentElement;
      html.classList.remove('wm-hiding');
      // REVERT NOTE (cold-open flash fix): after a long idle the renderer's
      // swapchain is cold and an immediate painted-ack can uncloak a white
      // frame — the flash seen only on the first open after a while. Warm
      // opens (idle <= COLD_IDLE_MS) keep the instant ack; cold opens wait
      // for presented frames like solid. To revert: set COLD_IDLE_MS to
      // Infinity (instant ack always) or 0 (gated ack always).
      const COLD_IDLE_MS = 45000;
      const idleMs = performance.now() - lastHideAtRef.current;
      if (html.dataset.material === 'glass' && idleMs <= COLD_IDLE_MS) {
        // First painted frame is on screen: tell native to lift the DWM
        // cloak gate, then unmask. DWM never composites this window before
        // the ack, so no white intermediate frame can appear (glass mode).
        invoke('overlay_painted').catch(() => {});
        html.classList.remove('wm-hidden');
        overlayPhaseRef.current = 'shown';
        invoke('overlay_phase_ack', { phase: 'shown' }).catch(() => {});
      } else {
      // Cold glass waits an extra frame with a longer cap; solid is unchanged.
      const needFrames = html.dataset.material === 'glass' ? 3 : 2;
      const gateCapMs = html.dataset.material === 'glass' ? 800 : 500;
      if (!html.classList.contains('wm-hidden')) {
        // Last hide was native (paste/blur paths): snap the mask on with no
        // transition — nothing may animate while the window was invisible.
        html.classList.add('wm-hidden', 'no-anim');
        void html.offsetWidth; // flush styles into this frame
        html.classList.remove('no-anim');
      }
      const gateStarted = performance.now();
      let framesSinceShow = 0;
      const releaseWhenPainted = () => requestAnimationFrame(() => {
        if (showEpoch !== showEpochRef.current || overlayPhaseRef.current !== 'showing') return;
        framesSinceShow += 1;
        const painted = html.dataset.painted === '1';
        if ((painted && framesSinceShow >= needFrames) || performance.now() - gateStarted >= gateCapMs) {
          // Painted: release the native DWM cloak gate first so the first
          // composited frame is real content, then unmask for the fade-in.
          invoke('overlay_painted').catch(() => {});
          html.classList.remove('wm-hidden');
          overlayPhaseRef.current = 'shown';
          invoke('overlay_phase_ack', { phase: 'shown' }).catch(() => {});
          return;
        }
        releaseWhenPainted();
      });
      releaseWhenPainted();
      }
      setSearch('');
      setActionPanelOpen(false);
      setActionIndex(0);
      setSnSearch('');
      setSnActionOpen(false);
      setSnActionIndex(0);
      loadTargetApp();
      fetchItems();
      fetchSnippets();
      // Re-sync live settings (preview/snippets flags) without touching the
      // tab — the overlay reopens on the last-used tab.
      invoke<AppSettings>('get_settings')
        .then((s) => {
          if (s) applyOverlaySettings(s);
          focusSearchInput();
        })
        .catch(() => {
          focusSearchInput();
        });
    });

    const unlistenCancelHide = safeListen('overlay-cancel-hide', () => {
      logClient('Received overlay-cancel-hide event.');
      if (pendingHideRef.current) {
        pendingHideRef.current.cancel();
        pendingHideRef.current = null;
      }
      overlayPhaseRef.current = 'shown';
      const html = document.documentElement;
      invoke('overlay_painted').catch(() => {});
      html.classList.remove('wm-hiding', 'wm-hidden');
      invoke('overlay_phase_ack', { phase: 'shown' }).catch(() => {});
    });

    const unlistenHideReq = safeListen<number>('overlay-hide-requested', (e) => {
      logClient(`Received overlay-hide-requested (gen=${e.payload}).`);
      requestHide(e.payload);
    });

    const unlistenSettings = safeListen<AppSettings>('settings-updated', (e) => {
      if (e.payload && typeof e.payload === 'object') applyOverlaySettings(e.payload);
    });

    const unlistenCycle = safeListen<number>('cycle-overlay-next', () => {
      setItems((prevItems) => {
        if (prevItems.length === 0) return prevItems;
        setSelectedIndex((prevIndex) => (prevIndex + 1) % prevItems.length);
        return prevItems;
      });
    });

    const unlistenStatus = safeListen<HotkeyStatus>('hotkey-status', (e) => {
      setHotkeyStatus(e.payload);
    });

    const pollStatus = () =>
      invoke<HotkeyStatus | null>('get_hotkey_status')
        .then((s) => {
          if (s) {
            setHotkeyStatus(s);
          } else {
            setTimeout(pollStatus, 600);
          }
        })
        .catch(() => {});
    pollStatus();

    let unlistenFocus: (() => void) | null = null;
    const onWindowFocus = () => {
      logClient('Webview onWindowFocus event.');
      loadTargetApp();
      fetchItems();
      focusSearchInput();
    };

    const onVisibilityChange = () => {
      logClient(`Webview visibilitychange: document.visibilityState=${document.visibilityState}`);
      if (document.visibilityState === 'visible') onWindowFocus();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    try {
      const win = getCurrentWindow();
      win
        .onFocusChanged(({ payload: focused }) => {
          logClient(`Webview win.onFocusChanged: focused=${focused}`);
          if (focused) onWindowFocus();
        })
        .then((fn) => {
          unlistenFocus = fn;
        })
        .catch(() => {});
    } catch {
      window.addEventListener('focus', onWindowFocus);
    }

    const unlistenPreviewToggle = safeListen<boolean>('preview-toggled', (e) => {
      setPreviewOpen(e.payload);
    });

    const unlistenQueue = safeListen('paste-queue-updated', () => {
      fetchQueue();
    });

    return () => {
      delete window.__carbonSetData;
      unlistenUpdated.then((fn) => fn());
      unlistenData.then((fn) => fn());
      unlistenSnData.then((fn) => fn());
      unlistenOpened.then((fn) => fn());
      unlistenCancelHide.then((fn) => fn());
      unlistenHideReq.then((fn) => fn());
      unlistenSettings.then((fn) => fn());
      unlistenCycle.then((fn) => fn());
      unlistenStatus.then((fn) => fn());
      unlistenPreviewToggle.then((fn) => fn());
      unlistenQueue.then((fn) => fn());
      unlistenFocus?.();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, []);

  const handlePaste = async (item: ClipItem, plainText: boolean = false, transform?: string) => {
    logClient(`handlePaste called for clip '${item.id}' (title='${item.title}', plainText=${plainText}, transform=${transform})`);
    try {
      await invoke('paste_clip', { id: item.id, plainText, transform: transform ?? null });
      logClient(`handlePaste: paste_clip invoke resolved.`);
    } catch (err) {
      logClient(`handlePaste: paste_clip invoke FAILED: ${err}`);
      console.error('Failed to paste clip:', err);
    }
  };

  const handleQueueClip = async (item: ClipItem) => {
    try {
      await invoke('queue_add_clips', { ids: [item.id] });
      fetchQueue();
    } catch (err) {
      console.error('Failed to add clip to queue:', err);
    }
  };

  const handleClearQueue = async () => {
    try {
      await invoke('queue_clear');
      fetchQueue();
    } catch (err) {
      console.error('Failed to clear queue:', err);
    }
  };

  const handleTogglePin = async (item: ClipItem) => {
    try {
      const newPin = await invoke<boolean>('toggle_pin_clip', { id: item.id });
      if (typeFilter === 'pinned' && !newPin) {
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        if (selectedIndex >= 0 && displayItems[selectedIndex]?.id === item.id) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
        }
      } else {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, is_pinned: newPin } : i)));
      }
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

  const handleCopyOnly = async (item: ClipItem) => {
    try {
      await invoke('copy_clip', { id: item.id });
      setSelectedIndex(0);
      fetchItems();
      setActionPanelOpen(false);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
      if (item.text_content) {
        await navigator.clipboard.writeText(item.text_content).catch(console.error);
      }
    }
  };

  // F2 & F3 PREVIEW TOGGLE PROTOCOL (State machine: idle | out | snap | in):
  // Step 1: CONTENT-OUT (90ms linear fade to opacity 0)
  // Step 2: SNAP (add html.wm-resizing + 0ms animated SetWindowPos + layout snap behind opacity 0, wait 2 rAF ticks)
  // Step 3: CONTENT-IN (remove html.wm-resizing + 160ms opacity settle; preview stays spatially locked)
  // Interruption: if toggled during ANY in-flight phase, instantly finalize previous target state, then start fresh transition.
  // Watchdog: force-finalize if in-flight >380ms.
  // Reduced motion: instant snap without fade.
  const togglePreview = useCallback(() => {
    const isReduced =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (isReduced) {
      const next = !previewOpenRef.current;
      previewOpenRef.current = next;
      targetPreviewOpenRef.current = next;
      setPreviewOpen(next);
      invoke('set_overlay_preview', { enabled: next }).catch(console.error);
      return;
    }

    // F3 Single-live-layout rule:
    // If Tab is pressed during ANY phase of an in-flight transition:
    // 1. Instantly finalize the current phase (clear timers, settle state to target).
    // 2. Immediately begin the fresh transition from that settled state.
    if (previewPhaseRef.current !== 'idle') {
      finalizeTransition();
    }

    const currentSettled = previewOpenRef.current;
    const next = !currentSettled;
    targetPreviewOpenRef.current = next;

    // Watchdog timer: if any phase takes >380ms without completing, force-finalize to target state.
    if (watchdogTimerRef.current) window.clearTimeout(watchdogTimerRef.current);
    watchdogTimerRef.current = window.setTimeout(() => {
      console.warn('[overlay] Preview transition watchdog triggered (>380ms)');
      finalizeTransition(next);
    }, 380);

    // Phase 1: CONTENT-OUT (90ms linear fade to opacity 0)
    previewPhaseRef.current = 'out';
    setPreviewPhase('out');

    previewTimerRef.current = window.setTimeout(() => {
      // Phase 2: SNAP (0ms animated SetWindowPos + layout snap behind opacity 0)
      previewPhaseRef.current = 'snap';
      setPreviewPhase('snap');
      // F2 SNAP VEIL: veil ONLY the preview pane across the snap window.
      // REVERT NOTE (preview flash rework): an earlier revision masked the
      // FULL surface (html.wm-hidden), but that blacked out the whole card on
      // every toggle and could stick on rapid spam. The veil below covers just
      // the fresh pixels while list/card stay visible. To revert: delete the
      // veil add/remove lines here, at content-in start, and in
      // finalizeTransition (covering falls back to content fades only).
      document.documentElement.classList.add('wm-resizing');
      previewPaneRef.current?.classList.add('snap-veil');

      previewOpenRef.current = next;
      setPreviewOpen(next);
      sendPreviewSize(next);

      // Wait rAF ticks for DWM presentation of new size before content-in.
      // REVERT NOTE (first-snap white flash fix): the preview subtree stays
      // mounted while collapsed, so its first paint at real size happens here
      // — cold style/layout/paint (and image decode) miss the normal 2-tick
      // window and leak a white frame. The very first snap therefore waits 4
      // ticks (~64ms, still under the fade); later snaps keep 2. To revert:
      // replace needTicks with a constant 2 and delete previewSnappedOnceRef.
      const needTicks = previewSnappedOnceRef.current ? 2 : 4;
      previewSnappedOnceRef.current = true;
      let snapTicks = 0;
      const waitSnapTicks = () => {
        previewRafRef.current = requestAnimationFrame(() => {
          snapTicks += 1;
          if (snapTicks < needTicks) {
            waitSnapTicks();
            return;
          }
          // Phase 3: CONTENT-IN (160ms cubic-bezier; no translation)
          // Lift the pane veil as content fades back in (veil fades via CSS).
          document.documentElement.classList.remove('wm-resizing');
          previewPaneRef.current?.classList.remove('snap-veil'); // REVERT: preview flash rework (veil lift)
          previewPhaseRef.current = 'in';
          setPreviewPhase('in');

          previewTimerRef.current = window.setTimeout(() => {
            previewPhaseRef.current = 'idle';
            setPreviewPhase('idle');
            if (watchdogTimerRef.current) {
              window.clearTimeout(watchdogTimerRef.current);
              watchdogTimerRef.current = null;
            }
            previewTimerRef.current = null;
            requestAnimationFrame(assertSingleLiveLayout);
          }, 180);
        });
      };
      waitSnapTicks();
    }, 90);
  }, [finalizeTransition]);

  // The highlighted clip of the VISIBLE (possibly app-filtered) list — every
  // paste/queue/preview action must operate on this, not the unfiltered array.
  const selectedItem = displayItems[selectedIndex];

  // Keep editingContent synchronized with selectedItem so raw/edit mode never renders empty text
  useEffect(() => {
    setEditingContent(selectedItem?.text_content || '');
  }, [selectedItem?.id, selectedItem?.text_content]);

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
      }
    } catch (err) {
      console.error('Failed to extract/copy OCR:', err);
    }
  };

  const handleContentEdit = (newContent: string) => {
    setEditingContent(newContent);
    if (selectedItem) {
      invoke('update_clip_text', { id: selectedItem.id, newText: newContent })
        .then(() => {
          setItems((prev) =>
            prev.map((i) =>
              i.id === selectedItem.id
                ? { ...i, text_content: newContent, title: newContent.split('\n')[0].slice(0, 100) }
                : i
            )
          );
        })
        .catch(console.error);
    }
  };

  const handleAddClipsToCollection = async (clipId: string, collectionId: string) => {
    try {
      await invoke('add_clip_to_collection', { clipId, collectionId });
      setAddToColModalOpen(false);
      fetchCollections();
    } catch (err) {
      console.error('Failed to add clip to collection:', err);
    }
  };

  const handleCreateAndAddToCollection = async (clipId: string) => {
    if (!newColName.trim()) return;
    try {
      const chosenColor = collectionColorFor(newColName.trim());
      const col = await invoke<Collection>('create_collection', {
        name: newColName.trim(),
        color: chosenColor,
        icon: null,
      });
      if (col) {
        await invoke('add_clip_to_collection', { clipId, collectionId: col.id });
      }
      setNewColName('');
      setShowCreateInline(false);
      setAddToColModalOpen(false);
      fetchCollections();
    } catch (err) {
      console.error('Failed to create and add to collection:', err);
    }
  };

  const actionHandlers: ClipActionHandlers = {
    onPaste: (item, plainText, transform) => handlePaste(item, plainText, transform),
    onTogglePin: (item) => handleTogglePin(item),
    onCopy: (item) => handleCopyOnly(item),
    onDelete: (item) => handleDelete(item),
    onQueue: (item) => handleQueueClip(item),
    onExtractOcr: (item) => handleExtractOrCopyOcr(item),
    onAddToCollection: () => {
      setActionPanelOpen(false);
      if (!selectedItem) return;
      if (collections.length === 0) {
        // No collections: open the picker ready to create one
        setShowCreateInline(true);
        setNewColName('');
        setAddToColModalOpen(true);
      } else if (collections.length === 1) {
        // Single collection: add straight away, no chooser
        handleAddClipsToCollection(selectedItem.id, collections[0].id);
      } else {
        setShowCreateInline(false);
        setNewColName('');
        setAddToColModalOpen(true);
      }
    },
  };

  const modalActions = selectedItem ? getActionsForClip(selectedItem, targetApp, actionHandlers, false) : [];

  // Snippets-tab keyboard handling: mirrors the clips tab's feel
  // (Escape hides, Tab toggles preview, arrows navigate, Enter pastes,
  // Ctrl+C copies, Ctrl+K opens the action panel).
  const handleSnippetKeyDown = (e: React.KeyboardEvent | KeyboardEvent) => {
    // Sequential argument prompt owns all keys while open.
    if (snArgPrompt) {
      if (e.key === 'Escape') {
        e.preventDefault();
        snCloseArgPrompt(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const finalVal = snArgValue.trim()
          ? snArgValue
          : snArgPrompt.defaultValue ?? snArgValue;
        snCloseArgPrompt(finalVal);
      }
      return;
    }

    // Editor modal: Escape closes it; everything else belongs to the modal.
    if (snEditorTarget) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSnEditorTarget(null);
      }
      return;
    }

    // Action panel navigation.
    if (snActionOpen && snSelected) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSnActionIndex((p) => (p + 1) % snActions.length);
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSnActionIndex((p) => (p - 1 + snActions.length) % snActions.length);
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSnActionOpen(false);
        return;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const act = snActions[snActionIndex];
        if (act) {
          act.handler();
          setSnActionOpen(false);
        }
        return;
      }
    }

    // Global hotkey toggles (Ctrl+Shift+Z hides overlay, Ctrl+Alt+X toggles enlarged)
    if (matchesHotkeyCombo(e, hotkeyStatus?.overlay || 'Ctrl+Shift+Z')) {
      e.preventDefault();
      requestHide();
      return;
    }
    if (matchesHotkeyCombo(e, hotkeyStatus?.enlarged || 'Ctrl+Alt+X')) {
      e.preventDefault();
      invoke('toggle_enlarged').catch(console.error);
      return;
    }

    // Escape always hides overlay
    if (e.key === 'Escape') {
      e.preventDefault();
      requestHide();
      return;
    }

    // Tab / Ctrl+Shift+O toggles preview (same toggle as clips tab)
    if (e.key === 'Tab' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o')) {
      e.preventDefault();
      togglePreview();
      return;
    }

    // Ctrl+K opens the snippet action panel
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (snSelected) {
        setSnActionIndex(0);
        setSnActionOpen(true);
      }
      return;
    }

    // Left/Right arrows: same rule as the clips tab — caret movement
    // between characters while typing, and with an empty search bar they
    // toggle focus to the other tab's bar. They never move the list.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const t = e.target as HTMLElement;
      const inInput = t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA';
      if (!inInput) return;
      if (snSearch.trim() !== '') return;
      e.preventDefault();
      switchTab(e.key === 'ArrowRight' ? 'snippets' : 'clips');
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (snFilteredRef.current.length > 0) {
        const delta =
          e.key === 'ArrowUp' ? -1 : 1;
        snNavAccumRef.current += delta;
        if (snNavRafRef.current === null) {
          snNavRafRef.current = requestAnimationFrame(flushSnNavAccum);
        }
      }
      return;
    }

    // E opens the editor for the highlighted snippet; Del deletes it.
    // Only when focus isn't inside an input, so typing stays untouched
    // (arrows intentionally still navigate while the search is focused).
    const target = e.target as HTMLElement;
    const typingInInput =
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.tagName === 'SELECT';
    if (!typingInInput && (e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (snSelected) setSnEditorTarget({ snippet: snSelected });
      return;
    }
    // Del deletes the highlighted snippet. When caret-retention has left
    // focus in a search field that is EMPTY (nothing to edit), Delete must
    // still delete rather than silently do nothing.
    if (e.key === 'Delete' || e.key === 'Del') {
      if (typingInInput) {
        const el = target as HTMLInputElement;
        const hasText = (el.value?.length ?? 0) > 0;
        const hasSelection = (el.selectionStart ?? 0) !== (el.selectionEnd ?? 0);
        if (hasText || hasSelection) return;
      }
      e.preventDefault();
      if (snSelected) handleSnDelete(snSelected);
      return;
    }

    // Enter pastes the highlighted snippet; Ctrl+C copies it.
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      useSnippet(snSelected, 'paste');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      useSnippet(snSelected, 'copy');
      return;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent | KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isSearchInput = target === searchInputRef.current;
    const isTextarea = target && target.tagName === 'TEXTAREA';
    const isInput = isSearchInput || isTextarea || (target && target.tagName === 'INPUT');
    logClient(`handleKeyDown: key='${e.key}', ctrl=${e.ctrlKey}, alt=${e.altKey}, shift=${e.shiftKey}, isInput=${isInput}`);

    // Snippets tab owns its own key handling (prompts, action panel,
    // list navigation, paste/copy) — clips shortcuts never apply there.
    if (tabRef.current === 'snippets') {
      handleSnippetKeyDown(e);
      return;
    }

    // Global hotkey toggles (Ctrl+Shift+Z hides overlay, Ctrl+Alt+X toggles enlarged)
    // Checked before search/input handling so pressing hotkeys inside the search input
    // instantly toggles/hides without triggering browser Redo or typing!
    if (matchesHotkeyCombo(e, hotkeyStatus?.overlay || 'Ctrl+Shift+Z')) {
      e.preventDefault();
      e.stopPropagation();
      logClient('Overlay toggle hotkey pressed inside overlay webview, running hide choreography');
      requestHide();
      return;
    }
    if (matchesHotkeyCombo(e, hotkeyStatus?.enlarged || 'Ctrl+Alt+X')) {
      e.preventDefault();
      e.stopPropagation();
      logClient('Enlarged toggle hotkey pressed inside overlay webview, invoking toggle_enlarged');
      invoke('toggle_enlarged').catch(console.error);
      return;
    }

    // Modal-specific guards
    if (addToColModalOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setAddToColModalOpen(false);
        setShowCreateInline(false);
        return;
      }
      if (isInput) {
        return; // Allow typing in the collection name input without triggering global hotkeys
      }
    }

    // Priority: Shift+Enter ALWAYS adds the selected clip to queue regardless of focus
    if (e.shiftKey && e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setActionPanelOpen(false);
      if (selectedItem) {
        handleQueueClip(selectedItem);
      }
      return;
    }

    // When focused in the editable preview textarea:
    if (isTextarea) {
      if (e.key === 'Escape') {
        e.preventDefault();
        target.blur();
        focusSearchInput();
        return;
      }
      // Ctrl+Enter or Cmd+Enter inside textarea pastes the edited text directly
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        setActionPanelOpen(false);
        if (selectedItem) {
          handlePaste(selectedItem, false);
        }
        return;
      }
      // Allow regular typing, Enter (for newlines), and Arrow navigation inside the textarea
      return;
    }

    // Quick Q key to queue when not typing in the search text
    if (!isInput && (e.key === 'q' || e.key === 'Q') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setActionPanelOpen(false);
      if (selectedItem) {
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
      if (selectedItem && handleClipKeyDown(e, selectedItem, actionHandlers)) {
        setActionPanelOpen(false);
        return;
      }
    }

    // Escape always hides overlay
    if (e.key === 'Escape') {
      e.preventDefault();
      logClient('Escape pressed, running hide choreography');
      requestHide();
      return;
    }

    // Ctrl+K opens Action Panel
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (displayItems.length > 0) {
        setActionIndex(0);
        setActionPanelOpen(true);
      }
      return;
    }

    // Tab or Ctrl+Shift+O toggles preview
    if (e.key === 'Tab' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o')) {
      e.preventDefault();
      togglePreview();
      return;
    }

    // Left/Right arrows: in the search bar they move the caret between
    // characters while there's text. With the bar empty there is no caret
    // to move, so they toggle focus only — jump to the other tab's search
    // bar (clips <-> snippets), nothing else (no list scrolling). Outside
    // inputs they do nothing (focus retention keeps the bar focused).
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!isInput) return;
      if (search.trim() !== '') return;
      e.preventDefault();
      switchTab(e.key === 'ArrowRight' ? 'snippets' : 'clips');
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (displayItems.length > 0) {
        navAccumRef.current += e.key === 'ArrowDown' ? 1 : -1;
        if (navRafRef.current === null) {
          navRafRef.current = requestAnimationFrame(flushNavAccum);
        }
      }
      return;
    }

    // Number-key quick paste (1–9):
    // Instant paste of visible row index when search is empty or with Alt/Ctrl modifier
    if (!actionPanelOpen && /^[1-9]$/.test(e.key) && (!isInput || search === '' || e.altKey || e.ctrlKey)) {
      const digit = parseInt(e.key, 10);
      const targetIdx = digit - 1;
      if (targetIdx >= 0 && targetIdx < displayItems.length) {
        e.preventDefault();
        logClient(`Number key ${digit} pressed, quick-pasting visible row index ${targetIdx}`);
        handlePaste(displayItems[targetIdx], false);
        return;
      }
    }

    // Backspace always belongs to text editing. Delete only does while there
    // is actually text to edit: an EMPTY search bar has no caret work, so
    // Delete falls through to the clip actions below. This matters because
    // caret-retention keeps the search bar focused after any click — without
    // this, plain Delete silently did nothing after clicking around.
    if (isInput && e.key === 'Backspace') return;
    if (isSearchInput && e.key === 'Delete') {
      const el = target as HTMLInputElement;
      const hasText = (el.value?.length ?? 0) > 0;
      const hasSelection = (el.selectionStart ?? 0) !== (el.selectionEnd ?? 0);
      if (hasText || hasSelection) return;
    } else if (isInput && e.key === 'Delete') {
      return;
    }

    // Clip actions (Enter to paste, Ctrl+Enter, Ctrl+Shift+M, Ctrl+Shift+V, Ctrl+D, Ctrl+C, Del)
    if (selectedItem && handleClipKeyDown(e, selectedItem, actionHandlers)) {
      setActionPanelOpen(false);
      return;
    }
  };

  // Frame-locked arrow navigation (same pattern as EnlargedWindow): rapid
  // key auto-repeat is capped at one step per animation frame so holding an
  // arrow key scrolls smoothly instead of bursting/jumping.
  const navAccumRef = useRef(0);
  const navRafRef = useRef<number | null>(null);

  const flushNavAccum = () => {
    navRafRef.current = null;
    const steps = navAccumRef.current;
    if (steps === 0) return;
    navAccumRef.current = 0;
    setSelectedIndex((prev) => {
      if (displayItems.length === 0) return prev;
      const next = (prev + steps) % displayItems.length;
      return next < 0 ? next + displayItems.length : next;
    });
  };

  useEffect(() => () => {
    if (navRafRef.current !== null) cancelAnimationFrame(navRafRef.current);
  }, []);

  const handleKeyDownRef = useRef<(e: React.KeyboardEvent | KeyboardEvent) => void>(() => {});
  handleKeyDownRef.current = handleKeyDown;

  // Single window-level keydown listener ensures all shortcuts trigger anywhere in overlay without double-firing
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
      ref={containerRef}
      className="overlay-container"
      tabIndex={-1}
      onBlur={(e: React.FocusEvent<HTMLDivElement>) => {
        // Caret retention: focus may only leave the search bar for an
        // editable control (input/textarea/select/contenteditable).
        // Clicking rows, the preview, gaps or buttons keeps the caret
        // blinking and the arrow keys working.
        const next = e.relatedTarget as HTMLElement | null;
        if (!next) return; // focus left the overlay entirely
        if (next.closest('input, textarea, select, [contenteditable="true"]')) return;
        // Custom dropdowns portal their option lists to document.body, so
        // focus legitimately lands outside this container while a picker is
        // open. Stealing caret focus back closed the list instantly (first
        // click on the trigger did nothing, choosing an option exited).
        if (next.closest('.c-dropdown, .c-dropdown-list')) return;
        const input =
          tabRef.current === 'snippets' ? snSearchInputRef.current : searchInputRef.current;
        if (input) setTimeout(() => input.focus(), 0);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
    >
      <div className={`overlay ${!previewOpen ? 'no-preview' : ''} ${tab === 'snippets' ? 'sn-tab' : ''}`}>
        <div
          id="content"
          className={`overlay-content ${
            previewPhase === 'out'
              ? 'content-fading-out'
              : previewPhase === 'in'
              ? 'content-fading-in'
              : ''
          }`}
          data-carbon-layout-layer="overlay"
        >
        {/* Top Search Bar — no tab switcher header: reopening restores the
            view you left (clips or snippets, preview open or closed). The
            placeholder announces the active tab; Left/Right in an empty
            bar toggle focus to the other tab's bar. */}
        <div className={`searchbar has-app-filter ${tab === 'snippets' ? 'inactive-tab' : ''}`}>
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
              autoFocus
            />
            {search && (
              <button
                className="searchbar-clear-btn"
                onClick={() => {
                  setSearch('');
                  focusSearchInput();
                }}
                title="Clear search query"
              >
                ✕
              </button>
            )}
            <Dropdown
              className="app-filter-dd"
              value={typeFilter}
              onChange={setTypeFilter}
              align="end"
              ariaLabel="Filter by type"
              title="Filter by type"
              options={[
                { value: '__all__', label: 'All Types' },
                {
                  value: 'pinned',
                  label: 'Favorites',
                  icon: (
                    <span style={{ color: '#F59E0B', display: 'inline-flex' }}>
                      <StarIcon />
                    </span>
                  ),
                },
                ...typeFilterOptions,
              ]}
            />
          </div>
          <div className={`searchbar sn-searchbar ${tab === 'clips' ? 'inactive-tab' : ''}`}>
            <span className="search-ic">
              <SearchIcon />
            </span>
            <input
              ref={snSearchInputRef}
              placeholder="Search snippets..."
              value={snSearch}
              onChange={(e) => setSnSearch(e.target.value)}
            />
            {snSearch && (
              <button
                className="searchbar-clear-btn"
                onClick={() => {
                  setSnSearch('');
                  focusSearchInput();
                }}
                title="Clear search query"
              >
                ✕
              </button>
            )}
            <span className="filter-box" title="Filter by tag">
              <FilterIcon className="filter-box-ic" />
              <Dropdown
                className="sn-tag-dd sn-tag-dd-overlay"
                value={snTagFilter}
                onChange={setSnTagFilter}
                align="end"
                ariaLabel="Filter by tag"
                options={[
                  { value: '__all__', label: 'All Tags' },
                  ...snAllTags.map((t) => ({ value: t, label: t })),
                ]}
              />
            </span>
          </div>

        {tab === 'clips' && pasteQueue.length > 0 && (
          <div className="queue-banner" style={{ margin: '0 10px 8px 10px' }}>
            <div className="queue-banner-left">
              <span className="queue-tag">Queue ({pasteQueue.length})</span>
              <span className="queue-dot">·</span>
              <div className="queue-next-meta" title={pasteQueue[0]?.title}>
                <span>Next:</span>
                <span className="queue-next-title">{constrainTitle(pasteQueue[0]?.title || '', 30)}</span>
              </div>
            </div>
            <div className="queue-banner-right">
              <span className="queue-auto-hint">Ctrl+V pastes in order</span>
              <button
                className="queue-clear-btn"
                title="Clear paste queue"
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

        {/* Master-Detail Layout */}
        <div className="overlay-body">
          <div className={`overlay-list ${tab === 'snippets' ? 'inactive-tab' : ''}`}>
            {displayItems.length === 0 ? (
              initialLoaded ? (
                <div className="empty">
                  <div className="big">No entries found</div>
                  <div className="sub">Nothing matched your current filter and search query</div>
                  {hotkeyStatus?.enlarged && (
                    <div className="sugg" style={{ marginTop: 8 }}>
                      <span onClick={() => invoke('toggle_enlarged')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                        Open full history ({hotkeyStatus.enlarged})
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="ov-loading" aria-label="Loading clips">
                  <div className="sk" />
                  <div className="sk" />
                  <div className="sk" />
                  <div className="sk" />
                  <div className="sk" />
                  <div className="sk" />
                </div>
              )
            ) : (
              (() => {
                const groups = groupItemsByDate(displayItems);
                let globalIdx = 0;

                return groups.map((group) => (
                  <div key={group.label} className="date-group">
                    <div className="date-group-label">{group.label}</div>
                    {group.items.map((item) => {
                      const currentIdx = globalIdx++;
                      const isSelected = selectedIndex === currentIdx;
                      const queueIdx = pasteQueue.findIndex((q) => q.id === item.id);

                      return (
                        <OverlayRow
                          key={item.id}
                          item={item}
                          index={currentIdx}
                          isSelected={isSelected}
                          isDragging={draggingId === item.id}
                          queueIdx={queueIdx}
                          onSelect={handleSelectRow}
                          onDragStart={handleOverlayDragStart}
                          onDragEnd={handleOverlayDragEnd}
                        />
                      );
                  })}
                </div>
              ));
            })()
          )}
          </div>
          {/* Snippets list (always mounted; hidden when the Clips tab is active) */}
          <div className={`overlay-list sn-overlay-list ${tab === 'clips' ? 'inactive-tab' : ''}`}>
            {snSnippets.length === 0 ? (
              snInitialLoaded ? (
                <div className="empty">
                  <div className="big">No snippets yet</div>
                  <div className="sub">Create snippets from the full window, then recall them here.</div>
                </div>
              ) : (
                <div className="ov-loading" aria-label="Loading snippets">
                  <div className="sk" />
                  <div className="sk" />
                  <div className="sk" />
                  <div className="sk" />
                </div>
              )
            ) : snFiltered.length === 0 ? (
              <div className="empty">
                <div className="big">No snippets found</div>
                <div className="sub">Nothing matched your search and tag filter</div>
              </div>
            ) : (
              snGrouped.map((group) => (
                <div key={group.label} className="date-group">
                  <div className="date-group-label">{group.label}</div>
                  {group.items.map((s) => {
                    const Icon = snippetIconFor(s.icon);
                    const isSelected = snSelectedId === s.id;
                    return (
                      <div
                        key={s.id}
                        id={`sn-ov-row-${s.id}`}
                        className={`snippet-row sn-row-single ${isSelected ? 'selected' : ''}`}
                        onClick={() => {
                          setSnSelectedId(s.id);
                          focusSearchInput();
                        }}
                      >
                        <span className="sn-row-ic"><Icon /></span>
                        <span className="sn-row-main-single">
                          <span className="sn-row-name">{s.name}</span>
                          <span className="sn-keyword-badge">{s.keyword || '/'}</span>
                          {(s.tags || []).length > 0 && (
                            <span className="sn-row-tags">
                              {(s.tags || []).slice(0, 1).map((t) => (
                                <span key={t} className="sn-mini-tag">#{t}</span>
                              ))}
                              {(s.tags || []).length > 1 && <span className="sn-mini-tag">+{(s.tags || []).length - 1}</span>}
                            </span>
                          )}
                        </span>
                        <span className="sn-row-time">{formatSnippetLastUsed(s.last_used_at)}</span>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          <div ref={previewPaneRef} className={`overlay-preview ${!previewOpen ? 'collapsed' : ''}`}>
            {tab === 'snippets' ? (
              snSelected ? (
                <>
                  <div className="overlay-preview-head">
                    <span className="preview-kind" style={{ color: 'var(--accent)' }}>
                      <span className="sn-detail-ic">{SnSelectedIcon && <SnSelectedIcon />}</span>
                      <span className="sn-preview-name">{snSelected.name}</span>
                      {snSelected.keyword && <span className="sn-keyword-badge">{snSelected.keyword}</span>}
                    </span>
                  </div>
                  <div className="overlay-preview-content">
                    <div className="sn-content-preview sn-overlay-content">
                      {snHighlighted.map((seg, i) =>
                        seg.cls === 'plain' ? (
                          <React.Fragment key={i}>{seg.text}</React.Fragment>
                        ) : (
                          <span key={i} className={seg.cls}>{seg.text}</span>
                        )
                      )}
                      {snSelected.content.length === 0 && <span className="sn-content-empty">Empty snippet — add content in the full window.</span>}
                    </div>
                  </div>
                  <div className="sn-overlay-meta">
                    {(snSelected.tags || []).length > 0 && (
                      <div className="sn-detail-tags">
                        {(snSelected.tags || []).map((t) => (
                          <span key={t} className="sn-tag-chip" onClick={() => setSnTagFilter(t)}>{t}</span>
                        ))}
                      </div>
                    )}
                    <span className="sn-overlay-used">
                      Used {snSelected.use_count.toLocaleString()}× · last {formatSnippetLastUsed(snSelected.last_used_at).toLowerCase()}
                    </span>
                  </div>
                </>
              ) : (
                <div className="sn-overlay-empty">Select a snippet to inspect it.</div>
              )
            ) : (
              selectedItem && (() => {
                const hasRenderedVersion =
                  selectedItem.content_type === 'rich_text' ||
                  (Boolean(selectedItem.text_content) && isMarkdownContent(selectedItem.text_content!));

                return (
                  <>
                    <div className="overlay-preview-head">
                      <span
                        className="preview-kind"
                        style={{ color: getTypeColor(selectedItem.content_type) }}
                      >
                        {getTypeIcon(selectedItem.content_type)}
                        {getSpecificTypeLabel(selectedItem)}
                      </span>
                      {selectedItem.content_type !== 'image' && selectedItem.content_type !== 'file' && hasRenderedVersion && (
                        <div className="seg" style={{ marginLeft: 'auto' }}>
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
                    </div>
                    <div className="overlay-preview-content">
                      {selectedItem.content_type === 'image' || selectedItem.content_type === 'file' ? (
                        <div
                          draggable
                          title="Drag to drop into any app"
                          style={{ display: 'contents' }}
                          onDragStart={(e) => handleOverlayDragStart(selectedItem, e)}
                          onDragEnd={handleOverlayDragEnd}
                        >
                          <ClipPreview item={selectedItem} />
                        </div>
                      ) : hasRenderedVersion && renderMode ? (
                        <div className="preview-render">
                          <ClipPreview item={selectedItem} forceRaw={false} />
                        </div>
                      ) : (
                        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                          {selectedItem.content_type === 'color' && (
                            <div className="color-swatch-box" style={{ background: selectedItem.title }}>
                              {selectedItem.title}
                            </div>
                          )}
                          <textarea
                            className="preview-edit"
                            spellCheck={false}
                            value={editingContent}
                            onChange={(e) => handleContentEdit(e.target.value)}
                            placeholder="Edit clip text..."
                          />
                        </div>
                      )}
                    </div>
                    <ClipMetaStrip item={selectedItem} onFilterByApp={(app) => setSourceAppFilter(app)} />
                  </>
                );
              })()
            )}
          </div>
        </div>

        <div className="overlay-bar">
          <div className="bar-left">
            <span
              className="hint primary"
              onClick={() => {
                if (tab === 'snippets') {
                  if (snSelected) useSnippet(snSelected, 'paste');
                } else {
                  if (selectedItem) handlePaste(selectedItem, false);
                }
              }}
            >
              <span className="key">Enter</span>
              <b>{targetApp ? `Paste to ${targetApp}` : 'Paste'}</b>
            </span>
            <span className="hint" onClick={togglePreview}>
              <span className="key">Tab</span>
              <b>{previewOpen ? 'Hide Preview' : 'Show Preview'}</b>
            </span>
            <span
              className="hint"
              onClick={() => {
                if (tab === 'snippets') {
                  setSnActionIndex(0);
                  setSnActionOpen(true);
                } else {
                  setActionIndex(0);
                  setActionPanelOpen(true);
                }
              }}
            >
              <span className="key">Ctrl+K</span>
              <b>Actions</b>
            </span>
          </div>
          <div className="bar-right">
            <span className="hint" onClick={() => requestHide()}>
              <span className="key">Esc</span>
              <b>Close</b>
            </span>
          </div>
        </div>
      </div>

        {/* Action Panel Modal (Ctrl+K) */}
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

        {/* Add to Collection Modal in Overlay */}
        {addToColModalOpen && selectedItem && (
          <div className="modal-backdrop" onClick={() => setAddToColModalOpen(false)}>
            <div className="modal-card add-to-col-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-head-icon" style={{ color: 'var(--accent)' }}>
                  <FolderIcon />
                </span>
                <span className="modal-title">Add clip to Collection</span>
                <button
                  className="modal-close-btn"
                  onClick={() => {
                    setAddToColModalOpen(false);
                    setShowCreateInline(false);
                    setNewColName('');
                  }}
                >
                  ✕
                </button>
              </div>
              <div className="modal-body col-selection-list">
                {collections.length === 0 && !showCreateInline ? (
                  <div className="col-empty-hint">No collections yet. Create your first collection below:</div>
                ) : (
                  collections.map((col) => {
                    const colColor = normalizeCollectionColor(col.color) || collectionColorFor(col.name);
                    return (
                      <button
                        key={col.id}
                        className="col-select-row"
                        onClick={() => handleAddClipsToCollection(selectedItem.id, col.id)}
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

                {showCreateInline ? (
                  <div className="col-create-inline-card">
                    <div className="modal-field">
                      <div className="col-name-input-wrap">
                        <input
                          type="text"
                          className="modal-input"
                          placeholder="Collection name..."
                          value={newColName}
                          onChange={(e) => setNewColName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleCreateAndAddToCollection(selectedItem.id);
                            }
                          }}
                          autoFocus
                        />
                        <span
                          className="col-name-dot"
                          style={{ background: collectionColorFor(newColName) }}
                        />
                      </div>
                    </div>
                    <div className="col-create-actions">
                      <button
                        type="button"
                        className="btn subtle"
                        onClick={() => setShowCreateInline(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={!newColName.trim()}
                        onClick={() => handleCreateAndAddToCollection(selectedItem.id)}
                      >
                        Create &amp; Add
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="col-select-row create-new-col-btn"
                    onClick={() => {
                      setNewColName('');
                      setShowCreateInline(true);
                    }}
                  >
                    <span className="col-select-icon" style={{ color: 'var(--accent)' }}>
                      <PlusIcon />
                    </span>
                    <span className="col-select-name">Create New Collection...</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Snippets: action panel (Ctrl+K) */}
        {snActionOpen && snSelected && (
          <div className="action-modal-overlay" onClick={() => setSnActionOpen(false)}>
            <div className="action-modal" onClick={(e) => e.stopPropagation()}>
              {snActions.map((act, i) => (
                <div
                  key={act.id}
                  className={`action-item ${i === snActionIndex ? 'selected' : ''} ${act.danger ? 'danger' : ''}`}
                  onClick={() => {
                    act.handler();
                    setSnActionOpen(false);
                  }}
                  onMouseEnter={() => setSnActionIndex(i)}
                >
                  <span className="action-item-left">
                    {act.icon} {act.label}
                  </span>
                  <span className="key">{act.shortcut}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Snippets: shared confirmation/error pill */}
        {snPill && (
          <div className={`sn-confirm-pill ${snPill.error ? 'error' : ''}`}>
            {snPill.error ? <span className="sn-pill-x">✕</span> : <span className="sn-pill-check">✓</span>} {snPill.text}
          </div>
        )}

        {/* Snippets: sequential argument prompt (shared component) */}
        {snArgPrompt && (
          <SnippetArgPrompt
            spec={snArgPrompt}
            value={snArgValue}
            onChange={setSnArgValue}
            onInsert={(v) => snCloseArgPrompt(v)}
            onCancel={() => snCloseArgPrompt(null)}
          />
        )}

        {/* Snippets: create/edit dialog — same shared component as the
            enlarged window (same editor, same behavior, same tokens) */}
        {snEditorTarget && (
          <SnippetEditorModal
            key={snEditorTarget.snippet?.id ?? 'new'}
            snippet={snEditorTarget.snippet}
            onClose={() => setSnEditorTarget(null)}
            onSaved={(saved) => {
              setSnSnippets((prev) => {
                const exists = prev.some((s) => s.id === saved.id);
                return exists ? prev.map((s) => (s.id === saved.id ? saved : s)) : [saved, ...prev];
              });
              setSnSelectedId(saved.id);
              setSnEditorTarget(null);
              showSnPill(`Saved "${saved.name}"`);
            }}
          />
        )}
      </div>
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
