import React, { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import type { Update } from '@tauri-apps/plugin-updater';
import { AppSettings, DbStats } from '../types';
import { ChevronLeftIcon, SpinnerIcon, CheckIcon, AlertTriangleIcon, DeleteIcon } from './Icons';

import { keyEventToCombo, normalizeCombo } from '../utils/hotkeys';

interface SettingsProps {
  onBack: () => void;
  onThemeToggle: () => void;
  currentTheme: string;
}

const DEFAULT_HOTKEYS = {
  quick_hotkey: 'Ctrl+Shift+Z',
  enlarged_hotkey: 'Ctrl+Alt+X',
};

const isDefaultHotkey = (field: 'quick_hotkey' | 'enlarged_hotkey', current: string | undefined): boolean => {
  if (!current) return false;
  return normalizeCombo(current) === normalizeCombo(DEFAULT_HOTKEYS[field]);
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
    quick_hotkey: 'Ctrl+Shift+Z',
    enlarged_hotkey: 'Ctrl+Alt+X',
    paste_plain_text: false,
    move_to_top_on_paste: true,
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
    dismissedUpdateVersion: '',
  });

  const [stats, setStats] = useState<DbStats | null>(null);
  const [recording, setRecording] = useState<'quick' | 'enlarged' | null>(null);
  const [draftCombo, setDraftCombo] = useState('');
  const [hotkeyError, setHotkeyError] = useState<{ field: 'quick' | 'enlarged'; message: string } | null>(null);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatusInfo | null>(null);
  const [expansionStatus, setExpansionStatus] = useState<'off' | 'not_yet_active' | 'active'>('off');
  const [showExpansionConsent, setShowExpansionConsent] = useState(false);

  // Updates — mirrors Typr's General → Updates: version, button, status + progress
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<string>('Carbon checks for updates when it starts.');
  const [updateBtnText, setUpdateBtnText] = useState('Check for latest updates');
  const [updateBtnDisabled, setUpdateBtnDisabled] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateProgressVisible, setUpdateProgressVisible] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

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
  const clipMergeDebounceRef = useRef<number | null>(null);
  const clipMergePendingRef = useRef<number | null>(null);
  // Serializes fire-and-forget settings saves so rapid toggle clicks persist
  // in order (see updateSetting).
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Ref mirror of settings so Tauri event listeners (registered once) always
  // see the latest hotkey values without re-subscribing on every keystroke,
  // which would otherwise drop events mid-flight and lose conflict banners.
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => {
    return () => {
      if (clipMergeDebounceRef.current) window.clearTimeout(clipMergeDebounceRef.current);
    };
  }, []);

  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  // Destructive-action confirmation (Clear history) — replaces window.confirm.
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const showToast = (type: 'success' | 'error' | 'info', message: string, duration = 4000) => {
    setToast({ type, message });
    setTimeout(() => {
      setToast((curr) => (curr?.message === message ? null : curr));
    }, duration);
  };

  // ── Updater (plugin) — on-demand check + install, banner uses same latest.json silently ──
  useEffect(() => {
    getVersion().then((v) => setAppVersion(v)).catch(() => {});
  }, []);

  const compareVersions = (a: string, b: string): number => {
    const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
    const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const av = pa[i] ?? 0;
      const bv = pb[i] ?? 0;
      if (av > bv) return 1;
      if (av < bv) return -1;
    }
    return 0;
  };

  const installUpdate = async (update: Update) => {
    setUpdateBtnDisabled(true);
    setUpdateBtnText('Downloading…');
    setUpdateProgressVisible(true);
    setUpdateProgress(0);
    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            break;
          case 'Progress':
            received += event.data.chunkLength;
            if (total > 0) setUpdateProgress(Math.min(100, (received / total) * 100));
            break;
          case 'Finished':
            setUpdateProgress(100);
            setUpdateStatus('Installing… Carbon will restart.');
            break;
        }
      });
      await relaunch();
    } catch (e) {
      setUpdateProgressVisible(false);
      setUpdateStatus(`Update failed: ${String(e)}`);
      setUpdateBtnDisabled(false);
      setUpdateBtnText('Retry');
    }
  };

  const runUpdateCheck = async (userAsked: boolean) => {
    if (pendingUpdate) {
      await installUpdate(pendingUpdate);
      return;
    }
    if (userAsked) {
      setUpdateBtnDisabled(true);
      setUpdateStatus('Checking…');
      setUpdateBtnText('Checking…');
      // Fast path — mirrors Typr/Glint perceived instantness: a lightweight
      // fetch + semver compare can confirm "latest" without waiting for the
      // full updater plugin (which also verifies signatures and prepares the
      // download). If no newer version, return immediately.
      if (appVersion) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 1200);
          const res = await fetch('https://github.com/sanirudh17/Carbon/releases/latest/download/latest.json', {
            cache: 'no-store',
            signal: ctrl.signal,
          });
          clearTimeout(t);
          if (res.ok) {
            const data = (await res.json()) as { version?: string };
            const latest = (data.version || '').replace(/^v/, '').trim();
            const current = appVersion.replace(/^v/, '').trim();
            if (latest && current && compareVersions(latest, current) <= 0) {
              setUpdateStatus('You are on the latest version.');
              setUpdateBtnText('Check for latest updates');
              setUpdateBtnDisabled(false);
              return;
            }
          }
        } catch {
          // Fall through to full check() — network hiccup, not a "latest" proof
        }
      }
    }
    try {
      const update = await check();
      if (update) {
        setPendingUpdate(update);
        setUpdateStatus(`Update available to v${update.version}.`);
        setUpdateBtnText('Download & install');
        setUpdateBtnDisabled(false);
      } else if (userAsked) {
        // Up-to-date — mirrors Typr/Glint: cross-references GitHub latest.json, shows version badge.
        setUpdateStatus('You are on the latest version.');
        setUpdateBtnText('Check for latest updates');
        setUpdateBtnDisabled(false);
      }
    } catch (e) {
      // Per product decision: a failed check (offline, 404 latest.json, remote error)
      // must never surface scary transport errors in Settings — report up-to-date.
      console.warn('[Carbon] update check failed:', e);
      if (userAsked) {
        setUpdateStatus('You are on the latest version.');
        setUpdateBtnText('Check for latest updates');
        setUpdateBtnDisabled(false);
      }
    }
  };

  // Key recorder: while recording, capture the next non-modifier key press
  // together with its modifiers and commit it as the new hotkey. Both webview
  // keydown events AND the low-level WH_KEYBOARD_LL hook are active so keystrokes
  // are captured even if an external application (like AMD/NVIDIA) holds a hotkey.
  useEffect(() => {
    if (!recording) return;
    committedRef.current = false;

    invoke('suspend_global_shortcuts').catch(() => {});
    invoke('start_recording_hotkey', { target: recording }).catch(() => {});

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        committedRef.current = false;
        invoke('stop_recording_hotkey').catch(() => {});
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

      const altGraph = (e as KeyboardEvent).getModifierState?.('AltGraph') ?? false;
      const mods: string[] = [];
      if (e.ctrlKey || altGraph) mods.push('Ctrl');
      if (e.altKey || altGraph) mods.push('Alt');
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
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && !altGraph) {
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
        const msg = `“${combo}” is already the ${otherName} hotkey — pick a different combination.`;
        setDraftCombo(combo);
        setHotkeyError({
          field: recording,
          message: msg,
        });
        showToast('error', msg, 8000);
        return;
      }

      committedRef.current = true;
      invoke('stop_recording_hotkey').catch(() => {});
      setHotkeyError(null);
      setRecording(null);
      setDraftCombo('');
      updateSetting(recording === 'quick' ? 'quick_hotkey' : 'enlarged_hotkey', combo);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      invoke('stop_recording_hotkey').catch(() => {});
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
      // Revert optimistic UI on failure
      fetchSettings();
      fetchExpansionStatus();
    }
  };

  const confirmEnableExpansion = async () => {
    setShowExpansionConsent(false);
    setSettings((prev) => ({ ...prev, snippet_expansion_enabled: true }));
    setExpansionStatus('not_yet_active');
    try {
      const st = await invoke<string>('set_snippet_expansion_enabled', { enabled: true });
      if (st) setExpansionStatus(st as 'off' | 'not_yet_active' | 'active');
    } catch (err) {
      console.error('Failed to enable expansion:', err);
      setSettings((prev) => ({ ...prev, snippet_expansion_enabled: false }));
      setExpansionStatus('off');
      showToast('error', String(err));
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

  const updateSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const updated = { ...settingsRef.current, [key]: value };
    setSettings(updated);

    if (key === 'accent_color') {
      applyAccentColor(value as string);
    }

    // Hotkeys must await the save: the backend atomically swaps both global
    // shortcuts and reports conflicts that we surface inline. Everything else
    // persists in the background so toggles flip instantly no matter how much
    // work save_settings does (trim, window close/recreate, autostart…).
    // Background saves are serialized through a promise chain so rapid
    // consecutive toggles persist in call order (last toggle always wins).
    const isHotkey = key === 'quick_hotkey' || key === 'enlarged_hotkey';
    if (!isHotkey) {
      saveQueueRef.current = saveQueueRef.current
        .then(() => invoke('save_settings', { newSettings: updated }))
        .then(() => undefined)
        .catch((err) => {
          console.error('Failed to auto-save setting:', err);
          showToast('error', `Could not save: ${String(err)}`, 6000);
        });
      return;
    }

    try {
      await invoke('save_settings', { newSettings: updated });
      setHotkeyError(null);
    } catch (err) {
      console.error('Failed to auto-save setting:', err);
      const msg = String(err);
      setHotkeyError({
        field: key === 'quick_hotkey' ? 'quick' : 'enlarged',
        message: msg,
      });
      showToast('error', msg, 8000);
      fetchSettings();
    }
  };

  const handleResetHotkey = async (field: 'quick_hotkey' | 'enlarged_hotkey') => {
    setHotkeyError(null);
    setRecording(null);
    setDraftCombo('');
    await updateSetting(field, DEFAULT_HOTKEYS[field]);
  };

  const handleClearHistory = async () => {
    setShowClearConfirm(false);
    try {
      await invoke('clear_history');
      fetchStats();
      showToast('success', 'Cleared all unpinned clipboard items.');
    } catch (err) {
      console.error('Failed to clear history:', err);
      showToast('error', 'Failed to clear history.', 6000);
    }
  };

  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const customColorRef = useRef<HTMLInputElement>(null);

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
    let unlistenRecorded: (() => void) | undefined;
    let unlistenDraft: (() => void) | undefined;
    let unlistenCancel: (() => void) | undefined;

    listen<HotkeyStatusInfo>('hotkey-status', (e) => setHotkeyStatus(e.payload)).then((fn) => {
      unlistenStatus = fn;
    });
    listen<string>('hotkey-error', (e) => showToast('error', e.payload, 8000)).then((fn) => {
      unlistenError = fn;
    });
    listen<{ target: 'quick' | 'enlarged'; combo: string }>('hotkey-recorded', (e) => {
      const { target, combo } = e.payload;
      const cur = settingsRef.current;
      const other = target === 'quick' ? cur.enlarged_hotkey : cur.quick_hotkey;
      const otherName = target === 'quick' ? 'Enlarged Window' : 'Quick Overlay';
      if (other && normalizeCombo(combo) === normalizeCombo(other)) {
        const msg = `“${combo}” is already the ${otherName} hotkey — pick a different combination.`;
        setHotkeyError({
          field: target,
          message: msg,
        });
        showToast('error', msg, 8000);
        setRecording(null);
        setDraftCombo('');
        invoke('stop_recording_hotkey').catch(() => {});
        invoke('resume_global_shortcuts').catch(() => {});
        return;
      }
      committedRef.current = true;
      invoke('stop_recording_hotkey').catch(() => {});
      setHotkeyError(null);
      setRecording(null);
      setDraftCombo('');
      updateSetting(target === 'quick' ? 'quick_hotkey' : 'enlarged_hotkey', combo);
    }).then((fn) => {
      unlistenRecorded = fn;
    });
    listen<{ draft: string }>('hotkey-draft-update', (e) => {
      setDraftCombo(e.payload.draft);
    }).then((fn) => {
      unlistenDraft = fn;
    });
    listen('hotkey-record-canceled', () => {
      setRecording(null);
      setDraftCombo('');
    }).then((fn) => {
      unlistenCancel = fn;
    });

    return () => {
      unlistenStatus?.();
      unlistenError?.();
      unlistenRecorded?.();
      unlistenDraft?.();
      unlistenCancel?.();
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
  const isCustomColor = !ACCENT_SWATCHES.some((s) => s.color.toLowerCase() === settings.accent_color.toLowerCase());

  return (
    <div className="settings">
      <div className="settings-head">
        <button className="btn subtle icon-btn" title="Back" onClick={onBack}>
          <ChevronLeftIcon />
        </button>
        <h2>Settings</h2>
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
              {recording === 'quick' ? (
                <button
                  type="button"
                  className="btn subtle small"
                  onClick={() => {
                    setRecording(null);
                    setDraftCombo('');
                    setHotkeyError(null);
                  }}
                >
                  Cancel
                </button>
              ) : !isDefaultHotkey('quick_hotkey', settings.quick_hotkey) ? (
                <button
                  type="button"
                  className="btn subtle small"
                  title="Reset to default (Ctrl+Shift+Z)"
                  onClick={() => handleResetHotkey('quick_hotkey')}
                >
                  Reset
                </button>
              ) : null}
            </div>
          </div>
          {hotkeyError?.field === 'quick' && (
            <div className="hotkey-error" role="alert">
              <AlertTriangleIcon /> {hotkeyError.message}
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
              {recording === 'enlarged' ? (
                <button
                  type="button"
                  className="btn subtle small"
                  onClick={() => {
                    setRecording(null);
                    setDraftCombo('');
                    setHotkeyError(null);
                  }}
                >
                  Cancel
                </button>
              ) : !isDefaultHotkey('enlarged_hotkey', settings.enlarged_hotkey) ? (
                <button
                  type="button"
                  className="btn subtle small"
                  title="Reset to default (Ctrl+Alt+X)"
                  onClick={() => handleResetHotkey('enlarged_hotkey')}
                >
                  Reset
                </button>
              ) : null}
            </div>
          </div>
          {hotkeyError?.field === 'enlarged' && (
            <div className="hotkey-error" role="alert">
              <AlertTriangleIcon /> {hotkeyError.message}
            </div>
          )}
          {(hotkeyStatus?.overlay_conflict || hotkeyStatus?.enlarged_conflict) && (
            <div className="hotkey-conflict-note" role="alert">
              <div className="hotkey-conflict-header">
                <AlertTriangleIcon /> Shortcut Conflict Detected
              </div>
              {hotkeyStatus.overlay_conflict && (
                <div className="hotkey-conflict-item">
                  Windows could not register <strong>“{hotkeyStatus.overlay_preferred}”</strong> for Quick Overlay because another app owns it. Carbon kept <strong>“{hotkeyStatus.overlay}”</strong>.
                </div>
              )}
              {hotkeyStatus.enlarged_conflict && (
                <div className="hotkey-conflict-item">
                  Windows could not register <strong>“{hotkeyStatus.enlarged_preferred}”</strong> for Enlarged Window because another app owns it. Carbon kept <strong>“{hotkeyStatus.enlarged}”</strong>.
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
                    invoke('set_overlay_default_tab', { tab: 'clips' }).catch((err) => {
                      console.error(err);
                      showToast('error', String(err));
                      fetchSettings();
                    });
                  }}
                >
                  Clips
                </button>
                <button
                  className={`seg-btn ${settings.overlay_default_tab === 'snippets' ? 'active' : ''}`}
                  onClick={() => {
                    setSettings((prev) => ({ ...prev, overlay_default_tab: 'snippets' }));
                    invoke('set_overlay_default_tab', { tab: 'snippets' }).catch((err) => {
                      console.error(err);
                      showToast('error', String(err));
                      fetchSettings();
                    });
                  }}
                >
                  Snippets
                </button>
              </div>
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
              Move to top on paste
              <div className="set-hint">Bump the pasted clip to the top of history</div>
            </div>
            <div className="set-control">
              <button
                className={`toggle ${settings.move_to_top_on_paste ? 'on' : ''}`}
                onClick={() => updateSetting('move_to_top_on_paste', !settings.move_to_top_on_paste)}
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
                onClick={() => {
                  if (settings.clip_merge_enabled && clipMergeDebounceRef.current) {
                    window.clearTimeout(clipMergeDebounceRef.current);
                    clipMergeDebounceRef.current = null;
                    clipMergePendingRef.current = null;
                  }
                  updateSetting('clip_merge_enabled', !settings.clip_merge_enabled);
                }}
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
                  value={settings.clip_merge_window_ms ?? 2500}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const trimmed = raw.trim();
                    if (trimmed === '') {
                      const next = 2500;
                      setSettings((prev) => ({ ...prev, clip_merge_window_ms: next }));
                      settingsRef.current = { ...settingsRef.current, clip_merge_window_ms: next };
                      clipMergePendingRef.current = next;
                      if (clipMergeDebounceRef.current) window.clearTimeout(clipMergeDebounceRef.current);
                      clipMergeDebounceRef.current = window.setTimeout(() => {
                        const pending = clipMergePendingRef.current;
                        clipMergePendingRef.current = null;
                        clipMergeDebounceRef.current = null;
                        if (pending !== null) updateSetting('clip_merge_window_ms', pending);
                      }, 400) as unknown as number;
                      return;
                    }
                    const parsed = Number.parseInt(trimmed, 10);
                    if (Number.isNaN(parsed)) return;
                    // Show raw parsed value immediately for smooth typing;
                    // backend save is clamped via debounce.
                    setSettings((prev) => ({ ...prev, clip_merge_window_ms: parsed }));
                    settingsRef.current = { ...settingsRef.current, clip_merge_window_ms: parsed };
                    clipMergePendingRef.current = Math.min(10000, Math.max(500, parsed));
                    if (clipMergeDebounceRef.current) window.clearTimeout(clipMergeDebounceRef.current);
                    clipMergeDebounceRef.current = window.setTimeout(() => {
                      const pending = clipMergePendingRef.current;
                      clipMergePendingRef.current = null;
                      clipMergeDebounceRef.current = null;
                      if (pending !== null) updateSetting('clip_merge_window_ms', pending);
                    }, 400) as unknown as number;
                  }}
                  onBlur={() => {
                    if (clipMergeDebounceRef.current) {
                      window.clearTimeout(clipMergeDebounceRef.current);
                      clipMergeDebounceRef.current = null;
                      const pending = clipMergePendingRef.current;
                      clipMergePendingRef.current = null;
                      if (pending !== null) {
                        // Clamp visible value immediately on blur so UI never shows out-of-range
                        setSettings((prev) => ({ ...prev, clip_merge_window_ms: pending }));
                        settingsRef.current = { ...settingsRef.current, clip_merge_window_ms: pending };
                        updateSetting('clip_merge_window_ms', pending);
                      } else {
                        // No pending debounce — ensure displayed value is clamped if user left it out of range
                        const cur = settingsRef.current.clip_merge_window_ms;
                        const clamped = Math.min(10000, Math.max(500, cur));
                        if (clamped !== cur) {
                          setSettings((prev) => ({ ...prev, clip_merge_window_ms: clamped }));
                          settingsRef.current = { ...settingsRef.current, clip_merge_window_ms: clamped };
                          updateSetting('clip_merge_window_ms', clamped);
                        }
                      }
                    } else {
                      const cur = settingsRef.current.clip_merge_window_ms;
                      const clamped = Math.min(10000, Math.max(500, cur));
                      if (clamped !== cur) {
                        setSettings((prev) => ({ ...prev, clip_merge_window_ms: clamped }));
                        settingsRef.current = { ...settingsRef.current, clip_merge_window_ms: clamped };
                        updateSetting('clip_merge_window_ms', clamped);
                      }
                    }
                  }}
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
                  const uid = (globalThis.crypto as Crypto | undefined)?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
                  const newRule = {
                    id: uid,
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
                              const checked = e.target.checked;
                              if (checked && rule.pattern) {
                                try {
                                  // Validate Rust regex is close to JS; use JS as quick check
                                  new RegExp(rule.pattern);
                                } catch (err) {
                                  showToast('error', `Invalid regex in "${rule.name}": ${String(err).replace(/^.*?:\s*/, '')}`);
                                  return;
                                }
                              }
                              const updated = [...settings.capture_rules];
                              updated[idx] = { ...updated[idx], is_regex: checked };
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
                            const newVal = e.target.value;
                            if (rule.is_regex && newVal) {
                              try {
                                new RegExp(newVal);
                              } catch (err) {
                                showToast('error', `Invalid regex pattern: ${String(err).replace(/^.*?:\s*/, '')}`);
                              }
                            }
                            const updated = [...settings.capture_rules];
                            updated[idx] = { ...updated[idx], pattern: newVal };
                            updateSetting('capture_rules', updated);
                          }}
                          style={(() => {
                            if (!rule.is_regex || !rule.pattern) return {};
                            try { new RegExp(rule.pattern); return {}; } catch { return { borderColor: '#e53e3e', background: 'rgba(229,62,62,0.06)' } as React.CSSProperties; }
                          })()}
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
                min={0}
                value={settings.retention_days}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  const v = Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
                  updateSetting('retention_days', v);
                }}
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
                min={0}
                value={settings.max_entries}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  const v = Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
                  updateSetting('max_entries', v);
                }}
              />
            </div>
          </div>

          <div className="set-row">
            <div className="set-label">
              Image size limit
              <div className="set-hint">Copies larger than this are skipped (0 = unlimited)</div>
            </div>
            <div className="set-control">
              <input
                className="num"
                type="number"
                min={0}
                value={settings.image_size_limit_mb}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  const v = Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
                  updateSetting('image_size_limit_mb', v);
                }}
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
              <button className="btn danger" onClick={() => setShowClearConfirm(true)}>
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

        {/* Updates — manual check + install, silent banner lives in App.tsx */}
        {/* Version badge is visually separate from the Updates heading and from the
            check-status line, so "Current version v0.1.0" never visually merges with
            the "Updates" title or the "You are on the latest version." hint. */}
        <section>
          <div className="sec-title">Updates</div>
          <div className="set-row">
            <div className="set-label">
              <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>Current version</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 2 }}>
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>v{appVersion || '…'}</span>
              </div>
              <div className="set-hint" style={{ marginTop: 4 }}>{updateStatus}</div>
            </div>
            <div className="set-control">
              <button
                className="btn accent"
                onClick={() => runUpdateCheck(true)}
                disabled={updateBtnDisabled}
                style={{ opacity: updateBtnDisabled ? 0.7 : 1 }}
              >
                {updateBtnDisabled && updateBtnText === 'Checking…' ? <SpinnerIcon /> : null}
                <span>{updateBtnText}</span>
              </button>
            </div>
          </div>
          {updateProgressVisible && (
            <div className="update-progress-wrap" style={{ marginTop: 8 }}>
              <div className="update-progress-bar">
                <div className="update-progress-fill" style={{ width: `${updateProgress}%` }} />
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{Math.round(updateProgress)}%</span>
            </div>
          )}
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
              <div className="accents" style={{ alignItems: 'center' }}>
                {ACCENT_SWATCHES.map((swatch) => (
                  <button
                    key={swatch.color}
                    className={`swatch ${settings.accent_color === swatch.color ? 'on' : ''}`}
                    style={{ background: swatch.color }}
                    title={swatch.name}
                    onClick={() => updateSetting('accent_color', swatch.color)}
                  />
                ))}
                <div
                  style={{
                    position: 'relative',
                    width: 22,
                    height: 22,
                    borderRadius: 7,
                    flexShrink: 0,
                  }}
                  title="Custom color"
                >
                  {/* Dashed "+" affordance underneath; purely visual. */}
                  <button
                    type="button"
                    aria-hidden="true"
                    tabIndex={-1}
                    className="swatch"
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 7,
                      border: '1.5px dashed var(--line)',
                      background: 'transparent',
                      display: 'grid',
                      placeItems: 'center',
                      cursor: 'pointer',
                      position: 'absolute',
                      inset: 0,
                      pointerEvents: 'none',
                    }}
                  >
                    <span aria-hidden style={{ fontSize: 11, lineHeight: 1, color: 'var(--text-3)', userSelect: 'none' }}>
                      +
                    </span>
                  </button>
                  {/* Real-size invisible input on top: WebView2 only opens the native
                      color dialog when the click lands on the input itself — hidden
                      zero-size inputs + showPicker() silently do nothing here. */}
                  <input
                    ref={customColorRef}
                    type="color"
                    value={settings.accent_color}
                    onChange={(e) => updateSetting('accent_color', e.target.value)}
                    aria-label="Pick custom accent color"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      opacity: 0,
                      cursor: 'pointer',
                      border: 'none',
                      padding: 0,
                    }}
                  />
                </div>
                {isCustomColor && (
                  <span
                    title={`Custom ${settings.accent_color}`}
                    aria-label={`Custom color ${settings.accent_color}`}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 7,
                      background: settings.accent_color,
                      border: '2px solid var(--line)',
                      boxShadow: '0 0 0 1px var(--accent-ring)',
                      flexShrink: 0,
                      display: 'inline-block',
                    }}
                  />
                )}
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
      {showClearConfirm && (
        <div className="modal-backdrop" onClick={() => setShowClearConfirm(false)}>
          <div
            className="modal-card delete-col-modal"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="clear-history-title"
          >
            <div className="modal-header">
              <span className="modal-head-icon modal-head-danger"><DeleteIcon /></span>
              <span className="modal-title" id="clear-history-title">Clear history?</span>
              <button className="modal-close-btn" onClick={() => setShowClearConfirm(false)} aria-label="Cancel">✕</button>
            </div>
            <div className="modal-body">
              <p className="modal-desc">
                This permanently deletes <b>all unpinned clipboard items</b> from this machine. Pinned items and snippets are kept.
              </p>
              <p className="modal-desc" style={{ color: 'var(--danger)', fontWeight: 500 }}>
                This action cannot be undone.
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn subtle" onClick={() => setShowClearConfirm(false)} autoFocus>
                Cancel
              </button>
              <button type="button" className="btn danger-solid" onClick={handleClearHistory}>
                Delete history
              </button>
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
