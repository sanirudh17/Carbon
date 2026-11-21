import type { ClipItem } from '../types';

export interface DateGroup {
  label: string;
  items: ClipItem[];
}

/**
 * Parses SQLite localtime strings (`YYYY-MM-DD HH:MM:SS`) and ISO timestamps
 * consistently as local time when no timezone offset is present.
 */
export function parseClipTimestamp(dateStr?: string | null): Date | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  if (!trimmed) return null;
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Local calendar-day distance between `d` and `now`:
 *   0 = Today, 1 = Yesterday, 2 = 2 calendar days ago, etc.
 */
export function getCalendarDayDiff(d: Date, now: Date = new Date()): number {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const itemDayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((todayStart.getTime() - itemDayStart.getTime()) / 86400000);
}

/**
 * Groups clips into `Today`, `Yesterday`, and formatted calendar date headings.
 * Uses calendar-day math identical to `formatCopiedAt` and `formatTimeAgo` so
 * headings and relative timestamps never contradict each other.
 */
export function groupItemsByDate(items: ClipItem[], now: Date = new Date()): DateGroup[] {
  const groups: Record<string, ClipItem[]> = {};
  const order: string[] = [];

  for (const item of items) {
    let label = 'Older';
    const d = parseClipTimestamp(item.created_at || item.updated_at);
    if (d) {
      const diffDays = getCalendarDayDiff(d, now);
      if (diffDays <= 0) {
        label = 'Today';
      } else if (diffDays === 1) {
        label = 'Yesterday';
      } else {
        label = d.toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
      }
    }

    if (!groups[label]) {
      groups[label] = [];
      order.push(label);
    }
    groups[label].push(item);
  }

  return order.map((label) => ({ label, items: groups[label] }));
}

/**
 * Relative timestamp consistent with `groupItemsByDate`:
 *   - Under 24h: `just now` / `Xm ago` / `Xh ago`
 *   - Yesterday (calendar day diff === 1) and >= 24h: `1d ago`
 *   - 2+ calendar days ago: `${diffDays}d ago` (never shows `1d ago` under a
 *     2-day-old calendar date heading).
 */
export function formatTimeAgo(dateStr?: string | null, now: Date = new Date()): string {
  const d = parseClipTimestamp(dateStr);
  if (!d) return 'just now';
  const diffSec = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000));
  const diffDays = getCalendarDayDiff(d, now);

  if (diffDays <= 0) {
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return `${Math.floor(diffSec / 3600)}h ago`;
  }
  if (diffDays === 1) {
    if (diffSec < 86400) {
      const hrs = Math.max(1, Math.floor(diffSec / 3600));
      return `${hrs}h ago`;
    }
    return '1d ago';
  }
  return `${diffDays}d ago`;
}
