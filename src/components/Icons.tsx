import React, { useState, useEffect, useRef } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  Search01Icon,
  Clock01Icon,
  TextIcon as HugeTextIcon,
  ScanTextIcon,
  CodeIcon as HugeCodeIcon,
  ArrowDown01Icon,
  FilterHorizontalIcon,
  HelpCircleIcon,
  File02Icon,
  Image02Icon,
  FileEmpty02Icon,
  Link04Icon,
  Mail01Icon,
  DropletIcon,
  StarIcon as HugeStarIcon,
  PinIcon as HugePinIcon,
  Copy01Icon,
  ClipboardIcon,
  Delete02Icon,
  Settings02Icon,
  ArrowRight01Icon,
  ArrowLeft01Icon,
  Tick02Icon,
  Sun03Icon,
  Moon02Icon,
  ComputerIcon,
  Video01Icon,
  Folder01Icon,
  LockIcon as HugeLockIcon,
  LockOpenIcon,
  ViewIcon,
  ViewOffIcon,
  Loading03Icon,
  LeftToRightListDashIcon,
  DragDropVerticalIcon,
  PlusSignIcon,
  PencilEdit02Icon,
  MoreHorizontalIcon,
  ScissorIcon,
  Calendar01Icon,
  AtIcon as HugeAtIcon,
  Tag01Icon,
  FlashIcon,
  QuoteUpIcon,
  Key01Icon,
  SlidersHorizontalIcon,
  Alert02Icon,
  Cancel01Icon,
  PauseIcon as HugePauseIcon,
  PlayIcon as HugePlayIcon,
  Shield01Icon,
} from '@hugeicons/core-free-icons';
import { invoke } from '@tauri-apps/api/core';
import { ClipItem, ContentType } from '../types';
import carbonBadgeDarkPng from '../assets/carbon-badge-dark.png';
import carbonBadgeLightPng from '../assets/carbon-badge-light.png';

export interface IconProps {
  className?: string;
  size?: number | string;
  width?: number | string;
  height?: number | string;
  strokeWidth?: number | string;
  style?: React.CSSProperties;
}

function resolveIconStyle(props: IconProps): React.CSSProperties | undefined {
  const w = props.width ?? props.size;
  const h = props.height ?? props.size;
  if (w !== undefined || h !== undefined || props.style) {
    return {
      ...(w !== undefined ? { width: typeof w === 'number' ? `${w}px` : w } : {}),
      ...(h !== undefined ? { height: typeof h === 'number' ? `${h}px` : h } : {}),
      ...props.style,
    };
  }
  return undefined;
}

function makeHugeIcon(
  icon: IconSvgElement,
  defaults: { className?: string; size?: number; strokeWidth?: number; prefixIconClass?: boolean } = {}
): React.FC<IconProps> {
  const {
    className: defaultClassName = 'icon',
    size: defaultSize,
    strokeWidth: defaultStroke = 1.5,
    prefixIconClass = false,
  } = defaults;

  return ({ className, size, width, height, strokeWidth = defaultStroke, style, ...rest }) => {
    const resolvedClass = prefixIconClass
      ? `icon ${className ?? ''}`.trim()
      : (className ?? defaultClassName);
    const numericSize = Number(width ?? height ?? size ?? defaultSize ?? 24);
    const resolvedStyle = resolveIconStyle({ size: size ?? defaultSize, width, height, style });
    return (
      <HugeiconsIcon
        icon={icon}
        className={resolvedClass}
        size={Number.isFinite(numericSize) ? numericSize : 24}
        strokeWidth={Number(strokeWidth)}
        style={resolvedStyle}
        {...rest}
      />
    );
  };
}

export const SearchIcon = makeHugeIcon(Search01Icon);
export const AllIcon = makeHugeIcon(Clock01Icon);
export const TextIcon = makeHugeIcon(HugeTextIcon);
export const OcrIcon = makeHugeIcon(ScanTextIcon);
export const CodeIcon = makeHugeIcon(HugeCodeIcon);
export const ChevronDownIcon = makeHugeIcon(ArrowDown01Icon, { strokeWidth: 1.65 });
export const FilterIcon = makeHugeIcon(FilterHorizontalIcon);
export const HelpIcon = makeHugeIcon(HelpCircleIcon);
export const RichTextIcon = makeHugeIcon(File02Icon);
export const ImageIcon = makeHugeIcon(Image02Icon);
export const FilesIcon = makeHugeIcon(FileEmpty02Icon);
export const LinksIcon = makeHugeIcon(Link04Icon);
export const EmailIcon = makeHugeIcon(Mail01Icon);
export const ColorsIcon = makeHugeIcon(DropletIcon);

