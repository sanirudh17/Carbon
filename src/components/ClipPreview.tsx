import React, { useMemo, useState, useEffect } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { ClipItem, ContentType } from '../types';
import { getTypeColor, LockIcon, EyeIcon, EyeOffIcon } from './Icons';

const ImagePreview: React.FC<{ item: ClipItem }> = ({ item }) => {
  const [src, setSrc] = useState<string>(() => (item.image_path ? convertFileSrc(item.image_path) : ''));

  useEffect(() => {
    let active = true;
    if (item.image_path) {
      setSrc(convertFileSrc(item.image_path));
      invoke<string>('get_image_data_url', { filePath: item.image_path })
        .then((url) => {
          if (active && url) setSrc(url);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [item.image_path, item.id]);

  return (
    <div className="preview-media" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="preview-image-simple">
        {src ? (
          <img
            src={src}
            alt="Clipboard image preview"
            draggable={false}
            onError={() => {
              if (item.image_path) {
                invoke<string>('get_image_data_url', { filePath: item.image_path })
                  .then((url) => url && setSrc(url))
                  .catch(() => {});
              }
            }}
          />
        ) : (
          <div className="preview-media-placeholder">Loading image preview...</div>
        )}
      </div>
    </div>
  );
};

/* ═════════════════════════════════════════════════════════════════════
 * Shared read-only preview rendering (used by the Quick Overlay pane and
 * the Enlarged Window's render-mode toggle).
 * ═════════════════════════════════════════════════════════════════════ */

// ── Rich text sanitization ─────────────────────────────────────────────
// The HTML lives in the user's own clipboard; still strip anything
// executable or window-escaping so a hostile snippet can't run.
const BANNED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'button', 'select', 'textarea', 'svg', 'math', 'head',
]);
const BANNED_PROTOCOLS = ['javascript:', 'vbscript:'];

function extractFragment(html: string): string {
  if (!html) return '';
  const cleanStr = html.replace(/\0/g, '').trim();

  const startMarker = '<!--StartFragment-->';
  const endMarker = '<!--EndFragment-->';
  const s = cleanStr.indexOf(startMarker);
  const e = cleanStr.indexOf(endMarker);
  if (s !== -1 && e !== -1 && e > s) {
    return cleanStr.slice(s + startMarker.length, e).trim();
  }

  // Try parsing StartFragment: / EndFragment: offsets
  const startMatch = cleanStr.match(/StartFragment:(\d+)/i);
  const endMatch = cleanStr.match(/EndFragment:(\d+)/i);
  if (startMatch && endMatch) {
    const startOffset = parseInt(startMatch[1], 10);
    const endOffset = parseInt(endMatch[1], 10);
    if (!isNaN(startOffset) && !isNaN(endOffset) && endOffset > startOffset && endOffset <= cleanStr.length) {
      const slice = cleanStr.slice(startOffset, endOffset).trim();
      if (slice) return slice;
    }
  }

  // If header exists without markers, strip header before <html> or <body>
  if (cleanStr.startsWith('Version:')) {
    const bodyIdx = cleanStr.indexOf('<body');
    if (bodyIdx !== -1) {
      const tagEnd = cleanStr.indexOf('>', bodyIdx);
      if (tagEnd !== -1) {
        const bodyEnd = cleanStr.indexOf('</body>', tagEnd);
        return cleanStr.slice(tagEnd + 1, bodyEnd !== -1 ? bodyEnd : undefined).trim();
      }
    }
  }

  return cleanStr;
}

// ── Source-theme detection (dark pages) ────────────────────────────────
// The preview wraps rich captures in a forced-white card so light-assuming
// page HTML stays readable on the dark app surface. That breaks captures
// from DARK sites: their light text (often with no explicit background —
// the black came from the stripped <body>) turns invisible on white.
// Detect a dark source from page-level signals (meta color-scheme, body
// bgcolor/text attrs, html/body inline background, data-theme) and render
// those on a dark card instead. Anything ambiguous stays on white (status
// quo ante). Pure helper — no DOM side effects.
function cssColorLuminance(color: string): number | null {
  const c = color.trim().toLowerCase();
  const named: Record<string, string> = {
    black: '#000000', white: '#ffffff', dimgray: '#696969', gray: '#808080',
    darkgray: '#a9a9a9', lightgray: '#d3d3d3', gainsboro: '#dcdcdc', red: '#ff0000',
  };
  let r = -1, g = -1, b = -1;
  const hex = named[c] || (/^#[0-9a-f]{3,8}$/.test(c) ? c : null);
  if (hex) {
    let h = hex.slice(1);
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((x) => x + x).join('');
    if (h.length >= 6) {
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    }
  } else {
    const m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (m) { r = Number(m[1]); g = Number(m[2]); b = Number(m[3]); }
  }
  if (r < 0 || g < 0 || b < 0 || r > 255 || g > 255 || b > 255) return null;
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function detectSourceTheme(html: string): 'dark' | 'light' {
  try {
    const doc = new DOMParser().parseFromString((html || '').replace(/\0/g, ''), 'text/html');
    const htmlEl = doc.documentElement;
    const body = doc.body;
    const isDark = (c: string) => { const l = cssColorLuminance(c); return l !== null && l < 0.35; };
    const isLight = (c: string) => { const l = cssColorLuminance(c); return l !== null && l > 0.65; };
    // <meta name="color-scheme" content="dark"> — strongest signal.
    const meta = doc.querySelector('meta[name="color-scheme"]');
    const metaContent = (meta?.getAttribute('content') || '').toLowerCase();
    if (metaContent.includes('dark')) return 'dark';
    if (metaContent.includes('light')) return 'light';
    // Legacy body bgcolor/text attributes.
    const bgAttr = body?.getAttribute('bgcolor') || '';
    if (bgAttr && isDark(bgAttr)) return 'dark';
    // Inline backgrounds / color-scheme on <html> / <body>.
    for (const el of [htmlEl, body]) {
      const st = (el?.getAttribute('style') || '').toLowerCase();
      const bgm = st.match(/background(?:-color)?\s*:\s*([^;}]+)/);
      if (bgm && isDark(bgm[1].trim())) return 'dark';
      if (bgm && isLight(bgm[1].trim())) return 'light';
      if (/color-scheme\s*:\s*[^;}]*dark/.test(st)) return 'dark';
    }
    // Explicit theme markers.
    const themed = htmlEl?.getAttribute('data-theme') || body?.getAttribute('data-theme') || '';
    if (themed.toLowerCase() === 'dark') return 'dark';
    if (themed.toLowerCase() === 'light') return 'light';
    const cls = `${htmlEl?.getAttribute('class') || ''} ${body?.getAttribute('class') || ''}`.toLowerCase();
    if (/\bdark\b/.test(cls) && !/\blight\b/.test(cls)) return 'dark';
    // Light default text with no dark background signals anywhere implies
    // the page itself was dark (its body backdrop was stripped with it).
    const textAttr = body?.getAttribute('text') || '';
    if (textAttr && isLight(textAttr)) return 'dark';
    // Content scan (last resort): light INLINE text with no dark INLINE
    // background anywhere in the fragment. Class-based colors can't apply
    // here (no site stylesheet), so only inline styles affect rendering —
    // and inline light-on-transparent text is exactly what the stripped
    // page backdrop used to sit behind. Flip only when light text is not
    // outnumbered by dark text (a light page stays light).
    // NOTE: `color` is ;-anchored so `background-color` never matches.
    let lightText = 0, darkText = 0, darkBg = 0, scanned = 0;
    const walker = doc.createTreeWalker(body as Node, NodeFilter.SHOW_ELEMENT);
    let node: Element | null;
    while ((node = walker.nextNode() as Element | null) && scanned < 1000) {
      scanned++;
      const st = `;${(node.getAttribute('style') || '').toLowerCase()};`;
      const cm = st.match(/;\s*color\s*:\s*([^;]+);/);
      if (cm) {
        const l = cssColorLuminance(cm[1].trim());
        if (l !== null) {
          if (l > 0.65) lightText++;
          else if (l < 0.35) darkText++;
        }
      }
      const bgm = st.match(/;\s*background(?:-color)?\s*:\s*([^;]+);/);
      if (bgm) {
        const v = bgm[1].trim();
        if (v && v !== 'transparent' && v !== 'none' && v !== 'initial' && v !== 'inherit' && v !== 'unset') {
          // Gradients and unparseable values (e.g. `url(...)`) count as
          // "has a backdrop" (conservative: keep the white card). Only a
          // provably-transparent background lets light text flip the card.
          const l = /gradient/.test(v) ? null : cssColorLuminance(v);
          if (l === null || l < 0.35) darkBg++;
        }
      }
    }
    if (lightText > 0 && darkBg === 0 && lightText >= darkText) return 'dark';
  } catch { /* fall through to light */ }
  return 'light';
}

function sanitizeRichHtml(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(extractFragment(html), 'text/html');
    const clean = (node: Element) => {
      for (const child of Array.from(node.children)) {
        const tag = child.tagName.toLowerCase();
        if (BANNED_TAGS.has(tag) || tag === 'head') {
          child.remove();
          continue;
        }
        if (tag === 'img') {
          const src = child.getAttribute('src')?.trim() || '';
          if (src) {
            // For blob: or auth-gated https: that will 404 in file://, the
            // Rust side now also captures the DIB rendering of the selection
            // as a fallback `image_path` on the rich_text item. Keep the
            // original src but let the fallback image below the HTML be the
            // authoritative visual — don't dominate the layout with 5×
            // "[Image not available]" spans.
            if (src.toLowerCase().startsWith('blob:')) {
              (child as HTMLElement).style.display = 'none';
            } else {
              child.setAttribute('referrerpolicy', 'no-referrer');
              child.setAttribute('loading', 'lazy');
              child.setAttribute(
                'onerror',
                "this.style.display='none'; var p=document.createElement('span'); p.className='rich-img-fallback'; p.textContent=' [Image] '; this.parentNode.insertBefore(p, this);"
              );
              (child as HTMLElement).style.maxWidth = '100%';
              (child as HTMLElement).style.height = 'auto';
              (child as HTMLElement).style.display = 'block';
              (child as HTMLElement).style.margin = '8px 0';
            }
          }
        }
        // Keep the original background for genuine rich captures (e.g., a
        // website's white question card). Stripping it was hiding the
        // website's own white background that the user expects to see.
        // The dark preview now shows the HTML as-is, with its original
        // background, so a site's white card renders white and Notepad's
        // plain wrapper (which has no background) stays dark.
        for (const attr of Array.from(child.attributes)) {
          const name = attr.name.toLowerCase();
          const val = attr.value.trim().toLowerCase();
          if (
            name.startsWith('on') ||
            ((name === 'href' || name === 'src') &&
              BANNED_PROTOCOLS.some((p) => val.startsWith(p)))
          ) {
            // Keep the onerror we just set for img
            if (tag === 'img' && name === 'onerror') continue;
            child.removeAttribute(attr.name);
          }
        }
        clean(child);
      }
    };
    clean(doc.body);
    renderMathInElement(doc.body);
    return doc.body.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
  } catch {
    return '';
  }
}

// ── Lightweight LaTeX math prettifier ────────────────────────────────────
// Clipboard HTML from study-note pages (e.g. Comet) carries raw `$...$`
// delimiters. A full KaTeX dependency is overkill for a clipboard preview,
// so we do a tiny conservative pass: `$...$`, `$$...$$`, `\(...\)` and
// `\[...\]` become serif-italic math spans with common commands
// (`\longrightarrow`/`\Longrightarrow`, `\sum`, `\wedge`, `\times`,
// `\circ`, `\epsilon`/`\varepsilon`, set operators, `\frac{a}{b}`,
// `^`/`_` super/subscripts, `\text{..}`, `\#`, Greek (incl. capitals), …)
// replaced by their glyphs. The opening `$` must not be glued to a word
// char (so "$5-$10" never matches) and pure numbers ($10$) stay literal —
// everything else with valid delimiters converts.
const MATH_GLYPHS: Record<string, string> = {
  Longrightarrow: '⟹', Longleftarrow: '⟸', implies: '⟹', iff: '⟺', Leftrightarrow: '⇔',
  to: '→', rightarrow: '→', longrightarrow: '⟶', leftarrow: '←', longleftarrow: '⟵',
  Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', mapsto: '↦',
  times: '×', div: '÷', cdot: '·', circ: '∘', bullet: '•', ast: '∗', star: '★',
  pm: '±', sim: '∼', simeq: '≃', cong: '≅', approx: '≈', equiv: '≡', propto: '∝',
  leq: '≤', geq: '≥', le: '≤', ge: '≥', ll: '≪', gg: '≫',
  neq: '≠', ne: '≠', infty: '∞',
  sum: '∑', prod: '∏', int: '∫',
  wedge: '∧', vee: '∨', land: '∧', lor: '∨', neg: '¬', lnot: '¬',
  models: '⊨', vdash: '⊢', mid: '∣',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ϵ',
  zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
  Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ',
  Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ',
  Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  cap: '∩', cup: '∪', bigcap: '⋂', bigcup: '⋃', in: '∈', notin: '∉',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  forall: '∀', exists: '∃', nexists: '∄',
  oplus: '⊕', ominus: '⊖', otimes: '⊗',
  partial: '∂', nabla: '∇', prime: '′',
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  lfloor: '⌊', rfloor: '⌋', floor: '⌊', lceil: '⌈', rceil: '⌉',
  langle: '⟨', rangle: '⟩', emptyset: '∅', varnothing: '∅',
  // Upright operators render as plain text (backslash dropped).
  lim: 'lim', log: 'log', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan',
  max: 'max', min: 'min', argmax: 'argmax', argmin: 'argmin',
  sup: 'sup', inf: 'inf', det: 'det', dim: 'dim',
};

function prettifyMathContent(s: string): string {
  // Escape first so the <sup>/<sub> inserted below survive as markup.
  let out = escapeHtml(s);
  // LaTeX `\\` line break → space (must run before single-backslash rules).
  out = out.replace(/\\\\/g, ' ');
  // `^\circ` is the degree idiom (`18^\circ C` → 18°C); a bare `\circ`
  // (function composition, `f \circ g`) renders as ∘.
  out = out.replace(/\^\\circ/g, '°');
  out = out.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)');
  out = out.replace(/\\sqrt\[[^\]]*\]\{([^}]*)\}/g, '√$1');
  out = out.replace(/\\sqrt\{([^}]*)\}/g, '√$1');
  out = out.replace(/\\(text|mathrm|mathbf|mathit|textbf|textit|mathcal|mathsf|boldsymbol|operatorname)\{([^}]*)\}/g, '$2');
  // Accent/styling wrappers keep their argument: `\hat{x}` → x, `\bar{x}` → x.
  out = out.replace(/\\(hat|bar|tilde|vec|dot|ddot|overline|underline)\{([^}]*)\}/g, '$2');
  out = out.replace(/\\(hat|bar|tilde|vec)\s*([A-Za-z])/g, '$2');
  // `\left(`/`\right)`, `\left|`/`\right.`, … are just delimiters.
  // The lookahead keeps longer commands (`\rightarrow`, `\leftarrow`,
  // `\leftrightarrow`) intact for the glyph lookup below.
  out = out.replace(/\\(left|right)(?![A-Za-z])\s*([({\[|.)\]])?/g, (_m, _cmd: string, delim?: string) =>
    !delim || delim === '.' ? '' : delim
  );
  // Sizing prefixes carry no meaning for a text preview — drop them, but
  // not inside `\bigcap` / `\bigcup` (lookahead, same reason as above).
  out = out.replace(/\\(bigg?|Bigg?)(?![A-Za-z])\s*/g, '');
  out = out.replace(/\\(hspace|vspace)(\{[^}]*\}|\*?\s*\S+)?/g, ' ');
  out = out.replace(/\\(quad|qquad)\b/g, ' ');
  // Blackboard-bold sets common in AI notes: `\mathbb{N}` → ℕ (others unwrap).
  out = out.replace(/\\mathbb\{([A-Z])\}/g, (_m, letter: string) =>
    ({ N: 'ℕ', R: 'ℝ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ' } as Record<string, string>)[letter] ?? letter
  );
  // Command lookup: longest letter-run after `\` (so `\sum_{…}` matches
  // even though `_` is a word char, where `\b` would fail). Unknown
  // commands (`\mathbb`, `\begin`, …) are left untouched.
  out = out.replace(/\\([A-Za-z]+)/g, (m, cmd: string) => MATH_GLYPHS[cmd] ?? m);
  // Superscripts / subscripts: $P^*$ → P*, $S_O$ → S with O subscript,
  // $18^\circ C$ → 18°C (handled above), $O(b^{d/2})$ keeps its exponent.
  out = out.replace(/\^\{([^}]*)\}|\^(\S)/g, '<sup>$1$2</sup>');
  out = out.replace(/_\{([^}]*)\}|_([A-Za-z0-9])/g, '<sub>$1$2</sub>');
  out = out.replace(/\\[ ,;:]/g, ' ').replace(/\\&amp;/g, '&amp;').replace(/\\%/g, '%').replace(/\\_/g, '&#95;').replace(/\\\$/g, '$').replace(/\\#/g, '#');
  return out.trim();
}

