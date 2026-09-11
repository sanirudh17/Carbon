import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Snippet } from '../types';
import {
  highlightSnippetTokens,
  ArgumentSpec,
  snippetBucketFor,
  SNIPPET_BUCKET_ORDER,
  formatSnippetLastUsed,
  filterSnippets,
} from '../utils/snippets';
import { useSnippetFlow } from '../utils/useSnippetFlow';
import { SnippetArgPrompt } from './SnippetArgPrompt';
import { SnippetEditorModal } from './SnippetEditorModal';
import { Dropdown } from './Dropdown';
import { snippetIconFor, SearchIcon,
  CopyIcon,
  PasteIcon,
  EditIcon,
  DeleteIcon,
  PlusIcon,
  MoreIcon,
  CheckIcon,
  FilterIcon,
} from './Icons';

interface ActionEntry {
  id: string;
  label: string;
  shortcut: string;
  icon: React.ReactNode;
  danger?: boolean;
  handler: () => void;
}

export const SnippetsView: React.FC<{
  createSignal: number;
  /** Warm cache from the parent — lets the section render instantly. */
  initialSnippets?: Snippet[];
}> = ({ createSignal, initialSnippets }) => {
  const [snippets, setSnippets] = useState<Snippet[]>(initialSnippets ?? []);
  const [loading, setLoading] = useState(!(initialSnippets && initialSnippets.length > 0));
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string>('__all__');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Create / edit dialog (shared component; null = create, else edit)
  const [editorTarget, setEditorTarget] = useState<{ snippet: Snippet | null } | null>(null);

  // Argument prompt (sequential, first-appearance order)
  const [argPrompt, setArgPrompt] = useState<ArgumentSpec & { resolvedDefault?: string } | null>(null);
  const [argValue, setArgValue] = useState('');
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  // Action panel (Ctrl+K)
  const [actionOpen, setActionOpen] = useState(false);
  const [actionIndex, setActionIndex] = useState(0);
  const activeActionRef = useRef<HTMLDivElement>(null);

  // Confirmation pill
  const [confirmPill, setConfirmPill] = useState<{ text: string; error?: boolean } | null>(null);
  const confirmTimerRef = useRef<number | null>(null);

  // Latest selection / actions, kept in refs so the window keydown handler
  // never acts on a stale selection (e.g. click a row then instantly press Enter).
  const selectedRef = useRef<Snippet | null>(null);
  const actionsRef = useRef<ActionEntry[]>([]);

  // Arrow-key navigation (rAF-coalesced like the clips list, so holding the
  // arrow scrolls smoothly instead of piling up keydowns).
  const navAccumRef = useRef(0);
  const navRafRef = useRef<number | null>(null);
  const filteredRef = useRef<Snippet[]>([]);

  // Row context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; snippet: Snippet } | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const fetchSnippets = useCallback(async () => {
    try {
      const list = await invoke<Snippet[]>('list_snippets');
      setSnippets(list || []);
    } catch (err) {
      console.error('Failed to fetch snippets:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Silent background refresh — the cache already covers first paint.
  useEffect(() => {
    fetchSnippets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchSnippets]);

  // Sidebar "+" → open the create dialog.
  useEffect(() => {
    if (createSignal > 0) {
      openCreateDialog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal]);

  const openCreateDialog = () => {
    setEditorTarget({ snippet: null });
  };

  const openEditDialog = (snippet: Snippet) => {
    setEditorTarget({ snippet });
  };

  const handleSaved = useCallback((saved: Snippet) => {
    setSnippets((prev) => {
      const exists = prev.some((s) => s.id === saved.id);
      return exists ? prev.map((s) => (s.id === saved.id ? saved : s)) : [saved, ...prev];
    });
    setSelectedId(saved.id);
    setEditorTarget(null);
  }, []);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of snippets) {
      for (const t of s.tags || []) set.add(t);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [snippets]);

  const filtered = useMemo(
    () => filterSnippets(snippets, search, tagFilter),
    [snippets, search, tagFilter]
  );

  filteredRef.current = filtered;

  const grouped = useMemo(() => {
    const map = new Map<string, Snippet[]>();
    for (const s of filtered) {
      const bucket = snippetBucketFor(s.last_used_at || s.created_at);
      if (!map.has(bucket)) map.set(bucket, []);
      map.get(bucket)!.push(s);
    }
    return SNIPPET_BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({ label: b, items: map.get(b)! }));
  }, [filtered]);

  const selected = useMemo(
    () => snippets.find((s) => s.id === selectedId) ?? null,
    [snippets, selectedId]
  );

  // Mirror the clips view: the first row is auto-selected so the capture +
  // preview layout is populated the moment the section opens. If the current
  // selection ever leaves the filtered set, fall back to the first row
  // instead of dropping to an empty preview.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((s) => s.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const showConfirmPill = (text: string, error = false) => {
    if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
    setConfirmPill({ text, error });
    confirmTimerRef.current = window.setTimeout(() => setConfirmPill(null), 4200);
  };

  const promptArgument = useCallback((spec: ArgumentSpec & { resolvedDefault?: string }) => {
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
      setArgValue(spec.resolvedDefault ?? spec.defaultValue ?? '');
      setArgPrompt(spec);
    });
  }, []);

  const closeArgPrompt = useCallback((value: string | null) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setArgPrompt(null);
    if (resolver) resolver(value);
  }, []);

  const { useSnippet } = useSnippetFlow({
    snippets,
    promptArgument,
    onConfirm: (text) => showConfirmPill(text),
    onError: (text) => showConfirmPill(text, true),
    onUsed: () => fetchSnippets(),
  });

  const handleDelete = (snippet: Snippet) => {
    // Optimistic: drop it from the UI immediately, persist in the background.
    // Any error rolls the view back via a fresh fetch.
    setSnippets((prev) => prev.filter((s) => s.id !== snippet.id));
    if (selectedId === snippet.id) setSelectedId(null);
    invoke('delete_snippet', { id: snippet.id }).catch((err) => {
      console.error('Failed to delete snippet:', err);
      fetchSnippets();
    });
  };

  const actions = useMemo<ActionEntry[]>(() => {
    const snip = selected;
    if (!snip) return [];
    return [
      {
        id: 'copy',
        label: 'Copy to Clipboard',
        shortcut: 'Ctrl+C',
        icon: <CopyIcon />,
        handler: () => useSnippet(snip, 'copy'),
      },
      {
        id: 'paste',
        label: 'Paste',
        shortcut: 'Enter',
        icon: <PasteIcon />,
        handler: () => useSnippet(snip, 'paste'),
      },
      {
        id: 'edit',
        label: 'Edit Snippet',
        shortcut: 'E',
        icon: <EditIcon />,
        handler: () => openEditDialog(snip),
      },
      {
        id: 'delete',
        label: 'Delete Snippet',
        shortcut: 'Del',
        icon: <DeleteIcon />,
        danger: true,
        handler: () => handleDelete(snip),
      },
    ];
  }, [selected, useSnippet]);

  selectedRef.current = selected;
  actionsRef.current = actions;

  const flushNavAccum = useCallback(() => {
    navRafRef.current = null;
    const steps = navAccumRef.current;
    if (steps === 0) return;
    navAccumRef.current = 0;
    const list = filteredRef.current;
    if (list.length === 0) return;
    const delta = Math.max(-2, Math.min(2, steps));
    setSelectedId((prev) => {
      const curIdx = prev ? list.findIndex((s) => s.id === prev) : -1;
      const base = curIdx === -1 ? 0 : curIdx;
      const next = Math.max(0, Math.min(list.length - 1, base + delta));
      return list[next].id;
    });
  }, []);

  // Auto-scroll the selected row into view (same feel as the clips list).
  useLayoutEffect(() => {
    if (!selectedId) return;
    document.getElementById(`snippet-row-${selectedId}`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  // Any mouse click on a button drops keyboard focus from it, so a later
  // Enter always means "paste" in the view instead of re-activating the last
  // clicked button (Copy, Actions, Edit, ...).
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest?.('button');
      if (btn && document.activeElement === btn) {
        btn.blur();
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const runAction = (act: ActionEntry) => {
    setActionOpen(false);
    act.handler();
  };

  // Global keyboard handling for the snippets view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

      if (argPrompt) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeArgPrompt(null);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const finalVal = argValue.trim()
            ? argValue
            : argPrompt.defaultValue ?? argValue;
          closeArgPrompt(finalVal);
        }
        return;
      }

      if (actionOpen && selectedRef.current) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActionIndex((p) => (p + 1) % actionsRef.current.length);
          return;
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActionIndex((p) => (p - 1 + actionsRef.current.length) % actionsRef.current.length);
          return;
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setActionOpen(false);
          return;
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const act = actionsRef.current[actionIndex];
          if (act) runAction(act);
          return;
        }
      }

      if (isInput) {
        if (e.key === 'Escape') (target as HTMLElement).blur();
        return;
      }

      // Arrow keys move the selection through the (filtered) snippet list.
      // Left/Right swap too (wrapping) — same "slider" interaction as the
      // Quick Overlay and the clips views.
      if (
        e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      ) {
        e.preventDefault();
        if (filteredRef.current.length > 0) {
          navAccumRef.current += e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
          if (navRafRef.current === null) {
            navRafRef.current = requestAnimationFrame(flushNavAccum);
          }
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (selectedRef.current) {
          setActionIndex(0);
          setActionOpen(true);
        }
        return;
      }
      if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useSnippet(selectedRef.current, 'paste');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        useSnippet(selectedRef.current, 'copy');
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        if (selectedRef.current) openEditDialog(selectedRef.current);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Del') {
        if (selectedRef.current) handleDelete(selectedRef.current);
        return;
      }
      if (e.key === 'Escape') {
        setCtxMenu(null);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [argPrompt, actionOpen, actionIndex, selectedRef, actionsRef, useSnippet, closeArgPrompt, flushNavAccum]);

  useEffect(() => () => {
    if (navRafRef.current !== null) cancelAnimationFrame(navRafRef.current);
  }, []);

  useEffect(() => {
    if (actionOpen && activeActionRef.current) {
      activeActionRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [actionIndex, actionOpen]);

  const previewHiglighted = useMemo(
    () => (selected ? highlightSnippetTokens(selected.content) : []),
    [selected]
  );

  const SelectedIcon = selected ? snippetIconFor(selected.icon) : null;

  return (
    <div className="snippets-view">
      {/* ── Left: search + grouped list ─────────────────────────── */}
      <div className="snippets-main">
        <div className="main-top">
          <div className="searchbar">
            <span className="search-ic"><SearchIcon /></span>
            <input
              ref={searchInputRef}
              placeholder="Search snippets..."
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
            <span className="filter-box" title="Filter by tag">
              <FilterIcon className="filter-box-ic" />
              <Dropdown
                className="sn-tag-dd"
                value={tagFilter}
                onChange={setTagFilter}
                align="end"
                ariaLabel="Filter by tag"
                options={[
                  { value: '__all__', label: 'All Tags' },
                  ...allTags.map((t) => ({ value: t, label: t })),
                ]}
              />
            </span>
          </div>
          <div className="total">
            {filtered.length} {filtered.length === 1 ? 'snippet' : 'snippets'}
          </div>
        </div>

        <div className="snippets-list">
          {loading ? (
            <div className="empty">
              <div className="big">Loading snippets…</div>
            </div>
          ) : snippets.length === 0 ? (
            <div className="empty">
              <div className="big">No snippets yet</div>
              <div className="sub">Author plain-text expansions, then copy or paste them anywhere.</div>
              <div className="empty-cta">
                <button className="btn primary" onClick={openCreateDialog}>
                  <PlusIcon size={12} /> Create your first snippet
                </button>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              <div className="big">No snippets found</div>
              <div className="sub">Nothing matched your search and tag filter</div>
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.label} className="date-group">
                <div className="date-group-label">{group.label}</div>
                {group.items.map((s) => {
                  const Icon = snippetIconFor(s.icon);
                  const isSelected = selectedId === s.id;
                  return (
                    <div
                      key={s.id}
                      id={`snippet-row-${s.id}`}
                      className={`snippet-row ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedId(s.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelectedId(s.id);
                        setCtxMenu({
                          x: Math.min(e.clientX, window.innerWidth - 240),
                          y: Math.min(e.clientY, window.innerHeight - 220),
                          snippet: s,
                        });
                      }}
                    >
                      <span className="sn-row-ic"><Icon /></span>
                      <div className="sn-row-title-area">
                        <span className="sn-row-name">{s.name}</span>
                        <span className="sn-keyword-badge">{s.keyword || '/'}</span>
                      </div>
                      {(s.tags || []).length > 0 && (
                        <div className="sn-row-tags">
                          {(s.tags || []).slice(0, 2).map((t) => (
                            <span key={t} className="sn-mini-tag">#{t}</span>
                          ))}
                          {(s.tags || []).length > 2 && <span className="sn-mini-tag">+{(s.tags || []).length - 2}</span>}
                        </div>
                      )}
                      <span className="sn-row-time">{formatSnippetLastUsed(s.last_used_at)}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Right: detail pane ───────────────────────────────────── */}
      <div className={`snippets-preview ${selected ? 'open' : ''}`}>
        {selected && SelectedIcon ? (
          <div className="snippets-preview-inner">
            <div className="preview-head">
              <span className="preview-kind">
                <span className="sn-detail-ic"><SelectedIcon /></span>
                {selected.name}
                {selected.keyword && <span className="sn-keyword-badge">{selected.keyword}</span>}
              </span>
              <div className="preview-actions">
                <button className="act" title="Edit Snippet (E)" onClick={() => openEditDialog(selected)}>
                  <EditIcon />
                </button>
                <button className="act" title="Actions (Ctrl+K)" onClick={() => { setActionIndex(0); setActionOpen(true); }}>
                  <MoreIcon />
                </button>
                <button className="act danger" title="Delete Snippet (Del)" onClick={() => handleDelete(selected)}>
                  <DeleteIcon />
                </button>
              </div>
            </div>

            <div className="sn-detail-body">
              <div className="sn-content-preview">
                {previewHiglighted.map((seg, i) =>
                  seg.cls === 'plain' ? (
                    <React.Fragment key={i}>{seg.text}</React.Fragment>
                  ) : (
                    <span key={i} className={seg.cls}>{seg.text}</span>
                  )
                )}
                {selected.content.length === 0 && <span className="sn-content-empty">Empty snippet — add content in Edit.</span>}
              </div>

              {(selected.tags || []).length > 0 && (
                <div className="sn-detail-tags">
                  {(selected.tags || []).map((t) => (
                    <span key={t} className="sn-tag-chip" onClick={() => setTagFilter(t)}>{t}</span>
                  ))}
                </div>
              )}
            </div>

            {/* Pinned above the footer like the captures Information strip:
                big content box fills, facts sit at the bottom. */}
            <div className="meta-strip">
              <div className="meta-row">
                <span className="meta-label">Label</span>
                <span className="meta-value">{selected.name}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Content Type</span>
                <span className="meta-value">Plain Text</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Times Copied</span>
                <span className="meta-value">{selected.use_count.toLocaleString()}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Last Copied</span>
                <span className="meta-value">{formatSnippetLastUsed(selected.last_used_at)}</span>
              </div>
            </div>

            <div className="snippets-preview-foot">
              <span className="sn-foot-label">
                {selected.show_confirmation && <span className="sn-foot-confirm">confirms on use</span>}
              </span>
              <div className="sn-foot-actions">
                <button type="button" className="btn subtle sn-actions-btn" onClick={() => { setActionIndex(0); setActionOpen(true); }}>
                  <span className="key">Ctrl+K</span>
                  <span>Actions</span>
                </button>
                <button className="btn primary" disabled={selected.content.length === 0} onClick={() => useSnippet(selected, 'copy')}>
                  <CopyIcon /> Copy to Clipboard
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Confirmation pill */}
      {confirmPill && (
        <div className={`sn-confirm-pill ${confirmPill.error ? 'error' : ''}`}>
          {confirmPill.error ? <span className="sn-pill-x">✕</span> : <CheckIcon />} {confirmPill.text}
        </div>
      )}

      {/* Row context menu */}
      {ctxMenu && (
        <>
          <div className="context-menu-backdrop" onClick={() => setCtxMenu(null)} />
          <div className="context-menu-popover" style={{ top: ctxMenu.y, left: ctxMenu.x }}>
            <div className="context-menu-item" onClick={() => { useSnippet(ctxMenu.snippet, 'copy'); setCtxMenu(null); }}>
              <span className="cm-ic"><CopyIcon /></span> Copy to Clipboard
            </div>
            <div className="context-menu-item" onClick={() => { useSnippet(ctxMenu.snippet, 'paste'); setCtxMenu(null); }}>
              <span className="cm-ic"><PasteIcon /></span> Paste
            </div>
            <div className="context-menu-divider" />
            <div className="context-menu-item" onClick={() => { openEditDialog(ctxMenu.snippet); setCtxMenu(null); }}>
              <span className="cm-ic"><EditIcon /></span> Edit Snippet
            </div>
            <div className="context-menu-item danger" onClick={() => { handleDelete(ctxMenu.snippet); setCtxMenu(null); }}>
              <span className="cm-ic"><DeleteIcon /></span> Delete Snippet
            </div>
          </div>
        </>
      )}

      {/* Action Panel (Ctrl+K) */}
      {actionOpen && selected && (
        <div className="action-modal-overlay" onClick={() => setActionOpen(false)}>
          <div className="action-modal" onClick={(e) => e.stopPropagation()}>
            {actions.map((act, i) => (
              <div
                key={act.id}
                ref={i === actionIndex ? activeActionRef : undefined}
                className={`action-item ${i === actionIndex ? 'selected' : ''} ${act.danger ? 'danger' : ''}`}
                onClick={() => runAction(act)}
                onMouseEnter={() => setActionIndex(i)}
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

      {/* Create / Edit dialog — shared component (also used by Quick Overlay) */}
      {editorTarget && (
        <SnippetEditorModal
          key={editorTarget.snippet?.id ?? 'new'}
          snippet={editorTarget.snippet}
          onClose={() => setEditorTarget(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Argument prompt — shared component (also used by the Quick Overlay) */}
      {argPrompt && (
        <SnippetArgPrompt
          spec={argPrompt}
          value={argValue}
          onChange={setArgValue}
          onInsert={(v) => closeArgPrompt(v)}
          onCancel={() => closeArgPrompt(null)}
        />
      )}
    </div>
  );
};