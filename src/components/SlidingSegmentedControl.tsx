import React, { useLayoutEffect, useRef, useState } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SlidingSegmentedControlProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  variant?: 'settings' | 'preview';
  style?: React.CSSProperties;
}

export function SlidingSegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  variant = 'settings',
  style,
}: SlidingSegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const mountedRef = useRef(false);
  const [thumb, setThumb] = useState<{ left: number; width: number; ready: boolean; animate: boolean }>({
    left: 0,
    width: 0,
    ready: false,
    animate: false,
  });

  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );

  useLayoutEffect(() => {
    const measure = (allowAnimate: boolean) => {
      const container = containerRef.current;
      const btn = btnRefs.current[activeIndex];
      if (!container || !btn) return;
      const cRect = container.getBoundingClientRect();
      const bRect = btn.getBoundingClientRect();
      const nextLeft = Math.round((bRect.left - cRect.left - container.clientLeft) * 2) / 2;
      const nextWidth = Math.round(bRect.width * 2) / 2;
      if (nextWidth <= 0) return;
      setThumb((prev) => {
        if (prev.ready && prev.left === nextLeft && prev.width === nextWidth) {
          return prev;
        }
        return {
          left: nextLeft,
          width: nextWidth,
          ready: true,
          animate: allowAnimate && prev.ready,
        };
      });
    };

    measure(mountedRef.current);
    mountedRef.current = true;

    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeIndex, options.length]);

  const baseClass = variant === 'preview' ? 'seg' : 'segmented-control';

  return (
    <div
      ref={containerRef}
      className={`${baseClass} has-slider`}
      data-slider-ready={thumb.ready ? 'true' : undefined}
      role="radiogroup"
      aria-label={ariaLabel}
      style={style}
    >
      <span
        className={`seg-slider-thumb ${thumb.animate ? 'is-animated' : ''}`}
        aria-hidden="true"
        style={{
          transform: `translate3d(${thumb.left}px, 0, 0)`,
          width: `${thumb.width}px`,
          opacity: thumb.ready ? 1 : 0,
        }}
      />
      {options.map((option, idx) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              btnRefs.current[idx] = el;
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={`seg-btn ${isActive ? 'active' : ''}`}
            onMouseDown={(e) => {
              // Prevent mouse clicks from leaving a sticky keyboard focus ring
              // while keeping Tab keyboard focus intact.
              e.preventDefault();
            }}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                const next = options[(idx + 1) % options.length];
                onChange(next.value);
                btnRefs.current[(idx + 1) % options.length]?.focus();
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                const prevIdx = (idx - 1 + options.length) % options.length;
                const prev = options[prevIdx];
                onChange(prev.value);
                btnRefs.current[prevIdx]?.focus();
              }
            }}
          >
            <span className="carbon-control-label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
