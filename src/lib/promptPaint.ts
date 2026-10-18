// A cloaked/minimized WebView can throttle rAF. Prefer two submitted browser
// frames, with a bounded fallback; never acknowledge directly from DOM commit.
export function schedulePromptPaint(ack: () => void): () => void {
  let cancelled = false;
  let sent = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout>;
  const finish = () => {
    if (cancelled || sent) return;
    sent = true;
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    ack();
  };
  const ready = () => {
    if (cancelled) return;
    if (document.documentElement.dataset.settingsReady === '0') {
      timer = setTimeout(ready, 16);
      return;
    }
    timer = setTimeout(finish, 160);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(finish);
    });
  };
  ready();
  return () => { cancelled = true; clearTimeout(timer); cancelAnimationFrame(frame); };
}