export const StarIcon: React.FC<IconProps & { filled?: boolean }> = ({
  className = 'icon',
  filled = false,
  size,
  width,
  height,
  strokeWidth = 1.5,
  style,
}) => (
  <HugeiconsIcon
    icon={HugeStarIcon}
    className={className}
    size={Number(width ?? height ?? size ?? 24)}
    strokeWidth={Number(strokeWidth)}
    fill={filled ? 'currentColor' : 'none'}
    style={resolveIconStyle({ size, width, height, style })}
  />
);

export const PinIcon: React.FC<IconProps & { filled?: boolean }> = ({
  className = 'icon',
  filled = false,
  size,
  width,
  height,
  strokeWidth = 1.5,
  style,
}) => (
  <HugeiconsIcon
    icon={HugePinIcon}
    className={className}
    size={Number(width ?? height ?? size ?? 24)}
    strokeWidth={Number(strokeWidth)}
    fill={filled ? 'currentColor' : 'none'}
    style={resolveIconStyle({ size, width, height, style })}
  />
);

export const CopyIcon = makeHugeIcon(Copy01Icon);
export const HollowClipboardIcon = makeHugeIcon(ClipboardIcon);
export const PasteIcon = makeHugeIcon(ClipboardIcon);
export const DeleteIcon = makeHugeIcon(Delete02Icon);
export const SettingsIcon = makeHugeIcon(Settings02Icon);
export const ChevronRightIcon = makeHugeIcon(ArrowRight01Icon, { strokeWidth: 1.6 });
export const ChevronLeftIcon = makeHugeIcon(ArrowLeft01Icon, { strokeWidth: 1.6 });
export const CheckIcon = makeHugeIcon(Tick02Icon, { size: 13, strokeWidth: 1.9 });
export const SunMoonIcon = makeHugeIcon(Sun03Icon);
export const SunIcon = makeHugeIcon(Sun03Icon);
export const MoonIcon = makeHugeIcon(Moon02Icon);
export const SystemThemeIcon = makeHugeIcon(ComputerIcon);
export const VideoIcon = makeHugeIcon(Video01Icon);
export const FolderIcon = makeHugeIcon(Folder01Icon, { size: 15, prefixIconClass: true });
export const LockIcon = makeHugeIcon(HugeLockIcon, { size: 14, strokeWidth: 1.6, prefixIconClass: true });
export const UnlockIcon = makeHugeIcon(LockOpenIcon, { size: 14, strokeWidth: 1.6, prefixIconClass: true });
export const EyeIcon = makeHugeIcon(ViewIcon, { className: '', size: 14, strokeWidth: 1.6 });
export const EyeOffIcon = makeHugeIcon(ViewOffIcon, { className: '', size: 14, strokeWidth: 1.6 });
export const SpinnerIcon = makeHugeIcon(Loading03Icon, { className: 'spinner-icon', size: 14, strokeWidth: 1.9 });
export const QueueIcon = makeHugeIcon(LeftToRightListDashIcon, { size: 14, strokeWidth: 1.55 });
export const DragHandleIcon = makeHugeIcon(DragDropVerticalIcon, { className: 'drag-handle-icon', size: 14, strokeWidth: 1.6 });
export const PlusIcon = makeHugeIcon(PlusSignIcon, { size: 13, strokeWidth: 1.75 });
export const EditIcon = makeHugeIcon(PencilEdit02Icon, { strokeWidth: 1.55 });
export const MoreIcon = makeHugeIcon(MoreHorizontalIcon, { strokeWidth: 1.65 });
export const SnippetIcon = makeHugeIcon(ScissorIcon);
export const CalendarIcon = makeHugeIcon(Calendar01Icon);
export const ClockIcon = makeHugeIcon(Clock01Icon);
export const AtIcon = makeHugeIcon(HugeAtIcon);
export const HashtagIcon = makeHugeIcon(Tag01Icon);
export const BoltIcon = makeHugeIcon(FlashIcon);
export const QuoteIcon = makeHugeIcon(QuoteUpIcon);
export const KeyIcon = makeHugeIcon(Key01Icon);
export const GearIcon = makeHugeIcon(SlidersHorizontalIcon);
export const AlertTriangleIcon = makeHugeIcon(Alert02Icon, { strokeWidth: 1.65 });
export const CloseIcon = makeHugeIcon(Cancel01Icon, { size: 13, strokeWidth: 1.75 });
export const PauseIcon = makeHugeIcon(HugePauseIcon, { size: 13, strokeWidth: 1.65 });
export const PlayIcon = makeHugeIcon(HugePlayIcon, { size: 13, strokeWidth: 1.65 });
export const ShieldIcon = makeHugeIcon(Shield01Icon, { size: 14, strokeWidth: 1.55 });

