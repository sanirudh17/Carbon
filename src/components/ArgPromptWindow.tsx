import React, { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
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
  // Submit re-entrancy: Enter-keydown on the input and the window-level
  // keydown listener both fire for the same Escape press, and double-Enter is
  // one key-repeat away. Two interleaved submits for one prompt would pop a
  // queue entry that belongs to the NEXT prompt. Exactly one submit runs.
  const submittingRef = useRef(false);
  // Focus-fetch ping-pong: Rust calls win.set_focus() at show AND on the
  // paint ack, and each focus event refetches. Coalesce refetches closer than
  // this so a focus storm cannot interleave with a submit.
  const lastFetchRef = useRef(0);

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
    // No setFocus() here: the backend present path (and the paint ack) own
    // the focus transition on the main thread. A second, cross-process focus
    // request from this listener raced those and bounced activation when the
    // prompt popped up (the visible "screen move").
    // Capture the id: if the spec changes (or clears) before this fires, the
    // ref points at a dead input and focusing it would steal focus for a
    // prompt that no longer exists.
    const wantId = s.id ?? null;
    setTimeout(() => {
      if (currentIdRef.current !== wantId) return;
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 40);
  }, []);

  const handleFetch = useCallback(async () => {
    // Coalesce focus-storm refetches; a fetch already decided the current
    // spec within the last window, so another one cannot change anything.
    const now = Date.now();
    if (now - lastFetchRef.current < 100) return;
    lastFetchRef.current = now;
    try {
      const active = await invoke<ArgSpec | null>('get_pending_arg_request');
      if (active) {
        loadSpec(active);
      }
    } catch {}
  }, [loadSpec]);

  // Paint gate: the backend cloaks the window until this ack, so the prompt
  // is never revealed unpainted.
  //
  // This MUST NOT be requestAnimationFrame-based. The window is cloaked
  // (DWM_CLOAK) while it waits for the ack, and a cloaked window produces no
  // compositor frames — so rAF never fires, the ack never arrives, and the
  // backend watchdog cancels every single prompt. useLayoutEffect runs after
  // React commits the DOM but before the browser paints, which is exactly the
  // guarantee the gate needs: the full content is in the DOM when the cloak is
  // lifted, and it does not depend on frames being produced while cloaked.
  const specId = spec?.id;
  useLayoutEffect(() => {
    if (specId === undefined || specId === null) return;
    // index.html ships <html class="wm-hidden">, and in the default glass
    // material that class forces `opacity: 0 !important` plus
    // `pointer-events: none !important` on the html element. Only choreo.ts
    // ever removes it, and choreo drives the overlay/main windows exclusively
    // — so argprompt stayed permanently invisible and presented as an empty
    // slab that swallowed clicks. Drop it now that the prompt DOM is committed.
    document.documentElement.classList.remove('wm-hidden');
    invoke('argprompt_painted', { id: specId }).catch(() => {});
  }, [specId]);

  const handleSubmit = useCallback(
    async (val: string | null) => {
      // Exactly-once submit per prompt: without this, the input-Enter handler
      // and the window-Escape handler (or a double key-repeat) interleave two
      // submits, and the second one pops whatever the queue holds next.
      if (submittingRef.current) {
        logClient('handleSubmit re-entered while submitting — ignored');
        return;
      }
      submittingRef.current = true;
      try {
        const cur = specRef.current;
        logClient(`handleSubmit val=${val} curId=${cur?.id}`);
        currentIdRef.current = null;
        const finalVal =
          val === null ? null : val.trim() ? val : (cur?.defaultValue ?? val);
        // Do NOT clear the card yet: when another prompt is queued the next
        // spec swaps straight into the live window (wizard continuity).
        // Clearing first renders the transparent shell between prompts — the
        // window goes see-through for a few frames, which reads as a jump /
        // flash before the second argument pops up.
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
        // Queue empty (or the submit failed): clear the card, then hide.
        setSpec(null);
        setValue('');
        try {
          await getCurrentWindow().hide();
          logClient('window hide ok');
        } catch (e) {
          logClient(`hide failed: ${e}`);
        }
      } finally {
        submittingRef.current = false;
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
    // Transparent shell — the window is only ever shown when a prompt is
    // requested and the spec fetch lands within milliseconds, so this is
    // essentially never seen. No card here: a card with no content would read
    // as a second, empty window.
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          fontSize: 13,
          color: 'var(--text-3)',
        }}
      >
        Loading…
      </div>
    );
  }

  const isSelect = !!spec.options && spec.options.length > 0;

  // ONE unified surface: this div fills the whole window and IS the card.
  // There used to be a transparent wrapper with a narrower inner box, which
  // read as a window inside a window.
  //
  // Glass recipe mirrors the quick overlay / .enlarged roots EXACTLY (same
  // frosted effect in all windows): the root stays TRANSPARENT so the single
  // `body { background: var(--glass-base) }` slab provides the base tint.
  // A second --glass-base slab here double-stacks over the body slab
  // (0.72 x 0.72 ≈ 0.92 opaque) and kills the acrylic read-through — the
  // prompt looked solid while the picker blurred. No perimeter border, no
  // page-level backdrop-filter (OS acrylic owns the blur); edge definition
  // comes from the outer shadow + acrylic/base contrast, same as .overlay.
  // The token flips to opaque under html[data-material="solid"], so solid
  // mode follows automatically via the body slab.
  // The button row is pinned to the bottom with marginTop:auto so short
  // content (one input) doesn't leave the actions floating mid-card.
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'transparent',
        border: 'none',
        borderRadius: 12,
        boxShadow: 'var(--glass-shadow)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)' }}>
        Enter value for <span style={{ color: 'var(--accent)' }}>{spec.name}</span>
      </div>

      {/* Middle section takes the remaining height and centers its content,
          so the input block uses the card instead of hugging the top while
          the buttons sit at the bottom. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
        {isSelect ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', minHeight: 0, flex: 1 }}>
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
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--glass-border)',
              background: 'var(--glass-elev)',
              color: 'var(--text)',
              fontSize: 13,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        )}

        {spec.defaultValue !== undefined && !isSelect && (
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            Leave empty to use default: <b>&ldquo;{spec.defaultValue}&rdquo;</b>
          </div>
        )}
      </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 'auto', paddingTop: 4 }}>
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
  );
};