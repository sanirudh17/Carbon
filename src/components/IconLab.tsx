import React, { useState, useEffect } from 'react';
import {
  Type,
  Code,
  FileText,
  Image as LucideImage,
  File as LucideFile,
  Link as LucideLink,
  Mail,
  Palette,
  Video,
  Search,
  Clock,
  Star,
  Pin,
  Copy,
  ClipboardPaste,
  Trash2,
  Settings,
  Folder,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  ListOrdered,
  GripVertical,
  Plus,
  Pencil,
  MoreHorizontal,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  Check,
  SunMoon,
  AlertTriangle,
  ScanText,
  Scissors,
  Calendar,
  AtSign,
  Hash,
  Zap,
  Quote,
  Key,
  Sliders,
} from 'lucide-react';

import {
  TextT as PhText,
  Code as PhCode,
  Article as PhArticle,
  Image as PhImage,
  File as PhFile,
  Link as PhLink,
  EnvelopeSimple as PhMail,
  Palette as PhPalette,
  VideoCamera as PhVideo,
  MagnifyingGlass as PhSearch,
  Clock as PhClock,
  Star as PhStar,
  PushPin as PhPin,
  Copy as PhCopy,
  ClipboardText as PhPaste,
  Trash as PhTrash,
  Gear as PhSettings,
  Folder as PhFolder,
  Lock as PhLock,
  LockOpen as PhUnlock,
  Eye as PhEye,
  EyeSlash as PhEyeOff,
  Queue as PhQueue,
  DotsSixVertical as PhDarg,
  Plus as PhPlus,
  PencilSimple as PhPencil,
  DotsThree as PhMore,
  CaretRight as PhChevronRight,
  CaretLeft as PhChevronLeft,
  CaretDown as PhChevronDown,
  Check as PhCheck,
  SunDim as PhSunMoon,
  Warning as PhAlert,
  Scan as PhScan,
  Scissors as PhScissors,
  Calendar as PhCalendar,
  At as PhAt,
  Hash as PhHash,
  Lightning as PhZap,
  Quotes as PhQuote,
  Key as PhKey,
  Sliders as PhSliders,
} from '@phosphor-icons/react';

import { HugeiconsIcon } from '@hugeicons/react';
import {
  TextIcon,
  CodeIcon,
  File01Icon,
  Image01Icon,
  Link01Icon,
  Mail01Icon,
  PaintBoardIcon,
  Video01Icon,
  Search01Icon,
  Clock01Icon,
  StarIcon,
  PinIcon,
  Copy01Icon,
  ClipboardIcon,
  Delete02Icon,
  Settings01Icon,
  Folder01Icon,
  LockIcon,
  LockOpenIcon,
  ViewIcon,
  ViewOffIcon,
  Queue01Icon,
  DragDropVerticalIcon,
  PlusSignIcon,
  PencilEdit02Icon,
  MoreHorizontalIcon,
  ArrowRight01Icon,
  ArrowLeft01Icon,
  ArrowDown01Icon,
  CheckIcon,
  Sun01Icon,
  Alert02Icon,
  ScanTextIcon,
  ScissorIcon,
  Calendar01Icon,
  AtIcon,
  Tag01Icon,
  FlashIcon,
  QuoteUpIcon,
  Key01Icon,
  SlidersHorizontalIcon,
} from '@hugeicons/core-free-icons';

export interface ShootoutItem {
  id: string;
  name: string;
  category: string;
  lucide: React.ReactNode;
  huge: React.ReactNode;
  phosphor: React.ReactNode;
  notes: string;
}

