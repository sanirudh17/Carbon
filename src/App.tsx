import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { QuickOverlay } from './components/QuickOverlay';
import { EnlargedWindow } from './components/EnlargedWindow';
import { Settings } from './components/Settings';
import { ExpansionPill } from './components/ExpansionPill';
import { ArgPromptWindow } from './components/ArgPromptWindow';
import { SunMoonIcon } from './components/Icons';
import { IconLab } from './components/IconLab';

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

export function App() {
  const [updaterBanner, setUpdaterBanner] = useState<{ version: string; update: Update } | null>(null);
  const [updaterDownloading, setUpdaterDownloading] = useState(false);
  const [updaterProgress, setUpdaterProgress] = useState(0);
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
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('carbon_theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

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
  // Module-scoped once-flag survives StrictMode remounts; Rust guards too.
  useEffect(() => {
    if (uiReadySent) return;
    uiReadySent = true;
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        import('@tauri-apps/api/event').then(({ emit }) => {
          emit('carbon-ui-ready').catch(() => {});
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
    if (settings.theme === 'light') {
      setTheme('light');
      document.documentElement.setAttribute('data-theme', 'light');
      try { localStorage.setItem('carbon_theme', 'light'); } catch {}
    } else if (settings.theme === 'dark') {
      setTheme('dark');
      document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('carbon_theme', 'dark'); } catch {}
    }
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
      .catch(console.error);

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

    const onFocus = () => {
      invoke<AppSettings>('get_settings')
        .then(applySettingsData)
        .catch(console.error);
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
      mediaQuery.removeEventListener('change', handleReducedTransparency);
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

    // If initial mount and window is visible, run paint gate
    getCurrentWindow()
      .isVisible()
      .then((vis) => {
        if (vis) {
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

  const toggleTheme = async () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    if (nextTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      const current = await invoke<Record<string, unknown>>('get_settings');
      await invoke('save_settings', { newSettings: { ...current, theme: nextTheme } });
    } catch (e) {
      console.error(e);
    }
  };

  if (showIconLab) {
    return (
      <IconLab
        onClose={() => {
          setShowIconLab(false);
          if (window.location.hash === '#/icon-lab') {
            history.replaceState(null, '', window.location.pathname);
          }
        }}
      />
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
          <button className="update-banner-btn primary" onClick={handleBannerUpdate}>Update</button>
          <button className="update-banner-btn ghost" onClick={handleBannerLater} title="Hide until next release">Later</button>
        </div>
      )}
    </div>
  ) : null;

  // 2. Enlarged Main Window View
  if (windowLabel === 'main') {
    if (activeTab === 'settings') {
      // Manual update check lives in Settings — banner (auto-check popup)
      // is intentionally hidden here so "Check for latest updates" only
      // updates the Settings row, never the top popup.
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--app-window-bg, transparent)' }}>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <Settings
              onBack={() => setActiveTab('enlarged')}
              onThemeToggle={toggleTheme}
              currentTheme={theme}
            />
          </div>
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--app-window-bg, transparent)' }}>
        {bannerEl}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <EnlargedWindow onOpenSettings={() => setActiveTab('settings')} />
        </div>
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
              Quick Overlay
            </button>
            <button
              className={`btn subtle ${activeTab === 'enlarged' ? 'accent' : ''}`}
              style={{ borderRadius: 999 }}
              onClick={() => setActiveTab('enlarged')}
            >
              Enlarged Window
            </button>
            <button
              className={`btn subtle ${activeTab === 'settings' ? 'accent' : ''}`}
              style={{ borderRadius: 999 }}
              onClick={() => setActiveTab('settings')}
            >
              Settings
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
            currentTheme={theme}
          />
        )}
      </div>
    </div>
  );
}
export default App;
