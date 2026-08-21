import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Snippet } from '../types';
import { highlightSnippetTokens } from '../utils/snippets';
import { SnippetIcon, SNIPPET_ICONS } from './Icons';

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
  const [draftConfirm, setDraftConfirm] = useState(snippet?.show_confirmation ?? false);
  const [draftError, setDraftError] = useState('');
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
          showConfirmation: draftConfirm,
        });
        onSaved(updated);
      } else {
        const created = await invoke<Snippet>('create_snippet', {
          name: draftName.trim(),
          keyword: draftKeyword.trim(),
          content: draftContent,
          tags: draftTags,
          icon: draftIcon,
          showConfirmation: draftConfirm,
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
              <label className="modal-label">Content — {`{placeholders}`} highlight as you type</label>
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
                  onChange={(e) => setDraftContent(e.target.value)}
                  onScroll={syncBackdropScroll}
                  placeholder="Type the snippet content here. Everything inside {…} becomes a dynamic placeholder."
                />
              </div>
              <div className="sn-legend-tray">
                <span className="sn-legend-tray-label">Insert:</span>
                <div className="sn-legend-chips">
                  <button type="button" className="sn-chip-btn" onClick={() => insertPlaceholder('{date}')} title="Insert current date">{'{date}'}</button>
                  <button type="button" className="sn-chip-btn" onClick={() => insertPlaceholder('{clipboard}')} title="Insert clipboard content">{'{clipboard}'}</button>
                  <button type="button" className="sn-chip-btn" onClick={() => insertPlaceholder('{selection}')} title="Insert selected text">{'{selection}'}</button>
                  <button type="button" className="sn-chip-btn" onClick={() => insertPlaceholder('{uuid}')} title="Insert random UUID">{'{uuid}'}</button>
                  <button type="button" className="sn-chip-btn" onClick={() => insertPlaceholder('{argument name="input"}')} title="Insert interactive prompt">{'{argument}'}</button>
                  <button type="button" className="sn-chip-btn" onClick={() => insertPlaceholder('{cursor}')} title="Set final caret position">{'{cursor}'}</button>
                </div>
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
                  onChange={(e) => setDraftName(e.target.value)}
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Keyword / Trigger</label>
                <input
                  type="text"
                  className="modal-input sn-keyword-input"
                  placeholder="/address"
                  value={draftKeyword}
                  onChange={(e) => setDraftKeyword(e.target.value)}
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Icon</label>
                <div className="sn-icon-picker">
                  {SNIPPET_ICONS.map(({ key, label, icon: I }) => (
                    <button
                      key={key}
                      type="button"
                      className={`sn-icon-option ${draftIcon === key ? 'on' : ''}`}
                      title={label}
                      onClick={() => setDraftIcon(key)}
                    >
                      <I />
                    </button>
                  ))}
                </div>
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
              <label className="sn-confirm-toggle">
                <input
                  type="checkbox"
                  checked={draftConfirm}
                  onChange={(e) => setDraftConfirm(e.target.checked)}
                />
                <span className="sn-confirm-label">Show confirmation</span>
                <span className="sn-confirm-hint">names this snippet in a brief pill after it is used</span>
              </label>
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