export const IconLab: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [size, setSize] = useState<'all' | '16' | '20' | '24'>('20');
  const [showTile, setShowTile] = useState(true);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  });

  const toggleLabTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (next === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items: ShootoutItem[] = [
    {
      id: 'content-text',
      name: 'Text Content',
      category: 'Content Types',
      lucide: <Type />,
      huge: <HugeiconsIcon icon={TextIcon} />,
      phosphor: <PhText />,
      notes: 'Lucide has clean baseline serif balance at 16px',
    },
    {
      id: 'content-code',
      name: 'Code Content',
      category: 'Content Types',
      lucide: <Code />,
      huge: <HugeiconsIcon icon={CodeIcon} />,
      phosphor: <PhCode />,
      notes: 'Lucide angle terminals match SF Mono code glyphs',
    },
    {
      id: 'content-rich',
      name: 'Rich Text',
      category: 'Content Types',
      lucide: <FileText />,
      huge: <HugeiconsIcon icon={File01Icon} />,
      phosphor: <PhArticle />,
      notes: 'Lucide FileText clearly depicts document with lines',
    },
    {
      id: 'content-image',
      name: 'Image Content',
      category: 'Content Types',
      lucide: <LucideImage />,
      huge: <HugeiconsIcon icon={Image01Icon} />,
      phosphor: <PhImage />,
      notes: 'Lucide mountain curve perfectly centered in 24 viewBox',
    },
    {
      id: 'content-file',
      name: 'File Content',
      category: 'Content Types',
      lucide: <LucideFile />,
      huge: <HugeiconsIcon icon={File01Icon} />,
      phosphor: <PhFile />,
      notes: 'Dog-ear fold crisp across all scales',
    },
    {
      id: 'content-link',
      name: 'Link Content',
      category: 'Content Types',
      lucide: <LucideLink />,
      huge: <HugeiconsIcon icon={Link01Icon} />,
      phosphor: <PhLink />,
      notes: '45-degree angle stroke balanced at 16px',
    },
    {
      id: 'content-email',
      name: 'Email Content',
      category: 'Content Types',
      lucide: <Mail />,
      huge: <HugeiconsIcon icon={Mail01Icon} />,
      phosphor: <PhMail />,
      notes: 'Envelope flap tip aligns with optical center',
    },
    {
      id: 'content-color',
      name: 'Color Content',
      category: 'Content Types',
      lucide: <Palette />,
      huge: <HugeiconsIcon icon={PaintBoardIcon} />,
      phosphor: <PhPalette />,
      notes: 'Thumb hole + 3 wells scale without noise',
    },
    {
      id: 'content-video',
      name: 'Video Content',
      category: 'Content Types',
      lucide: <Video />,
      huge: <HugeiconsIcon icon={Video01Icon} />,
      phosphor: <PhVideo />,
      notes: 'Camera body + lens taper balanced',
    },
    {
      id: 'ui-search',
      name: 'Search Bar',
      category: 'Navigation',
      lucide: <Search />,
      huge: <HugeiconsIcon icon={Search01Icon} />,
      phosphor: <PhSearch />,
      notes: 'Handle rounded terminal matches Raycast',
    },
    {
      id: 'ui-all',
      name: 'All History',
      category: 'Navigation',
      lucide: <Clock />,
      huge: <HugeiconsIcon icon={Clock01Icon} />,
      phosphor: <PhClock />,
      notes: 'Clean 90-degree hands',
    },
    {
      id: 'ui-favorite',
      name: 'Favorite / Star',
      category: 'Actions',
      lucide: <Star />,
      huge: <HugeiconsIcon icon={StarIcon} />,
      phosphor: <PhStar />,
      notes: 'Consistent 5-point symmetry',
    },
    {
      id: 'ui-pin',
      name: 'Pin',
      category: 'Actions',
      lucide: <Pin />,
      huge: <HugeiconsIcon icon={PinIcon} />,
      phosphor: <PhPin />,
      notes: 'Sharp pushpin point',
    },
    {
      id: 'ui-copy',
      name: 'Copy',
      category: 'Actions',
      lucide: <Copy />,
      huge: <HugeiconsIcon icon={Copy01Icon} />,
      phosphor: <PhCopy />,
      notes: 'Offset rectangles maintain optical gap at 16px',
    },
    {
      id: 'ui-paste',
      name: 'Paste',
      category: 'Actions',
      lucide: <ClipboardPaste />,
      huge: <HugeiconsIcon icon={ClipboardIcon} />,
      phosphor: <PhPaste />,
      notes: 'Clipboard board + paste arrow clearly legible',
    },
    {
      id: 'ui-delete',
      name: 'Delete',
      category: 'Actions',
      lucide: <Trash2 />,
      huge: <HugeiconsIcon icon={Delete02Icon} />,
      phosphor: <PhTrash />,
      notes: 'Can rim + vertical slots distinct',
    },
    {
      id: 'ui-settings',
      name: 'Settings',
      category: 'Navigation',
      lucide: <Settings />,
      huge: <HugeiconsIcon icon={Settings01Icon} />,
      phosphor: <PhSettings />,
      notes: '6-cog gear with open center',
    },
    {
      id: 'ui-folder',
      name: 'Folder',
      category: 'Collections',
      lucide: <Folder />,
      huge: <HugeiconsIcon icon={Folder01Icon} />,
      phosphor: <PhFolder />,
      notes: 'Tabbed folder flap rounded',
    },
    {
      id: 'ui-lock',
      name: 'Lock',
      category: 'Collections',
      lucide: <Lock />,
      huge: <HugeiconsIcon icon={LockIcon} />,
      phosphor: <PhLock />,
      notes: 'Shackle centered on body',
    },
    {
      id: 'ui-unlock',
      name: 'Unlock',
      category: 'Collections',
      lucide: <Unlock />,
      huge: <HugeiconsIcon icon={LockOpenIcon} />,
      phosphor: <PhUnlock />,
      notes: 'Open shackle angle clear',
    },
    {
      id: 'ui-eye',
      name: 'Show Sensitive',
      category: 'Privacy',
      lucide: <Eye />,
      huge: <HugeiconsIcon icon={ViewIcon} />,
      phosphor: <PhEye />,
      notes: 'Curved lids with centered iris',
    },
    {
      id: 'ui-eye-off',
      name: 'Hide Sensitive',
      category: 'Privacy',
      lucide: <EyeOff />,
      huge: <HugeiconsIcon icon={ViewOffIcon} />,
      phosphor: <PhEyeOff />,
      notes: 'Diagonal slash clean 45-degree',
    },
    {
      id: 'ui-queue',
      name: 'Queue',
      category: 'Queue',
      lucide: <ListOrdered />,
      huge: <HugeiconsIcon icon={Queue01Icon} />,
      phosphor: <PhQueue />,
      notes: 'Numbered lines denote sequential order',
    },
    {
      id: 'ui-drag',
      name: 'Drag Handle',
      category: 'Queue',
      lucide: <GripVertical />,
      huge: <HugeiconsIcon icon={DragDropVerticalIcon} />,
      phosphor: <PhDarg />,
      notes: '2x3 grid of dots aligned vertically',
    },
    {
      id: 'ui-plus',
      name: 'Plus / Add',
      category: 'Actions',
      lucide: <Plus />,
      huge: <HugeiconsIcon icon={PlusSignIcon} />,
      phosphor: <PhPlus />,
      notes: 'Perfect 4-way cross',
    },
    {
      id: 'ui-edit',
      name: 'Edit',
      category: 'Actions',
      lucide: <Pencil />,
      huge: <HugeiconsIcon icon={PencilEdit02Icon} />,
      phosphor: <PhPencil />,
      notes: 'Slanted pencil nib',
    },
    {
      id: 'ui-more',
      name: 'More / Ellipsis',
      category: 'Actions',
      lucide: <MoreHorizontal />,
      huge: <HugeiconsIcon icon={MoreHorizontalIcon} />,
      phosphor: <PhMore />,
      notes: '3 horizontal dots',
    },
    {
      id: 'ui-chevron-right',
      name: 'Chevron Right',
      category: 'Navigation',
      lucide: <ChevronRight />,
      huge: <HugeiconsIcon icon={ArrowRight01Icon} />,
      phosphor: <PhChevronRight />,
      notes: 'Consistent 90-degree corner apex',
    },
    {
      id: 'ui-chevron-left',
      name: 'Chevron Left',
      category: 'Navigation',
      lucide: <ChevronLeft />,
      huge: <HugeiconsIcon icon={ArrowLeft01Icon} />,
      phosphor: <PhChevronLeft />,
      notes: 'Mirror of chevron right',
    },
    {
      id: 'ui-chevron-down',
      name: 'Chevron Down',
      category: 'Navigation',
      lucide: <ChevronDown />,
      huge: <HugeiconsIcon icon={ArrowDown01Icon} />,
      phosphor: <PhChevronDown />,
      notes: 'Downward arrow head',
    },
    {
      id: 'ui-check',
      name: 'Checkmark',
      category: 'Feedback',
      lucide: <Check />,
      huge: <HugeiconsIcon icon={CheckIcon} />,
      phosphor: <PhCheck />,
      notes: 'Asymmetric checkmark baseline aligned',
    },
    {
      id: 'ui-sun-moon',
      name: 'Theme Toggle',
      category: 'Theme',
      lucide: <SunMoon />,
      huge: <HugeiconsIcon icon={Sun01Icon} />,
      phosphor: <PhSunMoon />,
      notes: 'Dual sun/crescent silhouette',
    },
    {
      id: 'ui-alert',
      name: 'Alert Warning',
      category: 'Feedback',
      lucide: <AlertTriangle />,
      huge: <HugeiconsIcon icon={Alert02Icon} />,
      phosphor: <PhAlert />,
      notes: 'Rounded corner equilateral triangle',
    },
    {
      id: 'ui-ocr',
      name: 'OCR Scan',
      category: 'Actions',
      lucide: <ScanText />,
      huge: <HugeiconsIcon icon={ScanTextIcon} />,
      phosphor: <PhScan />,
      notes: 'Viewfinder brackets with inner text lines',
    },
    {
      id: 'snippet-scissors',
      name: 'Snippet Scissors',
      category: 'Snippets',
      lucide: <Scissors />,
      huge: <HugeiconsIcon icon={ScissorIcon} />,
      phosphor: <PhScissors />,
      notes: 'Dual ring finger holes with blades',
    },
    {
      id: 'snippet-calendar',
      name: 'Calendar',
      category: 'Snippets',
      lucide: <Calendar />,
      huge: <HugeiconsIcon icon={Calendar01Icon} />,
      phosphor: <PhCalendar />,
      notes: 'Tear-off top binder loops',
    },
    {
      id: 'snippet-at',
      name: 'Mention At',
      category: 'Snippets',
      lucide: <AtSign />,
      huge: <HugeiconsIcon icon={AtIcon} />,
      phosphor: <PhAt />,
      notes: 'Spiral at-sign',
    },
    {
      id: 'snippet-hashtag',
      name: 'Hashtag',
      category: 'Snippets',
      lucide: <Hash />,
      huge: <HugeiconsIcon icon={Tag01Icon} />,
      phosphor: <PhHash />,
      notes: 'Waffle cross lines',
    },
    {
      id: 'snippet-bolt',
      name: 'Quick Action',
      category: 'Snippets',
      lucide: <Zap />,
      huge: <HugeiconsIcon icon={FlashIcon} />,
      phosphor: <PhZap />,
      notes: 'Lightning bolt angular shape',
    },
    {
      id: 'snippet-quote',
      name: 'Quote Variable',
      category: 'Snippets',
      lucide: <Quote />,
      huge: <HugeiconsIcon icon={QuoteUpIcon} />,
      phosphor: <PhQuote />,
      notes: 'Double apostrophe quotation mark',
    },
    {
      id: 'snippet-key',
      name: 'Key / Secret',
      category: 'Snippets',
      lucide: <Key />,
      huge: <HugeiconsIcon icon={Key01Icon} />,
      phosphor: <PhKey />,
      notes: 'Skeleton key bow and bitting',
    },
    {
      id: 'snippet-gear',
      name: 'Config Variable',
      category: 'Snippets',
      lucide: <Sliders />,
      huge: <HugeiconsIcon icon={SlidersHorizontalIcon} />,
      phosphor: <PhSliders />,
      notes: 'Equalizer slider handles',
    },
  ];

  const renderGlyph = (node: React.ReactNode, px: number) => {
    const tileStyle: React.CSSProperties = showTile
      ? {
          width: 36,
          height: 36,
          borderRadius: 10,
          background: theme === 'dark' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
        }
      : {
          width: 36,
          height: 36,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
        };

    const glyphBoxStyle: React.CSSProperties = {
      width: px,
      height: px,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'currentColor',
      opacity: theme === 'dark' ? 0.72 : 0.66,
    };

    return (
      <div style={tileStyle}>
        <div style={glyphBoxStyle}>
          {React.isValidElement(node)
            ? React.cloneElement(node as React.ReactElement<{ size?: number; width?: number; height?: number }>, {
                size: px,
                width: px,
                height: px,
              })
            : node}
        </div>
      </div>
    );
  };

  const sizesToShow = size === 'all' ? [16, 20, 24] : [parseInt(size, 10)];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: theme === 'dark' ? '#0E1015' : '#F6F8FA',
        color: theme === 'dark' ? '#F0F2F5' : '#181B20',
        overflowY: 'auto',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '24px 32px',
        boxSizing: 'border-box',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid rgba(128, 128, 128, 0.2)',
          paddingBottom: 16,
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>Icon Lab — Shootout Evaluation</span>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                background: '#10B981',
                color: '#fff',
                fontWeight: 600,
              }}
            >
              Winner: Lucide
            </span>
          </h1>
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
            Compare candidate families against the SF-Symbols / Raycast aesthetic bar (hotkey: Ctrl+Alt+Shift+I or Esc to close)
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Theme switch */}
          <button
            onClick={toggleLabTheme}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid rgba(128, 128, 128, 0.3)',
              background: 'transparent',
              color: 'currentColor',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            Theme: {theme === 'dark' ? '🌙 Dark' : '☀️ Light'}
          </button>

          {/* Tile switch */}
          <button
            onClick={() => setShowTile(!showTile)}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid rgba(128, 128, 128, 0.3)',
              background: showTile ? 'rgba(128, 128, 128, 0.2)' : 'transparent',
              color: 'currentColor',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            Tile: {showTile ? '36px Tile' : 'Bare'}
          </button>

          {/* Size switch */}
          <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(128, 128, 128, 0.3)' }}>
            {(['16', '20', '24', 'all'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSize(s)}
                style={{
                  padding: '6px 10px',
                  border: 'none',
                  background: size === s ? 'rgba(128, 128, 128, 0.25)' : 'transparent',
                  color: 'currentColor',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: size === s ? 600 : 400,
                }}
              >
                {s === 'all' ? 'All' : `${s}px`}
              </button>
            ))}
          </div>

          {/* Close */}
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px',
              borderRadius: 8,
              border: 'none',
              background: '#3B82F6',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Done (Esc)
          </button>
        </div>
      </div>

      {/* Reference Aesthetic Bar & Shootout Scoreboard */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.2fr 1fr',
          gap: 16,
          marginBottom: 24,
        }}
      >
        {/* Aesthetic Bar Card */}
        <div
          style={{
            padding: 16,
            borderRadius: 12,
            border: '1px solid rgba(128, 128, 128, 0.2)',
            background: theme === 'dark' ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.02)',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.8 }}>
            Aesthetic Reference Bar: Tinycast + Raycast
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.6, opacity: 0.85 }}>
            • <b>SF-Symbols Voice</b>: Balanced geometric lines, rounded stroke terminals, open counters.<br />
            • <b>Footprint</b>: Quiet, calm presence without heavy fills or visual noise.<br />
            • <b>Stroke Hierarchy</b>: <code>strokeWidth: 1.8</code> default; <code>2.0 - 2.25</code> for micro action icons.<br />
            • <b>Monochrome Purity</b>: 100% currentColor with tile alpha (dark: <code>0.06</code> / light: <code>0.05</code>).
          </div>
        </div>

        {/* Scorecard Table */}
        <div
          style={{
            padding: 16,
            borderRadius: 12,
            border: '1px solid rgba(128, 128, 128, 0.2)',
            background: theme === 'dark' ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.02)',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.8 }}>
            Shootout Decision Scorecard
          </div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(128, 128, 128, 0.2)' }}>
                <th style={{ padding: '4px 8px' }}>Family</th>
                <th style={{ padding: '4px 8px' }}>Centering</th>
                <th style={{ padding: '4px 8px' }}>Terminals</th>
                <th style={{ padding: '4px 8px' }}>16px Balance</th>
                <th style={{ padding: '4px 8px' }}>Coverage</th>
                <th style={{ padding: '4px 8px', fontWeight: 700 }}>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ background: 'rgba(16, 185, 129, 0.12)', fontWeight: 600 }}>
                <td style={{ padding: '6px 8px' }}>🏆 Lucide</td>
                <td style={{ padding: '6px 8px' }}>5 / 5</td>
                <td style={{ padding: '6px 8px' }}>5 / 5</td>
                <td style={{ padding: '6px 8px' }}>5 / 5</td>
                <td style={{ padding: '6px 8px' }}>5 / 5 (0 gaps)</td>
                <td style={{ padding: '6px 8px', color: '#10B981' }}>20 / 20</td>
              </tr>
              <tr>
                <td style={{ padding: '6px 8px' }}>Huge Icons (Rounded)</td>
                <td style={{ padding: '6px 8px' }}>4 / 5</td>
                <td style={{ padding: '6px 8px' }}>5 / 5</td>
                <td style={{ padding: '6px 8px' }}>4 / 5</td>
                <td style={{ padding: '6px 8px' }}>3 / 5 (gaps)</td>
                <td style={{ padding: '6px 8px' }}>16 / 20</td>
              </tr>
              <tr>
                <td style={{ padding: '6px 8px' }}>Phosphor</td>
                <td style={{ padding: '6px 8px' }}>4 / 5</td>
                <td style={{ padding: '6px 8px' }}>4 / 5</td>
                <td style={{ padding: '6px 8px' }}>4 / 5</td>
                <td style={{ padding: '6px 8px' }}>4 / 5</td>
                <td style={{ padding: '6px 8px' }}>16 / 20</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Comparison Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '220px 1fr 1fr 1fr',
            padding: '8px 16px',
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            opacity: 0.6,
            borderBottom: '1px solid rgba(128, 128, 128, 0.2)',
          }}
        >
          <div>Manifest Usage</div>
          <div>🏆 Lucide (Approved Winner)</div>
          <div>Huge Icons (Stroke Rounded)</div>
          <div>Phosphor (Regular)</div>
        </div>

        {items.map((item) => (
          <div
            key={item.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '220px 1fr 1fr 1fr',
              alignItems: 'center',
              padding: '8px 16px',
              borderRadius: 8,
              background: theme === 'dark' ? 'rgba(255, 255, 255, 0.02)' : 'rgba(0, 0, 0, 0.015)',
              borderBottom: '1px solid rgba(128, 128, 128, 0.08)',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{item.name}</div>
              <div style={{ fontSize: 11, opacity: 0.5, fontFamily: 'monospace' }}>{item.id}</div>
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{item.notes}</div>
            </div>

            {/* Lucide */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {sizesToShow.map((px) => (
                <div key={px} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  {renderGlyph(item.lucide, px)}
                  <span style={{ fontSize: 9, opacity: 0.5 }}>{px}px</span>
                </div>
              ))}
            </div>

            {/* Huge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {sizesToShow.map((px) => (
                <div key={px} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  {renderGlyph(item.huge, px)}
                  <span style={{ fontSize: 9, opacity: 0.5 }}>{px}px</span>
                </div>
              ))}
            </div>

            {/* Phosphor */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {sizesToShow.map((px) => (
                <div key={px} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  {renderGlyph(item.phosphor, px)}
                  <span style={{ fontSize: 9, opacity: 0.5 }}>{px}px</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
