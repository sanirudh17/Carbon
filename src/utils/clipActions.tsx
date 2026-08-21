import React from 'react';
import { ClipItem } from '../types';
import { StarIcon, CopyIcon, PasteIcon, DeleteIcon, QueueIcon, OcrIcon, FolderIcon } from '../components/Icons';
import { invoke } from '@tauri-apps/api/core';

export interface ActionDefinition {
  id:
    | 'paste'
    | 'paste-plain'
    | 'paste-markdown'
    | 'paste-json'
    | 'paste-uppercase'
    | 'paste-lowercase'
    | 'paste-titlecase'
    | 'paste-base64-encode'
    | 'paste-base64-decode'
    | 'paste-url-encode'
    | 'paste-url-decode'
    | 'queue'
    | 'pin'
    | 'copy'
    | 'copy-ocr'
    | 'copy-qr'
    | 'add-to-collection'
    | 'remove-from-collection'
    | 'delete';
  getLabel: (item: ClipItem, targetApp?: string | null) => string;
  shortcut: string;
  iconType?: 'star' | 'copy' | 'paste' | 'delete' | 'queue' | 'ocr' | 'folder';
  danger?: boolean;
  /** Whether this action is a paste variant (shown in the clipboard dropdown). */
  isPasteAction?: boolean;
  isVisible: (item: ClipItem, handlers?: ClipActionHandlers) => boolean;
  matchesKey: (e: React.KeyboardEvent | KeyboardEvent) => boolean;
  execute: (item: ClipItem, handlers: ClipActionHandlers) => void;
}

export interface ClipActionHandlers {
  onPaste: (item: ClipItem, plainText?: boolean, transform?: string) => void;
  onTogglePin: (item: ClipItem) => void;
  onCopy: (item: ClipItem) => void;
  onDelete: (item: ClipItem) => void;
  onQueue?: (item: ClipItem) => void;
  onExtractOcr?: (item: ClipItem) => void;
  onAddToCollection?: (item: ClipItem) => void;
  onRemoveFromCollection?: (item: ClipItem) => void;
  isInCollection?: boolean;
}

export interface RenderableAction {
  id: string;
  label: string;
  shortcut: string;
  iconType?: 'star' | 'copy' | 'paste' | 'delete' | 'queue' | 'ocr' | 'folder';
  icon?: React.ReactNode;
  danger?: boolean;
  handler: () => void;
}

