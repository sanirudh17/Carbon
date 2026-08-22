import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, ChevronDownIcon } from './Icons';

export interface DropdownOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

/**
 * Shared custom dropdown (app-wide replacement for native <select>).
 *
 * The option list renders through a PORTAL with FIXED positioning anchored
 * to the trigger, so opening it can never grow the scrollable area of any
 * surrounding container (modals, bars): only the list itself scrolls.
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
  const [pos, setPos] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value) ?? options[0];

  /** Anchor the portaled list to the trigger's viewport rect. */
  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const estHeight = Math.min(264, options.length * 29 + 10);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const dropUp = spaceBelow < Math.min(estHeight, 180) && spaceAbove > spaceBelow;

    const height = Math.max(120, dropUp ? Math.min(estHeight, spaceAbove) : Math.min(estHeight, spaceBelow));

    const style: React.CSSProperties = {
      position: 'fixed',
      maxHeight: height,
      // Match the trigger/text-box width exactly (grow only for long labels)
      minWidth: rect.width,
    };
    if (align === 'end') {
      style.right = Math.max(8, window.innerWidth - rect.right);
    } else {
      style.left = Math.max(8, rect.left);
    }
    if (dropUp) {
      style.bottom = window.innerHeight - rect.top + 5;
    } else {
      style.top = rect.bottom + 5;
    }
    setPos(style);
  }, [align, options.length]);

  useEffect(() => {
    if (!open) return;
    place();
    // Any ancestor scroll would detach the anchor → close instead of chasing.
    const onScrollCapture = (e: Event) => {
      const t = e.target as Node | null;
      if (listRef.current?.contains(t)) return; // own list scrolling is fine
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener('scroll', onScrollCapture, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScrollCapture, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, place]);

  // Outside click closes; must account for the portaled list node.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
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

  // Keep the highlighted option visible while arrowing.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
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
      {open &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            style={pos}
            className={`c-dropdown-list ${dropUpClass(pos)} ${align === 'end' ? 'origin-right' : 'origin-left'}`}
            onKeyDown={onListKeyDown}
            onBlur={(e) => {
              const next = e.relatedTarget as Node | null;
              if (!rootRef.current?.contains(next) && !listRef.current?.contains(next)) setOpen(false);
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
          </div>,
          document.body
        )}
    </div>
  );
};

function dropUpClass(pos: React.CSSProperties): string {
  return pos.bottom !== undefined ? 'up' : '';
}
