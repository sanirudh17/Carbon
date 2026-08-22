import React, { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const ExpansionPill: React.FC = () => {
  const [text, setText] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const showPill = (msg?: string) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setText(msg || 'text has been placed successfully');
    getCurrentWindow().show().catch(() => {});
    timerRef.current = window.setTimeout(async () => {
      try {
        const win = getCurrentWindow();
        await win.hide();
      } catch {}
      setText(null);
    }, 2000);
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('snippet-expanded', (e) => {
      showPill(e.payload || 'text has been placed successfully');
    }).then((fn) => {
      unlisten = fn;
    });

    let unlistenPill: (() => void) | undefined;
    listen<string>('expansion-pill-show', (e) => {
      showPill(e.payload || 'text has been placed successfully');
    }).then((fn) => {
      unlistenPill = fn;
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        getCurrentWindow().hide().catch(() => {});
        setText(null);
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      unlisten?.();
      unlistenPill?.();
      window.removeEventListener('keydown', onKey);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!text) return null;

  return (
    <div
      data-pill-content
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        pointerEvents: 'none',
        padding: 8,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 18px 10px 14px',
          borderRadius: 999,
          background: 'color-mix(in srgb, var(--surface, #1e1e24) 96%, transparent)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid var(--line, rgba(255,255,255,0.12))',
          boxShadow:
            '0 16px 40px -4px rgba(0,0,0,0.65), 0 4px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
          fontSize: 12.5,
          fontWeight: 500,
          color: 'var(--text, #f0f0f5)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          animation: 'modalScaleIn 160ms cubic-bezier(0.16, 1, 0.3, 1)',
          willChange: 'transform, opacity',
        }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'color-mix(in srgb, var(--accent) 72%, transparent)',
            color: '#ffffff',
            flexShrink: 0,
            boxShadow: '0 2px 8px var(--accent-ring, rgba(91,124,250,0.4))',
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m4.5 12.5 5 5 10-11" />
          </svg>
        </span>
        <span
          style={{
            letterSpacing: '-0.1px',
            color: 'var(--text, #f0f0f5)',
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};
