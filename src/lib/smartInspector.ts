/**
 * Deterministic, zero-dependency Smart Content Inspector for Carbon.
 *
 * Inspects clipboard text locally (zero AI, zero network) and returns a
 * structured read-only inspection card when the text matches a recognized
 * developer or power-user payload:
 *   1. JWT tokens (with optional `Bearer ` prefix) — alg, expiry status, claims
 *   2. Unix timestamps (10-digit s / 13-digit ms) — Local, UTC ISO, relative
 *   3. ISO-8601 timestamps — Local, Unix (s/ms), relative
 *   4. URLs — Query parameters table, URL breakdown (host/path/hash), or percent-decoded text
 *   5. Colors (#hex, rgb(), hsl()) — cross-format HEX / RGB / HSL conversions
 *   6. UUIDs (v1–v7) — version, variant, and embedded UTC timestamp for UUIDv7
 *   7. Cron expressions (5-field) — human-readable schedule summary
 *   8. JSON objects/arrays — structural summary + 1-click Minify / Pretty copy
 *   9. Readable UTF-8 Base64 — decoded text (auto-pretty JSON when valid)
 *
 * Returns `null` for ordinary text so regular clips stay completely uncluttered.
 */

export type SmartInspectionKind =
  | 'jwt'
  | 'timestamp'
  | 'iso_date'
  | 'url_params'
  | 'url_info'
  | 'url_encoded'
  | 'color'
  | 'uuid'
  | 'cron'
  | 'json'
  | 'base64';

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

