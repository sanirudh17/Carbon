import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Snippet } from '../types';
import { highlightSnippetTokens } from '../utils/snippets';
import { useTextHistory, restoreSelection } from '../utils/useTextHistory';
import { SnippetIcon, SNIPPET_ICONS, HelpIcon } from './Icons';
import { Dropdown } from './Dropdown';

/** Shared keydown wiring for Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y on one field. */
function historyKeyHandler(
  e: React.KeyboardEvent,
  hist: ReturnType<typeof useTextHistory>,
  value: string,
  el: HTMLInputElement | HTMLTextAreaElement | null,
  apply: (v: string) => void
): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) {
    e.preventDefault();
    const snap = hist.undo(value, el);
    if (snap) {
      apply(snap.value);
      restoreSelection(el, snap);
    }
    return true;
  }
  if ((k === 'z' && e.shiftKey) || k === 'y') {
    e.preventDefault();
    const snap = hist.redo(value, el);
    if (snap) {
      apply(snap.value);
      restoreSelection(el, snap);
    }
    return true;
  }
  return false;
}

/** Accurate per the expansion engine in utils/snippets.ts. */
const TOKEN_DOCS: { token: string; insert?: string; desc: string }[] = [
  { token: '{clipboard}', desc: 'Clipboard text — {clipboard offset=1} reaches further back' },
  { token: '{selection}', desc: 'Text selected when the snippet fires' },
  { token: '{date}', insert: '{date format="yyyy-MM-dd"}', desc: 'Today — supports format="…" / locale' },
  { token: '{time}', insert: '{time format="HH:mm"}', desc: 'Time now — optional offset="+3h"' },
  { token: '{datetime}', desc: 'Date and time together' },
  { token: '{day}', desc: 'Weekday name' },
  { token: '{uuid}', desc: 'Random UUID' },
  { token: '{argument}', insert: '{argument name="Input" default=""}', desc: 'Asks for a value each use — name / default / options' },
  { token: '{snippet:Name}', desc: 'Inline another snippet by its exact name' },
  { token: '{cursor}', desc: 'Where the caret lands after pasting' },
];

/**
 * Shared create/edit snippet dialog (enlarged window + Quick Overlay).
 * Owns the whole draft: name, keyword, content (with live `{token}`
 * highlighting), icon picker, tags, and the confirmation toggle.
 */
