import React, { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const ExpansionPill: React.FC = () => {
  const [text, setText] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const textRef = useRef<string | null>(null);
  textRef.current = text;

  const showPill = (name: string) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setText(name);
    getCurrentWindow().show().catch(() => {});
    timerRef.current = window.setTimeout(async () => {
      try {
        const win = getCurrentWindow();
        await win.hide();
      } catch {}
      setText(null);
    }, 1800);
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('snippet-expanded', (e) => {
      const name = e.payload as string;
      if (!name) return;
      showPill(name);
    }).then((fn) => {
      unlisten = fn;
    });

    let unlistenPill: (() => void) | undefined;
    listen<string>('expansion-pill-show', (e) => {
      const name = e.payload as string;
      if (!name) return;
      showPill(name);
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
        padding: 12,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          maxWidth: 360,
          padding: '11px 16px 11px 12px',
          borderRadius: 12,
          background: 'color-mix(in srgb, var(--surface) 96%, transparent)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid var(--line)',
          boxShadow: '0 16px 40px -4px rgba(0,0,0,0.65), 0 4px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
          fontSize: 13,
          fontWeight: 550,
          color: 'var(--text)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          animation: 'modalScaleIn 160ms var(--ease-out)',
          willChange: 'transform, opacity',
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--accent)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
            boxShadow: '0 2px 8px var(--accent-ring)',
          }}
        >
          ✓
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.1px',
          }}
        >
          Pasted&nbsp;<span style={{ color: 'var(--text-2)', fontWeight: 500 }}>{text}</span>
        </span>
        <span
          style={{
            marginLeft: 4,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            color: 'var(--text-3)',
            background: 'var(--elev)',
            border: '1px solid var(--line-soft)',
            padding: '2px 5px',
            borderRadius: 5,
            flexShrink: 0,
          }}
        >
          ✓ done
        </span>
      </div>
    </div>
  );
};