// Single-$ pairs need a guarded opening `$` (not glued to a word char, `-`
// or another `$`) so price ranges like "$5-$10" are never treated as math.
// Everything else with valid delimiters converts — EXCEPT pure numbers
// ($10$ stays literal), which is the only remaining price-like shape.
const MATH_RE = /\\\[([\s\S]+?)\\\]|\\\((.+?)\\\)|\$\$([\s\S]+?)\$\$|(?<![\w$\-–—])\$([^\s$](?:[^$]*?[^\s$])?)\$/g;

function mathifyTextContent(text: string): string {
  let result = '';
  let last = 0;
  MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_RE.exec(text)) !== null) {
    result += escapeHtml(text.slice(last, m.index));
    const content = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    const display = m[1] !== undefined || m[3] !== undefined;
    if (/^[\d\s.,$–—-]+$/.test(content)) {
      result += escapeHtml(m[0]);
    } else {
      result += `<span class="${display ? 'math-display' : 'math-inline'}">${prettifyMathContent(
        content
      )}</span>`;
    }
    last = m.index + m[0].length;
  }
  result += escapeHtml(text.slice(last));
  return result;
}

function renderMathInElement(root: Element) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = node.nodeValue || '';
    if (text.includes('$') || text.includes('\\(') || text.includes('\\[')) {
      const parent = (node as Text).parentElement;
      const tag = parent?.tagName.toLowerCase() || '';
      if (tag !== 'code' && tag !== 'pre' && tag !== 'script' && tag !== 'style' && tag !== 'textarea') {
        nodes.push(node as Text);
      }
    }
    node = walker.nextNode();
  }
  for (const textNode of nodes) {
    const html = mathifyTextContent(textNode.nodeValue || '');
    const tmp = doc.createElement('span');
    tmp.innerHTML = html;
    textNode.replaceWith(...Array.from(tmp.childNodes));
  }
}

