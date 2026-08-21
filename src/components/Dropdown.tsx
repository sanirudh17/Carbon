import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon } from './Icons';

export interface DropdownOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

/**
 * Shared custom dropdown (app-wide replacement for native <select>).
 * Themed from Carbon tokens, keyboard-navigable, with a smooth open/close.
 *
 * The trigger follows the standard select pattern: current selection +
 * chevron. `align="end"` opens the listbox toward the left edge (use when
 * the control sits at the right side of a bar).
 */
export const Dropdown: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  className?: string;
  title?: string;
  align?: 'start' | 'end';
  ariaLabel?: string;
}> = ({ value, onChange, options, className = '', title, align = 'start', ariaLabel }) => {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  // Flip the listbox upward when there is no room below (e.g. bottom bars).
  useLayoutEffect(() => {
    if (!open || !listRef.current) return;
    const rect = listRef.current.getBoundingClientRect();
    setDropUp(rect.bottom > window.innerHeight - 8 && rect.height < window.innerHeight - 80);
  }, [open]);

  const openAndFocus = () => {
    const idx = Math.max(0, options.findIndex((o) => o.value === value));
    setActiveIdx(idx);
    setOpen(true);
  };

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      openAndFocus();
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % options.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + options.length) % options.length);
        break;
      case 'Home':
        e.preventDefault();
        setActiveIdx(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIdx(options.length - 1);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const opt = options[activeIdx];
        if (opt) commit(opt.value);
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        break;
    }
  };

  // Keep the highlighted option in view while arrowing.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  return (
    <div className={`c-dropdown ${className}`} ref={rootRef} data-open={open ? '' : undefined}>
      <button
        type="button"
        className="c-dropdown-trigger"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? title}
        onClick={() => (open ? setOpen(false) : openAndFocus())}
        onKeyDown={onTriggerKeyDown}
      >
        {current?.icon && <span className="c-dropdown-value-ic">{current.icon}</span>}
        <span className="c-dropdown-value">{current?.label ?? '—'}</span>
        <ChevronDownIcon className="icon c-dropdown-chev" />
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          autoFocus
          className={`c-dropdown-list ${align === 'end' ? 'end' : ''} ${dropUp ? 'up' : ''}`}
          onKeyDown={onListKeyDown}
          onBlur={(e) => {
            if (!rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
          }}
        >
          {options.map((opt, i) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={`c-dropdown-item ${i === activeIdx ? 'active' : ''} ${opt.value === value ? 'selected' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => commit(opt.value)}
            >
              {opt.icon && <span className="c-dropdown-item-ic">{opt.icon}</span>}
              <span className="c-dropdown-item-label">{opt.label}</span>
              {opt.value === value && <CheckIcon className="icon c-dropdown-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
