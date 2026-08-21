import { Snippet } from '../types';

/**
 * Snippet placeholder expansion engine (Phase A panel-based use only).
 *
 * Token grammar (matches the spec table precisely):
 *   {keyword args... | mod1 | mod2}
 * Args are space-separated `key=value` pairs; values may be double-quoted.
 * Modifiers chain left to right: uppercase | lowercase | trim | percent-encode
 * | json-stringify | raw.
 *
 * Fail-safe rule: every unparseable / malformed / unknown token is left in the
 * output exactly as written — never silently dropped, so the broken token
 * stays visible to the person who wrote the snippet.
 */

export class SnippetCancelledError extends Error {
  constructor() {
    super('Snippet use cancelled');
  }
}

export interface ArgumentSpec {
  name: string;
  defaultValue?: string;
  options?: string[];
}

export type ArgumentPrompter = (
  spec: ArgumentSpec & { resolvedDefault?: string }
) => Promise<string | null>;

export interface ExpandContext {
  snippets: Snippet[];
  snippetsByName: Map<string, Snippet>;
  recentClipTexts: string[];
  selection: string | null;
  /** Prompts for an argument value; resolves null when the user cancels. */
  promptArgument: ArgumentPrompter;
  /** Dedupes arguments sharing the same name (incl. nested snippets). */
  argValues: Map<string, string>;
  /** Whether the first {cursor} has already been placed. */
  cursorPlaced: boolean;
}

export interface ExpansionResult {
  text: string;
  /** Index into the final text where the first {cursor} marker sits, else null. */
  cursorOffset: number | null;
}

const MAX_NEST_DEPTH = 5;

const VALID_MODIFIERS = new Set([
  'uppercase',
  'lowercase',
  'trim',
  'percent-encode',
  'json-stringify',
  'raw',
]);

interface TokenArgs {
  offset?: string;
  name?: string;
  default?: string;
  options?: string;
  format?: string;
  locale?: string;
}

interface ParsedToken {
  keywordLower: string;
  /** raw head segment (trimmed) — for literal round-trips */
  rawHead: string;
  args: TokenArgs;
  argsValid: boolean;
  namePart?: string; // for snippet:Name
  modifiers: string[];
  modifiersValid: boolean;
  raw: string; // original {…} source
}

/** Finds the closing `}` of a token starting at `{` (respecting quoted values). */
function findTokenEnd(text: string, start: number): number {
  let inQuote = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') inQuote = false;
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === '}') {
      return i;
    }
  }
  return -1;
}

/** Splits on `|` but not inside double-quoted values. */
function splitOutsideQuotes(input: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of input) {
    if (inQuote) {
      cur += ch;
      if (ch === '"') inQuote = false;
    } else if (ch === '"') {
      inQuote = true;
      cur += ch;
    } else if (ch === '|') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function parseArgs(remainder: string, bareModifiers: string[]): { args: TokenArgs; valid: boolean } {
  const args: TokenArgs = {};
  const argRe = /(\w+)=("[^"]*"|\S+)/g;
  let m: RegExpExecArray | null;
  const consumed: string[] = [];
  while ((m = argRe.exec(remainder)) !== null) {
    consumed.push(m[0]);
    const key = m[1].toLowerCase();
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case 'offset':
      case 'name':
      case 'default':
      case 'options':
      case 'format':
      case 'locale':
        (args as Record<string, string>)[key] = value;
        break;
      default:
        // Unknown args are ignored (lenient) — the token itself is parseable.
        break;
    }
  }
  // Anything left over after all `key=value` pairs were removed must either be
  // a bare modifier (e.g. `{date format="MMM" uppercase}`) or the args string
  // is malformed (e.g. `{clipboard offset}` with no value).
  let rest = remainder;
  for (const c of consumed) {
    rest = rest.split(c).join(' ');
  }
  const words = rest.replace(/\s+/g, ' ').trim().split(' ').filter((w) => w.length > 0);
  for (const w of words) {
    if (VALID_MODIFIERS.has(w)) {
      bareModifiers.push(w);
    } else {
      return { args, valid: false };
    }
  }
  return { args, valid: true };
}

