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

const ACCENT_SWATCHES = [
  { name: 'Periwinkle', color: '#5B7CFA' },
  { name: 'Sky', color: '#0EA5E9' },
  { name: 'Sapphire', color: '#3B82F6' },
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

  // Key recorder: while recording, capture the next non-modifier key press
  // together with its modifiers and commit it as the new hotkey.
  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const key = e.key;
      if (key === 'Escape') {
        setRecording(null);
        setDraftCombo('');
        return;
      }
      if (key === 'Backspace') {
        setDraftCombo('');
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
        return; // wait for the actual key
      }

      const mods: string[] = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.shiftKey) mods.push('Shift');
      if (e.altKey) mods.push('Alt');
      if (e.metaKey) mods.push('Win');

      const keyLabel = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
      if (mods.length === 0) {
        setDraftCombo(keyLabel); // show, but don't commit — needs a modifier
        return;
      }

      const combo = [...mods, keyLabel].join('+');
      setRecording(null);
      setDraftCombo('');
      updateSetting(recording === 'quick' ? 'quick_hotkey' : 'enlarged_hotkey', combo);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording]);

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
    document.documentElement.style.setProperty('--accent', color);
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
    } catch (err) {
      console.error('Failed to auto-save setting:', err);
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
                }}
              >
                {recording === 'quick' ? draftCombo || 'Press keys…' : settings.quick_hotkey}
              </button>
            </div>
          </div>
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
                }}
              >
                {recording === 'enlarged' ? draftCombo || 'Press keys…' : settings.enlarged_hotkey}
              </button>
            </div>
          </div>
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
