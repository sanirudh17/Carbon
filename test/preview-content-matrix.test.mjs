import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
const require = createRequire(import.meta.url), esbuild = require('esbuild');
const root = path.resolve(import.meta.dirname, '..');
const win = new Window({ settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
for (const key of ['window', 'document', 'DOMParser', 'NodeFilter', 'Node', 'Element', 'HTMLElement', 'DocumentFragment'])
    globalThis[key] = win[key] ?? win.document;
win.__TAURI_INTERNALS__ = { convertFileSrc: p => `https://asset.localhost/${encodeURIComponent(p)}` };
const output = esbuild.buildSync({ stdin: { contents: "export {ClipPreview,getClipFilePaths} from './src/components/ClipPreview';export {prepareRichPreview,extractFragment} from './src/lib/richText';", resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', external: ['react', 'react-dom', 'react-dom/server'], write: false, jsx: 'automatic', loader: { '.png': 'dataurl' } });
fs.mkdirSync(path.join(root, '.validation'), { recursive: true });
const bundle = path.join(root, '.validation', `preview-matrix-${process.pid}.cjs`);
fs.writeFileSync(bundle, output.outputFiles[0].text);
const { ClipPreview, getClipFilePaths, prepareRichPreview, extractFragment } = require(bundle);
process.on('exit', () => { try {
    fs.unlinkSync(bundle);
}
catch { } });
const clip = (type, text, extra = {}) => ({ id: 'matrix', title: 'Fixture', content_type: type, text_content: text, html_content: null, rtf_content: null, image_path: null, file_paths: null, file_size: 32, is_pinned: false, source_app: 'validation.exe', created_at: '2026-10-30 12:00:00', updated_at: '2026-10-30 12:00:00', is_sensitive: false, ...extra });
function render(item, raw = false) { const html = renderToStaticMarkup(React.createElement(ClipPreview, { item, forceRaw: raw })); const box = win.document.createElement('div'); box.innerHTML = html; return box; }
const richCases = [
    ['office', '<p class="MsoNormal"><b>Subject</b></p><table><tr><td>Cell</td></tr></table>', ['Subject', 'Cell']],
    ['gmail quote', '<div dir="ltr">Reply</div><blockquote class="gmail_quote">Earlier message <a href="mailto:hello@example.com">Sender</a></blockquote>', ['Reply', 'Earlier message', 'Sender']],
    ['lists and formatting', '<h2>Heading</h2><ul><li>First<ul><li>Nested</li></ul></li></ul><p><b>Bold</b> <i>Italic</i> <u>Underline</u></p>', ['Heading', 'Nested', 'Bold', 'Underline']],
    ['dark source', '<html><body style="background:#111;color:white"><p>Dark source text</p></body></html>', ['Dark source text']],
    ['legacy colors', '<table bgcolor="#222"><tr><td><font color="white">Legacy text</font></td></tr></table>', ['Legacy text']],
    ['low contrast', '<p style="color:white;background:white">Keep visible</p>', ['Keep visible']],
    ['code block', '<pre><code>if (a &lt; b) return a &amp; b;</code></pre>', ['if (a < b) return a & b;']],
    ['malformed', '<p>Alpha <b>Beta<div>Gamma', ['Alpha', 'Beta', 'Gamma']],
    ['interactive shells', '<form><button>Button label</button><textarea>Original text</textarea></form>', ['Button label', 'Original text']],
    ['Unicode', '<p>नमस्ते 👋 مرحبا café 中文</p>', ['नमस्ते 👋 مرحبا café 中文']],
    ['missing image', '<p>Image context</p><img src="blob:expired" alt="Diagram">', ['Image context']],
];
for (const theme of ['dark', 'light'])
    for (const [name, html, tokens] of richCases)
        test(`preview matrix ${theme}: ${name}`, () => { win.document.documentElement.dataset.theme = theme; const out = render(clip('rich_text', tokens.join(' '), { html_content: html })); for (const token of tokens)
            assert(out.textContent.includes(token), `${name}: missing ${token}`); assert(out.querySelector('.rich-doc')); assert(!out.querySelector('script,iframe,object,form,button:not(.btn)')); });
for (const [type, text, selector] of [['text', 'Plain <literal> & punctuation\nSecond line', '.preview-text'], ['code', '# Python comment\nvalue = "a_b_c"', '.preview-text.mono'], ['email', 'first_last_other+tag@example.com', '.preview-link-card'], ['link', 'https://example.com/a_b_c?q=x_y_z&x=1', '.preview-link-card']])
    test(`literal ${type} retains punctuation and never becomes Markdown`, () => { const out = render(clip(type, text)); assert(out.querySelector(selector)); assert.equal(out.textContent, text); assert(!out.querySelector('.rich-doc')); });
test('Markdown text renders structured content and escapes literal HTML', () => { const out = render(clip('text', '# Heading\n\n- First\n- Second\n\n```js\nconst a = "<script>";\n```')); assert(out.querySelector('h1, h2')); assert(out.querySelector('li')); assert(out.querySelector('pre code')); assert(!out.querySelector('script')); assert(out.textContent.includes('<script>')); });
test('RTF-only and Raw rich captures retain their plain-text twin', () => { const item = clip('rich_text', 'Literal <value> & notes', { rtf_content: '{\\rtf1 Fixture}' }); assert.equal(render(item).textContent, item.text_content); const raw = render({ ...item, html_content: '<strong>Formatted</strong>' }, true); assert.equal(raw.textContent, item.text_content); assert(!raw.querySelector('strong')); });
test('file, color, empty and masked captures render usable fallbacks', () => { const file = render(clip('file', 'C:\\Notes\\one.txt', { file_paths: JSON.stringify(['C:\\Notes\\one.txt', 'C:\\Notes\\two.txt']) })); assert(file.textContent.includes('one.txt')); assert(file.textContent.includes('1 more')); const color = render(clip('color', '#12abef', { title: '#12abef' })); assert(color.querySelector('.color-swatch-box')); assert(render(clip('text', '', { title: '' })).textContent.includes('No text content')); const masked = render(clip('text', 'synthetic-secret', { is_sensitive: true })); assert(!masked.textContent.includes('synthetic-secret')); assert(masked.textContent.includes('Reveal')); });
test('CF_HTML byte offsets retain Unicode without fragment markers', () => { const fragment = '<p>नमस्ते 👋 café</p>', prefix = '<html><body>', suffix = '</body></html>'; let header = 'Version:1.0\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n'; const start = Buffer.byteLength(header), fs = start + Buffer.byteLength(prefix), fe = fs + Buffer.byteLength(fragment), end = fe + Buffer.byteLength(suffix); for (const [key, value] of Object.entries({ StartHTML: start, EndHTML: end, StartFragment: fs, EndFragment: fe }))
    header = header.replace(`${key}:0000000000`, `${key}:${String(value).padStart(10, '0')}`); assert.equal(extractFragment(header + prefix + fragment + suffix), fragment); });
test('rich preview strips executable attributes and shells', () => { const out = prepareRichPreview('<p onclick="window.evil=1">Safe</p><script>window.evil=1</script><iframe src="https://example.invalid"></iframe><a href="javascript:alert(1)">Link</a>'); const node = win.document.createElement('div'); node.innerHTML = out.html; assert(!node.querySelector('script,iframe,[onclick],[href^="javascript:"]')); assert(node.textContent.includes('Safe')); });
test('Markdown preview strips executable link protocols', () => { const out = render(clip('text', '# Heading\n\n[Link](javascript:alert(1))')); assert(!out.querySelector('[href^="javascript:"]')); });
test('Markdown task states survive sanitization as disabled checkboxes', () => { const out = render(clip('text', '- [x] Completed\n- [ ] Pending')); const boxes = [...out.querySelectorAll('input[type="checkbox"]')]; assert.equal(boxes.length, 2); assert(boxes.every(e => e.disabled)); assert.equal(boxes[0].checked, true); assert.equal(boxes[1].checked, false); });
test('rich URL checks reject control-character-obfuscated executable schemes', () => { const html = prepareRichPreview('<a href="java&#x09;script:alert(1)">Link</a><input type="checkbox" checked onclick="window.evil=1">'); const node = win.document.createElement('div'); node.innerHTML = html.html; assert.equal(node.querySelector('a').hasAttribute('href'), false); const box = node.querySelector('input'); assert(box.disabled); assert(box.checked); assert(!box.hasAttribute('onclick')); });

test('file paths accept structured-only captures and preserve exact path bytes', () => {
 const paths = ['C:\\Notes\\one.txt', 'C:\\Notes\\two.txt'];
 assert.deepEqual(getClipFilePaths({file_paths:JSON.stringify([...paths, null, 3, ' ']),text_content:null}), paths);
 assert.deepEqual(getClipFilePaths({file_paths:'{}',text_content:paths.join('\r\n')}),paths);
 assert.deepEqual(getClipFilePaths({file_paths:'broken',text_content:paths[0]}),[paths[0]]);
 assert.deepEqual(getClipFilePaths({file_paths:null,text_content:null}),[]);
 const file = render(clip('file', null, {file_paths:JSON.stringify(paths)}));
 assert.equal(file.querySelector('button').textContent.trim(),'Reveal in Explorer');
 assert.equal(render(clip('file',null)).querySelector('button'),null);
});
