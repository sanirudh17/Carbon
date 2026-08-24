// Physical-key (e.code) → display token for non-alphanumeric keys.
const CODE_KEY: Record<string, string> = {
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`',
  Space: 'Space', Tab: 'Tab', Enter: 'Enter',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

/**
 * Convert a KeyboardEvent into a Carbon combo string using e.code (the physical key)
 * rather than e.key. Layout-independent.
 */
export const keyEventToCombo = (e: KeyboardEvent | React.KeyboardEvent): string | null => {
  const nativeEv = 'getModifierState' in e ? (e as KeyboardEvent) : (e as unknown as React.KeyboardEvent).nativeEvent;
  const altGraph = nativeEv?.getModifierState?.('AltGraph') ?? false;
  const mods: string[] = [];
  if (e.ctrlKey || altGraph) mods.push('Ctrl');
  if (e.altKey || altGraph) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Win');

  const code = e.code || '';
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = code.slice(6);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (code in CODE_KEY) key = CODE_KEY[code];

  if (!key && e.key && e.key.length === 1 && !['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    key = e.key.toUpperCase();
  }

  if (!key || mods.length === 0) return null;
  return [...mods, key].join('+');
};

/**
 * Normalize combo string (e.g. "Shift+Ctrl+Z" -> "ctrl+shift+Z") for reliable comparison.
 */
export const normalizeCombo = (combo: string): string => {
  if (!combo) return '';
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const mods: string[] = [];
  let key: string | null = null;
  for (const part of parts) {
    const l = part.toLowerCase();
    if (l === 'ctrl' || l === 'control') mods.push('ctrl');
    else if (l === 'alt' || l === 'option') mods.push('alt');
    else if (l === 'shift') mods.push('shift');
    else if (l === 'win' || l === 'super' || l === 'meta' || l === 'cmd' || l === 'command') mods.push('win');
    else key = part.toUpperCase();
  }
  mods.sort();
  return key ? [...mods, key].join('+') : mods.join('+');
};

/**
 * Checks whether a keyboard event matches a configured hotkey combination.
 */
export const matchesHotkeyCombo = (
  e: KeyboardEvent | React.KeyboardEvent,
  targetCombo?: string | null
): boolean => {
  if (!targetCombo) return false;
  const currentCombo = keyEventToCombo(e);
  if (currentCombo && normalizeCombo(currentCombo) === normalizeCombo(targetCombo)) {
    return true;
  }
  const norm = normalizeCombo(targetCombo);
  const parts = norm.split('+');
  const targetKey = parts[parts.length - 1];
  const hasCtrl = parts.includes('ctrl');
  const hasAlt = parts.includes('alt');
  const hasShift = parts.includes('shift');
  const hasWin = parts.includes('win');

  const nativeEv = 'getModifierState' in e ? (e as KeyboardEvent) : (e as unknown as React.KeyboardEvent).nativeEvent;
  const altGraph = nativeEv?.getModifierState?.('AltGraph') ?? false;
  const eCtrl = e.ctrlKey || altGraph;
  const eAlt = e.altKey || altGraph;
  const eShift = e.shiftKey;
  const eWin = e.metaKey;

  if (Boolean(eCtrl) !== hasCtrl) return false;
  if (Boolean(eAlt) !== hasAlt) return false;
  if (Boolean(eShift) !== hasShift) return false;
  if (Boolean(eWin) !== hasWin) return false;

  const k = e.key?.toUpperCase();
  const c = e.code?.toUpperCase();
  if (k === targetKey || c === `KEY${targetKey}` || c === `DIGIT${targetKey}` || c === targetKey) {
    return true;
  }
  return false;
};