export const CLIP_ACTIONS: ActionDefinition[] = [
  {
    id: 'paste',
    getLabel: () => 'Paste',
    shortcut: 'Enter',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: () => true,
    matchesKey: (e) => e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey,
    execute: (item, h) => h.onPaste(item, false),
  },
  {
    id: 'queue',
    getLabel: () => 'Add to Paste Queue',
    shortcut: 'Shift+Enter',
    iconType: 'queue',
    isVisible: () => true,
    matchesKey: (e) => e.shiftKey && e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey,
    execute: (item, h) => h.onQueue?.(item),
  },
  {
    id: 'paste-plain',
    getLabel: () => 'Paste as Plain Text',
    shortcut: 'Ctrl+Enter',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: (item) => Boolean(item.text_content) || Boolean(item.html_content),
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.shiftKey && !e.altKey,
    execute: (item, h) => h.onPaste(item, true, 'plain'),
  },
  {
    id: 'paste-markdown',
    getLabel: () => 'Paste as Markdown',
    shortcut: 'Ctrl+Shift+M',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: (item) => Boolean(item.text_content) || Boolean(item.html_content),
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm',
    execute: (item, h) => h.onPaste(item, false, 'markdown'),
  },
  {
    id: 'paste-json',
    getLabel: () => 'Paste as JSON',
    shortcut: 'Ctrl+Shift+J',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: (item) => Boolean(item.text_content) && item.content_type !== 'image',
    matchesKey: (e) =>
      (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key.toLowerCase() === 'v' || e.key.toLowerCase() === 'j'),
    execute: (item, h) => h.onPaste(item, false, 'json'),
  },
  {
    id: 'paste-uppercase',
    getLabel: () => 'Paste as UPPERCASE',
    shortcut: 'Ctrl+Shift+U',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: (item) => Boolean(item.text_content) && item.content_type !== 'image',
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'u',
    execute: (item, h) => h.onPaste(item, false, 'uppercase'),
  },
  {
    id: 'paste-lowercase',
    getLabel: () => 'Paste as lowercase',
    shortcut: 'Ctrl+Shift+L',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: (item) => Boolean(item.text_content) && item.content_type !== 'image',
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l',
    execute: (item, h) => h.onPaste(item, false, 'lowercase'),
  },
  {
    id: 'paste-titlecase',
    getLabel: () => 'Paste as Title Case',
    shortcut: 'Ctrl+Shift+T',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: (item) => Boolean(item.text_content) && item.content_type !== 'image',
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't',
    execute: (item, h) => h.onPaste(item, false, 'titlecase'),
  },
  {
    id: 'paste-base64-encode',
    getLabel: () => 'Paste as Base64 Encoded',
    shortcut: 'Ctrl+Shift+E',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: (item) => Boolean(item.text_content) && item.content_type !== 'image',
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e',
    execute: (item, h) => h.onPaste(item, false, 'base64_encode'),
  },
  {
    id: 'paste-base64-decode',
    getLabel: () => 'Paste as Base64 Decoded',
    shortcut: 'Ctrl+Shift+B',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: (item) => Boolean(item.text_content) && item.content_type !== 'image',
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b',
    execute: (item, h) => h.onPaste(item, false, 'base64_decode'),
  },
  {
    id: 'paste-url-encode',
    getLabel: () => 'Paste as URL Encoded',
    shortcut: 'Ctrl+Shift+R',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: (item) => Boolean(item.text_content) && item.content_type !== 'image',
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r',
    execute: (item, h) => h.onPaste(item, false, 'url_encode'),
  },
  {
    id: 'paste-url-decode',
    getLabel: () => 'Paste as URL Decoded',
    shortcut: 'Ctrl+Shift+Y',
    iconType: 'paste',
    isPasteAction: true,
    isVisible: (item) => Boolean(item.text_content) && item.content_type !== 'image',
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'y',
    execute: (item, h) => h.onPaste(item, false, 'url_decode'),
  },
  {
    id: 'pin',
    getLabel: (item) => (item.is_pinned ? 'Remove from Favorites' : 'Add to Favorites'),
    shortcut: 'Ctrl+D',
    iconType: 'star',
    isVisible: () => true,
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'd',
    execute: (item, h) => h.onTogglePin(item),
  },
  {
    id: 'copy',
    getLabel: () => 'Copy to Clipboard',
    shortcut: 'Ctrl+C',
    iconType: 'copy',
    isVisible: () => true,
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'c',
    execute: (item, h) => h.onCopy(item),
  },
  {
    id: 'copy-ocr',
    getLabel: (item) => (item.ocr_text && item.ocr_text.trim() ? 'Copy Extracted Text (OCR)' : 'Extract Text with OCR'),
    shortcut: 'Ctrl+Shift+T',
    iconType: 'ocr',
    isVisible: (item) => item.content_type === 'image',
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't',
    execute: (item, h) => {
      if (h.onExtractOcr) {
        h.onExtractOcr(item);
      } else if (item.ocr_text && item.ocr_text.trim()) {
        navigator.clipboard.writeText(item.ocr_text).catch(console.error);
      } else {
        invoke<string>('extract_image_ocr', { id: item.id })
          .then((text) => {
            if (text) navigator.clipboard.writeText(text).catch(console.error);
          })
          .catch(console.error);
      }
    },
  },
  {
    id: 'copy-qr',
    getLabel: () => 'Copy Decoded QR Content',
    shortcut: 'Ctrl+Shift+Q',
    iconType: 'copy',
    isVisible: (item) => Boolean(item.qr_content),
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'q',
    execute: (item) => {
      if (item.qr_content) {
        navigator.clipboard.writeText(item.qr_content).catch(console.error);
      }
    },
  },
  {
    id: 'add-to-collection',
    getLabel: () => 'Add to Collection...',
    shortcut: 'Ctrl+Shift+A',
    iconType: 'folder',
    isVisible: (_, h) => Boolean(h?.onAddToCollection),
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a',
    execute: (item, h) => h.onAddToCollection?.(item),
  },
  {
    id: 'remove-from-collection',
    getLabel: () => 'Remove from Collection',
    shortcut: 'Ctrl+Shift+R',
    iconType: 'folder',
    isVisible: (_, h) => Boolean(h?.isInCollection && h?.onRemoveFromCollection),
    matchesKey: (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r',
    execute: (item, h) => h.onRemoveFromCollection?.(item),
  },
  {
    id: 'delete',
    getLabel: () => 'Delete Entry',
    shortcut: 'Del',
    iconType: 'delete',
    danger: true,
    isVisible: () => true,
    matchesKey: (e) => e.key === 'Delete' || e.key === 'Del',
    execute: (item, h) => h.onDelete(item),
  },
];

function getActionIcon(iconType?: 'star' | 'copy' | 'paste' | 'delete' | 'queue' | 'ocr' | 'folder', item?: ClipItem) {
  switch (iconType) {
    case 'star':
      return <StarIcon filled={item?.is_pinned} />;
    case 'copy':
      return <CopyIcon />;
    case 'ocr':
      return <OcrIcon />;
    case 'paste':
      return <PasteIcon />;
    case 'queue':
      return <QueueIcon />;
    case 'folder':
      return <FolderIcon />;
    case 'delete':
      return <DeleteIcon />;
    default:
      return null;
  }
}

function buildActions(
  item: ClipItem,
  targetApp: string | null | undefined,
  handlers: ClipActionHandlers,
  definitions: ActionDefinition[]
): RenderableAction[] {
  return definitions.filter((act) => act.isVisible(item, handlers)).map((act) => ({
    id: act.id,
    label: act.getLabel(item, targetApp),
    shortcut: act.shortcut,
    iconType: act.iconType,
    icon: getActionIcon(act.iconType, item),
    danger: act.danger,
    handler: () => act.execute(item, handlers),
  }));
}

const MAIN_ACTION_IDS = new Set([
  'paste',
  'queue',
  'paste-plain',
  'paste-markdown',
  'paste-json',
  'copy',
  'copy-ocr',
  'copy-qr',
  'add-to-collection',
  'remove-from-collection',
  'pin',
  'delete',
]);

/**
 * Returns the list of actions (Ctrl+K modal).
 * When quickOverlayOnly is true, limits to the 7 main options to prevent overlay clutter.
 */
export function getActionsForClip(
  item: ClipItem,
  targetApp: string | null | undefined,
  handlers: ClipActionHandlers,
  quickOverlayOnly: boolean = false
): RenderableAction[] {
  const defs = quickOverlayOnly
    ? CLIP_ACTIONS.filter((a) => MAIN_ACTION_IDS.has(a.id))
    : CLIP_ACTIONS;
  return buildActions(item, targetApp, handlers, defs);
}

/**
 * Returns only paste-variant actions (clipboard icon dropdown in the preview header).
 * Pin / Copy / Delete already have their own dedicated icon buttons in the header,
 * so they don't belong in the clipboard dropdown.
 */
export function getPasteActionsForClip(
  item: ClipItem,
  targetApp: string | null | undefined,
  handlers: ClipActionHandlers
): RenderableAction[] {
  return buildActions(item, targetApp, handlers, CLIP_ACTIONS.filter((a) => a.isPasteAction));
}

/**
 * Handles keyboard shortcuts for clip actions.
 * Returns true if an action was handled (caller should stop further processing).
 */
export function handleClipKeyDown(
  e: React.KeyboardEvent | KeyboardEvent,
  item: ClipItem,
  handlers: ClipActionHandlers
): boolean {
  for (const act of CLIP_ACTIONS) {
    if (act.isVisible(item) && act.matchesKey(e)) {
      e.preventDefault();
      act.execute(item, handlers);
      return true;
    }
  }

  return false;
}
