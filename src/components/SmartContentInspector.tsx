import React, { useMemo, useState, useRef, useEffect } from 'react';
import { inspectClipContent, type SmartInspection } from '../lib/smartInspector';
import { CheckIcon, CopyIcon, SparklesIcon } from './Icons';

interface SmartContentInspectorProps {
  /** Pre-computed inspection (preferred when parent already checked availability). */
  inspection?: SmartInspection | null;
  /** Raw text fallback if parent didn't pre-compute `inspection`. */
  text?: string | null;
  disabled?: boolean;
  compact?: boolean;
}

/**
 * Quiet, opt-in frosted inspector surface revealed on demand via the Sparkles
 * button beside the Render/Raw toggle. Never shown by default so browsing clips
 * remains calm and uncluttered.
 */
export const SmartContentInspector: React.FC<SmartContentInspectorProps> = ({
  inspection: precomputed,
  text,
  disabled = false,
  compact = false,
}) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const inspection = useMemo(() => {
    if (disabled) return null;
    if (precomputed !== undefined) return precomputed;
    return inspectClipContent(text);
  }, [precomputed, text, disabled]);

  const resetKey = inspection?.copyValue ?? text ?? '';
  useEffect(() => {
    setCopied(false);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [resetKey]);

  if (!inspection) return null;

  const handleCopy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(inspection.copyValue);
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      console.error('SmartContentInspector copy failed:', err);
    }
  };

  return (
    <div
      className={`smart-inspector ${compact ? 'is-compact' : ''}`}
      data-kind={inspection.kind}
      role="region"
      aria-label={inspection.title}
    >
      <div className="smart-inspector-head">
        <div className="smart-inspector-title-group">
          {inspection.kind === 'color' && inspection.badge?.text ? (
            <span
              className="smart-inspector-swatch"
              style={{ background: inspection.badge.text }}
              aria-hidden="true"
            />
          ) : (
            <SparklesIcon className="smart-inspector-ic" size={13} />
          )}
          <span className="smart-inspector-title">{inspection.title}</span>
          {inspection.badge && (
            <span className={`smart-inspector-badge tone-${inspection.badge.tone}`}>
              {inspection.badge.text}
            </span>
          )}
        </div>
        <button
          type="button"
          className={`smart-inspector-copy ${copied ? 'is-copied' : ''}`}
          onClick={handleCopy}
          title={inspection.copyLabel}
        >
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          <span className="carbon-control-label">{copied ? 'Copied' : inspection.copyLabel}</span>
        </button>
      </div>

      <div className="smart-inspector-body">
        {inspection.rows && inspection.rows.length > 0 && (
          <div className="smart-inspector-rows">
            {inspection.rows.map((row, idx) => (
              <div key={`${row.label}-${idx}`} className="smart-inspector-row">
                <span className="smart-inspector-label">{row.label}</span>
                <span className={`smart-inspector-value ${row.mono ? 'mono' : ''}`} title={row.value}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {inspection.codeBlock && (
          <pre className="smart-inspector-code">{inspection.codeBlock}</pre>
        )}
      </div>
    </div>
  );
};