export function getTypeIcon(kind: ContentType) {
  switch (kind) {
    case 'code': return <CodeIcon />;
    case 'rich_text': return <RichTextIcon />;
    case 'image': return <ImageIcon />;
    case 'file': return <FilesIcon />;
    case 'link': return <LinksIcon />;
    case 'email': return <EmailIcon />;
    case 'color': return <ColorsIcon />;
    default: return <TextIcon />;
  }
}

const THUMBNAIL_CACHE_MAX = 120;
const thumbnailCache = new Map<string, string>();
const thumbnailInflight = new Map<string, Promise<string | null>>();
const THUMB_MAX_CONCURRENT = 4;
let thumbActiveCount = 0;
const thumbPendingQueue: Array<() => void> = [];

// Single shared IntersectionObserver for all ClipTileIcon placeholders so
// scrolling 200+ image rows allocates 1 observer instead of 200.
let sharedThumbObserver: IntersectionObserver | null = null;
const thumbObserverCallbacks = new Map<Element, () => void>();

function getSharedThumbObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!sharedThumbObserver) {
    sharedThumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const cb = thumbObserverCallbacks.get(entry.target);
            thumbObserverCallbacks.delete(entry.target);
            sharedThumbObserver?.unobserve(entry.target);
            cb?.();
          }
        }
      },
      { rootMargin: '160px' }
    );
  }
  return sharedThumbObserver;
}

function getCachedThumbnail(key: string): string | undefined {
  const val = thumbnailCache.get(key);
  if (val !== undefined) {
    // Touch LRU recency
    thumbnailCache.delete(key);
    thumbnailCache.set(key, val);
  }
  return val;
}

function setCachedThumbnail(key: string, val: string): void {
  thumbnailCache.delete(key);
  thumbnailCache.set(key, val);
  while (thumbnailCache.size > THUMBNAIL_CACHE_MAX) {
    const oldestKey = thumbnailCache.keys().next().value;
    if (oldestKey !== undefined) thumbnailCache.delete(oldestKey);
    else break;
  }
}

function runThumbQueue() {
  while (thumbActiveCount < THUMB_MAX_CONCURRENT && thumbPendingQueue.length > 0) {
    const next = thumbPendingQueue.shift();
    if (next) {
      thumbActiveCount += 1;
      next();
    }
  }
}