export function parseToken(raw: string): ParsedToken {
  const inner = raw.slice(1, -1);
  const segments = splitOutsideQuotes(inner);
  const head = segments[0].trim();
  const modifiers = segments.slice(1).map((s) => s.trim());

  let keywordLower: string;
  let namePart: string | undefined;
  const rawHeadLower = head.toLowerCase();

  if (rawHeadLower.startsWith('snippet:')) {
    keywordLower = 'snippet:';
    namePart = head.slice('snippet:'.length).trim();
  } else {
    const spaceIdx = head.search(/\s/);
    keywordLower = (spaceIdx === -1 ? head : head.slice(0, spaceIdx)).toLowerCase();
  }

  let args: TokenArgs = {};
  let argsValid = true;
  const bareModifiers: string[] = [];
  if (keywordLower !== 'snippet:') {
    const remainder = spaceAfterKeyword(head);
    const parsed = parseArgs(remainder, bareModifiers);
    args = parsed.args;
    argsValid = parsed.valid;
  }

  const allModifiers = [...modifiers, ...bareModifiers];
  const modifiersValid =
    allModifiers.length === 0 || allModifiers.every((mod) => VALID_MODIFIERS.has(mod));

  return {
    keywordLower,
    rawHead: head,
    args,
    argsValid,
    namePart,
    modifiers: allModifiers,
    modifiersValid,
    raw,
  };
}

function spaceAfterKeyword(head: string): string {
  const spaceIdx = head.search(/\s/);
  return spaceIdx === -1 ? '' : head.slice(spaceIdx).trim();
}

function applyModifiers(value: string, modifiers: string[]): string {
  let out = value;
  for (const mod of modifiers) {
    switch (mod) {
      case 'uppercase':
        out = out.toUpperCase();
        break;
      case 'lowercase':
        out = out.toLowerCase();
        break;
      case 'trim':
        out = out.trim();
        break;
      case 'percent-encode':
        out = encodeURIComponent(out);
        break;
      case 'json-stringify':
        out = JSON.stringify(out);
        break;
      case 'raw':
        break; // identity — values are never re-expanded anyway
    }
  }
  return out;
}

// ── Date / time helpers ────────────────────────────────────────────────

const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = MONTHS_FULL.map((m) => m.slice(0, 3));
const WEEKDAYS_FULL = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
const WEEKDAYS_SHORT = WEEKDAYS_FULL.map((d) => d.slice(0, 3));

/** Custom date format supporting yyyy yy MMMM MMM MM M EEEE EEE dd d HH H hh h mm m ss s a A */
export function formatDateToken(date: Date, format: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const hours24 = date.getHours();
  const hours12 = hours24 % 12 || 12;
  const mins = date.getMinutes();
  const secs = date.getSeconds();
  const ampm = hours24 < 12 ? 'am' : 'pm';

  const tokens: Array<[string, string]> = [
    ['yyyy', String(year)],
    ['yy', String(year).slice(-2)],
    ['MMMM', MONTHS_FULL[month]],
    ['MMM', MONTHS_SHORT[month]],
    ['MM', pad(month + 1)],
    ['M', String(month + 1)],
    ['EEEE', WEEKDAYS_FULL[date.getDay()]],
    ['EEE', WEEKDAYS_SHORT[date.getDay()]],
    ['dd', pad(day)],
    ['d', String(day)],
    ['HH', pad(hours24)],
    ['H', String(hours24)],
    ['hh', pad(hours12)],
    ['h', String(hours12)],
    ['mm', pad(mins)],
    ['m', String(mins)],
    ['ss', pad(secs)],
    ['s', String(secs)],
    ['A', ampm.toUpperCase()],
    ['a', ampm],
  ];
  const map = new Map(tokens);
  // Single-pass replacement (longest tokens first in the alternation) so an
  // already-substituted value can never be re-mangled by a later token
  // (e.g. MMM→"Aug" must not then have "A" replaced by "am"/"PM").
  return format.replace(
    /yyyy|yy|MMMM|MMM|MM|M|EEEE|EEE|dd|d|HH|H|hh|h|mm|m|ss|s|A|a/g,
    (tok) => map.get(tok) ?? tok
  );
}

