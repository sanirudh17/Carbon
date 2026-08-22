import { useRef } from 'react';

interface Snapshot {
  value: string;
  start: number;
  end: number;
}

type InputEl = HTMLInputElement | HTMLTextAreaElement | null;

/**
 * Standard-textbox Undo/Redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) for controlled
 * React inputs, whose native undo stacks are discarded by React's value
 * resets. Continuous typing coalesces into one step (bursts <600ms apart
 * with small deltas); paste, cut and large edits always get their own.
 *
 * Usage:
 *   const hist = useTextHistory();
 *   onChange={(e) => { hist.record(prevValue, el, e.target.value); set(v); }}
 *   onKeyDown={(e) => {
 *     const snap = hist.undo(value, el);
 *     if (snap) { set(snap.value); restoreCaret(el, snap); }
 *   }}
 */
export function useTextHistory() {
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const last = useRef<{ at: number; len: number }>({ at: 0, len: 0 });

  /** Snapshot the PREVIOUS value before a change lands. */
  const record = (prevValue: string, el: InputEl, nextValue?: string) => {
    const now = Date.now();
    const delta = Math.abs((nextValue ?? prevValue).length - prevValue.length);
    const burst = now - last.current.at < 600 && delta <= 1;
    if (!burst || past.current.length === 0) {
      past.current.push({
        value: prevValue,
        start: el?.selectionStart ?? prevValue.length,
        end: el?.selectionEnd ?? prevValue.length,
      });
      if (past.current.length > 300) past.current.shift();
    }
    last.current = { at: now, len: (nextValue ?? prevValue).length };
    future.current = [];
  };

  const undo = (currentValue: string, el: InputEl): Snapshot | null => {
    const snap = past.current.pop();
    if (!snap) return null;
    future.current.push({
      value: currentValue,
      start: el?.selectionStart ?? currentValue.length,
      end: el?.selectionEnd ?? currentValue.length,
    });
    return snap;
  };

  const redo = (currentValue: string, el: InputEl): Snapshot | null => {
    const snap = future.current.pop();
    if (!snap) return null;
    past.current.push({
      value: currentValue,
      start: el?.selectionStart ?? currentValue.length,
      end: el?.selectionEnd ?? currentValue.length,
    });
    return snap;
  };

  return { record, undo, redo };
}

/** Restores caret/selection after React commits the snapshot value. */
export function restoreSelection(
  el: InputEl,
  snap: Snapshot
) {
  if (!el) return;
  requestAnimationFrame(() => {
    try {
      const start = Math.min(snap.start, snap.value.length);
      const end = Math.min(snap.end, snap.value.length);
      el.setSelectionRange(start, end);
    } catch {
      /* element may have unmounted */
    }
  });
}
