/**
 * Deterministic, zero-dependency Smart Content Inspector for Carbon.
 *
 * Inspects clipboard text locally (zero AI, zero network) across real-world
 * developer and power-user payloads — never limited to synthetic samples:
 *   1. JWT tokens (bare, `Bearer`, `Authorization:`, quoted, or embedded in a short block)
 *   2. Unix timestamps (10s / 13ms / 16µs / 19ns) — Local, UTC ISO, relative
 *   3. ISO-8601 & RFC 2822 / HTTP dates — Local, Unix (s/ms), relative
 *   4. Colors (#rgb/#rgba/#rrggbb/#rrggbbaa, rgb/rgba, hsl/hsla, CSS4 space syntax, CSS declarations)
 *   5. UUIDs (v1–v8, braced/URN, UUIDv7 timestamp) & ULIDs (embedded UTC timestamp)
 *   6. Email addresses (bare, `mailto:`, `Name <addr>`, plus-tag parsing)
 *   7. URLs & query strings (http/https/ws/ftp/db URIs, `www.`, Markdown links, tracking-param cleaner, percent-decoded)
 *   8. Cron schedules (5-field, 6-field with seconds, named days/months, `@daily` presets)
 *   9. IPv4 CIDR subnets (network, broadcast, netmask, usable range, host count)
 *  10. cURL commands (method, target URL, headers, body preview)
 *  11. JSON objects/arrays (raw up to 128 KB, Markdown ```json fences, or escaped JSON strings)
 *  12. `.env` / KEY=VALUE config blocks (variable summary + 1-click Copy as JSON)
 *  13. Readable UTF-8 Base64 (standard/URL-safe, `Basic` auth, `data:...;base64,`, wrapped multiline)
 *  14. Unicode `\uXXXX` and HTML entity encoded text
 *
 * Returns `null` for ordinary prose and plain numbers so regular clips stay uncluttered.
 */

export type SmartInspectionKind =
  | 'jwt'
  | 'timestamp'
  | 'iso_date'
  | 'url_params'
  | 'url_info'
  | 'url_encoded'
  | 'email'
  | 'color'
  | 'uuid'
  | 'cron'
  | 'cidr'
  | 'curl'
  | 'json'
  | 'env'
  | 'base64'
  | 'escaped';

export interface SmartInspectionRow {
  label: string;
  value: string;
  mono?: boolean;
}

export interface SmartInspectionBadge {
  text: string;
  tone: 'ok' | 'warn' | 'muted';
}

export interface SmartInspection {
  kind: SmartInspectionKind;
  title: string;
  badge?: SmartInspectionBadge;
  rows?: SmartInspectionRow[];
  codeBlock?: string;
  copyLabel: string;
  copyValue: string;
}

const MAX_INSPECT_CHARS = 131_072; // 128 KB ceiling (e.g. real API JSON payloads)
const MIN_EPOCH_MS = 1_000_000_000_000; // 2001-09-09
const MAX_EPOCH_MS = 4_102_444_800_000; // 2100-01-01

const TRACKING_PARAM_PATTERNS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^igshid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^yclid$/i,
  /^si$/i,
];

function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'")) ||
      (t.startsWith('`') && t.endsWith('`')))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function decodeBase64UrlToUtf8(segment: string): string | null {
  try {
    let b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad === 1) return null;
    if (pad > 0) b64 += '='.repeat(4 - pad);

    const binary =
      typeof atob === 'function'
        ? atob(b64)
        : Buffer.from(b64, 'base64').toString('binary');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function formatRelativeDuration(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const future = deltaMs > 0;
  const wrap = (unit: string) => (future ? `in ${unit}` : `${unit} ago`);

  if (abs < 60_000) return future ? 'in <1m' : 'just now';
  if (abs < 3_600_000) return wrap(`${Math.round(abs / 60_000)}m`);
  if (abs < 86_400_000) return wrap(`${Math.round(abs / 3_600_000)}h`);
  if (abs < 365 * 86_400_000) return wrap(`${Math.round(abs / 86_400_000)}d`);
  return wrap(`${(abs / (365 * 86_400_000)).toFixed(1)}y`);
}

function inspectJwtToken(token: string, nowMs: number): SmartInspection | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  if (parts.some((p) => p.length < 4 || !/^[A-Za-z0-9_-]+$/.test(p))) return null;

  const headerRaw = decodeBase64UrlToUtf8(parts[0]);
  const payloadRaw = decodeBase64UrlToUtf8(parts[1]);
  if (!headerRaw || !payloadRaw) return null;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    const h = JSON.parse(headerRaw);
    const p = JSON.parse(payloadRaw);
    if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    header = h as Record<string, unknown>;
    payload = p as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof header.alg !== 'string' && typeof header.typ !== 'string') return null;

  const alg = typeof header.alg === 'string' ? header.alg : 'JWT';
  const rows: SmartInspectionRow[] = [];
  if (typeof payload.sub === 'string' || typeof payload.sub === 'number') {
    rows.push({ label: 'Subject', value: String(payload.sub), mono: true });
  }
  if (typeof payload.iss === 'string') {
    rows.push({ label: 'Issuer', value: payload.iss, mono: true });
  }
  if (typeof payload.aud === 'string') {
    rows.push({ label: 'Audience', value: payload.aud, mono: true });
  }

  let badge: SmartInspectionBadge | undefined;
  if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
    const expMs = payload.exp * 1000;
    const expired = expMs <= nowMs;
    const rel = formatRelativeDuration(expMs - nowMs);
    badge = {
      text: expired ? `Expired · ${rel}` : `Active · ${rel}`,
      tone: expired ? 'warn' : 'ok',
    };
    rows.push({ label: 'Expires', value: new Date(expMs).toLocaleString(), mono: true });
  }
  if (typeof payload.iat === 'number' && Number.isFinite(payload.iat)) {
    rows.push({ label: 'Issued', value: new Date(payload.iat * 1000).toLocaleString(), mono: true });
  }

  const prettyPayload = JSON.stringify(payload, null, 2);
  return {
    kind: 'jwt',
    title: `JWT · ${alg}`,
    badge,
    rows,
    codeBlock: prettyPayload,
    copyLabel: 'Copy Payload',
    copyValue: prettyPayload,
  };
}