// ── Content-type labels, specific rather than generic ──────────────────

function detectCodeLanguage(text: string): string | null {
  const t = (text || '').trim();
  if (!t) return null;

  if (/^\s*<(!DOCTYPE\s+)?html[\s>]/i.test(t) || /<[a-z][\s>][^>]*>[\s\S]*<\/[a-z]>/i.test(t.slice(0, 400))) {
    return 'HTML';
  }
  if (/^\s*[a-z.#*][\w.#:>-]*\s*\{[\s\S]*\}/i.test(t) && /:\s*[\w#()%.\s]+;/.test(t)) {
    return 'CSS';
  }
  if (/^\s*[{\[].*\s*:/s.test(t.slice(0, 300))) {
    try {
      JSON.parse(t);
      return 'JSON';
    } catch {
      /* not strict JSON — fall through */
    }
  }
  if (/\b(export|import|const|let|function|=>|async)\b/.test(t) && /[{}()]/.test(t)) {
    return 'JavaScript';
  }
  if (/^\s*(def|class|import|from)\s+\w+/m.test(t) && /\s*:\s*$/.test(t.split('\n')[0] || '')) {
    return 'Python';
  }
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|WITH)\s/i.test(t) && /;/.test(t)) {
    return 'SQL';
  }
  if (/^\s*(#{1,6}\s|\s*[-*+]\s|```)/m.test(t)) {
    return 'Markdown';
  }
  return null;
}

export function getQrCopyLabel(qrContent: string): string {
  return /^(?:https?|ftp):\/\//i.test(qrContent.trim()) ? 'Copy decoded link' : 'Copy decoded text';
}

export function getSpecificTypeLabel(item: ClipItem): string {
  switch (item.content_type) {
    case 'rich_text':
      return 'Text (Formatted)';
    case 'text':
      return 'Text (Plain)';
    case 'code': {
      const lang = item.text_content ? detectCodeLanguage(item.text_content) : null;
      return lang ? `Code (${lang})` : 'Code';
    }
    case 'image':
      return 'Image';
    case 'file':
      return item.is_video ? 'Video' : 'File';
    case 'link':
      return 'Link';
    case 'email':
      return 'Email';
    case 'color':
      return 'Color';
    default:
      return item.content_type;
  }
}

// ── Formatting helpers ─────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatCopiedAt(dateStr: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr.replace(' ', 'T'));
  if (isNaN(d.getTime())) return dateStr;

  const now = new Date();
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayStartD = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((dayStart.getTime() - dayStartD.getTime()) / 86400000);
  const dayLabel =
    diffDays === 0
      ? 'Today'
      : diffDays === 1
        ? 'Yesterday'
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${dayLabel} ${time}`;
}



const KNOWN_APP_NAMES: Record<string, string> = {
  'winword.exe': 'Word',
  'excel.exe': 'Excel',
  'powerpnt.exe': 'PowerPoint',
  'outlook.exe': 'Outlook',
  'onenote.exe': 'OneNote',
  'notepad.exe': 'Notepad',
  'code.exe': 'VS Code',
  'codium.exe': 'VS Code',
  'chrome.exe': 'Chrome',
  'msedge.exe': 'Edge',
  'firefox.exe': 'Firefox',
  'opera.exe': 'Opera',
  'explorer.exe': 'File Explorer',
  'windowsterminal.exe': 'Windows Terminal',
  'terminal.exe': 'Terminal',
  'powershell.exe': 'PowerShell',
  'pwsh.exe': 'PowerShell',
  'cmd.exe': 'Command Prompt',
  'slack.exe': 'Slack',
  'discord.exe': 'Discord',
  'teams.exe': 'Teams',
  'zoom.exe': 'Zoom',
  'obsidian.exe': 'Obsidian',
  'notion.exe': 'Notion',
  'spotify.exe': 'Spotify',
  'photoshop.exe': 'Photoshop',
  'figma.exe': 'Figma',
};

export function appDisplayName(app: string | null | undefined): string {
  if (!app) return 'Unknown App';
  const lower = app.toLowerCase();
  if (KNOWN_APP_NAMES[lower]) {
    return KNOWN_APP_NAMES[lower];
  }
  const clean = app.replace(/\.exe$/i, '').replace(/[_\-.]/g, ' ').trim();
  if (!clean) return 'Unknown App';
  return clean
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ── Markdown helpers ────────────────────────────────────────────────────

export function isMarkdownContent(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;

  return (
    // Headings (# Heading or Underline Heading)
    /^\s*#{1,6}(\s+|$)/m.test(t) ||
    /^[^\n]+\n\s*(=+|-+)\s*$/m.test(t) ||
    // Lists & Task lists (- , * , + , 1. , 1) , - [ ] , - [x])
    /^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/m.test(t) ||
    // Blockquotes (> Quote)
    /^\s*>\s*/m.test(t) ||
    // Fenced Code Blocks (``` or ~~~)
    /```|~~~/m.test(t) ||
    // Inline code (`code`)
    /`[^`]+`/.test(t) ||
    // Markdown Tables (| cell | cell |)
    /^\s*\|.+\|\s*$/m.test(t) ||
    // Horizontal rules (---, ***, ___)
    /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/m.test(t) ||
    // Bold, Italic, Strikethrough, Highlight (***, **, *, ___, __, _, ~~, ==)
    /(?:^|\s)(\*{1,3}|_{1,3}|~~|==)[^\s\n][\s\S]*?[^\s\n]\1(?:\s|$|[.,!?;:])/m.test(t) ||
    // Markdown links [text](url) or images ![alt](url) or reference [text][ref]
    /!?\[[^\]]*\]\([^)]+\)/.test(t) ||
    /\[[^\]]+\]:\s*\S+/.test(t) ||
    // HTML tags in text (e.g. <b>, <code>, <span>, <div>, <pre>, <a>, etc.)
    /<([a-z][a-z0-9]*)\b[^>]*>[\s\S]*?<\/\1>/i.test(t) ||
    /<(br|hr|img)\s*\/?>/i.test(t)
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseInlineMarkdown(str: string): string {
  if (!str) return '';

  // 1. Extract inline code blocks to protect them from further formatting
  const codeSpans: string[] = [];
  let s = str.replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(`<code class="inline-code">${escapeHtml(code)}</code>`);
    return `\x01code${codeSpans.length - 1}\x02`;
  });

  // 2. Escape remaining text
  s = escapeHtml(s);

  // 3. Images: ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="md-img" />');

  // 4. Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  // 5. Bold & Italic: ***text*** or ___text___
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');

  // 6. Bold: **text** or __text__
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // 7. Italic: *text* or _text_ (prevent matching identifiers like snake_case)
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*([^\w*]|$)/g, '$1<em>$2</em>$3');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_([^\w_]|$)/g, '$1<em>$2</em>$3');

  // 8. Strikethrough: ~~text~~
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 9. Highlight: ==text==
  s = s.replace(/==([^=]+)==/g, '<mark class="md-mark">$1</mark>');

  // 10. Restore code spans
  s = s.replace(/\x01code(\d+)\x02/g, (_m, idx) => codeSpans[Number(idx)] || '');

  return s;
}