/** Parses signed offsets like "+3h +30m" / "-1d" / "+2M" / "+1y". */
function applyOffsets(date: Date, offsetStr: string): Date | null {
  const re = /([+-]?\d+)([mdhMy])/g;
  const out = new Date(date.getTime());
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(offsetStr)) !== null) {
    matched = true;
    const amount = parseInt(m[1], 10);
    if (isNaN(amount)) return null;
    switch (m[2]) {
      case 'm': out.setMinutes(out.getMinutes() + amount); break;
      case 'h': out.setHours(out.getHours() + amount); break;
      case 'd': out.setDate(out.getDate() + amount); break;
      case 'M': out.setMonth(out.getMonth() + amount); break;
      case 'y': out.setFullYear(out.getFullYear() + amount); break;
    }
  }
  if (!matched && offsetStr.trim() !== '') return null;
  return out;
}

function localeDateString(date: Date, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'medium' }).format(date);
}

function localeTimeString(date: Date, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale || undefined, { timeStyle: 'medium' }).format(date);
}

function localeWeekdayString(date: Date, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale || undefined, { weekday: 'long' }).format(date);
}

/** Returns null when the token is malformed and must be left as written.
 * Snippet references and {cursor} are handled by the caller (they need the
 * global output assembly for correct cursor offsets / nesting). */
