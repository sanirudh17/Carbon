import React, { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AppSettings, DbStats } from '../types';
import { ChevronLeftIcon, SpinnerIcon, CheckIcon } from './Icons';

interface SettingsProps {
  onBack: () => void;
  onThemeToggle: () => void;
  currentTheme: string;
}

// Canonical form for comparing hotkey combos regardless of modifier order or
// casing: "shift+ctrl+x" and "Ctrl+Shift+X" compare equal.
const normalizeCombo = (combo: string): string => {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return parts.join('').toLowerCase();
  const key = parts[parts.length - 1].toLowerCase();
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase()).sort();
  return [...mods, key].join('+');
};

// Mirrors hotkey::HotkeyStatus on the Rust side.
interface HotkeyStatusInfo {
  overlay: string;
  enlarged: string;
  overlay_preferred: string;
  enlarged_preferred: string;
  overlay_conflict: boolean;
  enlarged_conflict: boolean;
}

// Physical-key (e.code) → display token for non-alphanumeric keys.
const CODE_KEY: Record<string, string> = {
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`',
  Space: 'Space', Tab: 'Tab', Enter: 'Enter',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

// Convert a KeyboardEvent into a Carbon combo string using e.code — the
// PHYSICAL key — rather than e.key. With Ctrl+Alt held (AltGr on many
// layouts) e.key can turn into a different character or symbol, which is why
// Ctrl+Alt combos previously failed to record; e.code is layout-independent
// and always identifies the key that was pressed. Returns null while only
// modifiers are held or the physical key isn't usable as a hotkey.
const keyEventToCombo = (e: KeyboardEvent): string | null => {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Win');

  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = code.slice(6);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (code in CODE_KEY) key = CODE_KEY[code];
  if (!key || mods.length === 0) return null;

  return [...mods, key].join('+');
};


const ACCENT_SWATCHES = [
  { name: 'Periwinkle', color: '#5B7CFA' },
  { name: 'Amethyst', color: '#8B5CF6' },
  { name: 'Lagoon', color: '#14B8A6' },
  { name: 'Emerald', color: '#10B981' },
  { name: 'Amber', color: '#F59E0B' },
  { name: 'Rose', color: '#F43F5E' },
];

export const Settings: React.FC<SettingsProps> = ({ onBack, onThemeToggle, currentTheme }) => {
  const [settings, setSettings] = useState<AppSettings>({
    quick_hotkey: 'Ctrl+Shift+X',
    enlarged_hotkey: 'Ctrl+Alt+X',
    paste_plain_text: false,
    move_to_top_on_paste: true,
    keep_window_warm: true,
    start_with_windows: true,
    retention_days: 30,
    max_entries: 5000,
    image_size_limit_mb: 20,
    accent_color: '#5B7CFA',
    theme: 'dark',
    ignore_apps: [],
    preview_enabled: true,
    overlay_default_tab: 'clips',
    detect_sensitive_data: false,
    clip_merge_enabled: false,
    clip_merge_window_ms: 2500,
    strip_tracking_params: false,
    capture_rules: [],
    snippet_expansion_enabled: false,
    show_snippets: true,
  });

  const [stats, setStats] = useState<DbStats | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);
  const [recording, setRecording] = useState<'quick' | 'enlarged' | null>(null);
  const [draftCombo, setDraftCombo] = useState('');
  const [hotkeyError, setHotkeyError] = useState<{ field: 'quick' | 'enlarged'; message: string } | null>(null);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatusInfo | null>(null);
  const [expansionStatus, setExpansionStatus] = useState<'off' | 'not_yet_active' | 'active'>('off');
  const [showExpansionConsent, setShowExpansionConsent] = useState(false);

  useEffect(() => {
    fetchSettings();
    fetchStats();
    fetchExpansionStatus();
    // No polling — status is checked on demand when Settings is opened.
    // Listen for live updates when the hook state changes.
    let unlisten: (() => void) | undefined;
    listen<string>('expansion-status-changed', (e) => {
      const v = e.payload as 'off' | 'not_yet_active' | 'active';
      if (v) setExpansionStatus(v);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const committedRef = useRef(false);

  // Key recorder: while recording, capture the next non-modifier key press
  // together with its modifiers and commit it as the new hotkey. A combo is
  // only accepted if it has at least one modifier (a bare key can't be a
  // global hotkey) and doesn't duplicate Carbon's other global hotkey.
  useEffect(() => {
    if (!recording) return;
    committedRef.current = false;

    // Suspend Carbon's own global shortcuts for the duration of the recording
    // session: registered combos are grabbed by the OS-level hook before the
    // webview sees them, so pressing e.g. the current enlarged-window combo
    // would toggle windows instead of being captured by the recorder.
    invoke('suspend_global_shortcuts').catch(() => {});

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        committedRef.current = false;
        setRecording(null);
        setDraftCombo('');
        setHotkeyError(null);
        return;
      }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        setDraftCombo('');
        setHotkeyError(null);
        return;
      }

      const mods: string[] = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Win');

      const combo = keyEventToCombo(e);
      if (!combo) {
        // Show live visual feedback while holding modifiers (e.g. "Ctrl+Alt+…")
        if (mods.length > 0) {
          setDraftCombo(mods.join('+') + '+…');
          setHotkeyError(null);
        }
        return;
      }

      // Reject bare keys with an explicit reason instead of silently waiting.
      const keyLabel = combo.split('+').pop() as string;
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setDraftCombo(keyLabel);
        setHotkeyError({
          field: recording,
          message: `"${keyLabel}" needs at least one modifier (Ctrl/Alt/Shift/Win) — a bare key can't be a global hotkey.`,
        });
        return;
      }

      // Reject duplicates of Carbon's own other global hotkey — that conflict
      // is internal, so Carbon catches it before even trying to register.
      const other = recording === 'quick' ? settings.enlarged_hotkey : settings.quick_hotkey;
      const otherName = recording === 'quick' ? 'Enlarged Window' : 'Quick Overlay';
      if (other && normalizeCombo(combo) === normalizeCombo(other)) {
        setDraftCombo(combo);
        setHotkeyError({
          field: recording,
          message: `“${combo}” is already the ${otherName} hotkey — pick a different combination.`,
        });
        return;
      }

      committedRef.current = true;
      setHotkeyError(null);
      setRecording(null);
      setDraftCombo('');
      updateSetting(recording === 'quick' ? 'quick_hotkey' : 'enlarged_hotkey', combo);
    };

    const onKeyUp = () => {
      // Clear or adjust modifier draft when keys are released
      setDraftCombo('');
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      // Re-arm shortcuts ONLY if recording was canceled or toggled off without
      // committing a new hotkey. When a combo was accepted, updateSetting ->
      // save_settings re-arms shortcuts with the NEW binding atomically.
      if (!committedRef.current) {
        invoke('resume_global_shortcuts').catch(() => {});
      }
    };
  }, [recording, settings]);

  const fetchSettings = async () => {
    try {
      const res = await invoke<AppSettings>('get_settings');
      if (res) {
        setSettings(res);
        applyAccentColor(res.accent_color);
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await invoke<DbStats>('get_stats');
      setStats(res);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  };

  const fetchExpansionStatus = async () => {
    try {
      const st = await invoke<string>('get_expansion_status');
      if (st === 'active' || st === 'not_yet_active' || st === 'off') {
        setExpansionStatus(st as 'off' | 'not_yet_active' | 'active');
      }
    } catch (err) {
      console.error('Failed to fetch expansion status:', err);
    }
  };

  const handleToggleExpansion = async (next: boolean) => {
    if (next) {
      setShowExpansionConsent(true);
      return;
    }
    setSettings((prev) => ({ ...prev, snippet_expansion_enabled: false }));
    setExpansionStatus('off');
    try {
      const st = await invoke<string>('set_snippet_expansion_enabled', { enabled: false });
      if (st) setExpansionStatus(st as 'off' | 'not_yet_active' | 'active');
    } catch (err) {
      console.error('Failed to disable expansion:', err);
    }
  };

  const confirmEnableExpansion = async () => {
    setShowExpansionConsent(false);
    setSettings((prev) => ({ ...prev, snippet_expansion_enabled: true }));
    setExpansionStatus('active');
    try {
      const st = await invoke<string>('set_snippet_expansion_enabled', { enabled: true });
      if (st) setExpansionStatus(st as 'off' | 'not_yet_active' | 'active');
    } catch (err) {
      console.error('Failed to enable expansion:', err);
    }
  };

  const handleToggleShowSnippets = async (next: boolean) => {
    try {
      await invoke('set_show_snippets', { enabled: next });
      setSettings((prev) => ({ ...prev, show_snippets: next }));
    } catch (err) {
      console.error('Failed to toggle show_snippets:', err);
    }
  };

  const applyAccentColor = (color: string) => {
    document.documentElement.style.setProperty('--accent-base', color);
  };

  const handleSave = async () => {
    try {
      await invoke('save_settings', { newSettings: settings });
      applyAccentColor(settings.accent_color);
      setSavedMessage(true);
      setTimeout(() => setSavedMessage(false), 2000);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  };

  const updateSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);

    if (key === 'accent_color') {
      applyAccentColor(value as string);
    }

    try {
      await invoke('save_settings', { newSettings: updated });
      if (key === 'quick_hotkey' || key === 'enlarged_hotkey') {
        setHotkeyError(null);
      }
    } catch (err) {
      console.error('Failed to auto-save setting:', err);
      if (key === 'quick_hotkey' || key === 'enlarged_hotkey') {
        setHotkeyError({
          field: key === 'quick_hotkey' ? 'quick' : 'enlarged',
          message: String(err),
        });
      }
      fetchSettings();
    }
  };

  const handleClearHistory = async () => {
    if (window.confirm('Are you sure you want to clear all unpinned clipboard items?')) {
      try {
        await invoke('clear_history');
        fetchStats();
      } catch (err) {
        console.error('Failed to clear history:', err);
      }
    }
  };

  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = (type: 'success' | 'error' | 'info', message: string, duration = 4000) => {
    setToast({ type, message });
    setTimeout(() => {
      setToast((curr) => (curr?.message === message ? null : curr));
    }, duration);
  };

  // Mirror the backend shortcut manager's registration status: after every
  // settings save it swaps both global shortcuts atomically and emits the
  // result. A conflict flag means Windows refused the preferred combo because
  // another app genuinely holds it — Carbon kept the previous binding, and we
  // surface that clearly instead of pretending the rebind succeeded.
  useEffect(() => {
    invoke<HotkeyStatusInfo | null>('get_hotkey_status')
      .then((s) => {
        if (s) setHotkeyStatus(s);
      })
      .catch(() => {});
    let unlistenStatus: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    listen<HotkeyStatusInfo>('hotkey-status', (e) => setHotkeyStatus(e.payload)).then((fn) => {
      unlistenStatus = fn;
    });
    listen<string>('hotkey-error', (e) => showToast('error', e.payload, 8000)).then((fn) => {
      unlistenError = fn;
    });
    return () => {
      unlistenStatus?.();
      unlistenError?.();
    };
  }, []);

  const handleExportBackup = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const jsonStr = await invoke<string>('export_backup_json');
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `carbon-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('success', 'Backup exported successfully.');
    } catch (err) {
      console.error('Failed to export backup:', err);
      showToast('error', 'Export failed: ' + String(err));
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isImporting) return;

    setIsImporting(true);
    try {
      const text = await file.text();
      const res = await invoke<{ imported_count: number; total_in_file: number }>('import_backup_json', {
        jsonData: text,
      });
      fetchStats();
      showToast('success', `Restored and merged ${res.imported_count} items into history.`);
    } catch (err) {
      console.error('Failed to restore backup:', err);
      showToast('error', 'Restore failed: ' + String(err));
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const currentSwatchName = ACCENT_SWATCHES.find((s) => s.color === settings.accent_color)?.name || 'Custom';

  return (
    <div className="settings">
      <div className="settings-head">
        <button className="btn subtle icon-btn" title="Back" onClick={onBack}>
          <ChevronLeftIcon />
        </button>
        <h2>Settings</h2>
        {savedMessage && <span style={{ fontSize: 11.5, color: 'var(--accent-text)' }}>Saved!</span>}
        <button className="btn accent" onClick={handleSave}>
          Save
        </button>
      </div>

      <div className="settings-body">
        {/* Shortcuts */}
        <section>
          <div className="sec-title">Shortcuts</div>
          <div className="hotkey-guide">
            <div className="hotkey-guide-title">How to change a shortcut</div>
            <ol>
              <li>Click a key chip, then press the key combination you want.</li>
              <li>
                Every shortcut needs <kbd>Ctrl</kbd>, <kbd>Alt</kbd>, or <kbd>Win</kbd> plus one more key (
                <kbd>Shift</kbd> is optional). Letters, numbers and F-keys all work.
              </li>
              <li>
                Press <kbd>Esc</kbd> to cancel, or <kbd>Backspace</kbd> to start over.
              </li>
            </ol>
            <p>
              Changes apply instantly and survive restarts. If another app already owns the combo you picked, Carbon
              keeps your previous shortcut and tells you right here.
            </p>
          </div>
          <div className="set-row">
            <div className="set-label">
              Quick paste hotkey
              <div className="set-hint">Opens the overlay anywhere. Click the key to change it.</div>
            </div>
            <div className="set-control hotkey-control">
              <button
                className={`hotkey-chip ${recording === 'quick' ? 'recording' : ''}`}
                onClick={() => {
                  setRecording(recording === 'quick' ? null : 'quick');
                  setDraftCombo('');
                  setHotkeyError(null);
                }}
              >
                {recording === 'quick' ? draftCombo || 'Press keys…' : settings.quick_hotkey}
              </button>
            </div>
          </div>
          {hotkeyError?.field === 'quick' && (
            <div className="hotkey-error" role="alert">
              {hotkeyError.message}
            </div>
          )}
          <div className="set-row">
            <div className="set-label">
              Enlarged window hotkey
              <div className="set-hint">Opens full library and settings. Click the key to change it.</div>
            </div>
            <div className="set-control hotkey-control">
              <button
                className={`hotkey-chip ${recording === 'enlarged' ? 'recording' : ''}`}
                onClick={() => {
                  setRecording(recording === 'enlarged' ? null : 'enlarged');
                  setDraftCombo('');
                  setHotkeyError(null);
                }}
              >
                {recording === 'enlarged' ? draftCombo || 'Press keys…' : settings.enlarged_hotkey}
              </button>
            </div>
          </div>
          {hotkeyError?.field === 'enlarged' && (
            <div className="hotkey-error" role="alert">
              {hotkeyError.message}
            </div>
          )}
          {(hotkeyStatus?.overlay_conflict || hotkeyStatus?.enlarged_conflict) && (
            <div className="hotkey-conflict-note">
              {hotkeyStatus.overlay_conflict && (
                <div>
                  Windows couldn’t register “{hotkeyStatus.overlay_preferred}” for the Quick Overlay — another
                  application owns it, so Carbon kept “{hotkeyStatus.overlay}”. Record a different combination
                  above and the new one applies instantly.
                </div>
              )}
              {hotkeyStatus.enlarged_conflict && (
                <div>
                  Windows couldn’t register “{hotkeyStatus.enlarged_preferred}” for the Enlarged Window — another
                  application owns it, so Carbon kept “{hotkeyStatus.enlarged}”. Record a different combination
                  above and the new one applies instantly.
                </div>
              )}
            </div>
          )}
        </section>

        {/* Behavior */}
        <section>
          <div className="sec-title">Behavior</div>
          <div className="set-row">
            <div className="set-label">
              Overlay opens on
              <div className="set-hint">Which tab the quick overlay shows first — Clips history or Snippets.</div>
            </div>
            <div className="set-control">
              <div className="seg">
                <button
                  className={`seg-btn ${settings.overlay_default_tab !== 'snippets' ? 'active' : ''}`}
                  onClick={() => {
                    setSettings((prev) => ({ ...prev, overlay_default_tab: 'clips' }));
                    invoke('set_overlay_default_tab', { tab: 'clips' }).catch(console.error);
                  }}
                >
                  Clips
                </button>
                <button
                  className={`seg-btn ${settings.overlay_default_tab === 'snippets' ? 'active' : ''}`}
                  onClick={() => {
                    setSettings((prev) => ({ ...prev, overlay_default_tab: 'snippets' }));
                    invoke('set_overlay_default_tab', { tab: 'snippets' }).catch(console.error);
                  }}
                >
                  Snippets
                </button>
              </div>
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              Keep window warm
              <div className="set-hint">Overlay stays in memory for instant summon.</div>
            </div>
            <div className="set-control">
              <button
                className={`toggle ${settings.keep_window_warm ? 'on' : ''}`}
                onClick={() => updateSetting('keep_window_warm', !settings.keep_window_warm)}
              >
                <span className="knob" />
              </button>
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              Start with Windows
              <div className="set-hint">Runs quietly in the tray on login</div>
            </div>
            <div className="set-control">
              <button
                className={`toggle ${settings.start_with_windows ? 'on' : ''}`}
                onClick={() => updateSetting('start_with_windows', !settings.start_with_windows)}
              >
                <span className="knob" />
              </button>
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              ClipMerge (append on repeat copy)
              <div className="set-hint">
                Copying text repeatedly within a short window appends to the top clip rather than creating separate entries.
              </div>
            </div>
            <div className="set-control">
              <button
                className={`toggle ${settings.clip_merge_enabled ? 'on' : ''}`}
                onClick={() => updateSetting('clip_merge_enabled', !settings.clip_merge_enabled)}
              >
                <span className="knob" />
              </button>
            </div>
          </div>

          {settings.clip_merge_enabled && (
            <div className="set-row">
              <div className="set-label">
                ClipMerge window
                <div className="set-hint">Time window to detect rapid successive copies</div>
              </div>
              <div className="set-control">
                <input
                  className="num"
                  type="number"
                  min={500}
                  max={10000}
                  step={250}
                  value={settings.clip_merge_window_ms || 2500}
                  onChange={(e) => updateSetting('clip_merge_window_ms', Math.max(500, parseInt(e.target.value) || 2500))}
                />
                <span className="unit">ms</span>
              </div>
            </div>
          )}
        </section>

        {/* Snippets — System-wide keyword expansion */}
        <section>
          <div className="sec-title">Snippets</div>
          <div className="set-row">
            <div className="set-label">
              Enable snippet expansion
              <div className="set-hint">
                Type keywords anywhere (e.g. <code>/select</code>) to expand snippets inline. Dynamic placeholders like <code>{'{date}'}</code> and <code>{'{clipboard}'}</code> evaluate in real time.
              </div>
            </div>
            <div className="set-control" style={{ gap: 8, alignItems: 'center' }}>
              {settings.snippet_expansion_enabled && (
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {expansionStatus === 'active' ? 'Active' : 'Starting…'}
                </span>
              )}
              <button
                className={`toggle ${settings.snippet_expansion_enabled ? 'on' : ''}`}
                onClick={() => handleToggleExpansion(!settings.snippet_expansion_enabled)}
              >
                <span className="knob" />
              </button>
            </div>
          </div>
          <div className="set-row">
            <div className="set-label">
              Show snippets in library &amp; overlay
              <div className="set-hint">
                Controls visibility of the Snippets section in the overlay and library.
              </div>
            </div>
            <div className="set-control">
              <button
                className={`toggle ${settings.show_snippets ? 'on' : ''}`}
                onClick={() => handleToggleShowSnippets(!settings.show_snippets)}
              >
                <span className="knob" />
              </button>
            </div>
          </div>
        </section>

        {/* Capture Rules */}
        <section>
          <div className="sec-title">Capture Rules & Sanitization</div>
          <div className="set-row">
            <div className="set-label">
              Strip URL tracking parameters
              <div className="set-hint">
                Auto-strips analytics tags (<code>utm_source</code>, <code>fbclid</code>, <code>gclid</code>, <code>igshid</code>, etc.) from copied URLs.
              </div>
            </div>
            <div className="set-control">
              <button
                className={`toggle ${settings.strip_tracking_params ? 'on' : ''}`}
                onClick={() => updateSetting('strip_tracking_params', !settings.strip_tracking_params)}
              >
                <span className="knob" />
              </button>
            </div>
          </div>

          <div className="capture-rules-box">
            <div className="capture-rules-header">
              <span className="capture-rules-title">Custom Find & Replace Rules</span>
              <button
                className="btn subtle"
                style={{ fontSize: 11, padding: '4px 10px', height: 26 }}
                onClick={() => {
                  const newRule = {
                    id: String(Date.now()),
                    name: `Rule ${(settings.capture_rules || []).length + 1}`,
                    pattern: '',
                    replacement: '',
                    is_regex: false,
                    enabled: true,
                  };
                  updateSetting('capture_rules', [...(settings.capture_rules || []), newRule]);
                }}
              >
                + Add Rule
              </button>
            </div>

            {(settings.capture_rules || []).length === 0 ? (
              <div className="capture-rules-empty">
                No custom capture rules defined. Click <b>+ Add Rule</b> to auto-clean or transform copied text the moment it is captured.
              </div>
            ) : (
              <div className="capture-rules-list">
                {settings.capture_rules.map((rule, idx) => (
                  <div key={rule.id || idx} className="capture-rule-card">
                    <div className="capture-rule-top">
                      <input
                        type="text"
                        className="capture-rule-name-input"
                        placeholder="Rule name"
                        value={rule.name}
                        onChange={(e) => {
                          const updated = [...settings.capture_rules];
                          updated[idx] = { ...updated[idx], name: e.target.value };
                          updateSetting('capture_rules', updated);
                        }}
                      />
                      <div className="capture-rule-top-right">
                        <label className="capture-rule-regex-label">
                          <input
                            type="checkbox"
                            checked={rule.is_regex}
                            onChange={(e) => {
                              const updated = [...settings.capture_rules];
                              updated[idx] = { ...updated[idx], is_regex: e.target.checked };
                              updateSetting('capture_rules', updated);
                            }}
                          />
                          Regex
                        </label>
                        <button
                          className={`toggle ${rule.enabled ? 'on' : ''}`}
                          style={{ transform: 'scale(0.85)', margin: 0 }}
                          onClick={() => {
                            const updated = [...settings.capture_rules];
                            updated[idx] = { ...updated[idx], enabled: !updated[idx].enabled };
                            updateSetting('capture_rules', updated);
                          }}
                        >
                          <span className="knob" />
                        </button>
                        <button
                          className="capture-rule-delete-btn"
                          title="Delete rule"
                          onClick={() => {
                            const updated = settings.capture_rules.filter((_, i) => i !== idx);
                            updateSetting('capture_rules', updated);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    <div className="capture-rule-fields">
                      <div className="capture-rule-field">
                        <span className="capture-rule-field-label">
                          {rule.is_regex ? 'Pattern (Regex)' : 'Find text'}
                        </span>
                        <input
                          type="text"
                          className="capture-rule-field-input"
                          placeholder={rule.is_regex ? 'e.g. \\s+$' : 'e.g. old_prefix_'}
                          value={rule.pattern}
                          onChange={(e) => {
                            const updated = [...settings.capture_rules];
                            updated[idx] = { ...updated[idx], pattern: e.target.value };
                            updateSetting('capture_rules', updated);
                          }}
                        />
                      </div>
                      <div className="capture-rule-field">
                        <span className="capture-rule-field-label">Replace with</span>
                        <input
                          type="text"
                          className="capture-rule-field-input"
                          placeholder="e.g. new_prefix_"
                          value={rule.replacement}
                          onChange={(e) => {
                            const updated = [...settings.capture_rules];
                            updated[idx] = { ...updated[idx], replacement: e.target.value };
                            updateSetting('capture_rules', updated);
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Privacy */}
        <section>
          <div className="sec-title">Privacy</div>
          <div className="set-row">
            <div className="set-label">
              Detect and auto-expire sensitive clips
              <div className="set-hint">
                Auto-masks credit cards, API keys, JWTs, and private keys on capture, and wipes them after a short timer. Opt-in local convenience, not an enterprise DLP guarantee.
              </div>
            </div>
            <div className="set-control">
              <button
                className={`toggle ${settings.detect_sensitive_data ? 'on' : ''}`}
                onClick={() => updateSetting('detect_sensitive_data', !settings.detect_sensitive_data)}
              >
                <span className="knob" />
              </button>
            </div>
          </div>
        </section>

        {/* Storage */}
        <section>
          <div className="sec-title">Storage</div>
          <div className="set-row">
            <div className="set-label">
              Retention
              <div className="set-hint">Entries older than this are deleted (0 = keep forever)</div>
            </div>
            <div className="set-control">
              <input
                className="num"
                type="number"
                value={settings.retention_days}
                onChange={(e) => updateSetting('retention_days', parseInt(e.target.value) || 0)}
              />
              <span className="unit">days</span>
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              Max entries
              <div className="set-hint">Oldest non-pinned entries are trimmed beyond this</div>
            </div>
            <div className="set-control">
              <input
                className="num"
                type="number"
                value={settings.max_entries}
                onChange={(e) => updateSetting('max_entries', parseInt(e.target.value) || 0)}
              />
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              Image size limit
              <div className="set-hint">Copies larger than this are skipped</div>
            </div>
            <div className="set-control">
              <input
                className="num"
                type="number"
                value={settings.image_size_limit_mb}
                onChange={(e) => updateSetting('image_size_limit_mb', parseInt(e.target.value) || 1)}
              />
              <span className="unit">MB</span>
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              Current usage
              <div className="set-hint">Local SQLite, WAL mode — everything stays on this machine</div>
            </div>
            <div className="set-control">
              <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
                {stats ? `${formatBytes(stats.db_size_bytes)} · ${stats.total_items} items` : 'Loading...'}
              </span>
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              Clear history
              <div className="set-hint">Deletes all non-pinned entries</div>
            </div>
            <div className="set-control">
              <button className="btn danger" onClick={handleClearHistory}>
                Clear
              </button>
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              Export backup
              <div className="set-hint">Download a local JSON backup of your history and images</div>
            </div>
            <div className="set-control">
              <button
                className="btn subtle"
                onClick={handleExportBackup}
                disabled={isExporting}
                style={{ opacity: isExporting ? 0.75 : 1 }}
              >
                {isExporting ? (
                  <>
                    <SpinnerIcon />
                    <span>Exporting…</span>
                  </>
                ) : (
                  <span>Export backup (.json)</span>
                )}
              </button>
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              Restore from backup
              <div className="set-hint">Merge entries from a previous Carbon backup into history</div>
            </div>
            <div className="set-control">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.carbon"
                style={{ display: 'none' }}
                onChange={handleImportFileSelected}
              />
              <button
                className="btn subtle"
                onClick={() => fileInputRef.current?.click()}
                disabled={isImporting}
                style={{ opacity: isImporting ? 0.75 : 1 }}
              >
                {isImporting ? (
                  <>
                    <SpinnerIcon />
                    <span>Restoring…</span>
                  </>
                ) : (
                  <span>Restore backup…</span>
                )}
              </button>
            </div>
          </div>
        </section>

        {/* Appearance */}
        <section>
          <div className="sec-title">Appearance</div>
          <div className="set-row">
            <div className="set-label">
              Accent theme
              <div className="set-hint">Currently active: {currentSwatchName}</div>
            </div>
            <div className="set-control">
              <div className="accents">
                {ACCENT_SWATCHES.map((swatch) => (
                  <button
                    key={swatch.color}
                    className={`swatch ${settings.accent_color === swatch.color ? 'on' : ''}`}
                    style={{ background: swatch.color }}
                    title={swatch.name}
                    onClick={() => updateSetting('accent_color', swatch.color)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              Theme mode
              <div className="set-hint">Dark / Light contrast preference</div>
            </div>
            <div className="set-control">
              <button
                className="btn subtle"
                onClick={() => {
                  const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
                  onThemeToggle();
                  updateSetting('theme', nextTheme);
                }}
              >
                Switch to {currentTheme === 'light' ? 'Dark' : 'Light'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {toast && (
        <div className={`settings-toast ${toast.type}`}>
          <div className="settings-toast-icon">
            {toast.type === 'success' ? <CheckIcon /> : toast.type === 'info' ? <SpinnerIcon /> : '⚠️'}
          </div>
          <div className="settings-toast-message">{toast.message}</div>
        </div>
      )}

      {showExpansionConsent && (
        <div className="modal-backdrop" onClick={() => setShowExpansionConsent(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420, width: '100%' }}>
            <div className="modal-header">
              <span className="modal-title">Enable Snippet Expansion</span>
              <button className="modal-close-btn" onClick={() => setShowExpansionConsent(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px' }}>
              <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0, color: 'var(--text-2)' }}>
                Carbon expands keywords into full snippets as you type in any application across Windows.
              </p>

              <div className="consent-bullets">
                <div className="consent-bullet">
                  <span className="consent-dot">•</span>
                  <span>Instant inline replacement at native typing speed</span>
                </div>
                <div className="consent-bullet">
                  <span className="consent-dot">•</span>
                  <span>Private in-memory buffer (256 chars) that is never written to disk</span>
                </div>
                <div className="consent-bullet">
                  <span className="consent-dot">•</span>
                  <span>Zero background CPU when idle; detaches completely when disabled</span>
                </div>
              </div>

              <div className="consent-note">
                Windows UIPI security safely disables expansion inside elevated Administrator windows.
              </div>
            </div>
            <div className="modal-footer" style={{ padding: '12px 18px' }}>
              <button className="btn subtle" onClick={() => setShowExpansionConsent(false)}>Cancel</button>
              <button className="btn primary" onClick={confirmEnableExpansion}>Enable Expansion</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};



function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
