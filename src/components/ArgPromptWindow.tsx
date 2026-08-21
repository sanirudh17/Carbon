import React, { useEffect, useState, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';

interface ArgSpec {
  id?: number;
  name: string;
  defaultValue?: string;
  options?: string[];
  resolvedDefault?: string;
}

export const ArgPromptWindow: React.FC = () => {
  const [spec, setSpec] = useState<ArgSpec | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const specRef = useRef<ArgSpec | null>(null);
  specRef.current = spec;
  const currentIdRef = useRef<number | null>(null);

  const logClient = (msg: string) => {
    invoke('log_client_event', { event: `[argprompt] ${msg}` }).catch(() => {});
  };

  const loadSpec = useCallback((s: ArgSpec | null) => {
    if (!s) return;
    if (s.id !== undefined && s.id === currentIdRef.current) {
      return;
    }
    logClient(`loadSpec id=${s.id} name=${s.name} default=${s.defaultValue}`);
    currentIdRef.current = s.id ?? null;
    setSpec(s);
    setValue(s.resolvedDefault ?? s.defaultValue ?? '');
    getCurrentWindow().show().catch((e) => logClient(`show failed: ${e}`));
    getCurrentWindow().setFocus().catch((e) => logClient(`setFocus failed: ${e}`));
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 40);
  }, []);

  const handleFetch = useCallback(async () => {
    try {
      const active = await invoke<ArgSpec | null>('get_pending_arg_request');
      if (active) {
        loadSpec(active);
      }
    } catch {}
  }, [loadSpec]);

  const handleSubmit = useCallback(
    async (val: string | null) => {
      const cur = specRef.current;
      logClient(`handleSubmit val=${val} curId=${cur?.id}`);
      currentIdRef.current = null;
      const finalVal =
        val === null ? null : val.trim() ? val : (cur?.defaultValue ?? val);
      setSpec(null);
      setValue('');
      try {
        await invoke('submit_arg_prompt', { value: finalVal });
        logClient(`submit_arg_prompt ok val=${finalVal}`);
      } catch (e) {
        logClient(`submit_arg_prompt failed: ${e}`);
      }
      try {
        const next = await invoke<ArgSpec | null>('get_pending_arg_request');
        if (next && next.id !== cur?.id) {
          logClient(`handleSubmit found next pending id=${next.id}`);
          loadSpec(next);
          return;
        }
      } catch (e) {
        logClient(`get pending after submit failed: ${e}`);
      }
      try {
        await getCurrentWindow().hide();
        logClient('window hide ok');
      } catch (e) {
        logClient(`hide failed: ${e}`);
      }
    },
    [loadSpec],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ArgSpec>('arg-prompt-request', (e) => {
      if (e.payload) {
        loadSpec(e.payload);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    handleFetch();

    const win = getCurrentWindow();
    const unlistenFocusPromise = win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        handleFetch();
      }
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleSubmit(null);
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      unlisten?.();
      unlistenFocusPromise.then((fn) => fn());
      window.removeEventListener('keydown', onKey);
    };
  }, [loadSpec, handleFetch, handleSubmit]);

  if (!spec) {
    // Keep a minimal DOM so a transparent window shown by Rust before the
    // spec is fetched does not flash as a black rectangle on Windows.
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
        }}
      >
        <div
          style={{
            width: 440,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            boxShadow: '0 16px 40px rgba(0,0,0,0.38)',
            padding: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            color: 'var(--text-3)',
          }}
        >
          Loading…
        </div>
      </div>
    );
  }

  const isSelect = !!spec.options && spec.options.length > 0;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        padding: 12,
        boxSizing: 'border-box',
      }}
      onClick={() => handleSubmit(null)}
    >
      <div
        style={{
          width: 440,
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          boxShadow: '0 16px 40px rgba(0,0,0,0.38)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)' }}>
          Enter value for <span style={{ color: 'var(--accent)' }}>{spec.name}</span>
        </div>

        {isSelect ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {spec.options!.map((o) => (
              <button
                key={o}
                type="button"
                className={`btn subtle ${value === o ? 'accent' : ''}`}
                style={{ textAlign: 'left', justifyContent: 'flex-start', padding: '8px 12px' }}
                onClick={() => handleSubmit(o)}
              >
                {o}
              </button>
            ))}
          </div>
        ) : (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={spec.defaultValue ? `Default: ${spec.defaultValue}` : 'Enter value…'}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSubmit(value);
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                handleSubmit(null);
              }
            }}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--line)',
              background: 'var(--elev)',
              color: 'var(--text)',
              fontSize: 13,
              outline: 'none',
            }}
          />
        )}

        {spec.defaultValue !== undefined && !isSelect && (
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            Leave empty to use default: <b>&ldquo;{spec.defaultValue}&rdquo;</b>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn subtle" type="button" onClick={() => handleSubmit(null)}>
            Cancel
          </button>
          {!isSelect && (
            <button className="btn accent" type="button" onClick={() => handleSubmit(value)}>
              Insert
            </button>
          )}
        </div>
      </div>
    </div>
  );
};