async function resolveToken(
  token: ParsedToken,
  ctx: ExpandContext
): Promise<string | null> {
  const { keywordLower, args, modifiers, modifiersValid, argsValid } = token;

  // Non-parseable / unknown keyword → leave literal.
  if (!argsValid || !modifiersValid) return null;
  if (keywordLower === 'snippet:' || keywordLower === 'cursor') return null;
  const known =
    keywordLower === 'clipboard' ||
    keywordLower === 'selection' ||
    keywordLower === 'selectedtext' ||
    keywordLower === 'date' ||
    keywordLower === 'time' ||
    keywordLower === 'datetime' ||
    keywordLower === 'day' ||
    keywordLower === 'uuid' ||
    keywordLower === 'argument';
  if (!known) return null;

  // Date cannot combine format with locale.
  if (args.format && args.locale) return null;

  let value = '';
  switch (keywordLower) {
    case 'clipboard': {
      const offsetRaw = args.offset ?? '0';
      if (!/^\d+$/.test(offsetRaw)) return null;
      const idx = parseInt(offsetRaw, 10);
      value = ctx.recentClipTexts[idx] ?? '';
      break;
    }
    case 'selection':
    case 'selectedtext':
      value =
        ctx.selection && ctx.selection.trim().length > 0
          ? ctx.selection
          : ctx.recentClipTexts[0] ?? '';
      break;
    case 'date': {
      const d = new Date();
      value = args.format
        ? formatDateToken(d, args.format)
        : localeDateString(d, args.locale);
      break;
    }
    case 'time': {
      let d = new Date();
      if (args.offset !== undefined) {
        const shifted = args.offset.trim() === '' ? d : applyOffsets(d, args.offset);
        if (!shifted) return null;
        d = shifted;
      }
      value = args.format
        ? formatDateToken(d, args.format)
        : localeTimeString(d, args.locale);
      break;
    }
    case 'datetime': {
      const d = new Date();
      value = new Intl.DateTimeFormat(args.locale || undefined, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(d);
      break;
    }
    case 'day':
      value = localeWeekdayString(new Date(), args.locale);
      break;
    case 'uuid':
      value = crypto.randomUUID();
      break;
    case 'argument': {
      const argName = args.name && args.name.trim() ? args.name : 'Argument';
      const options = args.options !== undefined
        ? args.options.split(',').map((o) => o.trim()).filter((o) => o.length > 0)
        : undefined;
      let resolved = ctx.argValues.get(argName);
      if (resolved === undefined) {
        const valueOrNull = await ctx.promptArgument({
          name: argName,
          defaultValue: args.default,
          options,
          resolvedDefault: args.default,
        });
        if (valueOrNull === null) {
          throw new SnippetCancelledError();
        }
        resolved = valueOrNull;
        ctx.argValues.set(argName, resolved);
      }
      value = resolved; // inserted literally, never re-expanded
      break;
    }
    default:
      return null;
  }

  return applyModifiers(value, modifiers);
}

/** Expands `content`, resolving nested refs up to MAX_NEST_DEPTH with cycles left literal. */
export async function expandSnippetContent(
  content: string,
  ctx: ExpandContext,
  path: Set<string> = new Set(),
  depth = 0
): Promise<ExpansionResult> {
  let out = '';
  let cursorOffset: number | null = null;
  const placeCursor = (offset: number) => {
    if (cursorOffset === null) {
      cursorOffset = offset;
    }
  };
  const hasCursor = () => cursorOffset !== null || ctx.cursorPlaced;

  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '{') {
      const end = findTokenEnd(content, i);
      if (end === -1) {
        out += ch;
        i++;
        continue;
      }
      const raw = content.slice(i, end + 1);
      const token = parseToken(raw);

      if (token.keywordLower === 'cursor') {
        // Only the FIRST {cursor} in the whole expansion is honored; the rest
        // are removed. The offset stays relative to this (sub)text — the
        // caller rebases it onto the global output.
        if (!hasCursor()) {
          placeCursor(out.length);
        }
        i = end + 1;
        continue;
      }

      if (token.keywordLower === 'snippet:') {
        const { argsValid, modifiersValid, namePart, modifiers } = token;
        if (!argsValid || !modifiersValid || !namePart || namePart.length === 0 || modifiers.length > 0) {
          out += raw;
          i = end + 1;
          continue;
        }
        if (depth + 1 > MAX_NEST_DEPTH) {
          out += raw; // too deep → literal
          i = end + 1;
          continue;
        }
        const key = namePart.toLowerCase();
        if (path.has(key)) {
          out += raw; // cycle → literal
          i = end + 1;
          continue;
        }
        const target = ctx.snippetsByName.get(key);
        if (!target) {
          out += raw; // missing → literal
          i = end + 1;
          continue;
        }
        path.add(key);
        const sub = await expandSnippetContent(target.content, ctx, path, depth + 1);
        path.delete(key);
        if (sub.cursorOffset !== null && !hasCursor()) {
          placeCursor(out.length + sub.cursorOffset);
          ctx.cursorPlaced = true;
        }
        out += sub.text;
        i = end + 1;
        continue;
      }

      const resolved = await resolveToken(token, ctx);
      if (resolved === null) {
        out += raw; // malformed / unknown → literal, never silently dropped
      } else {
        out += resolved;
      }
      i = end + 1;
      continue;
    }
    out += ch;
    i++;
  }

  return { text: out, cursorOffset };
}

/**
 * Expands a whole snippet at use time (fresh per use).
 * Throws SnippetCancelledError when the user cancels an argument prompt.
 */
