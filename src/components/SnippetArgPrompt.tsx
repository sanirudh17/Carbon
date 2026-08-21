import React from 'react';
import { BoltIcon } from './Icons';
import { ArgumentSpec } from '../utils/snippets';

/**
 * Shared sequential argument prompt modal for snippet expansion.
 * Used by SnippetsView (enlarged window) and the Quick Overlay snippets
 * tab — identical UI for the identical feature.
 *
 * onInsert receives the resolved value: the clicked option, the current
 * input text (optionally falling back to the token's default when empty).
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
          <span className="modal-title">Argument: {spec.name}</span>
          <button className="modal-close-btn" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          {hasOptions ? (
            <div className="sn-arg-options">
              {spec.options!.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`sn-arg-option ${value === opt ? 'on' : ''}`}
                  onClick={() => onInsert(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : (
            <input
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
            type="button"
            className="btn primary"
            disabled={hasOptions && !value}
            onClick={() =>
              onInsert(
                hasOptions
                  ? value || (spec.defaultValue ?? '')
                  : value.trim()
                  ? value
                  : spec.defaultValue ?? value,
              )
            }
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
};