function tryInspectJwt(trimmed: string, nowMs: number): SmartInspection | null {
  if (trimmed.length > 8192) return null;
  // Direct token, Authorization header, Bearer prefix, or quoted value
  const stripped = stripOuterQuotes(
    trimmed
      .replace(/^Authorization\s*:\s*/i, '')
      .replace(/^Bearer\s+/i, '')
      .replace(/[,;]+$/, ''),
  );
  const direct = inspectJwtToken(stripped, nowMs);
  if (direct) return direct;

  // Embedded JWT inside a short header/env/log snippet (e.g. `TOKEN=eyJ...`)
  if (trimmed.length <= 4096 && trimmed.includes('eyJ')) {
    const match = trimmed.match(/\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})\b/);
    if (match) {
      return inspectJwtToken(match[1], nowMs);
    }
  }
  return null;
}

function tryInspectTimestamp(trimmed: string, nowMs: number): SmartInspection | null {
  const clean = stripOuterQuotes(trimmed.replace(/[,;]+$/, ''));
  if (!/^\d{10}(?:\d{3}|\d{6}|\d{9})?$/.test(clean)) return null;

  let epochMs: number;
  let unitLabel: string;
  if (clean.length === 10) {
    epochMs = Number(clean) * 1000;
    unitLabel = 's';
  } else if (clean.length === 13) {
    epochMs = Number(clean);
    unitLabel = 'ms';
  } else if (clean.length === 16) {
    epochMs = Math.floor(Number(clean.slice(0, 13)));
    unitLabel = 'µs';
  } else {
    epochMs = Math.floor(Number(clean.slice(0, 13)));
    unitLabel = 'ns';
  }

  if (!Number.isFinite(epochMs) || epochMs < MIN_EPOCH_MS || epochMs > MAX_EPOCH_MS) {
    return null;
  }

  const d = new Date(epochMs);
  if (isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  const rel = formatRelativeDuration(epochMs - nowMs);

  return {
    kind: 'timestamp',
    title: `Unix Timestamp (${unitLabel})`,
    badge: { text: rel, tone: 'muted' },
    rows: [
      { label: 'Local', value: d.toLocaleString(), mono: true },
      { label: 'UTC ISO', value: iso, mono: true },
    ],
    copyLabel: 'Copy ISO',
    copyValue: iso,
  };
}

function tryInspectIsoDate(trimmed: string, nowMs: number): SmartInspection | null {
  const clean = stripOuterQuotes(trimmed.replace(/[,;]+$/, ''));
  if (clean.length > 64 || clean.includes('\n')) return null;

  const isIsoDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(clean);
  const isIsoDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(clean);
  const isRfc2822 = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:GMT|UTC|[+-]\d{4})$/i.test(clean);

  if (!isIsoDateTime && !isIsoDateOnly && !isRfc2822) return null;

  const parsedInput = isIsoDateOnly
    ? `${clean}T00:00:00Z`
    : isIsoDateTime && clean.includes(' ')
      ? clean.replace(' ', 'T')
      : clean;
  const d = new Date(parsedInput);
  if (isNaN(d.getTime())) return null;
  const epochMs = d.getTime();
  const epochSec = Math.floor(epochMs / 1000);
  const rel = formatRelativeDuration(epochMs - nowMs);

  return {
    kind: 'iso_date',
    title: isRfc2822 ? 'HTTP / RFC 2822 Date' : isIsoDateOnly ? 'ISO Date' : 'ISO Timestamp',
    badge: { text: rel, tone: 'muted' },
    rows: [
      { label: 'Local', value: isIsoDateOnly ? d.toLocaleDateString() : d.toLocaleString(), mono: true },
      { label: 'Unix (s)', value: String(epochSec), mono: true },
      { label: 'Unix (ms)', value: String(epochMs), mono: true },
    ],
    copyLabel: 'Copy Unix (s)',
    copyValue: String(epochSec),
  };
}