export async function expandSnippet(
  snippet: Pick<Snippet, 'content'>,
  ctx: Omit<ExpandContext, 'snippetsByName' | 'argValues' | 'cursorPlaced'>
): Promise<ExpansionResult> {
  const byName = new Map<string, Snippet>();
  for (const s of ctx.snippets) {
    if (!byName.has(s.name.toLowerCase())) {
      byName.set(s.name.toLowerCase(), s);
    }
  }
  const session: ExpandContext = {
    ...ctx,
    snippetsByName: byName,
    argValues: new Map(),
    cursorPlaced: false,
  };
  const result = await expandSnippetContent(snippet.content, session);
  return result;
}

// ── Editor / preview syntax highlighting ───────────────────────────────

export interface HighlightSegment {
  text: string;
  cls: string; // token class or 'plain'
}

/** Splits snippet content into plain + highlighted token segments for display. */
export function highlightSnippetTokens(content: string): HighlightSegment[] {
  const segs: HighlightSegment[] = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] === '{') {
      const end = findTokenEnd(content, i);
      if (end === -1) {
        segs.push({ text: content[i], cls: 'plain' });
        i++;
        continue;
      }
      const raw = content.slice(i, end + 1);
      const token = parseToken(raw);
      let cls = 'sn-tok';
      if (token.keywordLower === 'cursor') cls = 'sn-tok-cursor';
      else if (token.keywordLower === 'argument') cls = 'sn-tok-arg';
      else if (token.keywordLower === 'snippet:') cls = 'sn-tok-snip';
      else if (
        token.keywordLower === 'clipboard' ||
        token.keywordLower === 'selection' ||
        token.keywordLower === 'selectedtext' ||
        token.keywordLower === 'date' ||
        token.keywordLower === 'time' ||
        token.keywordLower === 'datetime' ||
        token.keywordLower === 'day' ||
        token.keywordLower === 'uuid'
      ) {
        cls = 'sn-tok-dyn';
      }
      // Malformed / unknown → error styling so the author sees the problem.
      const known =
        token.keywordLower === 'clipboard' ||
        token.keywordLower === 'selection' ||
        token.keywordLower === 'selectedtext' ||
        token.keywordLower === 'date' ||
        token.keywordLower === 'time' ||
        token.keywordLower === 'datetime' ||
        token.keywordLower === 'day' ||
        token.keywordLower === 'uuid' ||
        token.keywordLower === 'argument' ||
        token.keywordLower === 'snippet:' ||
        token.keywordLower === 'cursor';
      const hasBadArgs =
        token.keywordLower === 'date' && token.args.format && token.args.locale;
      if (!known || !token.argsValid || !token.modifiersValid || hasBadArgs) {
        cls = 'sn-tok-bad';
      }
      segs.push({ text: raw, cls });
      i = end + 1;
      continue;
    }
    segs.push({ text: content[i], cls: 'plain' });
    i++;
  }
  return segs;
}

/* ── Shared list helpers (used by SnippetsView AND the Quick Overlay) ── */

export const SNIPPET_BUCKET_ORDER = ['Today', 'Yesterday', 'This Year', 'Older'];

export function snippetBucketFor(dateKey: string | null): string {
  if (!dateKey) return 'Older';
  const d = new Date(dateKey.replace(' ', 'T'));
  if (isNaN(d.getTime())) return 'Older';
  const now = new Date();
  const todayStr = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === todayStr) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) return 'This Year';
  return 'Older';
}

export function formatSnippetLastUsed(dateKey: string | null): string {
  if (!dateKey) return 'Never';
  const d = new Date(dateKey.replace(' ', 'T'));
  if (isNaN(d.getTime())) return 'Never';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Single search/filter predicate shared by both surfaces (name, keyword, content, tags). */
export function filterSnippets(snippets: Snippet[], search: string, tagFilter: string): Snippet[] {
  const q = search.trim().toLowerCase();
  return snippets.filter((s) => {
    if (tagFilter !== '__all__' && !(s.tags || []).includes(tagFilter)) return false;
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.keyword.toLowerCase().includes(q) ||
      s.content.toLowerCase().includes(q) ||
      (s.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  });
}