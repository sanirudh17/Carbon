import React, { useState, useEffect } from 'react';
import {
  Search,
  Clock,
  Type,
  ScanText,
  Code,
  ChevronDown,
  Filter,
  CircleHelp,
  FileText,
  Image as LucideImage,
  File as LucideFile,
  Link as LucideLink,
  Mail,
  Palette,
  Star,
  Pin,
  Copy,
  Clipboard,
  ClipboardPaste,
  Trash2,
  Settings,
  ChevronRight,
  ChevronLeft,
  Check,
  SunMoon,
  Video,
  Folder,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Loader2,
  ListOrdered,
  GripVertical,
  Plus,
  Pencil,
  MoreHorizontal,
  Scissors,
  Calendar,
  AtSign,
  Hash,
  Zap,
  Quote,
  Key,
  Sliders,
  AlertTriangle,
} from 'lucide-react';
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

export const SearchIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Search className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const AllIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Clock className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const TextIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Type className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const OcrIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <ScanText className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const CodeIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Code className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const ChevronDownIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 2.0, ...props }) => (
  <ChevronDown className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const FilterIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Filter className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const HelpIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <CircleHelp className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const RichTextIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <FileText className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const ImageIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <LucideImage className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const FilesIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <LucideFile className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const LinksIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <LucideLink className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const EmailIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Mail className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const ColorsIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Palette className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const StarIcon: React.FC<IconProps & { filled?: boolean }> = ({
  className = 'icon',
  filled = false,
  size,
  strokeWidth = 1.8,
  ...props
}) => (
  <Star
    className={className}
    fill={filled ? 'currentColor' : 'none'}
    size={size}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ size, ...props })}
  />
);

export const PinIcon: React.FC<IconProps & { filled?: boolean }> = ({
  className = 'icon',
  filled = false,
  size,
  strokeWidth = 1.8,
  ...props
}) => (
  <Pin
    className={className}
    fill={filled ? 'currentColor' : 'none'}
    size={size}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ size, ...props })}
  />
);

export const CopyIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Copy className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const HollowClipboardIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Clipboard className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const PasteIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <ClipboardPaste className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const DeleteIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Trash2 className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const SettingsIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Settings className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const ChevronRightIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <ChevronRight className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const ChevronLeftIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <ChevronLeft className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const CheckIcon: React.FC<IconProps> = ({
  className = 'icon',
  width,
  height,
  size = 13,
  strokeWidth = 2.4,
  ...props
}) => (
  <Check
    className={className}
    size={Number(width ?? height ?? size)}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ width, height, size, ...props })}
  />
);

export const SunMoonIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <SunMoon className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const VideoIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Video className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const FolderIcon: React.FC<IconProps> = ({ className = '', size = 15, strokeWidth = 1.8, ...props }) => (
  <Folder
    className={`icon ${className}`.trim()}
    size={size}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ size, ...props })}
  />
);

export const LockIcon: React.FC<IconProps> = ({ className = '', size = 15, strokeWidth = 2.0, ...props }) => (
  <Lock
    className={`icon ${className}`.trim()}
    size={size}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ size, ...props })}
  />
);

export const UnlockIcon: React.FC<IconProps> = ({ className = '', size = 15, strokeWidth = 2.0, ...props }) => (
  <Unlock
    className={`icon ${className}`.trim()}
    size={size}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ size, ...props })}
  />
);

export const EyeIcon: React.FC<IconProps> = ({ className = '', size = 14, strokeWidth = 2.0, ...props }) => (
  <Eye
    className={className}
    size={size}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ size, ...props })}
  />
);

export const EyeOffIcon: React.FC<IconProps> = ({ className = '', size = 14, strokeWidth = 2.0, ...props }) => (
  <EyeOff
    className={className}
    size={size}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ size, ...props })}
  />
);

export const SpinnerIcon: React.FC<IconProps> = ({ className = 'spinner-icon', size = 14, strokeWidth = 2.5, ...props }) => (
  <Loader2
    className={className}
    size={size}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ size, ...props })}
  />
);

export const QueueIcon: React.FC<IconProps> = ({ className = 'icon', size = 14, strokeWidth = 2.0, ...props }) => (
  <ListOrdered
    className={className}
    size={size}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ size, ...props })}
  />
);

export const DragHandleIcon: React.FC<IconProps> = ({ className = 'drag-handle-icon', size = 14, strokeWidth = 2.0, ...props }) => (
  <GripVertical
    className={className}
    size={size}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ size, ...props })}
  />
);

export const PlusIcon: React.FC<IconProps> = ({
  className = 'icon',
  width,
  height,
  size = 13,
  strokeWidth = 2.2,
  ...props
}) => (
  <Plus
    className={className}
    size={Number(width ?? height ?? size)}
    strokeWidth={strokeWidth}
    style={resolveIconStyle({ width, height, size, ...props })}
  />
);

export const EditIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 2.0, ...props }) => (
  <Pencil className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const MoreIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 2.0, ...props }) => (
  <MoreHorizontal className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const SnippetIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Scissors className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const CalendarIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Calendar className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const ClockIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Clock className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const AtIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <AtSign className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const HashtagIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Hash className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const BoltIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Zap className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const QuoteIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Quote className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const KeyIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Key className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const GearIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 1.8, ...props }) => (
  <Sliders className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

export const AlertTriangleIcon: React.FC<IconProps> = ({ className = 'icon', size, strokeWidth = 2.0, ...props }) => (
  <AlertTriangle className={className} size={size} strokeWidth={strokeWidth} style={resolveIconStyle({ size, ...props })} />
);

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

export const thumbnailCache = new Map<string, string>();

/**
 * Miniature clip tile icon (Tinycast / Raycast parity):
 * - If sensitive: shielded with LockIcon.
 * - If image with image_path: loads actual image data URL via Tauri IPC and renders miniature thumbnail.
 * - Otherwise: renders content-type glyph.
 */
export const ClipTileIcon: React.FC<{ item: ClipItem; className?: string }> = ({ item, className }) => {
  const [thumb, setThumb] = useState<string | null>(() => {
    if (item.content_type === 'image' && item.image_path && !item.is_sensitive) {
      return thumbnailCache.get(item.image_path) || null;
    }
    return null;
  });

  useEffect(() => {
    if (item.content_type !== 'image' || !item.image_path || item.is_sensitive) {
      setThumb(null);
      return;
    }

    const cached = thumbnailCache.get(item.image_path);
    if (cached) {
      setThumb(cached);
      return;
    }

    let active = true;
    invoke<string>('get_image_data_url', { filePath: item.image_path })
      .then((dataUrl) => {
        if (active && dataUrl) {
          thumbnailCache.set(item.image_path!, dataUrl);
          setThumb(dataUrl);
        }
      })
      .catch((err) => {
        console.warn('ClipTileIcon failed to load thumbnail:', err);
      });

    return () => {
      active = false;
    };
  }, [item.image_path, item.id, item.content_type, item.is_sensitive]);

  if (item.is_sensitive) {
    return <LockIcon className={className} />;
  }

  if (item.content_type === 'image' && thumb) {
    return (
      <img
        src={thumb}
        alt=""
        draggable={false}
        className="clip-thumb-img"
      />
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
// switches theme — no React state needed. PNGs are the original Glint
// exports (1.2–1.3 MB) at native resolution for crisp rendering.
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