function tryInspectEmail(trimmed: string): SmartInspection | null {
  if (trimmed.length > 254 || trimmed.includes('\n')) return null;
  let displayName: string | null = null;
  let candidate = stripOuterQuotes(trimmed);
  if (/^mailto:/i.test(candidate)) {
    candidate = candidate.replace(/^mailto:/i, '').split('?')[0].trim();
  }
  const angleMatch = candidate.match(/^([^<>]{1,80})\s*<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$/);
  if (angleMatch) {
    displayName = stripOuterQuotes(angleMatch[1]);
    candidate = angleMatch[2].trim();
  }
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(candidate)) {
    return null;
  }
  const atIdx = candidate.lastIndexOf('@');
  const local = candidate.slice(0, atIdx);
  const domain = candidate.slice(atIdx + 1).toLowerCase();
  const plusIdx = local.indexOf('+');
  const baseMailbox = plusIdx > 0 ? local.slice(0, plusIdx) : local;
  const plusTag = plusIdx > 0 ? local.slice(plusIdx + 1) : null;

  const rows: SmartInspectionRow[] = [];
  if (displayName) rows.push({ label: 'Name', value: displayName });
  rows.push({ label: 'Mailbox', value: baseMailbox, mono: true });
  if (plusTag) rows.push({ label: 'Tag', value: `+${plusTag}`, mono: true });
  rows.push({ label: 'Domain', value: domain, mono: true });

  const cleanEmail = plusTag ? `${baseMailbox}@${domain}` : candidate;
  const copyClean = Boolean(plusTag || displayName || /^mailto:/i.test(trimmed));

  return {
    kind: 'email',
    title: 'Email Inspector',
    badge: { text: domain, tone: 'muted' },
    rows,
    copyLabel: copyClean ? 'Copy Clean Email' : 'Copy Domain',
    copyValue: copyClean ? cleanEmail : domain,
  };
}

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAM_PATTERNS.some((re) => re.test(key));
}

function tryInspectUrl(trimmed: string): SmartInspection | null {
  if (trimmed.includes('\n')) return null;

  let candidate = stripOuterQuotes(trimmed);
  // Markdown link `[label](https://...)`
  const mdLink = candidate.match(/^\[[^\]]{1,120}\]\((https?:\/\/[^\s)]+)\)$/i);
  if (mdLink) {
    candidate = mdLink[1];
  } else if (candidate.startsWith('<') && candidate.endsWith('>')) {
    candidate = candidate.slice(1, -1).trim();
  }
  if (candidate.includes(' ')) return null;

  const hasKnownScheme = /^(?:https?|wss?|ftp|ftps|postgres(?:ql)?|mysql|redis|rediss|mongodb(?:\+srv)?):\/\//i.test(candidate);
  const isBareWww = /^www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#].*)?$/i.test(candidate);

  if (hasKnownScheme || isBareWww) {
    try {
      const normalized = isBareWww ? `https://${candidate}` : candidate;
      const u = new URL(normalized);
      const entries = Array.from(u.searchParams.entries());
      if (entries.length > 0) {
        const rows: SmartInspectionRow[] = entries.slice(0, 10).map(([k, v]) => ({
          label: k,
          value: v || '(empty)',
          mono: true,
        }));
        const trackingKeys = entries.filter(([k]) => isTrackingParam(k));
        if (trackingKeys.length > 0) {
          const cleanUrl = new URL(normalized);
          for (const [k] of trackingKeys) cleanUrl.searchParams.delete(k);
          return {
            kind: 'url_params',
            title: `URL Parameters (${entries.length})`,
            badge: { text: `${trackingKeys.length} tracking`, tone: 'warn' },
            rows,
            copyLabel: 'Copy Clean URL',
            copyValue: cleanUrl.toString(),
          };
        }
        const decodedUrl = (() => {
          try {
            return decodeURIComponent(normalized);
          } catch {
            return normalized;
          }
        })();
        return {
          kind: 'url_params',
          title: `URL Parameters (${entries.length})`,
          rows,
          copyLabel: 'Copy Decoded URL',
          copyValue: decodedUrl,
        };
      }

      const hasPath = Boolean(u.pathname && u.pathname !== '/');
      const hasHash = Boolean(u.hash);
      const hasPort = Boolean(u.port);
      const decodedPath = (() => {
        try {
          return decodeURIComponent(u.pathname);
        } catch {
          return u.pathname;
        }
      })();
      const rows: SmartInspectionRow[] = [
        { label: 'Host', value: u.hostname, mono: true },
      ];
      if (hasPort) rows.push({ label: 'Port', value: u.port, mono: true });
      if (u.username) rows.push({ label: 'User', value: decodeURIComponent(u.username), mono: true });
      if (hasPath) rows.push({ label: 'Path', value: decodedPath, mono: true });
      if (hasHash) rows.push({ label: 'Fragment', value: u.hash, mono: true });
      return {
        kind: 'url_info',
        title: 'URL Inspector',
        badge: { text: u.protocol.replace(':', '').toUpperCase(), tone: 'muted' },
        rows,
        copyLabel: 'Copy Host',
        copyValue: u.host,
      };
    } catch {
      /* invalid URL */
    }
  }

  // Standalone query string (e.g. `?foo=1&bar=hello%20world` or `a=1&b=2`)
  if (/^\??[A-Za-z0-9_.~%-]+=[^&\s]*(?:&[A-Za-z0-9_.~%-]+=[^&\s]*)+$/.test(candidate)) {
    try {
      const params = new URLSearchParams(candidate.startsWith('?') ? candidate.slice(1) : candidate);
      const entries = Array.from(params.entries());
      if (entries.length >= 2) {
        const obj: Record<string, string> = {};
        for (const [k, v] of entries) obj[k] = v;
        return {
          kind: 'url_params',
          title: `Query String (${entries.length})`,
          rows: entries.slice(0, 10).map(([k, v]) => ({
            label: k,
            value: v || '(empty)',
            mono: true,
          })),
          copyLabel: 'Copy as JSON',
          copyValue: JSON.stringify(obj, null, 2),
        };
      }
    } catch {
      /* ignore */
    }
  }

  // Percent-encoded string (at least 2 `%XX` triplets)
  const pctMatches = candidate.match(/%[0-9a-fA-F]{2}/g);
  if (pctMatches && pctMatches.length >= 2) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded !== candidate && decoded.trim().length > 0) {
        return {
          kind: 'url_encoded',
          title: 'URL Decoded',
          codeBlock: decoded,
          copyLabel: 'Copy Decoded',
          copyValue: decoded,
        };
      }
    } catch {
      /* malformed percent escape */
    }
  }

  return null;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

