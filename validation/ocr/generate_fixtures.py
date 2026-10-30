"""Owned synthetic screenshots; Pillow is a validation-only dependency."""
import json, random, string, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.validation/ocr/fixtures')
root.mkdir(parents=True, exist_ok=True)
rng = random.Random(20261030)
key = 'test_' + ''.join(rng.choice(string.ascii_letters + string.digits) for _ in range(36))
lines = ['Carbon keeps clipboard history on this device.',
         'Email: demo.user+notes@example.com', 'Synthetic token: ' + key,
         'const selected = items[0]?.id ?? "missing";',
         r'Path: C:\Projects\carbon\preview_01.tsx',
         'C# rate: 25% | --dpi 300 | total $1,234.56',
         'Mixed: O0 Il1 {json} [array] foo_bar/path.ts']
cases = []
def draw_case(name, font_name, size, dark, scale=1, full=False, tall=False):
    font = ImageFont.truetype('C:/Windows/Fonts/' + font_name, size)
    width = max(760, int(max(font.getlength(s) for s in lines)) + 50)
    height = (size + 15) * len(lines) + 36
    positions = [(20, 18 + i * (size + 15), text) for i, text in enumerate(lines)]
    expected = list(lines)
    if full:
        width, height = max(width, 1920), 1080
        positions = [(x + 180, y + 240, text) for x, y, text in positions]
    if tall:
        height = 2400
        expected = [f'Clipboard line {i:02d}: Keep code C# and rate 25% unchanged.' for i in range(42)]
        positions = [(20, 20 + i * 55, text) for i, text in enumerate(expected)]
    image = Image.new('RGB', (width, height), '#101113' if dark else 'white')
    draw = ImageDraw.Draw(image)
    for x, y, text in positions:
        draw.text((x, y), text, font=font, fill='#eeeeee' if dark else '#161616')
    if scale != 1:
        image = image.resize((round(width * scale), round(height * scale)), Image.Resampling.LANCZOS)
    image.save(root / (name + '.png'))
    cases.append(dict(file=name + '.png', expected=' '.join(expected), exact_token=key if not tall else None))
for font in ['consola.ttf', 'segoeui.ttf']:
    for size in [11, 15]:
        for dark in [False, True]:
            draw_case(f'{font[:-4]}-{size}-' + ('dark' if dark else 'light'), font, size, dark)
for scale in [.5, .75, 1]:
    for dark in [False, True]:
        draw_case(f'reduced-{scale}-' + ('dark' if dark else 'light'), 'consola.ttf', 18, dark, scale)
for dark in [False, True]:
    theme = 'dark' if dark else 'light'
    draw_case('full-' + theme, 'segoeui.ttf', 15, dark, full=True)
    draw_case('tall-' + theme, 'consola.ttf', 15, dark, tall=True)
(root / 'fixtures.json').write_text(json.dumps(cases, indent=2), encoding='utf-8')
print(f'Generated {len(cases)} owned OCR fixtures in {root}')
