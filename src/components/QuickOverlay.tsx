import React, { useEffect, useLayoutEffect, useState, useRef, memo, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ClipItem, HotkeyStatus, AppSettings, Collection, Snippet } from '../types';
import { ClipPreview, ClipMetaStrip, getSpecificTypeLabel, isMarkdownContent, appDisplayName } from './ClipPreview';
import { getActionsForClip, handleClipKeyDown, ClipActionHandlers } from '../utils/clipActions';
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
  snippetIconFor,
  getTypeIcon,
  getTypeColor,
} from './Icons';
import { SnippetEditorModal } from './SnippetEditorModal';
import { Dropdown } from './Dropdown';

declare global {
  interface Window {
    __carbonSetData?: (data: ClipItem[]) => void;
  }
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
  queueIdx,
  onSelect,
}: {
  item: ClipItem;
  index: number;
  isSelected: boolean;
  queueIdx: number;
  onSelect: (idx: number) => void;
}) {
  const tint = getTypeColor(item.content_type);
  return (
    <div
      id={`overlay-row-${index}`}
      className={`row ${isSelected ? 'selected' : ''} ${queueIdx >= 0 ? 'in-queue' : ''}`}
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
        <div className="row-meta">
          <span className="row-time">{formatTimeAgo(item.created_at)}</span>
        </div>
      </div>
    </div>
  );
});