function hslToRgb(h: number, sPct: number, lPct: number): [number, number, number] {
  const s = sPct / 100;
  const l = lPct / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function toHexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
}

function parseAlpha(raw?: string): number {
  if (!raw) return 1;
  const trimmed = raw.trim();
  if (trimmed.endsWith('%')) {
    const pct = parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 1;
  }
  const num = parseFloat(trimmed);
  return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 1;
}

function tryInspectColor(trimmed: string): SmartInspection | null {
  if (trimmed.length > 96 || trimmed.includes('\n')) return null;

  // Allow CSS property declarations like `color: #5B7CFA;` or `--accent: rgb(47 111 235 / 80%);`
  const cleaned = stripOuterQuotes(
    trimmed
      .replace(/^(?:--[a-z0-9-]+|[a-z-]+)\s*:\s*/i, '')
      .replace(/;+\s*$/, ''),
  );

  let r: number, g: number, b: number;
  let alpha = 1;
  let inputKind: 'hex' | 'rgb' | 'hsl';

  const hexMatch = cleaned.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  const rgbCommaMatch = cleaned.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+%?))?\s*\)$/i,
  );
  const rgbSpaceMatch = cleaned.match(
    /^rgba?\(\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s*\/\s*([\d.]+%?))?\s*\)$/i,
  );
  const hslCommaMatch = cleaned.match(
    /^hsla?\(\s*(\d{1,3})(?:deg)?\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%(?:\s*,\s*([\d.]+%?))?\s*\)$/i,
  );
  const hslSpaceMatch = cleaned.match(
    /^hsla?\(\s*(\d{1,3})(?:deg)?\s+(\d{1,3})%\s+(\d{1,3})%(?:\s*\/\s*([\d.]+%?))?\s*\)$/i,
  );

  if (hexMatch) {
    inputKind = 'hex';
    const raw = hexMatch[1];
    if (raw.length === 3 || raw.length === 4) {
      r = parseInt(raw[0] + raw[0], 16);
      g = parseInt(raw[1] + raw[1], 16);
      b = parseInt(raw[2] + raw[2], 16);
      if (raw.length === 4) alpha = parseInt(raw[3] + raw[3], 16) / 255;
    } else {
      r = parseInt(raw.slice(0, 2), 16);
      g = parseInt(raw.slice(2, 4), 16);
      b = parseInt(raw.slice(4, 6), 16);
      if (raw.length === 8) alpha = parseInt(raw.slice(6, 8), 16) / 255;
    }
  } else if (rgbCommaMatch || rgbSpaceMatch) {
    inputKind = 'rgb';
    const m = (rgbCommaMatch || rgbSpaceMatch)!;
    r = Number(m[1]);
    g = Number(m[2]);
    b = Number(m[3]);
    if (r > 255 || g > 255 || b > 255) return null;
    alpha = parseAlpha(m[4]);
  } else if (hslCommaMatch || hslSpaceMatch) {
    inputKind = 'hsl';
    const m = (hslCommaMatch || hslSpaceMatch)!;
    const h = Number(m[1]) % 360;
    const s = Number(m[2]);
    const l = Number(m[3]);
    if (s > 100 || l > 100) return null;
    [r, g, b] = hslToRgb(h, s, l);
    alpha = parseAlpha(m[4]);
  } else {
    return null;
  }

  const hasAlpha = alpha < 0.999;
  const alphaRounded = Math.round(alpha * 100) / 100;
  const hexBase = `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
  const hex = hasAlpha ? `${hexBase}${toHexByte(alpha * 255)}` : hexBase;
  const rgb = hasAlpha ? `rgba(${r}, ${g}, ${b}, ${alphaRounded})` : `rgb(${r}, ${g}, ${b})`;
  const [h, s, l] = rgbToHsl(r, g, b);
  const hsl = hasAlpha ? `hsla(${h}, ${s}%, ${l}%, ${alphaRounded})` : `hsl(${h}, ${s}%, ${l}%)`;

  return {
    kind: 'color',
    title: 'Color Formats',
    badge: { text: hex, tone: 'muted' },
    rows: [
      { label: 'HEX', value: hex, mono: true },
      { label: 'RGB', value: rgb, mono: true },
      { label: 'HSL', value: hsl, mono: true },
    ],
    copyLabel: inputKind === 'hex' ? 'Copy RGB' : 'Copy HEX',
    copyValue: inputKind === 'hex' ? rgb : hex,
  };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function tryInspectUuidOrUlid(trimmed: string, nowMs: number): SmartInspection | null {
  if (trimmed.length > 64 || trimmed.includes('\n')) return null;
  let clean = stripOuterQuotes(trimmed.replace(/[,;]+$/, ''));
  if (/^urn:uuid:/i.test(clean)) clean = clean.slice(9);
  if (clean.startsWith('{') && clean.endsWith('}')) clean = clean.slice(1, -1);

  const m = clean.match(
    /^([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([1-8][0-9a-fA-F]{3})-([89abAB][0-9a-fA-F]{3})-([0-9a-fA-F]{12})$/,
  );
  if (m) {
    const version = parseInt(m[3][0], 16);
    const compact = clean.replace(/-/g, '').toLowerCase();
    const rows: SmartInspectionRow[] = [
      { label: 'Version', value: `UUID v${version}`, mono: true },
      { label: 'Compact', value: compact, mono: true },
    ];

    if (version === 7) {
      const hexTs = `${m[1]}${m[2]}`;
      const epochMs = parseInt(hexTs, 16);
      if (epochMs >= MIN_EPOCH_MS && epochMs <= MAX_EPOCH_MS) {
        const d = new Date(epochMs);
        rows.push({
          label: 'Created',
          value: `${d.toLocaleString()} (${formatRelativeDuration(epochMs - nowMs)})`,
          mono: true,
        });
      }
    }

    return {
      kind: 'uuid',
      title: 'UUID Inspector',
      badge: { text: `v${version}`, tone: 'muted' },
      rows,
      copyLabel: 'Copy Compact',
      copyValue: compact,
    };
  }

  // Crockford Base32 26-char ULID (first 10 chars encode a 48-bit Unix ms timestamp)
  if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(clean) && /[0-9]/.test(clean) && /[A-Z]/.test(clean)) {
    let epochMs = 0;
    for (let i = 0; i < 10; i++) {
      const v = CROCKFORD.indexOf(clean[i]);
      if (v < 0) return null;
      epochMs = epochMs * 32 + v;
    }
    if (epochMs >= MIN_EPOCH_MS && epochMs <= MAX_EPOCH_MS) {
      const d = new Date(epochMs);
      const iso = d.toISOString();
      return {
        kind: 'uuid',
        title: 'ULID Inspector',
        badge: { text: formatRelativeDuration(epochMs - nowMs), tone: 'muted' },
        rows: [
          { label: 'Created', value: d.toLocaleString(), mono: true },
          { label: 'UTC ISO', value: iso, mono: true },
          { label: 'Unix (ms)', value: String(epochMs), mono: true },
        ],
        copyLabel: 'Copy ISO',
        copyValue: iso,
      };
    }
  }

  return null;
}

const CRON_PRESETS: Record<string, string> = {
  '@yearly': 'Once a year (Jan 1 at 00:00)',
  '@annually': 'Once a year (Jan 1 at 00:00)',
  '@monthly': 'Once a month (1st at 00:00)',
  '@weekly': 'Once a week (Sunday at 00:00)',
  '@daily': 'Daily at 00:00',
  '@midnight': 'Daily at 00:00',
  '@hourly': 'Hourly at :00',
};

function describeCron5(fields: string[], secPrefix?: string): string | null {
  const [min, hr, dom, mon, dow] = fields;
  const validNumField = (f: string) =>
    /^(\*|\d+(-\d+)?(,\d+(-\d+)?)*)(\/\d+)?$/.test(f);
  const validNameOrNumField = (f: string) =>
    /^(\*|([0-9]{1,2}|[A-Z]{3})(-([0-9]{1,2}|[A-Z]{3}))?(,([0-9]{1,2}|[A-Z]{3})(-([0-9]{1,2}|[A-Z]{3}))?)*)(\/\d+)?$/i.test(f);

  if (!validNumField(min) || !validNumField(hr) || !validNumField(dom)) return null;
  if (!validNameOrNumField(mon) || !validNameOrNumField(dow)) return null;

  const secNote = secPrefix && secPrefix !== '0' ? ` (sec ${secPrefix})` : '';
  if (min === '*' && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return secPrefix?.startsWith('*/')
      ? `Every ${secPrefix.slice(2)} seconds`
      : `Every minute${secNote}`;
  }
  if (min.startsWith('*/') && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${min.slice(2)} minutes${secNote}`;
  }
  if (/^\d+$/.test(min) && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Hourly at :${min.padStart(2, '0')}${secNote}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && mon === '*') {
    const time = `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
    const dowUpper = dow.toUpperCase();
    if (dow === '*') return `Daily at ${time}${secNote}`;
    if (dow === '1-5' || dowUpper === 'MON-FRI') return `Weekdays (Mon–Fri) at ${time}${secNote}`;
    if (dow === '0,6' || dow === '6,0' || dowUpper === 'SAT,SUN' || dowUpper === 'SUN,SAT') {
      return `Weekends at ${time}${secNote}`;
    }
    return `At ${time} on day-of-week ${dow}${secNote}`;
  }
  return secPrefix
    ? `sec=${secPrefix}, min=${min}, hr=${hr}, dom=${dom}, mon=${mon}, dow=${dow}`
    : `min=${min}, hr=${hr}, dom=${dom}, mon=${mon}, dow=${dow}`;
}

function tryInspectCron(trimmed: string): SmartInspection | null {
  if (trimmed.includes('\n') || trimmed.length > 80) return null;
  const clean = stripOuterQuotes(trimmed);
  const preset = CRON_PRESETS[clean.toLowerCase()];
  if (preset) {
    return {
      kind: 'cron',
      title: 'Cron Schedule',
      badge: { text: 'preset', tone: 'muted' },
      rows: [
        { label: 'Schedule', value: preset },
        { label: 'Expression', value: clean.toLowerCase(), mono: true },
      ],
      copyLabel: 'Copy Schedule',
      copyValue: preset,
    };
  }

  const fields = clean.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return null;
  // Require at least one cron-specific token (*, /, -) so plain numbers don't trigger
  if (!/[*/,-]/.test(clean)) return null;

  const is6 = fields.length === 6;
  if (is6 && !/^(\*|\d+(-\d+)?(,\d+(-\d+)?)*)(\/\d+)?$/.test(fields[0])) return null;
  const five = is6 ? fields.slice(1) : fields;
  const summary = describeCron5(five, is6 ? fields[0] : undefined);
  if (!summary) return null;

  return {
    kind: 'cron',
    title: 'Cron Schedule',
    badge: { text: is6 ? '6-field' : '5-field', tone: 'muted' },
    rows: [
      { label: 'Schedule', value: summary },
      {
        label: 'Fields',
        value: is6
          ? `sec ${fields[0]} · min ${five[0]} · hr ${five[1]} · dom ${five[2]} · mon ${five[3]} · dow ${five[4]}`
          : `min ${five[0]} · hr ${five[1]} · dom ${five[2]} · mon ${five[3]} · dow ${five[4]}`,
        mono: true,
      },
    ],
    copyLabel: 'Copy Schedule',
    copyValue: summary,
  };
}

function intToIpv4(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function tryInspectCidr(trimmed: string): SmartInspection | null {
  if (trimmed.includes('\n') || trimmed.length > 24) return null;
  const clean = stripOuterQuotes(trimmed);
  const m = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return null;

  const ipInt = (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const totalHosts = Math.pow(2, 32 - prefix);
  const usableHosts = prefix >= 31 ? totalHosts : Math.max(0, totalHosts - 2);
  const firstUsable = prefix >= 31 ? network : (network + 1) >>> 0;
  const lastUsable = prefix >= 31 ? broadcast : (broadcast - 1) >>> 0;
  const rangeStr = `${intToIpv4(firstUsable)} – ${intToIpv4(lastUsable)}`;

  return {
    kind: 'cidr',
    title: 'IPv4 CIDR Subnet',
    badge: { text: `${usableHosts.toLocaleString()} usable`, tone: 'muted' },
    rows: [
      { label: 'Network', value: `${intToIpv4(network)}/${prefix}`, mono: true },
      { label: 'Netmask', value: intToIpv4(mask), mono: true },
      { label: 'Range', value: rangeStr, mono: true },
      { label: 'Broadcast', value: intToIpv4(broadcast), mono: true },
    ],
    copyLabel: 'Copy Range',
    copyValue: rangeStr,
  };
}

function tryInspectCurl(trimmed: string): SmartInspection | null {
  if (trimmed.length > 16_000) return null;
  if (!/^curl(?:\.exe)?\s+/i.test(trimmed)) return null;

  const flattened = trimmed.replace(/\\\r?\n\s*/g, ' ');
  const urlMatch = flattened.match(/(?:^|\s)['"]?(https?:\/\/[^\s'"]+)['"]?/i);
  if (!urlMatch) return null;

  const url = urlMatch[1];
  const methodMatch = flattened.match(/(?:^|\s)(?:-X|--request)\s+['"]?([A-Z]+)['"]?/i);
  const hasData = /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|--json)\s+/.test(flattened);
  const method = methodMatch ? methodMatch[1].toUpperCase() : hasData ? 'POST' : 'GET';
  const headerMatches = flattened.match(/(?:^|\s)(?:-H|--header)\s+(?:'[^']*'|"[^"]*")/g) || [];
  const dataMatch = flattened.match(/(?:^|\s)(?:-d|--data(?:-raw|-binary)?|--json)\s+(?:'([^']*)'|"((?:\\.|[^"])*)")/);

  const rows: SmartInspectionRow[] = [
    { label: 'Method', value: method, mono: true },
    { label: 'URL', value: url, mono: true },
  ];
  if (headerMatches.length > 0) {
    rows.push({ label: 'Headers', value: `${headerMatches.length} header${headerMatches.length === 1 ? '' : 's'}`, mono: true });
  }

  let bodyBlock: string | undefined;
  if (dataMatch) {
    const rawBody = (dataMatch[1] ?? dataMatch[2] ?? '').replace(/\\"/g, '"').trim();
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        bodyBlock = JSON.stringify(parsed, null, 2);
      } catch {
        bodyBlock = rawBody.slice(0, 1200);
      }
    }
  }

  return {
    kind: 'curl',
    title: 'cURL Command',
    badge: { text: method, tone: 'ok' },
    rows,
    codeBlock: bodyBlock,
    copyLabel: 'Copy URL',
    copyValue: url,
  };
}

function tryInspectJson(trimmed: string): SmartInspection | null {
  if (trimmed.length < 2 || trimmed.length > MAX_INSPECT_CHARS) return null;

  let candidate = trimmed;
  let unwrappedFromFence = false;
  // Support Markdown fenced JSON blocks (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/^```(?:jsonc?|javascript|js)?\s*\r?\n([\s\S]+?)\r?\n```$/i);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
    unwrappedFromFence = true;
  }

  const first = candidate[0];
  const last = candidate[candidate.length - 1];
  let parsed: unknown;
  let wasEscapedString = false;

  if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return null;
    }
  } else if (first === '"' && last === '"' && candidate.includes('\\"')) {
    // Escaped JSON string literal (e.g. `"{\"ok\":true}"`)
    try {
      const inner = JSON.parse(candidate);
      if (typeof inner !== 'string') return null;
      const innerTrim = inner.trim();
      if (!((innerTrim.startsWith('{') && innerTrim.endsWith('}')) || (innerTrim.startsWith('[') && innerTrim.endsWith(']')))) {
        return null;
      }
      parsed = JSON.parse(innerTrim);
      wasEscapedString = true;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const isArray = Array.isArray(parsed);
  const count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
  const minified = JSON.stringify(parsed);
  const pretty = JSON.stringify(parsed, null, 2);
  const isAlreadyMinified = wasEscapedString || unwrappedFromFence || !candidate.includes('\n');
  const rows: SmartInspectionRow[] = [
    {
      label: 'Structure',
      value: isArray
        ? `Array (${count} ${count === 1 ? 'item' : 'items'})`
        : `Object (${count} ${count === 1 ? 'key' : 'keys'})`,
    },
    { label: 'Minified size', value: `${minified.length.toLocaleString()} bytes`, mono: true },
  ];
  if (!isArray && count > 0) {
    const keys = Object.keys(parsed).slice(0, 6).join(', ');
    rows.push({
      label: 'Top keys',
      value: count > 6 ? `${keys} +${count - 6}` : keys,
      mono: true,
    });
  }

  return {
    kind: 'json',
    title: wasEscapedString ? 'Escaped JSON' : 'JSON Inspector',
    badge: { text: 'Valid JSON', tone: 'ok' },
    rows,
    codeBlock: wasEscapedString ? pretty.slice(0, 2000) : undefined,
    copyLabel: isAlreadyMinified ? 'Copy Pretty' : 'Copy Minified',
    copyValue: isAlreadyMinified ? pretty : minified,
  };
}

function tryInspectEnv(trimmed: string): SmartInspection | null {
  if (!trimmed.includes('\n') || trimmed.length > 32_000) return null;
  const lines = trimmed.split(/\r?\n/);
  const entries: Array<[string, string]> = [];
  let nonCommentCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    nonCommentCount++;
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{1,63})\s*=\s*(.*)$/);
    if (!m) continue;
    entries.push([m[1], stripOuterQuotes(m[2])]);
  }

  if (entries.length < 2 || entries.length / Math.max(1, nonCommentCount) < 0.75) {
    return null;
  }

  const obj: Record<string, string> = {};
  for (const [k, v] of entries) obj[k] = v;
  const keysPreview = entries.slice(0, 6).map(([k]) => k).join(', ');

  return {
    kind: 'env',
    title: 'Environment Config',
    badge: { text: `${entries.length} vars`, tone: 'muted' },
    rows: [
      {
        label: 'Keys',
        value: entries.length > 6 ? `${keysPreview} +${entries.length - 6}` : keysPreview,
        mono: true,
      },
    ],
    copyLabel: 'Copy as JSON',
    copyValue: JSON.stringify(obj, null, 2),
  };
}

function tryInspectBase64(trimmed: string): SmartInspection | null {
  if (trimmed.length > 16_384) return null;

  let candidate = trimmed;
  let labelPrefix = 'Base64 Decoded';

  // `Authorization: Basic ...` or `Basic ...`
  const basicMatch = trimmed.match(/^(?:Authorization\s*:\s*)?Basic\s+([A-Za-z0-9+/_-]+=*)$/i);
  if (basicMatch) {
    candidate = basicMatch[1];
    labelPrefix = 'HTTP Basic Auth';
  } else {
    // `data:text/plain;base64,...` or `data:application/json;base64,...`
    const dataUriMatch = trimmed.match(/^data:(?:text\/[a-z0-9.+-]+|application\/(?:json|xml|javascript))[^,]*;base64,([A-Za-z0-9+/=\r\n]+)$/i);
    if (dataUriMatch) {
      candidate = dataUriMatch[1].replace(/\s+/g, '');
      labelPrefix = 'Data URI Base64';
    } else if (trimmed.includes('\n')) {
      // Multiline wrapped MIME Base64 (every non-empty line must be pure Base64 chars)
      const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2 || lines.some((l) => !/^[A-Za-z0-9+/]+={0,2}$/.test(l))) return null;
      candidate = lines.join('');
    }
  }

  const minLen = candidate.includes('=') || labelPrefix !== 'Base64 Decoded' ? 12 : 16;
  if (candidate.length < minLen || candidate.length > 12_288) return null;
  if (candidate.includes(' ')) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(candidate)) return null;
  // Reject pure hex hashes (MD5/SHA-1/SHA-256) or UUIDs
  if (/^[0-9a-fA-F]+$/.test(candidate)) return null;
  if (/^[0-9a-fA-F-]{36}$/.test(candidate)) return null;
  // Must carry standard padding OR be a clean multiple of 4 (unless URL-safe unpadded)
  if (
    candidate.length % 4 !== 0 &&
    !candidate.includes('=') &&
    !candidate.includes('-') &&
    !candidate.includes('_')
  ) {
    return null;
  }

  const decoded = decodeBase64UrlToUtf8(candidate);
  if (!decoded || decoded.length < 5) return null;

  // Verify readability: >= 94% printable text & contains realistic text structure
  // so random base64 tokens/IDs don't false-positive.
  let printable = 0;
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      printable++;
    }
  }
  if (printable / decoded.length < 0.94) return null;
  const looksStructured =
    /[\s:={},[\]<>\/]/.test(decoded) && /[A-Za-z0-9]{2,}/.test(decoded);
  if (!looksStructured) return null;

  let display = decoded;
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object') {
      display = JSON.stringify(parsed, null, 2);
    }
  } catch {
    /* keep raw decoded UTF-8 */
  }

  return {
    kind: 'base64',
    title: labelPrefix,
    badge: { text: `${decoded.length} chars`, tone: 'muted' },
    codeBlock: display,
    copyLabel: 'Copy Decoded',
    copyValue: display,
  };
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function tryInspectEscapedText(trimmed: string): SmartInspection | null {
  if (trimmed.length > 8192) return null;

  const unicodeMatches = trimmed.match(/\\u[0-9a-fA-F]{4}/g);
  if (unicodeMatches && unicodeMatches.length >= 2) {
    const decoded = trimmed.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    if (decoded !== trimmed) {
      return {
        kind: 'escaped',
        title: 'Unicode Unescaped',
        badge: { text: `${unicodeMatches.length} escapes`, tone: 'muted' },
        codeBlock: decoded,
        copyLabel: 'Copy Decoded',
        copyValue: decoded,
      };
    }
  }

  const entityMatches = trimmed.match(/&(?:#x[0-9a-fA-F]{2,6}|#\d{2,6}|amp|lt|gt|quot|apos|nbsp);/gi);
  if (entityMatches && entityMatches.length >= 2) {
    const decoded = trimmed.replace(
      /&(?:#x([0-9a-fA-F]{2,6})|#(\d{2,6})|(amp|lt|gt|quot|apos|nbsp));/gi,
      (full, hex, dec, named) => {
        if (hex) {
          const cp = parseInt(hex, 16);
          return cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
        }
        if (dec) {
          const cp = parseInt(dec, 10);
          return cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
        }
        return HTML_ENTITY_MAP[String(named).toLowerCase()] ?? full;
      },
    );
    if (decoded !== trimmed) {
      return {
        kind: 'escaped',
        title: 'HTML Entities Decoded',
        badge: { text: `${entityMatches.length} entities`, tone: 'muted' },
        codeBlock: decoded,
        copyLabel: 'Copy Decoded',
        copyValue: decoded,
      };
    }
  }

  return null;
}

/**
 * Inspects clipboard text for structured developer/power-user payloads.
 * Returns `null` for ordinary text so normal clips stay uncluttered.
 */
export function inspectClipContent(
  text?: string | null,
  nowMs: number = Date.now(),
): SmartInspection | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_INSPECT_CHARS) return null;

  return (
    tryInspectJwt(trimmed, nowMs) ||
    tryInspectTimestamp(trimmed, nowMs) ||
    tryInspectIsoDate(trimmed, nowMs) ||
    tryInspectColor(trimmed) ||
    tryInspectUuidOrUlid(trimmed, nowMs) ||
    tryInspectEmail(trimmed) ||
    tryInspectUrl(trimmed) ||
    tryInspectCron(trimmed) ||
    tryInspectCidr(trimmed) ||
    tryInspectCurl(trimmed) ||
    tryInspectJson(trimmed) ||
    tryInspectEnv(trimmed) ||
    tryInspectBase64(trimmed) ||
    tryInspectEscapedText(trimmed)
  );
}