export function parseMarkdownToHtml(md: string): string {
  if (!md) return '';

  const lines = md.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeBuffer: string[] = [];
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';
  let paragraphBuffer: string[] = [];
  let blockquoteBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuffer.length > 0) {
      out.push(`<p>${paragraphBuffer.map(parseInlineMarkdown).join('<br />')}</p>`);
      paragraphBuffer = [];
    }
  };

  const flushBlockquote = () => {
    if (blockquoteBuffer.length > 0) {
      out.push(`<blockquote>${blockquoteBuffer.map(parseInlineMarkdown).join('<br />')}</blockquote>`);
      blockquoteBuffer = [];
    }
  };

  const closeListIfNeeded = () => {
    if (inList) {
      out.push(listType === 'ul' ? '</ul>' : '</ol>');
      inList = false;
    }
  };

  const flushAll = () => {
    flushParagraph();
    flushBlockquote();
    closeListIfNeeded();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Fenced Code Blocks
    if (trimmed.startsWith('```')) {
      flushAll();
      if (inCodeBlock) {
        out.push(
          `<pre class="md-code-block"><code class="language-${codeLang}">${escapeHtml(
            codeBuffer.join('\n')
          )}</code></pre>`
        );
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLang = trimmed.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // 2. Blank Lines
    if (!trimmed) {
      flushAll();
      continue;
    }

    // 3. Horizontal Rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushAll();
      out.push('<hr class="md-hr" />');
      continue;
    }

    // 4. Blockquotes
    if (trimmed.startsWith('>')) {
      flushParagraph();
      closeListIfNeeded();
      const quoteText = trimmed.replace(/^>\s?/, '');
      blockquoteBuffer.push(quoteText);
      continue;
    } else {
      flushBlockquote();
    }

    // 5. Headings (# Title)
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushAll();
      const level = headingMatch[1].length;
      const content = parseInlineMarkdown(headingMatch[2]);
      out.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    // 6. Markdown Tables (Row starts with | and next row is separator)
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && nextLine.startsWith('|') && /^\|[\s:\-|\s]+\|$/.test(nextLine)) {
        flushAll();
        // Parse table
        const headerCells = trimmed
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim());
        const alignSpecs = nextLine
          .slice(1, -1)
          .split('|')
          .map((c) => {
            const spec = c.trim();
            if (spec.startsWith(':') && spec.endsWith(':')) return 'center';
            if (spec.endsWith(':')) return 'right';
            return 'left';
          });

        let tableHtml = '<table><thead><tr>';
        headerCells.forEach((c, idx) => {
          const align = alignSpecs[idx] || 'left';
          tableHtml += `<th style="text-align:${align}">${parseInlineMarkdown(c)}</th>`;
        });
        tableHtml += '</tr></thead><tbody>';

        i++; // skip separator
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|') && lines[i + 1].trim().endsWith('|')) {
          i++;
          const rowCells = lines[i]
            .trim()
            .slice(1, -1)
            .split('|')
            .map((c) => c.trim());
          tableHtml += '<tr>';
          rowCells.forEach((c, idx) => {
            const align = alignSpecs[idx] || 'left';
            tableHtml += `<td style="text-align:${align}">${parseInlineMarkdown(c)}</td>`;
          });
          tableHtml += '</tr>';
        }
        tableHtml += '</tbody></table>';
        out.push(tableHtml);
        continue;
      }
    }

    // 7. Unordered Lists and Task Lists (- [ ] or - [x] or - item)
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ulMatch) {
      flushParagraph();
      if (!inList || listType !== 'ul') {
        closeListIfNeeded();
        inList = true;
        listType = 'ul';
        out.push('<ul>');
      }
      const rawItem = ulMatch[2];
      const taskMatch = rawItem.match(/^\[([ xX])\]\s+(.*)$/);
      if (taskMatch) {
        const isChecked = taskMatch[1].toLowerCase() === 'x';
        out.push(
          `<li class="task-item"><input type="checkbox" disabled ${
            isChecked ? 'checked' : ''
          } /> ${parseInlineMarkdown(taskMatch[2])}</li>`
        );
      } else {
        out.push(`<li>${parseInlineMarkdown(rawItem)}</li>`);
      }
      continue;
    }

    // 8. Ordered Lists (1. item)
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (olMatch) {
      flushParagraph();
      if (!inList || listType !== 'ol') {
        closeListIfNeeded();
        inList = true;
        listType = 'ol';
        out.push('<ol>');
      }
      out.push(`<li>${parseInlineMarkdown(olMatch[2])}</li>`);
      continue;
    }

    // 9. Regular text lines (grouped into paragraphs)
    closeListIfNeeded();
    paragraphBuffer.push(line);
  }

  if (inCodeBlock) {
    out.push(
      `<pre class="md-code-block"><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`
    );
  }
  flushAll();

  return out.join('\n');
}

