import { useEffect, useRef, type RefObject } from 'react';

interface UseSlidingIndicatorOptions {
  containerRef: RefObject<HTMLElement | null>;
  indicatorRef: RefObject<HTMLElement | null>;
  activeSelector: string;
  /** Data attribute set on container (e.g. 'listIndicator' -> data-list-indicator="ready"). */
  readyDataAttr: string;
  /** Changes here trigger a smooth GPU glide to the new active element. */
  deps: readonly unknown[];
  /** Changes here snap immediately without gliding across unrelated views/filters. */
  snapDeps?: readonly unknown[];
  /** Disable the indicator (e.g. during multi-select or inactive tab). */
  enabled?: boolean;
  /** True when the indicator lives inside the scrollable container itself. */
  scrollRelative?: boolean;
}

/**
 * Pure-DOM, zero-re-render sliding selection indicator.
 * Mutates only the indicator element's inline transform/size/opacity inside a
 * coalesced requestAnimationFrame so keyboard navigation, scrolling, and tab
 * switching never trigger extra React commits or synchronous layout thrash.
 */
export function useSlidingIndicator({
  containerRef,
  indicatorRef,
  activeSelector,
  readyDataAttr,
  deps,
  snapDeps = [],
  enabled = true,
  scrollRelative = true,
}: UseSlidingIndicatorOptions): void {
  const prevSnapRef = useRef<readonly unknown[]>(snapDeps);
  const hasVisibleRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingAnimateRef = useRef(false);
  const lastMetricsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const measureFnRef = useRef<((allowAnimate: boolean) => void) | null>(null);

  const scheduleMeasure = (allowAnimate: boolean) => {
    // Never let a passive layout/scroll tick cancel an already-queued animated glide.
    if (rafRef.current !== null) {
      pendingAnimateRef.current = pendingAnimateRef.current || allowAnimate;
      return;
    }
    pendingAnimateRef.current = allowAnimate;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const shouldAnimate = pendingAnimateRef.current;
      pendingAnimateRef.current = false;
      measureFnRef.current?.(shouldAnimate);
    });
  };

  useEffect(() => {
    const snapChanged =
      prevSnapRef.current.length !== snapDeps.length ||
      snapDeps.some((val, i) => !Object.is(val, prevSnapRef.current[i]));
    prevSnapRef.current = snapDeps;

    const container = containerRef.current;
    const indicator = indicatorRef.current;

    const hide = () => {
      if (indicator) {
        indicator.classList.remove('is-animated');
        indicator.style.opacity = '0';
      }
      if (container) {
        delete container.dataset[readyDataAttr];
      }
      hasVisibleRef.current = false;
      lastMetricsRef.current = null;
    };

    if (!enabled || !container || !indicator) {
      measureFnRef.current = null;
      hide();
      return;
    }

    const applyMeasure = (allowAnimate: boolean) => {
      const c = containerRef.current;
      const ind = indicatorRef.current;
      if (!c || !ind) return;

      const activeEl = c.querySelector<HTMLElement>(activeSelector);
      if (!activeEl) {
        hide();
        return;
      }

      let x: number;
      let y: number;
      let w: number;
      let h: number;

      if (scrollRelative && activeEl.offsetParent === c) {
        // Layout-space coordinates relative to the positioned container:
        // immune to CSS transform entrance animations (e.g. modal scale(0.95)).
        x = Math.round(activeEl.offsetLeft * 2) / 2;
        y = Math.round(activeEl.offsetTop * 2) / 2;
        w = Math.round(activeEl.offsetWidth * 2) / 2;
        h = Math.round(activeEl.offsetHeight * 2) / 2;
      } else {
        const cRect = c.getBoundingClientRect();
        const eRect = activeEl.getBoundingClientRect();
        if (eRect.width <= 0 || eRect.height <= 0) {
          hide();
          return;
        }
        x = Math.round((eRect.left - cRect.left + (scrollRelative ? c.scrollLeft : 0)) * 2) / 2;
        y = Math.round((eRect.top - cRect.top + (scrollRelative ? c.scrollTop : 0)) * 2) / 2;
        w = Math.round(eRect.width * 2) / 2;
        h = Math.round(eRect.height * 2) / 2;
      }

      if (w <= 0 || h <= 0) {
        hide();
        return;
      }

      const isDanger = activeEl.classList.contains('danger');
      ind.classList.toggle('is-danger', isDanger);

      const prev = lastMetricsRef.current;
      if (prev && prev.x === x && prev.y === y && prev.w === w && prev.h === h && hasVisibleRef.current) {
        return;
      }
      lastMetricsRef.current = { x, y, w, h };

      const shouldAnimate = allowAnimate && hasVisibleRef.current;
      if (shouldAnimate) {
        ind.classList.add('is-animated');
      } else {
        ind.classList.remove('is-animated');
      }

      ind.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      ind.style.width = `${w}px`;
      ind.style.height = `${h}px`;
      ind.style.opacity = '1';
      c.dataset[readyDataAttr] = 'ready';
      hasVisibleRef.current = true;
    };

    measureFnRef.current = applyMeasure;

    if (snapChanged && rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pendingAnimateRef.current = false;
    }

    // Measure immediately on snap/initial paint or smoothly on selection change
    scheduleMeasure(!snapChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, activeSelector, readyDataAttr, scrollRelative, ...deps, ...snapDeps]);

  // Persistent container observers: created once while enabled (never torn down
  // on selection changes, eliminating ResizeObserver initial-callback teleports).
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    const onNestedScroll = () => scheduleMeasure(false);
    if (!scrollRelative) {
      container.addEventListener('scroll', onNestedScroll, { capture: true, passive: true });
    }

    let ro: ResizeObserver | undefined;
    let lastW = container.clientWidth;
    let lastH = container.clientHeight;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        scheduleMeasure(false);
      });
      ro.observe(container);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        pendingAnimateRef.current = false;
      }
      if (!scrollRelative) {
        container.removeEventListener('scroll', onNestedScroll, true);
      }
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, scrollRelative]);
}
