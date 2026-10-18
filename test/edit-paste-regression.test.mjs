import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

async function loadEditor(invoke) {
  const source = fs.readFileSync(new URL('../src/lib/entryEdit.ts', import.meta.url), 'utf8')
    .replace("import { invoke } from '@tauri-apps/api/core';", 'const invoke = globalThis.__editInvoke;');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  globalThis.__editInvoke = invoke;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}#${Math.random()}`);
}

test('paste waits for the blur save after the dirty buffer has been cleared', async () => {
  let release;
  let stored = 'old';
  const editor = await loadEditor(async (command, args) => {
    if (command === 'update_clip_text') {
      await new Promise(resolve => { release = resolve; });
      stored = args.text;
    }
  });
  const blur = editor.commitEntryText('clip', 'edited', 'overlay');
  await new Promise(resolve => setImmediate(resolve));
  let pasted;
  const paste = editor.waitForEntryText('clip').then(() => { pasted = stored; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pasted, undefined);
  release();
  await Promise.all([blur, paste]);
  assert.equal(pasted, 'edited');
});

test('overlapping saves serialize so the newest edit wins', async () => {
  let release;
  const writes = [];
  const editor = await loadEditor(async (command, args) => {
    if (command !== 'update_clip_text') return;
    if (args.text === 'first') await new Promise(resolve => { release = resolve; });
    writes.push(args.text);
  });
  const first = editor.commitEntryText('clip', 'first', 'overlay');
  const second = editor.commitEntryText('clip', 'second', 'overlay');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, []);
  release();
  await editor.waitForEntryText('clip');
  await Promise.all([first, second]);
  assert.deepEqual(writes, ['first', 'second']);
});

test('failed saves block stale paste until a successful retry', async () => {
  let failing = true;
  const editor = await loadEditor(async command => {
    if (command === 'update_clip_text' && failing) throw new Error('write failed');
  });
  await assert.rejects(editor.commitEntryText('clip', 'edited', 'main'), /write failed/);
  await assert.rejects(editor.waitForEntryText('clip'), /write failed/);
  failing = false;
  await editor.commitEntryText('clip', 'edited', 'main');
  await editor.waitForEntryText('clip');
});

test('entry updates clear rich formats and update byte size in both window caches', async () => {
  const editor = await loadEditor(async () => {});
  const [updated] = editor.applyEntryUpdatedToList([
    { id: 'clip', content_type: 'rich_text', text_content: 'old', html_content: '<b>old</b>', rtf_content: 'old', file_size: 3 },
  ], { id: 'clip', content_type: 'text', text_content: 'new text', html_content: null, rtf_content: null, file_size: 8 });
  assert.equal(updated.html_content, null);
  assert.equal(updated.rtf_content, null);
  assert.equal(updated.content_type, 'text');
  assert.equal(updated.file_size, 8);
});