export function renderMarkdownToHtml(markdown: string): string {
  return parseMarkdownToHtml(markdown);
}

// ── Content renderer ───────────────────────────────────────────────────

export const ClipPreview: React.FC<{ item: ClipItem; forceRaw?: boolean }> = ({ item, forceRaw = false }) => {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setRevealed(false);
  }, [item.id]);

  const sanitizedHtml = useMemo(
    () => (item.html_content ? sanitizeRichHtml(item.html_content) : ''),
    [item.html_content]
  );

  // Dark-source pages render on a dark card (their light text would vanish
  // on the forced-white card); everything else keeps the white card.
  const sourceTheme = useMemo(
    () => (item.html_content ? detectSourceTheme(item.html_content) : 'light'),
    [item.html_content]
  );

  // Sensitive data masking check
  if (item.is_sensitive && !revealed) {
    return (
      <div className="preview-sensitive-mask">
        <div className="sensitive-badge-box">
          <LockIcon />
          <span>Sensitive Clip Protected</span>
        </div>
        <div className="sensitive-dots">••••••••••••••••••••••••••••</div>
        <div className="sensitive-hint">
          {item.expires_at ? 'Auto-expires shortly · Value masked for privacy' : 'Value masked for privacy'}
        </div>
        <button className="btn subtle sensitive-reveal-btn" onClick={() => setRevealed(true)}>
          <EyeIcon /> Reveal sensitive content
        </button>
      </div>
    );
  }

  // Content body
  const renderContentBody = () => {
    // Image
    if (item.content_type === 'image' && item.image_path) {
      return <ImagePreview item={item} />;
    }

    // File / video
    if (item.content_type === 'file') {
      let paths: string[] = [];
      if (item.file_paths) {
        try {
          paths = JSON.parse(item.file_paths);
        } catch {
          paths = [];
        }
      } else if (item.text_content) {
        paths = item.text_content.split('\n').filter(Boolean);
      }

      return (
        <div className="preview-media">
          {item.is_video && paths[0] ? (
            <div className="preview-video-wrapper">
              <video controls src={convertFileSrc(paths[0])} />
            </div>
          ) : null}
          <div className="preview-file-card">
            <div className="preview-file-title">{item.title}</div>
            <div className="preview-file-meta">Size: {formatBytes(item.file_size)}</div>
            {paths.map((p) => (
              <div key={p} className="preview-file-meta mono" style={{ wordBreak: 'break-all' }}>
                {p}
              </div>
            ))}
            {paths.length > 1 && (
              <div className="preview-file-meta muted">{paths.length - 1} more file(s)</div>
            )}
          </div>
        </div>
      );
    }

    // Color
    if (item.content_type === 'color') {
      return (
        <div className="color-swatch-box" style={{ background: item.title }}>
          {item.title}
        </div>
      );
    }

    const text = item.text_content || item.title || '';

    if (!forceRaw) {
      // Rich text — actually formatted HTML. Document-like captures (Gmail,
      // Comet, Chrome, localhost docs) carry dark-on-light styling from the
      // source page; rendering them on the app's dark surface makes black
      // text invisible except where the page set its own white background
      // (the "only diagrams highlighted" bug). So ALL rich_text renders
      // inside a light document card with forced dark ink, regardless of
      // source app. Plain Notepad stays dark because it is `text`, not
      // `rich_text`.
      if (item.content_type === 'rich_text' && sanitizedHtml) {
        const richHtml =
          sourceTheme === 'dark' ? (
            <div className="rich-doc rich-doc-dark" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
          ) : (
            <div className="rich-doc rich-doc-light" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
          );
        // If this rich capture also has a DIB fallback image (because its
        // HTML contained <img> with blob: or auth-gated https:), show that
        // captured image below the HTML so the images from sites like
        // rec215.examly.io are actually visible instead of "[Image not available]".
        const fallback = item.image_path ? (
          <div style={{ marginTop: 12 }}>
            <ImagePreview item={item} />
          </div>
        ) : null;
        return (
          <div
            style={
              sourceTheme === 'dark'
                ? {
                    background: '#14161a',
                    padding: '14px 16px',
                    borderRadius: '8px',
                    border: '1px solid #2a2e35',
                    overflow: 'hidden',
                    backgroundClip: 'padding-box',
                  }
                : {
                    background: '#ffffff',
                    color: '#1f2937',
                    padding: '14px 16px',
                    borderRadius: '8px',
                    border: '1px solid #e5e7eb',
                    overflow: 'hidden',
                    backgroundClip: 'padding-box',
                  }
            }
          >
            {richHtml}
            {fallback}
          </div>
        );
      }

      // Markdown text — formatted Markdown HTML
      if (isMarkdownContent(text)) {
        const renderedMd = renderMarkdownToHtml(text);
        if (renderedMd) {
          return (
            <div className="rich-doc" dangerouslySetInnerHTML={{ __html: renderedMd }} />
          );
        }
      }
    }

    if (!text.trim()) {
      return (
        <div className="preview-text-empty" style={{ opacity: 0.45, fontStyle: 'italic', padding: 8 }}>
          (No text content)
        </div>
      );
    }

    // Plain text / code / link / email (and raw fallback)
    if (item.content_type === 'link' || item.content_type === 'email') {
      return (
        <div className="preview-text plain" style={{ wordBreak: 'break-all' }}>
          {text}
        </div>
      );
    }
    return (
      <div className={`preview-text ${item.content_type === 'code' ? 'mono' : ''}`}>
        {text}
      </div>
    );
  };

  return (
    <div className="clip-preview-container">
      {item.is_sensitive && revealed && (
        <div className="sensitive-revealed-bar">
          <span className="sensitive-bar-text">
            <LockIcon /> Sensitive clip revealed {item.expires_at ? '(auto-expires soon)' : ''}
          </span>
          <button className="btn subtle small sensitive-remask-btn" onClick={() => setRevealed(false)}>
            <EyeOffIcon /> Mask
          </button>
        </div>
      )}
      {renderContentBody()}
    </div>
  );
};

