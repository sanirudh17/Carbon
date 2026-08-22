import React from 'react';
import { ContentType } from '../types';

export const SearchIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const AllIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const TextIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M5 6.5V4.5h14v2" />
    <path d="M12 4.5V19.5" />
    <path d="M9 19.5h6" />
  </svg>
);

export const OcrIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 8h10" />
    <path d="M7 12h10" />
    <path d="M7 16h6" />
  </svg>
);

export const CodeIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="m8 8-4 4 4 4" />
    <path d="m16 8 4 4-4 4" />
    <path d="m13 6-2 12" />
  </svg>
);

export const ChevronDownIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 9.5 6 5.5 6-5.5" />
  </svg>
);

export const FilterIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 4H2l8 9.09V19l4 2v-7.91L22 4z" />
  </svg>
);

export const HelpIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.7 9.3a2.4 2.4 0 0 1 4.66.8c0 1.5-2.36 1.9-2.36 3.15" />
    <path d="M12 16.6h.01" strokeWidth="2.2" />
  </svg>
);

export const RichTextIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M4 5h16" />
    <path d="M4 9h10" />
    <path d="M4 13h7" />
    <path d="M4 17h4" />
    <path d="m15 13 2.5 2.5L22 11" />
  </svg>
);

export const ImageIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4.5 17.5 5-5 4 4 2.5-2.5 3.5 3.5" />
  </svg>
);

export const FilesIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
    <path d="M14 4v5h5" />
  </svg>
);

export const LinksIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M10 14a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.6 1.6" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6" />
  </svg>
);

export const EmailIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
    <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
  </svg>
);

export const ColorsIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.8 2-1.7 0-1-.8-1.5-.8-2.4 0-1 .8-1.6 2.1-1.6h1.4A4.2 4.2 0 0 0 21 10.6c0-4-4-7.1-9-7.1Z" />
    <circle cx="7.6" cy="10.5" r=".9" />
    <circle cx="10.5" cy="7.2" r=".9" />
    <circle cx="15" cy="7.4" r=".9" />
  </svg>
);

export const StarIcon: React.FC<{ className?: string; filled?: boolean }> = ({ className = 'icon', filled = false }) => (
  <svg className={className} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

export const PinIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <StarIcon className={className} />
);

export const CopyIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const HollowClipboardIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
  </svg>
);

export const PasteIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1Z" />
    <path d="M8 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3" />
    <path d="m9.5 12.5 2 2 3.5-3.5" />
  </svg>
);

export const DeleteIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M4 6.5h16" />
    <path d="M9 6.5V4.8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.7" />
    <path d="M6 6.5 6.8 19a2 2 0 0 0 2 1.9h6.4a2 2 0 0 0 2-1.9l.8-12.5" />
    <path d="M10 10.5v6M14 10.5v6" />
  </svg>
);

export const SettingsIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

export const ChevronRightIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 5 16 12l-6.5 7" />
  </svg>
);

export const ChevronLeftIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </svg>
);

export const CheckIcon: React.FC<{
  className?: string;
  width?: number | string;
  height?: number | string;
  size?: number | string;
}> = ({ className = 'icon', width, height, size = 13 }) => (
  <svg
    className={className}
    width={width ?? size}
    height={height ?? size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
);

export const SunMoonIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" />
  </svg>
);

export const VideoIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="23 7 16 12 23 17 23 7" />
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
);

export const FolderIcon: React.FC<{ className?: string }> = ({ className = '' }) => (
  <svg className={`icon ${className}`.trim()} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
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

export function getTypeColor(kind: ContentType): string {
  switch (kind) {
    case 'code': return 'var(--tint-code)';
    case 'rich_text': return 'var(--tint-rich)';
    case 'image': return 'var(--tint-image)';
    case 'file': return 'var(--tint-files)';
    case 'link': return 'var(--tint-link)';
    case 'email': return 'var(--tint-email)';
    case 'color': return 'var(--tint-color)';
    default: return 'var(--tint-text)';
  }
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

export const LockIcon: React.FC<{ className?: string }> = ({ className = '' }) => (
  <svg className={`icon ${className}`.trim()} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
  </svg>
);

export const EyeIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
    <circle cx="12" cy="12" r="3"></circle>
  </svg>
);

export const EyeOffIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
    <line x1="1" y1="1" x2="23" y2="23"></line>
  </svg>
);

