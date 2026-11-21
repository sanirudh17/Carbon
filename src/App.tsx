import { applyAccentContrast } from './lib/accentContrast';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { QuickOverlay } from './components/QuickOverlay';
import { EnlargedWindow } from './components/EnlargedWindow';
import { Settings } from './components/Settings';
import { ExpansionPill } from './components/ExpansionPill';
import { ArgPromptWindow } from './components/ArgPromptWindow';
import { SunMoonIcon, PauseIcon } from './components/Icons';

const DevIconLab = import.meta.env.DEV
  ? lazy(() => import('./components/IconLab').then((m) => ({ default: m.IconLab })))
  : null;

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import type { Update } from '@tauri-apps/plugin-updater';
import type { AppSettings } from './types';
import { initPaintGate, executeWindowShow, executeWindowHide, traceChoreo } from './lib/choreo';

declare global {
  interface Window {
    __carbonSettings?: AppSettings;
    __carbonApplySettings?: (settings: Partial<AppSettings>) => void;
    __carbonRequestEnlargedHide?: () => void;
  }
}

// Once-flag for carbon-ui-ready (module scope: survives StrictMode remounts).
let uiReadySent = false;

type ThemePreference = 'dark' | 'light' | 'system';

interface PauseStatus {
  paused: boolean;
  resume_at_ms: number | null;
}