function tryInspectJwt(trimmed: string, nowMs: number): SmartInspection | null {
  const token = trimmed.replace(/^Bearer\s+/i, '').trim();
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

function tryInspectTimestamp(trimmed: string, nowMs: number): SmartInspection | null {
  if (!/^\d{10}(\d{3})?$/.test(trimmed)) return null;
  const raw = Number(trimmed);
  if (!Number.isSafeInteger(raw)) return null;

  const isMs = trimmed.length === 13;
  const epochMs = isMs ? raw : raw * 1000;
  // Year 2001-09-09 through 2100-01-01 to avoid arbitrary phone/account numbers
  const MIN_MS = 1_000_000_000_000;
  const MAX_MS = 4_102_444_800_000;
  if (epochMs < MIN_MS || epochMs > MAX_MS) return null;

  const d = new Date(epochMs);
  if (isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  const rel = formatRelativeDuration(epochMs - nowMs);

  return {
    kind: 'timestamp',
    title: isMs ? 'Unix Timestamp (ms)' : 'Unix Timestamp (s)',
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
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(trimmed)) {
    return null;
  }
  const d = new Date(trimmed.includes(' ') ? trimmed.replace(' ', 'T') : trimmed);
  if (isNaN(d.getTime())) return null;
  const epochMs = d.getTime();
  const epochSec = Math.floor(epochMs / 1000);
  const rel = formatRelativeDuration(epochMs - nowMs);

  return {
    kind: 'iso_date',
    title: 'ISO Timestamp',
    badge: { text: rel, tone: 'muted' },
    rows: [
      { label: 'Local', value: d.toLocaleString(), mono: true },
      { label: 'Unix (s)', value: String(epochSec), mono: true },
      { label: 'Unix (ms)', value: String(epochMs), mono: true },
    ],
    copyLabel: 'Copy Unix (s)',
    copyValue: String(epochSec),
  };
}

function tryInspectUrl(trimmed: string): SmartInspection | null {
  if (trimmed.includes('\n') || trimmed.includes(' ')) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      const entries = Array.from(u.searchParams.entries());
      if (entries.length > 0) {
        const rows: SmartInspectionRow[] = entries.slice(0, 10).map(([k, v]) => ({
          label: k,
          value: v || '(empty)',
          mono: true,
        }));
        const decodedUrl = (() => {
          try {
            return decodeURIComponent(trimmed);
          } catch {
            return trimmed;
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

      // Plain URL with non-trivial path, percent-encoding, or hash
      const hasPath = u.pathname && u.pathname !== '/';
      const hasHash = Boolean(u.hash);
      if (hasPath || hasHash) {
        const decodedPath = (() => {
          try {
            return decodeURIComponent(u.pathname);
          } catch {
            return u.pathname;
          }
        })();
        const rows: SmartInspectionRow[] = [
          { label: 'Host', value: u.host, mono: true },
        ];
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
      }
    } catch {
      /* invalid URL */
    }
  }

  // Percent-encoded string (at least 2 `%XX` triplets)
  const pctMatches = trimmed.match(/%[0-9a-fA-F]{2}/g);
  if (pctMatches && pctMatches.length >= 2) {
    try {
      const decoded = decodeURIComponent(trimmed);
      if (decoded !== trimmed && decoded.trim().length > 0) {
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

function tryInspectColor(trimmed: string): SmartInspection | null {
  let r: number, g: number, b: number;
  let inputKind: 'hex' | 'rgb' | 'hsl';

  const hexMatch = trimmed.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)$/i);
  const hslMatch = trimmed.match(/^hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%(?:\s*,\s*[\d.]+)?\s*\)$/i);

  if (hexMatch) {
    inputKind = 'hex';
    const raw = hexMatch[1];
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    b = parseInt(full.slice(4, 6), 16);
  } else if (rgbMatch) {
    inputKind = 'rgb';
    r = Number(rgbMatch[1]);
    g = Number(rgbMatch[2]);
    b = Number(rgbMatch[3]);
    if (r > 255 || g > 255 || b > 255) return null;
  } else if (hslMatch) {
    inputKind = 'hsl';
    const h = Number(hslMatch[1]) % 360;
    const s = Number(hslMatch[2]);
    const l = Number(hslMatch[3]);
    if (s > 100 || l > 100) return null;
    [r, g, b] = hslToRgb(h, s, l);
  } else {
    return null;
  }

  const hex = `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
  const rgb = `rgb(${r}, ${g}, ${b})`;
  const [h, s, l] = rgbToHsl(r, g, b);
  const hsl = `hsl(${h}, ${s}%, ${l}%)`;

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

function tryInspectUuid(trimmed: string, nowMs: number): SmartInspection | null {
  const m = trimmed.match(
    /^([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([1-8][0-9a-fA-F]{3})-([89abAB][0-9a-fA-F]{3})-([0-9a-fA-F]{12})$/,
  );
  if (!m) return null;
  const version = parseInt(m[3][0], 16);
  const rows: SmartInspectionRow[] = [
    { label: 'Version', value: `UUID v${version}`, mono: true },
    { label: 'Compact', value: trimmed.replace(/-/g, '').toLowerCase(), mono: true },
  ];

  // UUIDv7 embeds a 48-bit big-endian Unix millisecond timestamp in the first 12 hex digits
  if (version === 7) {
    const hexTs = `${m[1]}${m[2]}`;
    const epochMs = parseInt(hexTs, 16);
    if (epochMs >= 1_000_000_000_000 && epochMs <= 4_102_444_800_000) {
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
    copyValue: trimmed.replace(/-/g, '').toLowerCase(),
  };
}

function describeCron(fields: string[]): string | null {
  const [min, hr, dom, mon, dow] = fields;
  const validField = (f: string) => /^(\*|\d+(-\d+)?(,\d+(-\d+)?)*)(\/\d+)?$/.test(f);
  if (!fields.every(validField)) return null;
  if (min === '*' && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'Every minute';
  }
  if (min.startsWith('*/') && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${min.slice(2)} minutes`;
  }
  if (/^\d+$/.test(min) && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Hourly at :${min.padStart(2, '0')}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && mon === '*') {
    const time = `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
    if (dow === '*') return `Daily at ${time}`;
    if (dow === '1-5') return `Weekdays (Mon–Fri) at ${time}`;
    if (dow === '0,6' || dow === '6,0') return `Weekends at ${time}`;
    return `At ${time} on day-of-week ${dow}`;
  }
  return `min=${min}, hr=${hr}, dom=${dom}, mon=${mon}, dow=${dow}`;
}

function tryInspectCron(trimmed: string): SmartInspection | null {
  if (trimmed.includes('\n')) return null;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return null;
  // Require at least one cron-specific token (*, /, -) so plain 5 numbers don't trigger
  if (!/[*/,-]/.test(trimmed)) return null;
  const summary = describeCron(fields);
  if (!summary) return null;
  return {
    kind: 'cron',
    title: 'Cron Schedule',
    badge: { text: '5-field', tone: 'muted' },
    rows: [
      { label: 'Schedule', value: summary },
      { label: 'Fields', value: `min ${fields[0]} · hr ${fields[1]} · dom ${fields[2]} · mon ${fields[3]} · dow ${fields[4]}`, mono: true },
    ],
    copyLabel: 'Copy Schedule',
    copyValue: summary,
  };
}

function tryInspectJson(trimmed: string): SmartInspection | null {
  if (trimmed.length < 2 || trimmed.length > 16_000) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    const isArray = Array.isArray(parsed);
    const count = isArray ? parsed.length : Object.keys(parsed).length;
    const minified = JSON.stringify(parsed);
    const pretty = JSON.stringify(parsed, null, 2);
    const isAlreadyMinified = !trimmed.includes('\n');
    const rows: SmartInspectionRow[] = [
      {
        label: 'Structure',
        value: isArray ? `Array (${count} ${count === 1 ? 'item' : 'items'})` : `Object (${count} ${count === 1 ? 'key' : 'keys'})`,
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
      title: 'JSON Inspector',
      badge: { text: 'Valid JSON', tone: 'ok' },
      rows,
      copyLabel: isAlreadyMinified ? 'Copy Pretty' : 'Copy Minified',
      copyValue: isAlreadyMinified ? pretty : minified,
    };
  } catch {
    return null;
  }
}

function tryInspectBase64(trimmed: string): SmartInspection | null {
  if (trimmed.length < 16 || trimmed.length > 8192) return null;
  if (trimmed.includes('\n') || trimmed.includes(' ')) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;
  // Reject pure hex hashes (MD5/SHA-1/SHA-256) or UUIDs
  if (/^[0-9a-fA-F]+$/.test(trimmed)) return null;
  if (/^[0-9a-fA-F-]{36}$/.test(trimmed)) return null;
  // Must carry standard padding OR be a clean multiple of 4
  if (trimmed.length % 4 !== 0 && !trimmed.includes('=') && !trimmed.includes('-') && !trimmed.includes('_')) {
    return null;
  }

  const decoded = decodeBase64UrlToUtf8(trimmed);
  if (!decoded || decoded.length < 6) return null;

  // Verify readability: >= 94% printable text & contains realistic text structure
  // (space, JSON/XML punctuation, or URL scheme) so random base64 tokens/IDs don't false-positive.
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
    title: 'Base64 Decoded',
    badge: { text: `${decoded.length} chars`, tone: 'muted' },
    codeBlock: display,
    copyLabel: 'Copy Decoded',
    copyValue: display,
  };
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
  if (!trimmed || trimmed.length > 16_000) return null;

  return (
    tryInspectJwt(trimmed, nowMs) ||
    tryInspectTimestamp(trimmed, nowMs) ||
    tryInspectIsoDate(trimmed, nowMs) ||
    tryInspectColor(trimmed) ||
    tryInspectUuid(trimmed, nowMs) ||
    tryInspectUrl(trimmed) ||
    tryInspectCron(trimmed) ||
    tryInspectJson(trimmed) ||
    tryInspectBase64(trimmed)
  );
}