async function downscaleThumbnail(dataUrl: string): Promise<string> {
  try {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return dataUrl;
    return await new Promise<string>((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        try {
          const maxSide = 64;
          const nw = img.naturalWidth || 0;
          const nh = img.naturalHeight || 0;
          if (!nw || !nh || (nw <= maxSide && nh <= maxSide)) {
            resolve(dataUrl);
            return;
          }
          const scale = Math.min(maxSide / nw, maxSide / nh);
          const w = Math.max(1, Math.round(nw * scale));
          const h = Math.max(1, Math.round(nh * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(dataUrl);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          const small = canvas.toDataURL('image/webp', 0.8);
          resolve(small.startsWith('data:image/') ? small : canvas.toDataURL('image/png'));
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  } catch {
    return dataUrl;
  }
}

function loadThumbnail(filePath: string): Promise<string | null> {
  const cached = getCachedThumbnail(filePath);
  if (cached) return Promise.resolve(cached);

  const existing = thumbnailInflight.get(filePath);
  if (existing) return existing;

  const promise = new Promise<string | null>((resolve) => {
    const start = () => {
      invoke<string>('get_image_data_url', { filePath })
        .then(async (dataUrl) => {
          if (!dataUrl) return null;
          const compact = await downscaleThumbnail(dataUrl);
          setCachedThumbnail(filePath, compact);
          return compact;
        })
        .catch(() => null)
        .then((res) => {
          thumbnailInflight.delete(filePath);
          thumbActiveCount = Math.max(0, thumbActiveCount - 1);
          runThumbQueue();
          resolve(res);
        });
    };
    thumbPendingQueue.push(start);
    runThumbQueue();
  });

  thumbnailInflight.set(filePath, promise);
  return promise;
}

/**
 * Miniature clip tile icon (Tinycast / Raycast parity):
 * - If sensitive: shielded with LockIcon.
 * - If image with image_path: lazily loads & downscales miniature 64px thumbnail
 *   when near the viewport via a single shared IntersectionObserver + bounded LRU
 *   cache + max-4 concurrency queue (never stalls on 100+ images).
 * - Otherwise: renders content-type glyph.
 */
export const ClipTileIcon: React.FC<{ item: ClipItem; className?: string }> = ({ item, className }) => {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [thumb, setThumb] = useState<string | null>(() => {
    if (item.content_type === 'image' && item.image_path && !item.is_sensitive) {
      return getCachedThumbnail(item.image_path) || null;
    }
    return null;
  });

  useEffect(() => {
    if (item.content_type !== 'image' || !item.image_path || item.is_sensitive) {
      setThumb(null);
      return;
    }

    const filePath = item.image_path;
    const cached = getCachedThumbnail(filePath);
    if (cached) {
      setThumb(cached);
      return;
    }

    let active = true;
    let started = false;
    const triggerLoad = () => {
      if (started || !active) return;
      started = true;
      loadThumbnail(filePath).then((url) => {
        if (active && url) setThumb(url);
      });
    };

    const el = hostRef.current;
    const observer = el ? getSharedThumbObserver() : null;
    if (el && observer) {
      thumbObserverCallbacks.set(el, triggerLoad);
      observer.observe(el);
      return () => {
        active = false;
        thumbObserverCallbacks.delete(el);
        observer.unobserve(el);
      };
    }

    triggerLoad();
    return () => {
      active = false;
    };
  }, [item.image_path, item.id, item.content_type, item.is_sensitive]);

  if (item.is_sensitive) {
    return <LockIcon className={className} />;
  }

  if (item.content_type === 'image') {
    if (thumb) {
      return (
        <img
          src={thumb}
          alt=""
          draggable={false}
          decoding="async"
          className="clip-thumb-img"
        />
      );
    }
    return (
      <span ref={hostRef} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <ImageIcon />
      </span>
    );
  }

  return <>{getTypeIcon(item.content_type)}</>;
};

export function getTypeColor(_kind?: ContentType): string {
  return 'currentColor';
}

export function getTypeLabel(kind: ContentType): string {
  switch (kind) {
    case 'code': return 'Code';
    case 'rich_text': return 'Rich text';
    case 'image': return 'Image';
    case 'file': return 'File';
    case 'link': return 'Link';
    case 'email': return 'Email';
    case 'color': return 'Color';
    default: return 'Text';
  }
}

/* ── Snippet icon registry (shared by SnippetsView + Quick Overlay) ── */

export interface SnippetIconsEntry {
  key: string;
  label: string;
  icon: React.FC<IconProps>;
}

export const SNIPPET_ICONS: SnippetIconsEntry[] = [
  { key: 'snippet', label: 'Snippet', icon: SnippetIcon },
  { key: 'text', label: 'Text', icon: TextIcon },
  { key: 'code', label: 'Code', icon: CodeIcon },
  { key: 'calendar', label: 'Calendar', icon: CalendarIcon },
  { key: 'clock', label: 'Clock', icon: ClockIcon },
  { key: 'at', label: 'Mention', icon: AtIcon },
  { key: 'hashtag', label: 'Hashtag', icon: HashtagIcon },
  { key: 'bolt', label: 'Quick', icon: BoltIcon },
  { key: 'quote', label: 'Quote', icon: QuoteIcon },
  { key: 'key', label: 'Key', icon: KeyIcon },
  { key: 'gear', label: 'Config', icon: GearIcon },
  { key: 'email', label: 'Email', icon: EmailIcon },
  { key: 'link', label: 'Link', icon: LinksIcon },
  { key: 'colors', label: 'Color', icon: ColorsIcon },
  { key: 'star', label: 'Favorite', icon: StarIcon },
];

export function snippetIconFor(key: string | null): React.FC<IconProps> {
  return SNIPPET_ICONS.find((i) => i.key === (key || 'snippet'))?.icon ?? SnippetIcon;
}

// Carbon brand mark: a simplified clipboard glyph distilled from the full
// layered-clipboard illustration — just the board and its latch, bold enough
// to stay legible at the small sidebar-header size (~24px), where the full
// illustration's gradients and fine text lines would turn to noise. Stroke
// uses currentColor so the mark inherits the active accent theme via the
// .brand-mark CSS color (var(--accent)) instead of a hardcoded hex.
export const CarbonMarkIcon: React.FC<IconProps> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15.5 4H17a2.5 2.5 0 0 1 2.5 2.5v12A2.5 2.5 0 0 1 17 21H7a2.5 2.5 0 0 1-2.5-2.5v-12A2.5 2.5 0 0 1 7 4h1.5" />
    <rect x="8.5" y="2" width="7" height="4.5" rx="1.4" />
  </svg>
);

// Full-colour Carbon app badge — PNG at highest quality, not SVG. Two PNGs
// ship: dark for dark theme, light for light theme. CSS shows exactly one
// via html[data-theme], so the icon swaps automatically when the user
// switches theme — no React state needed.
export const BrandBadgeIcon: React.FC<IconProps> = ({ className = 'icon' }) => (
  <>
    <img
      src={carbonBadgeDarkPng}
      className={`${className} carbon-badge-dark`}
      alt="Carbon"
      draggable={false}
      decoding="sync"
      style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'auto' }}
    />
    <img
      src={carbonBadgeLightPng}
      className={`${className} carbon-badge-light`}
      alt="Carbon"
      draggable={false}
      decoding="sync"
      style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'auto' }}
    />
  </>
);
