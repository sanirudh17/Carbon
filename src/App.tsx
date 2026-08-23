import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { QuickOverlay } from './components/QuickOverlay';
import { EnlargedWindow } from './components/EnlargedWindow';
import { Settings } from './components/Settings';
import { ExpansionPill } from './components/ExpansionPill';
import { ArgPromptWindow } from './components/ArgPromptWindow';
import { SunMoonIcon } from './components/Icons';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import type { Update } from '@tauri-apps/plugin-updater';
import type { AppSettings } from './types';

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
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  const applySettingsData = (settings: { accent_color?: string; theme?: string }) => {
    if (settings?.accent_color) {
      document.documentElement.style.setProperty('--accent-base', settings.accent_color);
    }
    if (settings?.theme === 'light') {
      setTheme('light');
      document.documentElement.setAttribute('data-theme', 'light');
    } else if (settings?.theme === 'dark') {
      setTheme('dark');
      document.documentElement.removeAttribute('data-theme');
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
    try {
      const win = getCurrentWindow();
      if (win && win.label) {
        setWindowLabel(win.label);
      }
    } catch {}

    invoke<{ accent_color?: string; theme?: string }>('get_settings')
      .then(applySettingsData)
      .catch(console.error);

    const unlistenPromise = listen<{ accent_color?: string; theme?: string }>('settings-updated', (event) => {
      applySettingsData(event.payload);
    });

    const onFocus = () => {
      invoke<{ accent_color?: string; theme?: string }>('get_settings')
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
      window.removeEventListener('keydown', blockBrowserDefaultHotkeys, true);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

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
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-text">
        {updaterDownloading ? `Downloading Carbon v${updaterBanner.version}… ${Math.round(updaterProgress)}%` : `Update available to v${updaterBanner.version} — click Update.`}
      </span>
      {updaterDownloading ? (
        <div className="update-banner-progress"><div className="update-banner-progress-fill" style={{ width: `${updaterProgress}%` }} /></div>
      ) : (
        <>
          <button className="btn accent" style={{ height: 26, padding: '0 12px', fontSize: 12 }} onClick={handleBannerUpdate}>Update</button>
          <button className="btn subtle" style={{ height: 26, padding: '0 10px', fontSize: 12 }} onClick={handleBannerLater} title="Hide this until the next release">Later</button>
        </>
      )}
    </div>
  ) : null;

  // 2. Enlarged Main Window View
  if (windowLabel === 'main') {
    if (activeTab === 'settings') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg0)' }}>
          {bannerEl}
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
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg0)' }}>
        {bannerEl}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <EnlargedWindow onOpenSettings={() => setActiveTab('settings')} />
        </div>
      </div>
    );
  }

  // 3. Dev / Browser Mode (all-in-one interactive test preview)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg0)' }}>
      {bannerEl}
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
