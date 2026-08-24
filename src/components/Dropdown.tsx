import React, { useEffect, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon } from './Icons';

export interface DropdownOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

/**
 * Shared custom dropdown (app-wide replacement for native <select>).
 *
 * Renders cleanly in-tree with absolute positioning anchored to .c-dropdown,
 * avoiding portal timing issues, focus theft, and viewport scrolls.
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
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value) ?? options[0];

  // Outside click closes
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const openAndFocus = () => {
    setActiveIdx(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
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
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  // Keep highlighted option visible inside the dropdown list
  useEffect(() => {
    if (!open || !listRef.current) return;
    const list = listRef.current;
    const el = list.children[activeIdx] as HTMLElement | undefined;
    if (!el) return;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    if (elTop < list.scrollTop) {
      list.scrollTop = elTop;
    } else if (elBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = elBottom - list.clientHeight;
    }
  }, [activeIdx, open]);

  return (
    <div className={`c-dropdown ${className}`} ref={rootRef} data-open={open ? '' : undefined}>
      <button
        ref={triggerRef}
        type="button"
        className="c-dropdown-trigger"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? title}
        onMouseDown={(e) => {
          // Prevent search input blur theft and unwanted focus scrolling
          e.preventDefault();
        }}
        onClick={() => (open ? setOpen(false) : openAndFocus())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            e.stopPropagation();
            openAndFocus();
          }
        }}
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
          className={`c-dropdown-list align-${align}`}
          onKeyDown={onListKeyDown}
        >
          {options.map((opt, i) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={`c-dropdown-item ${i === activeIdx ? 'active' : ''} ${opt.value === value ? 'selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
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