export const SpinnerIcon: React.FC<{ className?: string }> = ({ className = 'spinner-icon' }) => (
  <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

export const QueueIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6h16M4 12h16M4 18h10" />
    <polyline points="17 15 20 18 17 21" />
  </svg>
);

export const DragHandleIcon: React.FC<{ className?: string }> = ({ className = 'drag-handle-icon' }) => (
  <svg className={className} width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
    <circle cx="2.5" cy="2.5" r="1.2" />
    <circle cx="7.5" cy="2.5" r="1.2" />
    <circle cx="2.5" cy="7" r="1.2" />
    <circle cx="7.5" cy="7" r="1.2" />
    <circle cx="2.5" cy="11.5" r="1.2" />
    <circle cx="7.5" cy="11.5" r="1.2" />
  </svg>
);

export const PlusIcon: React.FC<{ className?: string; width?: number | string; height?: number | string; size?: number | string }> = ({
  className = 'icon',
  width,
  height,
  size = 13,
}) => (
  <svg
    className={className}
    width={width ?? size}
    height={height ?? size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

export const UnlockIcon: React.FC<{ className?: string }> = ({ className = '' }) => (
  <svg className={`icon ${className}`.trim()} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
    <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
  </svg>
);

export const EditIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
  </svg>
);

export const MoreIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>
    <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>
  </svg>
);

export const SnippetIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {/* Scissors — "snip"-pets; deliberately unrelated to the Code type glyph */}
    <circle cx="6" cy="6" r="2.6" />
    <circle cx="6" cy="18" r="2.6" />
    <path d="M8.25 7.55 20 19.25" />
    <path d="M20 4.75 8.25 16.45" />
  </svg>
);

export const CalendarIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" />
    <path d="M8 13.5h3M13.5 13.5h2M8 17h3" />
  </svg>
);

export const ClockIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const AtIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
  </svg>
);

export const HashtagIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 4 7 20M17 4l-2 16M5 9h15M4 15h15" />
  </svg>
);

export const BoltIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z" />
  </svg>
);

export const QuoteIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 6.5c-2.8 1-4.5 3.2-4.5 6v4h5v-6H7.2c.2-1.4 1-2.6 2.3-3.4l0-0.6ZM19.5 6.5c-2.8 1-4.5 3.2-4.5 6v4h5v-6h-2.8c.2-1.4 1-2.6 2.3-3.4l0-0.6Z" />
  </svg>
);

export const KeyIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="15.5" r="4.5" />
    <path d="M11.3 12.2 20 3.5M15.5 8l2.8 2.8M18 5.5 20.5 8" />
  </svg>
);

export const GearIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 7h14M5 17h14M5 12h9" />
    <circle cx="17.5" cy="12" r="2" />
  </svg>
);


/* ── Snippet icon registry (shared by SnippetsView + Quick Overlay) ── */

export interface SnippetIconsEntry {
  key: string;
  label: string;
  icon: React.FC<{ className?: string }>;
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

export function snippetIconFor(key: string | null): React.FC<{ className?: string }> {
  return SNIPPET_ICONS.find((i) => i.key === (key || 'snippet'))?.icon ?? SnippetIcon;
}

// Carbon brand mark: a simplified clipboard glyph distilled from the full
// layered-clipboard illustration — just the board and its latch, bold enough
// to stay legible at the small sidebar-header size (~24px), where the full
// illustration's gradients and fine text lines would turn to noise. Stroke
// uses currentColor so the mark inherits the active accent theme via the
// .brand-mark CSS color (var(--accent)) instead of a hardcoded hex.
export const CarbonMarkIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15.5 4H17a2.5 2.5 0 0 1 2.5 2.5v12A2.5 2.5 0 0 1 17 21H7a2.5 2.5 0 0 1-2.5-2.5v-12A2.5 2.5 0 0 1 7 4h1.5" />
    <rect x="8.5" y="2" width="7" height="4.5" rx="1.4" />
  </svg>
);