// ── Metadata strip ─────────────────────────────────────────────────────

export const ClipMetaStrip: React.FC<{ item: ClipItem; onFilterByApp?: (app: string) => void }> = ({
  item,
  onFilterByApp,
}) => {
  const tint = getTypeColor(item.content_type);
  const extra: { label: string; value: string; mono?: boolean }[] = [];

  if (item.is_sensitive) {
    extra.push({
      label: 'Privacy',
      value: item.expires_at ? 'Sensitive (Auto-expires)' : 'Sensitive (Protected)',
    });
  }

  if (item.content_type === 'image') {
    if (item.image_width && item.image_height) {
      extra.push({ label: 'Dimensions', value: `${item.image_width} × ${item.image_height} px` });
    }
    if (item.file_size > 0) {
      extra.push({ label: 'File size', value: formatBytes(item.file_size) });
    }
  } else if (item.content_type === 'file') {
    if (item.file_size > 0) {
      extra.push({ label: 'File size', value: formatBytes(item.file_size) });
    }
    let paths: string[] = [];
    if (item.file_paths) {
      try {
        paths = JSON.parse(item.file_paths);
      } catch {
        paths = [];
      }
    }
    const firstPath = paths[0] || item.text_content?.split('\n')[0];
    if (firstPath) {
      extra.push({ label: item.is_video ? 'Video path' : 'Path', value: firstPath, mono: true });
    }
  } else if (item.content_type === 'text' || item.content_type === 'code') {
    const text = item.text_content || '';
    const chars = text.length;
    // Single length metric shared by prose and code — character count.
    extra.push({
      label: 'Length',
      value: `${chars.toLocaleString()} chars`,
    });
  } else if (item.content_type === 'color') {
    extra.push({ label: 'Hex value', value: item.title });
  } else if (item.content_type === 'link' && item.text_content) {
    extra.push({ label: 'URL host', value: (() => {
      try { return new URL(item.text_content!).host; } catch { return item.text_content!; }
    })() });
  }

  const appName = item.source_app ? appDisplayName(item.source_app) : 'Unknown';

  return (
    <div className="meta-strip">
      <div className="meta-title">Information</div>
      <div className="meta-row">
        <span className="meta-label">Application</span>
        <span
          className={`meta-value ${onFilterByApp && item.source_app ? 'meta-app-clickable' : ''}`}
          onClick={() => {
            if (onFilterByApp && item.source_app) {
              onFilterByApp(item.source_app);
            }
          }}
          title={onFilterByApp && item.source_app ? `Filter by ${appName}` : undefined}
        >
          {appName}
        </span>
      </div>
      <div className="meta-row">
        <span className="meta-label">Copied</span>
        <span className="meta-value">{formatCopiedAt(item.created_at)}</span>
      </div>
      <div className="meta-row">
        <span className="meta-label">Content type</span>
        <span className="meta-value" style={{ color: tint }}>
          {getSpecificTypeLabel(item)}
        </span>
      </div>
      {extra.map((row) => (
        <div className="meta-row" key={row.label}>
          <span className="meta-label">{row.label}</span>
          <span className={`meta-value ${row.mono ? 'mono' : ''}`} style={{ wordBreak: 'break-all' }}>
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
};

export type { ContentType };