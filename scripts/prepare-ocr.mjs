// Build-time preparation only. Carbon never downloads OCR during recognition.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(project, 'src-tauri/resources/ocr/manifest.json'), 'utf8'));
const output = path.join(project, 'src-tauri/binaries/ocr');
const cacheFlag = process.argv.indexOf('--cache');
const cache = path.resolve(cacheFlag >= 0 ? process.argv[cacheFlag + 1] : path.join(project, '.validation/ocr-cache'));
await fs.mkdir(output, { recursive: true });
await fs.mkdir(cache, { recursive: true });
async function valid(file, spec) {
  try {
    const bytes = await fs.readFile(file);
    return bytes.length === spec.bytes && crypto.createHash('sha256').update(bytes).digest('hex') === spec.sha256;
  } catch { return false; }
}
async function obtain(file, spec, url) {
  if (await valid(file, spec)) return;
  if (process.argv.includes('--offline')) throw new Error(`Missing or invalid bundled OCR asset: ${path.basename(file)}`);
  console.log(`Fetching pinned OCR asset: ${path.basename(file)}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`OCR download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error('Empty OCR download');
  const chunks = []; let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > spec.bytes) throw new Error(`Oversized OCR download: ${path.basename(file)}`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== spec.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== spec.sha256) {
    throw new Error(`OCR integrity check failed: ${path.basename(file)}`);
  }
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, file);
}
const missing = [];
for (const spec of manifest.files) {
  if (await valid(path.join(output, spec.name), spec)) continue;
  if (spec.local) {
    const source = path.join(project, spec.local);
    if (!await valid(source, spec)) throw new Error(`Invalid OCR notice: ${spec.name}`);
    await fs.copyFile(source, path.join(output, spec.name));
  } else if (spec.url) {
    const source = path.join(cache, spec.name);
    await obtain(source, spec, spec.url);
    await fs.copyFile(source, path.join(output, spec.name));
  } else missing.push(spec);
}
if (missing.length) {
  const archive = path.join(cache, 'runtime.zip');
  await obtain(archive, manifest.runtimeArchive, manifest.runtimeArchive.url);
  const stage = path.join(output, `.extract-${process.pid}`);
  await fs.mkdir(stage, { recursive: true });
  try {
    execFileSync('tar.exe', ['-xf', archive, '-C', stage, ...missing.map(spec => spec.archivePath)], { windowsHide: true });
    for (const spec of missing) {
      const source = path.join(stage, spec.archivePath);
      if (!await valid(source, spec)) throw new Error(`Invalid OCR runtime file: ${spec.name}`);
      await fs.copyFile(source, path.join(output, spec.name));
    }
  } finally {
    // Only remove this script's checked, owned extraction directory.
    if (path.dirname(stage) !== output || !path.basename(stage).startsWith('.extract-')) throw new Error('Invalid staging path');
    await fs.rm(stage, { recursive: true, force: true });
  }
}
for (const spec of manifest.files) {
  if (!await valid(path.join(output, spec.name), spec)) throw new Error(`Bundled OCR verification failed: ${spec.name}`);
}
await fs.copyFile(path.join(project, 'src-tauri/resources/ocr/manifest.json'), path.join(output, 'manifest.json'));
console.log(`Bundled OCR verified: ${manifest.engine}, ${(manifest.files.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(1)} MiB, offline-ready.`);