// Full-colour Carbon app badge (the layered-clipboard illustration) rendered
// twice inside one SVG: a dark-theme variant and a light-theme variant. CSS
// shows exactly one via the html[data-theme] attribute, so the sidebar mark
// swaps automatically whenever the user switches theme — no React state or
// props needed. Gradient ids are namespaced to avoid colliding with any other
// inline SVGs in the document.
export const BrandBadgeIcon: React.FC<{ className?: string }> = ({ className = 'icon' }) => (
  <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="carbon-badge-bg-light" x1="32" y1="2" x2="32" y2="62" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#FFFFFF" />
        <stop offset="1" stopColor="#E9EBF1" />
      </linearGradient>
      <linearGradient id="carbon-badge-plate-dark" x1="36" y1="13" x2="36" y2="53" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#F3F3F8" />
        <stop offset="1" stopColor="#C4C7D4" />
      </linearGradient>
      <linearGradient id="carbon-badge-plate-light" x1="36" y1="13" x2="36" y2="53" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#FFFFFF" />
        <stop offset="1" stopColor="#F2F3F8" />
      </linearGradient>
    </defs>

    {/* Dark-theme variant */}
    <g className="carbon-badge-dark">
      <rect x="1" y="1" width="62" height="62" rx="15" fill="#171A21" />
      <rect x="1.75" y="1.75" width="60.5" height="60.5" rx="14.25" stroke="#2B303C" strokeWidth="1.5" />
      <g transform="rotate(-9 26 38)">
        <rect x="12.5" y="17" width="27" height="38" rx="6.5" fill="#333947" />
      </g>
      <g transform="rotate(3 37 35)">
        <rect x="28.5" y="8" width="15.5" height="10" rx="4" fill="#474D5C" />
        <rect x="22.5" y="13" width="28.5" height="40" rx="6.5" fill="url(#carbon-badge-plate-dark)" />
        <rect x="30" y="23" width="13.5" height="3.6" rx="1.8" fill="#343945" />
        <rect x="30" y="30.6" width="13.5" height="3.6" rx="1.8" fill="#343945" />
        <rect x="30" y="38.2" width="8.5" height="3.6" rx="1.8" fill="#343945" />
      </g>
    </g>

    {/* Light-theme variant */}
    <g className="carbon-badge-light">
      <rect x="1" y="1" width="62" height="62" rx="15" fill="url(#carbon-badge-bg-light)" />
      <rect x="1.75" y="1.75" width="60.5" height="60.5" rx="14.25" stroke="#DFE2EA" strokeWidth="1.5" />
      <g transform="rotate(-9 26 38)">
        <rect x="12.5" y="17" width="27" height="38" rx="6.5" fill="#C2C6D5" />
      </g>
      <g transform="rotate(3 37 35)">
        <rect x="28.5" y="8" width="15.5" height="10" rx="4" fill="#6E7686" />
        <rect x="22.5" y="13" width="28.5" height="40" rx="6.5" fill="url(#carbon-badge-plate-light)" stroke="#E3E5EE" strokeWidth="1" />
        <rect x="30" y="23" width="13.5" height="3.6" rx="1.8" fill="#DCDFE8" />
        <rect x="30" y="30.6" width="13.5" height="3.6" rx="1.8" fill="#DCDFE8" />
        <rect x="30" y="38.2" width="8.5" height="3.6" rx="1.8" fill="#DCDFE8" />
      </g>
    </g>
  </svg>
);