export const SnippetEditorModal: React.FC<{
  snippet: Snippet | null;
  onClose: () => void;
  onSaved: (snippet: Snippet) => void;
}> = ({ snippet, onClose, onSaved }) => {
  const [draftName, setDraftName] = useState(snippet?.name ?? '');
  const [draftKeyword, setDraftKeyword] = useState(snippet?.keyword ?? '');
  const [draftContent, setDraftContent] = useState(snippet?.content ?? '');
  const [draftIcon, setDraftIcon] = useState(snippet?.icon || 'snippet');
  const [draftTags, setDraftTags] = useState<string[]>(snippet?.tags || []);
  const [tagInput, setTagInput] = useState('');
  // Confirmation is on by default for new snippets; existing snippets keep
  // their stored choice (the per-snippet toggle was removed from this form).
  const effectiveConfirm = snippet ? snippet.show_confirmation : true;
  const [draftError, setDraftError] = useState('');
  const contentHistory = useTextHistory();
  const nameHistory = useTextHistory();
  const keywordHistory = useTextHistory();
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpPos, setHelpPos] = useState<React.CSSProperties>({});
  const helpBtnRef = useRef<HTMLButtonElement>(null);
  const helpPopRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => nameInputRef.current?.focus(), 60);
  }, []);

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, '');
    if (!t) return;
    setDraftTags((prev) => (prev.includes(t) ? prev : [...prev, t]));
    setTagInput('');
  };

  const handleSave = async () => {
    if (!draftName.trim()) {
      setDraftError('Give the snippet a name.');
      return;
    }
    if (!draftKeyword.trim()) {
      setDraftError('Give the snippet a keyword/trigger, e.g. /dsv4p.');
      return;
    }
    try {
      if (snippet) {
        const updated = await invoke<Snippet>('update_snippet', {
          id: snippet.id,
          name: draftName.trim(),
          keyword: draftKeyword.trim(),
          content: draftContent,
          tags: draftTags,
          icon: draftIcon,
          showConfirmation: effectiveConfirm,
        });
        onSaved(updated);
      } else {
        const created = await invoke<Snippet>('create_snippet', {
          name: draftName.trim(),
          keyword: draftKeyword.trim(),
          content: draftContent,
          tags: draftTags,
          icon: draftIcon,
          showConfirmation: effectiveConfirm,
        });
        onSaved(created);
      }
    } catch (err) {
      console.error('Failed to save snippet:', err);
      setDraftError('Could not save the snippet.');
    }
  };

  const syncBackdropScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = e.currentTarget.scrollTop;
      backdropRef.current.scrollLeft = e.currentTarget.scrollLeft;
    }
  };

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertPlaceholder = (token: string) => {
    const el = textareaRef.current;
    if (!el) {
      setDraftContent((prev) => prev + token);
      return;
    }
    const start = el.selectionStart ?? draftContent.length;
    const end = el.selectionEnd ?? draftContent.length;
    const next = draftContent.slice(0, start) + token + draftContent.slice(end);
    setDraftContent(next);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    }, 10);
  };

  const highlighted = useMemo(() => highlightSnippetTokens(draftContent), [draftContent]);

  /** Anchor the reference panel to the help button; only the panel scrolls. */
  useEffect(() => {
    if (!helpOpen) return;
    const place = () => {
      const el = helpBtnRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 10;
      const spaceAbove = rect.top - 10;
      const dropUp = spaceBelow < 300 && spaceAbove > spaceBelow;
      setHelpPos({
        position: 'fixed',
        width: 400,
        maxHeight: Math.max(180, dropUp ? Math.min(480, spaceAbove) : Math.min(480, spaceBelow)),
        left: Math.max(8, Math.min(rect.left - 2, window.innerWidth - 408)),
        ...(dropUp
          ? { bottom: window.innerHeight - rect.top + 7 }
          : { top: rect.bottom + 7 }),
      });
    };
    place();
    const onScrollCapture = (e: Event) => {
      if (helpPopRef.current?.contains(e.target as Node)) return;
      setHelpOpen(false);
    };
    const onResize = () => setHelpOpen(false);
    window.addEventListener('scroll', onScrollCapture, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScrollCapture, true);
      window.removeEventListener('resize', onResize);
    };
  }, [helpOpen]);

  // Close the placeholder reference on Escape / outside click.
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Keep the app-window Escape handler out of this while the panel closes.
        e.stopImmediatePropagation();
        setHelpOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.('.sn-help-pop') && !t.closest?.('.sn-help-btn')) setHelpOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [helpOpen]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card sn-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-head-icon"><SnippetIcon /></span>
          <span className="modal-title">{snippet ? 'Edit Snippet' : 'New Snippet'}</span>
          <button className="modal-close-btn" onClick={onClose}>✕</button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <div className="modal-body sn-modal-body">
            {/* Left: content editor with inline token highlighting */}
            <div className="sn-edit-col">
              <div className="sn-content-head">
                <label className="modal-label">Content</label>
                <button
                  ref={helpBtnRef}
                  type="button"
                  className={`sn-help-btn ${helpOpen ? 'on' : ''}`}
                  title="Placeholder reference"
                  aria-label="Placeholder reference"
                  aria-expanded={helpOpen}
                  onClick={() => setHelpOpen((v) => !v)}
                >
                  <HelpIcon />
                </button>
                {helpOpen &&
                  createPortal(
                    <div
                      ref={helpPopRef}
                      role="dialog"
                      aria-label="Placeholder reference"
                      style={helpPos}
                      className="sn-help-pop"
                    >
                      <div className="sn-help-head">
                        <span className="sn-help-title">Dynamic placeholders</span>
                        <span className="sn-help-sub">click to insert at caret</span>
                      </div>
                      <div className="sn-help-rows">
                        {TOKEN_DOCS.map((tok) => (
                          <button
                            key={tok.token}
                            type="button"
                            className="sn-help-row"
                            onClick={() => insertPlaceholder(tok.insert ?? tok.token)}
                          >
                            <code>{tok.token}</code>
                            <span>{tok.desc}</span>
                            <em>insert</em>
                          </button>
                        ))}
                      </div>
                      <div className="sn-help-mods">
                        <div className="sn-help-mods-title">Modifiers — chain after any token</div>
                        <div className="sn-help-mod-pills">
                          {['uppercase', 'lowercase', 'trim', 'percent-encode', 'json-stringify', 'raw'].map((m) => (
                            <code key={m}>{m}</code>
                          ))}
                        </div>
                        <div className="sn-help-ex">
                          Example: <code>{'{clipboard | lowercase}'}</code>
                        </div>
                      </div>
                    </div>,
                    document.body
                  )}
              </div>
              <div className="sn-editor-wrap">
                <div className="sn-editor-backdrop" ref={backdropRef} aria-hidden="true">
                  {highlighted.map((seg, i) =>
                    seg.cls === 'plain' ? (
                      <React.Fragment key={i}>{seg.text}</React.Fragment>
                    ) : (
                      <span key={i} className={seg.cls}>{seg.text}</span>
                    )
                  )}
                </div>
                <textarea
                  ref={textareaRef}
                  className="sn-editor-input"
                  spellCheck={false}
                  value={draftContent}
                  onChange={(e) => {
                    contentHistory.record(draftContent, textareaRef.current, e.target.value);
                    setDraftContent(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    historyKeyHandler(e, contentHistory, draftContent, textareaRef.current, setDraftContent);
                  }}
                  onScroll={syncBackdropScroll}
                  placeholder="Write your snippet — anything in {braces} becomes a live placeholder."
                />
              </div>
            </div>

            {/* Right: properties */}
            <div className="sn-edit-col sn-edit-props">
              <div className="modal-field">
                <label className="modal-label">Name</label>
                <input
                  ref={nameInputRef}
                  type="text"
                  className="modal-input"
                  placeholder="e.g. Address signature"
                  value={draftName}
                  onChange={(e) => {
                    nameHistory.record(draftName, nameInputRef.current, e.target.value);
                    setDraftName(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    historyKeyHandler(e, nameHistory, draftName, nameInputRef.current, setDraftName);
                  }}
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Keyword / Trigger</label>
                <input
                  type="text"
                  className="modal-input sn-keyword-input"
                  placeholder="/address"
                  value={draftKeyword}
                  onChange={(e) => {
                    keywordHistory.record(draftKeyword, e.target as HTMLInputElement, e.target.value);
                    setDraftKeyword(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    historyKeyHandler(e, keywordHistory, draftKeyword, e.target as HTMLInputElement, setDraftKeyword);
                  }}
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Icon</label>
                <Dropdown
                  className="sn-icon-dd"
                  value={draftIcon}
                  onChange={setDraftIcon}
                  title="Snippet icon"
                  options={SNIPPET_ICONS.map(({ key, label, icon: I }) => ({
                    value: key,
                    label,
                    icon: <I />,
                  }))}
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Tags</label>
                <div className="sn-tag-edit">
                  {draftTags.map((t) => (
                    <span key={t} className="sn-tag-chip">
                      {t}
                      <button type="button" onClick={() => setDraftTags((p) => p.filter((x) => x !== t))}>✕</button>
                    </span>
                  ))}
                  <input
                    type="text"
                    className="sn-tag-input"
                    placeholder={draftTags.length ? 'Add tag…' : 'e.g. email, work'}
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        addTag(tagInput);
                      } else if (e.key === 'Backspace' && !tagInput && draftTags.length) {
                        setDraftTags((p) => p.slice(0, -1));
                      }
                    }}
                    onBlur={() => addTag(tagInput)}
                  />
                </div>
              </div>
              {draftError && <div className="pin-error-msg">{draftError}</div>}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn subtle" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              {snippet ? 'Save Changes' : 'Create Snippet'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};