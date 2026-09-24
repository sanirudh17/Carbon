/**
 * Pure rich-text helpers (sanitize, source-theme detection, contrast).
 * Deliberately React/Tauri-free so the preview pipeline is unit-runnable
 * (esbuild bundle + headless engine) and statically testable.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


// ── Rich text sanitization ─────────────────────────────────────────────
// The HTML lives in the user's own clipboard; still strip anything
// executable or window-escaping so a hostile snippet can't run.
// CONTENT-BEARING tags (button/form/input/select/textarea, …) are UNWRAPPED
// — their inner text stays in the preview. Only true non-content shells
// (script/style/iframe/head/…) are removed outright. Removing <button>
// wholesale is what dropped visible labels (e.g. "Assessment") that the
// plain-text twin still had.
const REMOVE_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
]);
const UNWRAP_TAGS = new Set([
  'form', 'input', 'button', 'select', 'textarea', 'svg', 'math', 'head',
]);
const BANNED_PROTOCOLS = ['javascript:', 'vbscript:'];

export function extractFragment(html: string): string {
  if (!html) return '';
  const cleanStr = html.replace(/\0/g, '').trim();

  const startMarker = '<!--StartFragment-->';
  const endMarker = '<!--EndFragment-->';
  const s = cleanStr.indexOf(startMarker);
  const e = cleanStr.indexOf(endMarker);
  if (s !== -1 && e !== -1 && e > s) {
    return cleanStr.slice(s + startMarker.length, e).trim();
  }

  // Try parsing StartFragment: / EndFragment: byte offsets. CF_HTML
  // offsets are BYTES from the payload start — slicing the UTF-16 JS
  // string corrupts every non-ASCII fragment, so encode and slice bytes.
  // (Offsets are relative to the raw payload, hence no pre-trim here.)
  const startMatch = cleanStr.match(/StartFragment:(\d+)/i);
  const endMatch = cleanStr.match(/EndFragment:(\d+)/i);
  if (startMatch && endMatch) {
    const startOffset = parseInt(startMatch[1], 10);
    const endOffset = parseInt(endMatch[1], 10);
    if (!isNaN(startOffset) && !isNaN(endOffset) && endOffset > startOffset) {
      try {
        const bytes = new TextEncoder().encode((html || '').replace(/\0/g, ''));
        if (endOffset <= bytes.length) {
          const slice = new TextDecoder().decode(bytes.slice(startOffset, endOffset)).trim();
          if (slice) return slice;
        }
      } catch { /* fall through to body fallback */ }
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
export function cssColorLuminance(color: string): number | null {
  const c = color.trim().toLowerCase();
  const named: Record<string, string> = {
    black: '#000000', white: '#ffffff', dimgray: '#696969', gray: '#808080',
    darkgray: '#a9a9a9', lightgray: '#d3d3d3', gainsboro: '#dcdcdc', silver: '#c0c0c0',
    red: '#ff0000', maroon: '#800000', orange: '#ffa500', yellow: '#ffff00', olive: '#808000',
    lime: '#00ff00', green: '#008000', aqua: '#00ffff', teal: '#008080', blue: '#0000ff',
    navy: '#000080', fuchsia: '#ff00ff', purple: '#800080',
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
    else {
      // hsl()/hsla() (comma or space separated): convert to sRGB.
      const hm = c.match(/^hsla?\(\s*([\d.]+)(deg|rad|grad|turn)?\s*[,\s]+\s*([\d.]+)%\s*[,\s]+\s*([\d.]+)%/);
      if (hm) {
        let h = Number(hm[1]);
        const unit = hm[2] || 'deg';
        if (unit === 'rad') h = (h * 180) / Math.PI;
        else if (unit === 'grad') h = h * 0.9;
        else if (unit === 'turn') h = h * 360;
        h = ((h % 360) + 360) % 360;
        const s = Math.min(1, Math.max(0, Number(hm[3]) / 100));
        const l = Math.min(1, Math.max(0, Number(hm[4]) / 100));
        const k = (n: number) => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f2 = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        r = Math.round(f2(0) * 255); g = Math.round(f2(8) * 255); b = Math.round(f2(4) * 255);
      }
    }
  }
  if (r < 0 || g < 0 || b < 0 || r > 255 || g > 255 || b > 255) return null;
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function detectSourceTheme(html: string): 'dark' | 'light' {
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

export function sanitizeRichHtml(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(extractFragment(html), 'text/html');
    const clean = (node: Element) => {
      for (const child of Array.from(node.children)) {
        const tag = child.tagName.toLowerCase();
        if (REMOVE_TAGS.has(tag)) {
          child.remove();
          continue;
        }
        // Unwrap interactive/form shells (and <head>): keep the children
        // (text) in place so visible labels aren't dropped with the tag.
        if (UNWRAP_TAGS.has(tag)) {
          const parent = child.parentNode;
          if (parent) {
            while (child.firstChild) parent.insertBefore(child.firstChild, child);
            parent.removeChild(child);
            // Promoted children were not in this Array.from snapshot —
            // clean the parent again after this pass (bounded by tag depth).
            clean(parent);
          }
          return;
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
        // Legacy color attributes (<font color>, bgcolor) still render as
        // engine presentation hints but are invisible to the contrast model
        // (B1 loss point: model said "inherited ink", engine showed the
        // attribute color). Fold them into inline style — single source of
        // truth for engine and model — then drop the attribute.
        const fontColor = tag === 'font' ? (child.getAttribute('color') || '').trim() : '';
        if (fontColor) {
          const existing = child.getAttribute('style') || '';
          if (!/(^|;)\s*color\s*:/i.test(`;${existing};`)) {
            child.setAttribute('style', `color: ${fontColor};${existing ? ` ${existing}` : ''}`);
          }
          child.removeAttribute('color');
        }
        const bgAttrColor = (child.getAttribute('bgcolor') || '').trim();
        if (bgAttrColor) {
          const existingBg = child.getAttribute('style') || '';
          if (!/(^|;)\s*background(?:-color)?\s*:/i.test(`;${existingBg};`)) {
            child.setAttribute('style', `background-color: ${bgAttrColor};${existingBg ? ` ${existingBg}` : ''}`);
          }
          child.removeAttribute('bgcolor');
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

// ── Per-node contrast enforcement (ADDENDUM v28-A) ──────────────────────
// Card-level theming guesses the page; node-level colors decide legibility.
// This pass walks the sanitized fragment carrying the effective (fg, bg)
// down the tree — inline declarations win, otherwise values inherit — and
// rewrites ONLY the fg of nodes whose own pair falls below AA (4.5:1).
// Inline backgrounds are authoritative and never dropped; the replacement
// fg prefers the card theme ink (aesthetic continuity) and falls back to
// near-black / near-white extremes (guaranteed pass). Nodes without direct
// text are skipped to avoid pointless DOM churn.
export interface RichCardTheme {
  bg: string;
  ink: string;
}

export const RICH_CARD_THEMES: Record<'dark' | 'light', RichCardTheme> = {
  light: { bg: '#ffffff', ink: '#1f2937' },
  dark: { bg: '#14161a', ink: '#e8eaed' },
};

const CONTRAST_FALLBACKS = ['#111827', '#f5f5f5'];

/** First color token of a shorthand value (background: <color> <image>…). */
function firstColorToken(value: string): string | null {
  const m = value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/i);
  if (m) return m[0];
  const words = value.split(/[\s,()]+/);
  for (const w of words) {
    const t = w.trim().toLowerCase();
    if (!t || t === 'transparent' || t === 'none' || t === 'initial' || t === 'inherit' || t === 'unset' || t === 'currentcolor') continue;
    if (/^[a-z]+$/.test(t)) return t;
  }
  return null;
}

/** ;-anchored inline declaration lookup (never confuses color with background-color). */
function inlineDecl(styleAttr: string, prop: 'color' | 'background' | 'background-color'): string | null {
  const m = `;${styleAttr.toLowerCase()};`.match(new RegExp(`;\\s*${prop}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

function parseInlineColor(value: string | null): string | null {
  if (!value) return null;
  const tok = firstColorToken(value);
  if (!tok) return null;
  return cssColorLuminance(tok) === null ? null : tok;
}

/** Nearest parseable inline background up the chain, else the card surface. */
function parseInlineBackground(value: string | null): string | null {
  if (!value) return null;
  const low = value.toLowerCase();
  if (/gradient/.test(low)) return null;
  const tok = firstColorToken(value);
  if (!tok) return null;
  if (/^(transparent|none|initial|inherit|unset)$/.test(tok.toLowerCase())) return null;
  return cssColorLuminance(tok) === null ? null : tok;
}

export function contrastRatio(fgCss: string, bgCss: string): number | null {
  const f = cssColorLuminance(fgCss);
  const b = cssColorLuminance(bgCss);
  if (f === null || b === null) return null;
  const [hi, lo] = f > b ? [f, b] : [b, f];
  return (hi + 0.05) / (lo + 0.05);
}

export function pickContrastingFg(bgCss: string, themeInk: string): string | null {
  const candidates = [themeInk, ...CONTRAST_FALLBACKS];
  for (const fg of candidates) {
    const r = contrastRatio(fg, bgCss);
    if (r !== null && r >= 4.5) return fg;
  }
  const last = contrastRatio(candidates[candidates.length - 1], bgCss);
  const first = contrastRatio(candidates[0], bgCss);
  if (last === null) return null;
  return last >= (first ?? 0) ? candidates[candidates.length - 1] : candidates[0];
}

function hasDirectText(el: Element): boolean {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3 && (n.textContent || '').trim()) return true;
  }
  return false;
}

/** Carbon's own chip backgrounds (index.css) per card theme. Must stay in
 * sync with `.rich-doc-light/dark code|pre` — the contrast test extracts the
 * real rules, so drift fails loudly there instead of washing chips. */
const CARBON_CHIP_BG: Record<'code' | 'pre', { light: string; dark: string }> = {
  code: { light: '#f3f4f6', dark: 'rgba(255, 255, 255, 0.08)' },
  pre: { light: '#f9fafb', dark: 'rgba(255, 255, 255, 0.05)' },
};

/** Channels + alpha for hex / rgb() / rgba() / hsl() / hsla() / named. */
function parseChannels(css: string): { r: number; g: number; b: number; a: number } | null {
  const c = css.trim().toLowerCase();
  const named: Record<string, string> = {
    black: '#000000', white: '#ffffff', transparent: 'rgba(0,0,0,0)',
  };
  const src = named[c] ?? c;
  const hm = src.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hm) {
    let h = hm[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  // Comma form: rgb(1, 2, 3[, a]). Space form: rgb(1 2 3[ / a]).
  const m = src.match(/^rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*[,\/]\s*([\d.]+))?\s*\)$/);
  if (m) {
    return {
      r: Number(m[1]), g: Number(m[2]), b: Number(m[3]),
      a: m[4] === undefined ? 1 : Number(m[4]),
    };
  }
  // hsl()/hsla() (comma or space separated, any angle unit).
  const hh = src.match(/^hsla?\(\s*([\d.]+)(deg|rad|grad|turn)?\s*(?:,\s*|\s+)([\d.]+)%\s*(?:,\s*|\s+)([\d.]+)%(?:\s*[,\/]\s*([\d.]+))?\s*\)$/);
  if (hh) {
    let h = Number(hh[1]);
    const unit = hh[2] || 'deg';
    if (unit === 'rad') h = (h * 180) / Math.PI;
    else if (unit === 'grad') h = h * 0.9;
    else if (unit === 'turn') h = h * 360;
    h = ((h % 360) + 360) % 360;
    const s = Math.min(1, Math.max(0, Number(hh[3]) / 100));
    const l = Math.min(1, Math.max(0, Number(hh[4]) / 100));
    const k = (n: number) => (n + h / 30) % 12;
    const aa = s * Math.min(l, 1 - l);
    const f2 = (n: number) => l - aa * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return {
      r: Math.round(f2(0) * 255), g: Math.round(f2(8) * 255), b: Math.round(f2(4) * 255),
      a: hh[5] === undefined ? 1 : Number(hh[5]),
    };
  }
  const lum = cssColorLuminance(src);
  if (lum === null) return null;
  // Named color without channels: treat as opaque via luminance-matched gray.
  const v = Math.round(255 * Math.pow(lum, 1 / 2.2));
  return { r: v, g: v, b: v, a: 1 };
}

/** Effective opaque backdrop: composite a (possibly translucent) background
 * over the opaque backdrop below. Opaque values pass through untouched;
 * unparseable values (gradients, var(), urls) inherit through. */
function compositeOverBg(bgCss: string, belowCss: string): string {
  try {
    const bg = parseChannels(bgCss);
    if (!bg) return belowCss;
    if (!(bg.a < 1)) return bgCss;
    const base = parseChannels(belowCss);
    if (!base) return bgCss;
    const mix = (f: number, b: number) => Math.round(bg.a * f + (1 - bg.a) * b);
    return `rgb(${mix(bg.r, base.r)}, ${mix(bg.g, base.g)}, ${mix(bg.b, base.b)})`;
  } catch {
    return belowCss;
  }
}

export function enforceRichContrast(root: Element, card: RichCardTheme): number {
  let overrides = 0;
  // Carbon paints its own chip backgrounds UNDER author inline colors
  // (index.css): `.rich-doc-light code/pre` and `.rich-doc-dark code/pre`.
  // The model used to see only the nearest INLINE background — typically the
  // site's dark bubble — so a mid-gray author fg "passed" against near-black
  // while the engine rendered it on a near-white chip (washed Qwen chips).
  // Model the chip exactly when no nearer inline background exists (inline
  // style beats stylesheets in the engine, so an inline bg stays
  // authoritative). Every declared layer composites over the EFFECTIVE
  // backdrop below (recursively, from the card up) — a translucent chip over
  // a dark bubble is dark in the engine, and compositing over the card would
  // "fix" its text to dark ink: dark-on-dark-chip (the 1.23:1 span trap).
  const cardLum = cssColorLuminance(card.bg);
  const themeKey = cardLum !== null && cardLum < 0.35 ? 'dark' : 'light';
  const visit = (el: Element, inhFg: string, nearEffBg: string, inChip: boolean): void => {
    const tag = el.tagName.toLowerCase();
    const styleAttr = el.getAttribute('style') || '';
    // Attribute backstop: sanitize folds color/bgcolor into style, but
    // fragments arriving via other paths (markdown, tests) may still carry
    // them — the engine renders them, so the model must see them too.
    const ownFg =
      parseInlineColor(inlineDecl(styleAttr, 'color')) ??
      parseInlineColor(el.getAttribute('color')) ??
      inhFg;
    const ownInlineBg =
      parseInlineBackground(inlineDecl(styleAttr, 'background-color')) ??
      parseInlineBackground(inlineDecl(styleAttr, 'background')) ??
      parseInlineBackground(el.getAttribute('bgcolor'));
    const carbonChip =
      !ownInlineBg && !inChip && (tag === 'code' || tag === 'pre')
        ? CARBON_CHIP_BG[tag][themeKey]
        : null;
    const declaredBg = ownInlineBg ?? carbonChip;
    // Invariant: ownEffBg is always opaque (declared layers composite over
    // the effective backdrop below; unparseable layers inherit through).
    // Opaque chains are byte-identical to the old nearest-wins model.
    const ownEffBg = declaredBg ? compositeOverBg(declaredBg, nearEffBg) : nearEffBg;
    let effFg = ownFg;
    const ratio = contrastRatio(ownFg, ownEffBg);
    if (ratio !== null && ratio < 4.5 && hasDirectText(el)) {
      const pick = pickContrastingFg(ownEffBg, card.ink);
      if (pick && pick.toLowerCase() !== ownFg.toLowerCase()) {
        (el as HTMLElement).style.color = pick;
        effFg = pick;
        overrides++;
      }
    }
    const childChip = inChip || tag === 'code' || tag === 'pre';
    for (const child of Array.from(el.children)) visit(child, effFg, ownEffBg, childChip);
  };
  for (const child of Array.from(root.children)) visit(child, card.ink, card.bg, false);
  return overrides;
}

/** Full preview pipeline: theme guess → sanitize → per-node AA enforcement. */
export function prepareRichPreview(html: string): { html: string; theme: 'dark' | 'light'; overrides: number } {
  const theme = detectSourceTheme(html);
  const sanitized = sanitizeRichHtml(html);
  try {
    const doc = new DOMParser().parseFromString(sanitized, 'text/html');
    const overrides = enforceRichContrast(doc.body, RICH_CARD_THEMES[theme]);
    return {
      html: doc.body.innerHTML.replace(/<!--[\s\S]*?-->/g, ''),
      theme,
      overrides,
    };
  } catch {
    return { html: sanitized, theme, overrides: 0 };
  }
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
