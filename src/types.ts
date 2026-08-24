export type ContentType =
  | 'text'
  | 'code'
  | 'rich_text'
  | 'image'
  | 'file'
  | 'link'
  | 'email'
  | 'color';

export interface CaptureRule {
  id: string;
  name: string;
  pattern: string;
  replacement: string;
  is_regex: boolean;
  enabled: boolean;
}

export interface ClipItem {
  id: string;
  content_type: ContentType;
  title: string;
  text_content: string | null;
  rtf_content: string | null;
  html_content: string | null;
  image_path: string | null;
  image_width: number | null;
  image_height: number | null;
  file_paths: string | null;
  is_video: boolean;
  file_size: number;
  is_pinned: boolean;
  source_app: string | null;
  created_at: string;
  updated_at: string;
  qr_content: string | null;
  is_sensitive?: boolean;
  expires_at?: string | null;
  ocr_text?: string | null;
}

export interface AppSettings {
  quick_hotkey: string;
  enlarged_hotkey: string;
  paste_plain_text: boolean;
  move_to_top_on_paste: boolean;
  start_with_windows: boolean;
  retention_days: number;
  max_entries: number;
  image_size_limit_mb: number;
  accent_color: string;
  theme: string;
  ignore_apps: string[];
  preview_enabled: boolean;
  overlay_default_tab: string;
  detect_sensitive_data: boolean;
  clip_merge_enabled: boolean;
  clip_merge_window_ms: number;
  strip_tracking_params: boolean;
  capture_rules: CaptureRule[];
  snippet_expansion_enabled: boolean;
  show_snippets: boolean;
  dismissedUpdateVersion?: string;
}

export type ExpansionStatus = 'off' | 'not_yet_active' | 'active';

export interface DbStats {
  total_items: number;
  db_size_bytes: number;
  text_count: number;
  code_count: number;
  rich_text_count: number;
  image_count: number;
  file_count: number;
  link_count: number;
  email_count: number;
  color_count: number;
  pinned_count: number;
}

export interface HotkeyStatus {
  overlay: string;
  enlarged: string;
  overlay_preferred: string;
  enlarged_preferred: string;
  overlay_conflict: boolean;
  enlarged_conflict: boolean;
}

export interface Collection {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  is_locked: boolean;
  item_count: number;
  created_at: string;
}

export interface Snippet {
  id: string;
  name: string;
  keyword: string;
  content: string;
  tags: string[];
  icon: string | null;
  use_count: number;
  last_used_at: string | null;
  show_confirmation: boolean;
  created_at: string;
  updated_at: string;
}

declare global {
  interface Window {
    __carbonDraggingClipIds?: string[] | null;
    __carbonSetData?: (data: ClipItem[]) => void;
    __carbonSetSnippets?: (data: Snippet[]) => void;
  }
}