function resolveEffectiveTheme(pref: ThemePreference): 'dark' | 'light' {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

export function App() {
  const [updaterBanner, setUpdaterBanner] = useState<{ version: string; update: Update } | null>(null);
  const [updaterDownloading, setUpdaterDownloading] = useState(false);
  const [updaterProgress, setUpdaterProgress] = useState(0);
  const [pauseStatus, setPauseStatus] = useState<PauseStatus>({ paused: false, resume_at_ms: null });
  const [windowLabel, setWindowLabel] = useState<string>(() => {
    try {
      const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })?.__TAURI_INTERNALS__;
      if (internals?.metadata?.currentWindow?.label) {
        return internals.metadata.currentWindow.label;
      }
      const win = getCurrentWindow();
      return win?.label || 'browser';
    } catch {
      return 'browser';
    }
  });
  const [activeTab, setActiveTab] = useState<'overlay' | 'enlarged' | 'settings'>('enlarged');
  const [themePref, setThemePref] = useState<ThemePreference>(() => {
    try {
      const saved = localStorage.getItem('carbon_theme');
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    } catch {}
    return 'dark';
  });
  const themePrefRef = useRef<ThemePreference>(themePref);
  themePrefRef.current = themePref;
  const [theme, setTheme] = useState<'dark' | 'light'>(() => resolveEffectiveTheme(themePref));

  const [showIconLab, setShowIconLab] = useState(() => {
    return import.meta.env.DEV && typeof window !== 'undefined' && window.location.hash === '#/icon-lab';
  });

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handleHashChange = () => {
      setShowIconLab(window.location.hash === '#/icon-lab');
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.shiftKey && (e.key === 'I' || e.key === 'i')) {
        e.preventDefault();
        setShowIconLab((prev) => !prev);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // v9 F2 & v15 I1: hidden warm windows may only reveal after React has committed a
  // paintable tree. Initialized via choreo module paint gate.
  useEffect(() => {
    return initPaintGate();
  }, []);

  // Readiness for first-present prewarm: emit carbon-ui-ready only AFTER
  // first commit + paint (rAF x2), never at module evaluation — the old
  // module-level emit fired before React committed, so under the dev
  // server (slow transform waterfall + StrictMode double-mount) the
  // backend prewarmed a blank surface and the first open flashed white.
  // Carry the window label: Rust presents ONLY the window that reported
  // ready (pill/overlay finishing first used to arm main's one-shot cycle
  // before main's tree had painted — first main open flashed white).
  // Module-scoped once-flag survives StrictMode remounts; Rust guards too.
  useEffect(() => {
    if (uiReadySent) return;
    let cancelled = false;
    const label = windowLabel;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        uiReadySent = true;
        import('@tauri-apps/api/event').then(({ emit }) => {
          emit('carbon-ui-ready', { label }).catch(() => { uiReadySent = false; });
        }).catch(() => {});
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const applySettingsData = (settings: Partial<AppSettings>) => {
    if (!settings) return;
    if (settings.accent_color) {
      document.documentElement.style.setProperty('--accent-base', settings.accent_color);
      try { localStorage.setItem('carbon_accent_color', settings.accent_color); } catch {}
    }
    let resolvedTheme: 'dark' | 'light' = (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    if (settings.theme === 'light' || settings.theme === 'dark' || settings.theme === 'system') {
      const pref = settings.theme as ThemePreference;
      themePrefRef.current = pref;
      setThemePref(pref);
      resolvedTheme = resolveEffectiveTheme(pref);
      setTheme(resolvedTheme);
      document.documentElement.setAttribute('data-theme', resolvedTheme);
      try { localStorage.setItem('carbon_theme', pref); } catch {}
    }
    applyAccentContrast(
      settings.accent_color || getComputedStyle(document.documentElement).getPropertyValue('--accent-base').trim() || '#5B7CFA',
      resolvedTheme
    );
    if (settings.window_material) {
      const mat = settings.window_material === 'acrylic' ? 'glass' : settings.window_material;
      document.documentElement.setAttribute('data-material', mat);
      try { localStorage.setItem('carbon_window_material', settings.window_material); } catch {}
    }
  };

  useEffect(() => {
    // Silent update check — mirrors Typr: quietly check latest.json, show banner
    // only when genuinely newer and not already dismissed. Failures are silent.
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const settings = await invoke<AppSettings>('get_settings');
        const update = await check();
        if (cancelled || !update) return;
        if (update.version === (settings as unknown as { dismissedUpdateVersion?: string }).dismissedUpdateVersion) return;
        setUpdaterBanner({ version: update.version, update });
      } catch (e) {
        console.warn('[Carbon] background update check failed:', e);
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  const handleBannerLater = async () => {
    const v = updaterBanner?.version;
    setUpdaterBanner(null);
    if (!v) return;
    try {
      const s = await invoke<AppSettings>('get_settings');
      await invoke('save_settings', { newSettings: { ...s, dismissedUpdateVersion: v } });
    } catch (e) {
      console.warn('[Carbon] could not persist dismissedUpdateVersion', e);
    }
  };

  const handleBannerUpdate = async () => {
    if (!updaterBanner?.update) return;
    const upd = updaterBanner.update;
    setUpdaterDownloading(true);
    setUpdaterProgress(0);
    let total = 0;
    let received = 0;
    try {
      await upd.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            break;
          case 'Progress':
            received += event.data.chunkLength;
            if (total > 0) setUpdaterProgress(Math.min(100, (received / total) * 100));
            break;
          case 'Finished':
            setUpdaterProgress(100);
            break;
        }
      });
      await relaunch();
    } catch (e) {
      console.error('[Carbon] update install failed', e);
      setUpdaterDownloading(false);
      setUpdaterBanner(null);
    }
  };

  useEffect(() => {
    window.__carbonApplySettings = applySettingsData;
    if (window.__carbonSettings) {
      applySettingsData(window.__carbonSettings);
    }

    try {
      const win = getCurrentWindow();
      if (win && win.label) {
        setWindowLabel(win.label);
      }
    } catch {}

    const isOverlay = windowLabel === 'overlay' || (windowLabel === 'browser' && activeTab === 'overlay');
    const winClass = isOverlay ? 'win-overlay' : 'win-library';
    document.body.classList.remove('win-overlay', 'win-library');
    document.body.classList.add(winClass);
    document.documentElement.classList.remove('win-overlay', 'win-library');
    document.documentElement.classList.add(winClass);

    invoke<AppSettings>('get_settings')
      .then(applySettingsData)
      .catch(console.error)
      .finally(() => {
        // The persisted theme/material must commit before the first reveal.
        // Otherwise a fast packaged load presents the bootstrap appearance.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          document.documentElement.dataset.settingsReady = '1';
        }));
      });

    const unlistenPromise = listen<AppSettings>('settings-updated', (event) => {
      applySettingsData(event.payload);
    });

    const unlistenMaterialPromise = listen<string>('window-material-changed', (event) => {
      if (event.payload) {
        const mat = event.payload === 'acrylic' ? 'glass' : event.payload;
        document.documentElement.setAttribute('data-material', mat);
        try { localStorage.setItem('carbon_window_material', event.payload); } catch {}
      }
    });

    const mediaQuery = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const handleReducedTransparency = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        document.documentElement.setAttribute('data-reduced-transparency', 'true');
      } else {
        document.documentElement.removeAttribute('data-reduced-transparency');
      }
    };
    handleReducedTransparency(mediaQuery);
    mediaQuery.addEventListener('change', handleReducedTransparency);

    // Live Follow System Theme watcher
    const schemeQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleSchemeChange = () => {
      if (themePrefRef.current !== 'system') return;
      const effective = schemeQuery.matches ? 'light' : 'dark';
      setTheme(effective);
      document.documentElement.setAttribute('data-theme', effective);
      applyAccentContrast(
        getComputedStyle(document.documentElement).getPropertyValue('--accent-base').trim() || '#5B7CFA',
        effective
      );
      invoke('sync_native_theme', { effectiveTheme: effective }).catch(() => {});
    };
    schemeQuery.addEventListener('change', handleSchemeChange);

    // Live capture pause status sync (tray or Settings)
    invoke<PauseStatus>('get_pause_status')
      .then((st) => { if (st) setPauseStatus(st); })
      .catch(() => {});
    const unlistenPausePromise = listen<PauseStatus>('capture-pause-changed', (event) => {
      if (event.payload) setPauseStatus(event.payload);
    });

    const onFocus = () => {
      invoke<AppSettings>('get_settings')
        .then(applySettingsData)
        .catch(console.error);
      invoke<PauseStatus>('get_pause_status')
        .then((st) => { if (st) setPauseStatus(st); })
        .catch(() => {});
    };

    // Prevent browser default actions (Print on Ctrl+P) while allowing
    // event propagation to React component keydown handlers.
    const blockBrowserDefaultHotkeys = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', blockBrowserDefaultHotkeys, true);
    window.addEventListener('focus', onFocus);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      unlistenMaterialPromise.then((unlisten) => unlisten());
      unlistenPausePromise.then((unlisten) => unlisten());
      mediaQuery.removeEventListener('change', handleReducedTransparency);
      schemeQuery.removeEventListener('change', handleSchemeChange);
      window.removeEventListener('keydown', blockBrowserDefaultHotkeys, true);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  useEffect(() => {
    const isOverlay = windowLabel === 'overlay' || (windowLabel === 'browser' && activeTab === 'overlay');
    const winClass = isOverlay ? 'win-overlay' : 'win-library';
    document.body.classList.remove('win-overlay', 'win-library');
    document.body.classList.add(winClass);
    document.documentElement.classList.remove('win-overlay', 'win-library');
    document.documentElement.classList.add(winClass);
  }, [windowLabel, activeTab]);

  useEffect(() => {
    if (windowLabel !== 'main') return;

    let cancelShow: (() => void) | null = null;
    let hideHandle: { cancel: () => void } | null = null;

    const doHide = (reason: string) => {
      traceChoreo(`main doHide start (reason=${reason})`);
      if (cancelShow) cancelShow();
      hideHandle = executeWindowHide('main');
    };

    window.__carbonRequestEnlargedHide = () => doHide('webview-hotkey');

    // Show choreography: warm invocations uncloak immediately after the 2-rAF
    // paint gate (settleMs=0) to meet Invariant I1 and I5 (latency within baseline).
    const unlistenOpened = listen<{ token?: number }>('enlarged-opened', (e) => {
      traceChoreo('main enlarged-opened received');
      if (hideHandle) hideHandle.cancel();
      const token = typeof e.payload === 'object' && e.payload !== null && typeof e.payload.token === 'number'
        ? e.payload.token
        : undefined;
      cancelShow = executeWindowShow('main', undefined, 0, token);
    });

    // Hide choreography: ack generation and execute choreo hide
    const unlistenHideReq = listen<number>('enlarged-hide-requested', (e) => {
      if (typeof e.payload === 'number') {
        invoke('enlarged_hide_ack', { gen: e.payload }).catch(() => {});
      }
      doHide('hide-requested');
    });

    // If initial mount and window is genuinely revealed, run paint gate.
    // isVisible() alone is true after the cloaked first-present prewarm
    // (WS_VISIBLE while cloaked), which used to fire a tokenless show on
    // every cold boot; is_main_revealed asks the cloak/paint flags instead.
    invoke<boolean>('is_main_revealed')
      .then((revealed) => {
        if (revealed) {
          cancelShow = executeWindowShow('main', undefined, 150);
        }
      })
      .catch(() => {});

    return () => {
      window.__carbonRequestEnlargedHide = undefined;
      if (cancelShow) cancelShow();
      unlistenOpened.then((fn) => fn());
      unlistenHideReq.then((fn) => fn());
    };
  }, [windowLabel]);

  const setThemeMode = async (nextPref: ThemePreference) => {
    themePrefRef.current = nextPref;
    setThemePref(nextPref);
    const effective = resolveEffectiveTheme(nextPref);
    applyAccentContrast(
      getComputedStyle(document.documentElement).getPropertyValue('--accent-base').trim() || '#5B7CFA',
      effective
    );
    setTheme(effective);
    document.documentElement.setAttribute('data-theme', effective);
    try { localStorage.setItem('carbon_theme', nextPref); } catch {}
    try {
      const current = await invoke<Record<string, unknown>>('get_settings');
      await invoke('save_settings', { newSettings: { ...current, theme: nextPref } });
    } catch (e) {
      console.error(e);
    }
  };

  const toggleTheme = async () => {
    const nextTheme: ThemePreference = theme === 'dark' ? 'light' : 'dark';
    await setThemeMode(nextTheme);
  };

  if (showIconLab && DevIconLab) {
    return (
      <Suspense fallback={null}>
        <DevIconLab
          onClose={() => {
            setShowIconLab(false);
            if (window.location.hash === '#/icon-lab') {
              history.replaceState(null, '', window.location.pathname);
            }
          }}
        />
      </Suspense>
    );
  }

  // 1. Overlay Window View
  if (windowLabel === 'overlay') {
    return <QuickOverlay />;
  }

  if (windowLabel === 'pill') {
    return <ExpansionPill />;
  }

  if (windowLabel === 'argprompt') {
    return <ArgPromptWindow />;
  }

  const bannerEl = updaterBanner ? (
    <div className={`update-banner ${updaterDownloading ? 'is-downloading' : ''}`} role="status" aria-live="polite">
      <span className="update-banner-dot" aria-hidden="true" />
      <span className="update-banner-text">
        {updaterDownloading
          ? `Updating to v${updaterBanner.version}… ${Math.round(updaterProgress)}%`
          : `Update available — v${updaterBanner.version}`}
      </span>
      {updaterDownloading ? (
        <div className="update-banner-progress" aria-hidden="true">
          <div className="update-banner-progress-fill" style={{ width: `${updaterProgress}%` }} />
        </div>
      ) : (
        <div className="update-banner-actions">
          <button className="update-banner-btn primary" onClick={handleBannerUpdate}><span className="carbon-control-label">Update</span></button>
          <button className="update-banner-btn ghost" onClick={handleBannerLater} title="Hide until next release"><span className="carbon-control-label">Later</span></button>
        </div>
      )}
    </div>
  ) : null;

  const pausedBannerEl = pauseStatus.paused ? (
    <div className="pause-banner" role="status" aria-live="polite">
      <span className="pause-banner-icon" aria-hidden="true"><PauseIcon /></span>
      <span className="pause-banner-text">
        {pauseStatus.resume_at_ms
          ? (() => {
              const rem = Math.max(1, Math.ceil((pauseStatus.resume_at_ms - Date.now()) / 60_000));
              return `Clipboard capture paused · resumes in ${rem}m`;
            })()
          : 'Clipboard capture paused'}
      </span>
      <button
        className="update-banner-btn primary"
        onClick={() => { invoke('resume_capture').catch(console.error); }}
      >
        <span className="carbon-control-label">Resume</span>
      </button>
    </div>
  ) : null;

  // 2. Enlarged Main Window View
  // Keep EnlargedWindow mounted while Settings is open so returning via the
  // Back button is 0ms instantaneous without remounting 200+ rows or re-firing IPCs.
  if (windowLabel === 'main') {
    const isSettingsOpen = activeTab === 'settings';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--app-window-bg, transparent)', border: 'none', outline: 'none' }}>
        {pausedBannerEl}
        {!isSettingsOpen && bannerEl}
        <div style={{ flex: 1, overflow: 'hidden', border: 'none', outline: 'none', display: isSettingsOpen ? 'none' : 'block' }}>
          <EnlargedWindow onOpenSettings={() => setActiveTab('settings')} isHidden={isSettingsOpen} />
        </div>
        {isSettingsOpen && (
          <div style={{ flex: 1, overflow: 'hidden', border: 'none', outline: 'none' }}>
            <Settings
              onBack={() => setActiveTab('enlarged')}
              onThemeToggle={toggleTheme}
              onThemeChange={setThemeMode}
              currentTheme={theme}
              themePreference={themePref}
            />
          </div>
        )}
      </div>
    );
  }

  // 3. Dev / Browser Mode (all-in-one interactive test preview)
  // Banner is auto-check only — hidden in Settings where manual check owns the UI
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg0)' }}>
      {activeTab !== 'settings' && bannerEl}
      <div
        className="canvas-head"
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="brand-mark" style={{ width: 28, height: 28, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--accent) 22%, transparent)', color: 'var(--accent-text)', border: '1px solid color-mix(in srgb, var(--accent) 38%, transparent)', fontWeight: 700 }}>
            C
          </div>
          <h1 style={{ fontSize: 16, fontWeight: 650 }}>
            Carbon <span style={{ color: 'var(--text-3)', fontSize: 12, fontWeight: 400 }}>— Clipboard Manager</span>
          </h1>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="view-switch" style={{ display: 'flex', gap: 4, background: 'var(--elev)', padding: 3, borderRadius: 999, border: '1px solid var(--line)' }}>
            <button
              className={`btn subtle ${activeTab === 'overlay' ? 'accent' : ''}`}
              style={{ borderRadius: 999 }}
              onClick={() => setActiveTab('overlay')}
            >
              <span className="carbon-control-label">Quick Overlay</span>
            </button>
            <button
              className={`btn subtle ${activeTab === 'enlarged' ? 'accent' : ''}`}
              style={{ borderRadius: 999 }}
              onClick={() => setActiveTab('enlarged')}
            >
              <span className="carbon-control-label">Enlarged Window</span>
            </button>
            <button
              className={`btn subtle ${activeTab === 'settings' ? 'accent' : ''}`}
              style={{ borderRadius: 999 }}
              onClick={() => setActiveTab('settings')}
            >
              <span className="carbon-control-label">Settings</span>
            </button>
          </div>

          <button className="theme-toggle" onClick={toggleTheme}>
            <SunMoonIcon />
            <span id="theme-label">{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === 'overlay' && <QuickOverlay />}
        {activeTab === 'enlarged' && <EnlargedWindow onOpenSettings={() => setActiveTab('settings')} />}
        {activeTab === 'settings' && (
          <Settings
            onBack={() => setActiveTab('enlarged')}
            onThemeToggle={toggleTheme}
            onThemeChange={setThemeMode}
            currentTheme={theme}
            themePreference={themePref}
          />
        )}
      </div>
    </div>
  );
}
export default App;
