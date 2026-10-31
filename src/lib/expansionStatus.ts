export type ExpansionStatus = 'off' | 'not_yet_active' | 'active';

/** Refresh only during startup. A delayed reply or missed hook event must not
 * leave Settings stuck on Starting, and active expansion needs no idle polling. */
export async function refreshExpansionUntilActive(
  readStatus: () => Promise<ExpansionStatus>,
  onStatus: (status: ExpansionStatus) => void,
  options: {
    signal: AbortSignal;
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<ExpansionStatus> {
  const { signal, timeoutMs = 7000, intervalMs = 200, now = Date.now } = options;
  const wait = options.wait ?? ((ms: number, abort: AbortSignal) => new Promise<void>((resolve) => {
    if (abort.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); abort.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    abort.addEventListener('abort', finish, { once: true });
  }));
  const deadline = now() + timeoutMs;
  let status: ExpansionStatus = 'not_yet_active';
  while (!signal.aborted) {
    try {
      const next = await readStatus();
      if (signal.aborted) return status;
      if (next === 'off' || next === 'not_yet_active' || next === 'active') {
        status = next;
        onStatus(status);
        if (status === 'active') return status;
      }
    } catch { if (signal.aborted) return status; }
    if (now() >= deadline) return status;
    await wait(Math.min(intervalMs, Math.max(0, deadline - now())), signal);
  }
  return status;
}