export const QuickOverlay: React.FC = () => {
  const [tab, setTab] = useState<'clips' | 'snippets'>('clips');
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const [items, setItems] = useState<ClipItem[]>([]);
  const [pasteQueue, setPasteQueue] = useState<ClipItem[]>([]);
  // Pending native-window resize for the preview toggle (see togglePreview)
  const previewResizeTimer = useRef<number | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [addToColModalOpen, setAddToColModalOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [showCreateInline, setShowCreateInline] = useState(false);
  const [search, setSearch] = useState('');
  // Application filter chip in the searchbar (same behavior as the main app:
  // click the APPLICATION value in the preview to filter, ✕ to clear).
  const [sourceAppFilter, setSourceAppFilter] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [renderMode, setRenderMode] = useState<boolean>(true);
  const [editingContent, setEditingContent] = useState<string>('');
  const [actionPanelOpen, setActionPanelOpen] = useState(false);
  const [actionIndex, setActionIndex] = useState(0);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [showSnippets, setShowSnippets] = useState(true);
  const [targetApp, setTargetApp] = useState<string | null>(null);

  // ── Snippets tab state ────────────────────────────────────────────
  const [snSnippets, setSnSnippets] = useState<Snippet[]>([]);
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
      setSelectedIndex(0);
    } catch (err) {
      console.error('Failed to fetch clips:', err);
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

  // Distinct source applications present in the clipboard history — feeds the
  // Raycast-style "All Apps" filter box in the overlay's clips searchbar.
  const appFilterOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of items) {
      if (i.source_app && !seen.has(i.source_app)) seen.set(i.source_app, appDisplayName(i.source_app));
    }
    return Array.from(seen.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([raw, label]) => ({ value: raw, label }));
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

  // Client-side application filter (mirrors EnlargedWindow semantics)
  const displayItems = useMemo(
    () =>
      sourceAppFilter
        ? items.filter(
            (i) => i.source_app && i.source_app.toLowerCase() === sourceAppFilter.toLowerCase()
          )
        : items,
    [items, sourceAppFilter]
  );

  // Reset highlight when the filter changes so Enter/preview stay valid
  useEffect(() => {
    setSelectedIndex(0);
  }, [sourceAppFilter]);

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
    setSnActionOpen(false);
    setActionPanelOpen(false);
    focusSearchInput();
  };

  // Stable row-select handler for memoized rows (identity never changes)
  const handleSelectRow = useCallback((idx: number) => {
    setSelectedIndex(idx);
    focusSearchInput();
  }, []);

  // ── Settings-driven behavior ───────────────────────────────────────
  // The overlay opens with the user's chosen tab and preview state, and
  // stays in sync live (settings-updated fires in every window).
  const applyOverlaySettings = useCallback((s: AppSettings) => {
    if (typeof s.preview_enabled === 'boolean') setPreviewOpen(s.preview_enabled);
    if (typeof s.show_snippets === 'boolean') {
      setShowSnippets(s.show_snippets);
      if (!s.show_snippets) {
        tabRef.current = 'clips';
        setTab('clips');
        return;
      }
    }
    const next = s.overlay_default_tab === 'snippets' ? 'snippets' : 'clips';
    tabRef.current = next;
    setTab(next);
  }, []);

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
        setSelectedIndex(0);
      }
    };

    window.__carbonSetSnippets = (data: Snippet[]) => {
      if (Array.isArray(data)) {
        setSnSnippets(data);
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
        setSnSelectedId((prev) => {
          if (list.length === 0) return null;
          return prev && list.some((s) => s.id === prev) ? prev : list[0].id;
        });
      }
    });

    const unlistenOpened = safeListen('overlay-opened', () => {
      logClient('Received overlay-opened event.');
      setSearch('');
      setActionPanelOpen(false);
      setActionIndex(0);
      setSnSearch('');
      setSnActionOpen(false);
      setSnActionIndex(0);
      loadTargetApp();
      fetchLatest();
      fetchSnippets();
      // Restore the previous view: the active tab and the preview state
      // stay exactly as the user left them — reopening never resets back
      // to the default tab. The Rust-side overlay-data / overlay-snippets
      // pushes keep both lists instant. Just focus the search bar.
      focusSearchInput();
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
      fetchLatest();
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
      await invoke('toggle_pin_clip', { id: item.id });
      fetchItems();
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

  const togglePreview = () => {
    setPreviewOpen((prev) => {
      const next = !prev;
      // Sequence: let the pane slide shut/open via CSS first, THEN resize the
      // native window once the content has settled. Resizing simultaneously
      // made the OS-level snap fight the animation (the "jump").
      if (previewResizeTimer.current) window.clearTimeout(previewResizeTimer.current);
      previewResizeTimer.current = window.setTimeout(
        () => {
          invoke('set_overlay_preview', { enabled: next }).catch(console.error);
        },
        // Opening: grow the (smoothly animated) window right away so the pane
        // unfolds into new space. Closing: fold the pane first, then contract.
        next ? 0 : 150
      );
      return next;
    });
  };

  // The highlighted clip of the VISIBLE (possibly app-filtered) list — every
  // paste/queue/preview action must operate on this, not the unfiltered array.
  const selectedItem = displayItems[selectedIndex];

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

    // Escape always hides overlay
    if (e.key === 'Escape') {
      e.preventDefault();
      invoke('hide_overlay').catch(console.error);
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
      logClient('Escape pressed, invoking hide_overlay');
      invoke('hide_overlay').catch(console.error);
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
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown);
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
              value={sourceAppFilter ?? '__all__'}
              onChange={(v) => setSourceAppFilter(v === '__all__' ? null : v)}
              align="end"
              ariaLabel="Filter by application"
              title="Filter by application"
              options={[{ value: '__all__', label: 'All Apps' }, ...appFilterOptions]}
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
                          queueIdx={queueIdx}
                          onSelect={handleSelectRow}
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
              <div className="empty">
                <div className="big">No snippets yet</div>
                <div className="sub">Create snippets from the full window, then recall them here.</div>
              </div>
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
          <div className={`overlay-preview ${!previewOpen ? 'collapsed' : ''}`}>
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
                  Boolean(selectedItem.html_content) ||
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
                        <ClipPreview item={selectedItem} />
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
            <span className="hint" onClick={() => invoke('hide_overlay')}>
              <span className="key">Esc</span>
              <b>Close</b>
            </span>
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
