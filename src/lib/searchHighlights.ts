// Preserve source offsets while folding case and diacritics, including Unicode
// combining marks. The returned ranges only decorate the preview, never text
// stored in the database, an editable field, or the system clipboard.
export function matchRanges(text: string, query: string): [number, number][] {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean).map(fold))].filter(Boolean);
  if (!terms.length) return [];
  let normalized = fold(text);
  const directOffsets = normalized.length === text.length;
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  if (!directOffsets) normalized = '';
  for (const char of directOffsets ? '' : text) {
    const part = fold(char);
    for (let n = 0; n < part.length; n++) {
      starts.push(offset);
      ends.push(offset + char.length);
    }
    if (!part && ends.length) ends[ends.length - 1] = offset + char.length;
    normalized += part;
    offset += char.length;
  }
  const hits: [number, number][] = [];
  for (const term of terms) {
    let at = 0;
    while (hits.length < 2000 && (at = normalized.indexOf(term, at)) !== -1) {
      hits.push(directOffsets ? [at, at + term.length] : [starts[at], ends[at + term.length - 1]]);
      at += term.length;
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last && hit[0] <= last[1]) last[1] = Math.max(last[1], hit[1]);
    else merged.push(hit);
  }
  return merged;
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function highlightPreview(root: HTMLElement, query: string): () => void {
  // CSS Custom Highlights paints native ranges without inserting nodes into
  // sanitized rich HTML. It also leaves selection and copy behavior intact.
  const api = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightClass = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!api || !HighlightClass || !query.trim()) return () => {};
  const nodes: Text[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest('button, input, textarea, script, style, .preview-sensitive-mask, .sensitive-revealed-bar')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  let text = '';
  const offsets: number[] = [];
  while ((node = walk.nextNode())) {
    offsets.push(text.length);
    nodes.push(node as Text);
    text += node.textContent || '';
  }
  const ranges = matchRanges(text, query).map(([start, end]) => {
    let first = 0;
    while (first + 1 < nodes.length && offsets[first + 1] <= start) first++;
    let last = first;
    while (last + 1 < nodes.length && offsets[last + 1] < end) last++;
    const range = document.createRange();
    range.setStart(nodes[first], start - offsets[first]);
    range.setEnd(nodes[last], end - offsets[last]);
    return range;
  });
  api.set('carbon-search', new HighlightClass(...ranges));
  if (ranges.length) {
    const match = ranges[0].getBoundingClientRect();
    let scroll: HTMLElement | null = root.parentElement;
    while (scroll && getComputedStyle(scroll).overflowY !== 'auto' && getComputedStyle(scroll).overflowY !== 'scroll') scroll = scroll.parentElement;
    if (scroll) {
      const bounds = scroll.getBoundingClientRect();
      if (match.top < bounds.top || match.bottom > bounds.bottom) scroll.scrollTop += match.top - bounds.top - 24;
    }
  }
  return () => { api.delete('carbon-search'); };
}
