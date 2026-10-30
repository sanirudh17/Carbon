import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/accentContrast.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { accentForeground } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('all shipped accent choices retain readable filled-button labels in both themes and hover states', () => {
  for (const color of ['#5B7CFA', '#8B5CF6', '#14B8A6', '#10B981', '#F59E0B', '#F43F5E', '#000000', '#ffffff']) {
    for (const theme of ['dark', 'light']) for (const hover of [false, true]) {
      const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
      const shown = rgb.map(v => theme === 'light' ? v * (hover ? .78 : .9) : hover ? v * .82 + 255 * .18 : v);
      const linear = shown.map(v => v / 255 <= .04045 ? v / 255 / 12.92 : ((v / 255 + .055) / 1.055) ** 2.4);
      const luminance = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
      const foreground = accentForeground(color, theme, hover);
      const ratio = foreground === '#000000' ? (luminance + .05) / .05 : 1.05 / (luminance + .05);
      assert(ratio >= 4.5, `${color} ${theme} hover=${hover} gives ${ratio}`);
    }
  }
});
