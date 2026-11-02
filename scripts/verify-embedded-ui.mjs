import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {brotliDecompressSync} from 'node:zlib';
import assert from 'node:assert/strict';
const target=path.resolve(process.env.CARGO_TARGET_DIR||'src-tauri/target');
const exe=fs.readFileSync(path.resolve(process.argv[2]||path.join(target,'release/carbon.exe')));
const html=fs.readFileSync('dist/index.html','utf8');
const assets=[...new Set([...html.matchAll(/(?:src|href)="([^\"]+\.(?:css|js))"/g)].map(m=>m[1]))];
assert(assets.some(f=>f.endsWith('.css'))&&assets.some(f=>f.endsWith('.js')),'Production entry CSS/JS missing');
const candidates=[];
function walk(dir){if(!fs.existsSync(dir))return;for(const f of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,f.name);if(f.isDirectory())walk(full);else if(/\.(css|js)$/.test(f.name))candidates.push(full)}}
for(const dir of fs.readdirSync(path.join(target,'release/build'),{withFileTypes:true}))if(dir.isDirectory()&&dir.name.startsWith('carbon-'))walk(path.join(target,'release/build',dir.name,'out/tauri-codegen-assets'));
const proofs=[];let css='',js='';
for(const asset of assets){
 const source=fs.readFileSync(path.join('dist',asset.replace(/^\//,'')));if(asset.endsWith('.css'))css+=source.toString();else js+=source.toString();
 let match;
 for(const candidate of candidates.filter(f=>path.extname(f)===path.extname(asset))){
  const encoded=fs.readFileSync(candidate);let decoded=encoded;try{decoded=brotliDecompressSync(encoded)}catch{}
  if(decoded.equals(source)&&exe.includes(encoded)){match={asset,sourceBytes:source.length,embeddedBytes:encoded.length,sha256:crypto.createHash('sha256').update(source).digest('hex')};break}
 }
 assert(match,'Production asset not found intact in executable: '+asset);proofs.push(match);
}
assert(/--glass-base:\s*rgb\(0 0 0\s*\/\s*68%\)/.test(css),'Approved dark tint missing');
assert(/--glass-base:\s*rgb\(255 255 255\s*\/\s*48%\)/.test(css),'Approved light tint missing');
assert(css.includes('html.wm-hiding,html.wm-hidden{opacity:1!important}'),'Painted document backing rule missing');
assert(!css.includes('@keyframes ovFadeIn'),'Whole-document opacity animation returned');
assert(js.includes('prepare_window_present'),'Native frame preparation handshake missing');
assert(!js.includes('dataset.heartbeat'),'Idle DOM heartbeat returned');
console.log(JSON.stringify({approvedGlassAndRevealCodeEmbedded:true,assets:proofs},null,2));
