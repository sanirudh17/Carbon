import React from 'react';
import { BoltIcon, CheckIcon } from './Icons';
import { ArgumentSpec } from '../utils/snippets';

/**
 * Shared sequential argument prompt modal for snippet expansion.
 * Used by SnippetsView (enlarged window) and the Quick Overlay snippets
 * tab — identical UI for the identical feature.
 *
 * onInsert receives the resolved value: the clicked option, the current
 * input text (optionally falling back to the token's default when empty).
 * Wrapped in a form so Enter always means "Insert".
 */
export const SnippetArgPrompt: React.FC<{
  spec: ArgumentSpec & { resolvedDefault?: string };
  value: string;
  onChange: (value: string) => void;
  onInsert: (value: string) => void;
  onCancel: () => void;
}> = ({ spec, value, onChange, onInsert, onCancel }) => {
  const hasOptions = !!spec.options && spec.options.length > 0;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card sn-arg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-head-icon"><BoltIcon /></span>
          <span className="modal-title">{spec.name}</span>
          <button className="modal-close-btn" onClick={onCancel}>✕</button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onInsert(
              hasOptions
                ? value || (spec.defaultValue ?? '')
                : value.trim()
                ? value
                : spec.defaultValue ?? value,
            );
          }}
        >
          <div className="modal-body">
            {!hasOptions && (
              <label className="modal-label" htmlFor="sn-arg-value">Value</label>
            )}
            {hasOptions ? (
              <div className="sn-arg-options" role="listbox" aria-label={`Options for ${spec.name}`}>
                {spec.options!.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className={`sn-arg-option ${value === opt ? 'on' : ''}`}
                    onClick={() => onInsert(opt)}
                  >
                    <span className="sn-arg-option-check">{value === opt && <CheckIcon />}</span>
                    {opt}
                  </button>
                ))}
              </div>
            ) : (
              <input
                id="sn-arg-value"
                type="text"
                className="modal-input"
                placeholder={spec.defaultValue ? spec.defaultValue : 'Enter a value…'}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                autoFocus
              />
            )}
            {spec.defaultValue !== undefined && !hasOptions && (
              <div className="modal-desc sn-arg-hint">
                Leave empty to use the default: <b>&ldquo;{spec.defaultValue}&rdquo;</b>
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn subtle" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={hasOptions && !value}
            >
              Insert
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
