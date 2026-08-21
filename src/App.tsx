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

export function App() {
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
      document.documentElement.style.setProperty('--accent', settings.accent_color);
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

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    if (nextTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    invoke('save_settings', { newSettings: { theme: nextTheme } }).catch(console.error);
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

  // 2. Enlarged Main Window View
  if (windowLabel === 'main') {
    if (activeTab === 'settings') {
      return (
        <Settings
          onBack={() => setActiveTab('enlarged')}
          onThemeToggle={toggleTheme}
          currentTheme={theme}
        />
      );
    }
    return <EnlargedWindow onOpenSettings={() => setActiveTab('settings')} />;
  }

  // 3. Dev / Browser Mode (all-in-one interactive test preview)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg0)' }}>
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
          <div className="brand-mark" style={{ width: 28, height: 28, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'var(--accent)', color: '#fff', fontWeight: 700 }}>
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
