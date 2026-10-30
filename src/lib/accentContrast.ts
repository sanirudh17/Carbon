/** Preserve the chosen accent hue while making filled-button labels readable. */
export function accentForeground(color: string, theme: string, hover = false): string {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : '5B7CFA';
  const base = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16));
  // Light actions use a pale accent glass fill with a related ink color.
  // Even white-on-white input keeps at least 4.5:1 at this ink strength.
  if (theme === 'light') return '#' + base.map(value => Math.round(value * .45).toString(16).padStart(2, '0')).join('');
  const rgb = base.map(value => hover ? value * .82 + 255 * .18 : value);
  const linear = rgb.map(value => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  // Black or white always gives at least 4.5:1 on an opaque sRGB accent.
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#ffffff';
}

export function applyAccentContrast(color: string, theme: string): void {
  document.documentElement.style.setProperty('--accent-fg', accentForeground(color, theme));
  document.documentElement.style.setProperty('--accent-fg-hover', accentForeground(color, theme, true));
}
