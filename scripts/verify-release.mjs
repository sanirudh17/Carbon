import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export function verifyUpdaterSignature(bytes,encodedSignature,encodedPublicKey){
 const pubLines=Buffer.from(encodedPublicKey.trim(),'base64').toString('utf8').trim().split(/\r?\n/);
 const sigLines=Buffer.from(encodedSignature.trim(),'base64').toString('utf8').trim().split(/\r?\n/);
 const pub=Buffer.from(pubLines[1]||'','base64'),sig=Buffer.from(sigLines[1]||'','base64');
 assert.equal(pub.length,42);assert.equal(sig.length,74);assert(pub.subarray(2,10).equals(sig.subarray(2,10)),'Updater key ID mismatch');
 assert(sigLines[2]?.startsWith('trusted comment: '),'Invalid trusted comment');
 const algorithm=sig.subarray(0,2).toString();assert(['Ed','ED'].includes(algorithm),'Unknown signature algorithm');
 const key=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pub.subarray(10)]),format:'der',type:'spki'});
 const message=algorithm==='ED'?crypto.createHash('blake2b512').update(bytes).digest():bytes;
 assert(crypto.verify(null,message,key,sig.subarray(10)),'Invalid installer signature');
 // Same trusted-comment construction as minisign-verify used by Tauri.
 const global=Buffer.concat([sig.subarray(10),Buffer.from(sigLines[2].slice(17))]);
 assert(crypto.verify(null,global,key,Buffer.from(sigLines[3]||'','base64')),'Invalid trusted-comment signature');
 return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))){
 const version=process.argv[2];assert(/^\d+\.\d+\.\d+$/.test(version||''),'Pass the release version');
 const root=path.resolve(process.argv[3]||'.validation/release');
 const name='Carbon_'+version+'_x64-setup.exe';const bytes=fs.readFileSync(path.join(root,name));
 const signature=fs.readFileSync(path.join(root,name+'.sig'),'utf8').trim();
 const manifestBytes=fs.readFileSync(path.join(root,'latest.json'));assert(!manifestBytes.subarray(0,3).equals(Buffer.from([239,187,191])),'Manifest has a BOM');
 const manifest=JSON.parse(manifestBytes.toString('utf8')),config=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8'));
 assert.equal(config.version,version);assert.equal(manifest.version,version);
 assert.equal(JSON.parse(fs.readFileSync('package.json','utf8')).version,version);
 assert.equal(JSON.parse(fs.readFileSync('package-lock.json','utf8')).version,version);
 assert.equal(JSON.parse(fs.readFileSync('package-lock.json','utf8')).packages[''].version,version);
 const cargoToml=fs.readFileSync('src-tauri/Cargo.toml','utf8');
 const cargoLock=fs.readFileSync('src-tauri/Cargo.lock','utf8');
 assert.equal(cargoToml.split(String.fromCharCode(10)).find(line=>line.startsWith('version = ')).split('"')[1],version);
 assert.equal(cargoLock.split('name = "carbon"')[1].split(String.fromCharCode(10)).find(line=>line.startsWith('version = ')).split('"')[1],version);
 assert.equal(manifest.platforms['windows-x86_64'].url,'https://github.com/sanirudh17/Carbon/releases/download/v'+version+'/'+name);
 assert.equal(manifest.platforms['windows-x86_64'].signature,signature);assert(Number.isFinite(Date.parse(manifest.pub_date)));
 verifyUpdaterSignature(bytes,signature,config.plugins.updater.pubkey);
 const altered=Buffer.from(bytes);altered[Math.floor(altered.length/2)]^=1;assert.throws(()=>verifyUpdaterSignature(altered,signature,config.plugins.updater.pubkey),'Tampered installer must fail');
 const checksums=fs.readFileSync(path.join(root,'SHA256SUMS'),'utf8').trim().split(/\r?\n/);assert.equal(checksums.length,3);
 for(const line of checksums){
  const match=line.match(/^([a-f0-9]{64})  (.+)$/);assert(match,'Malformed checksum line');assert.equal(path.basename(match[2]),match[2]);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,match[2]))).digest('hex'),match[1]);
 }
 console.log('PASS release '+version+': versions, BOM-free updater, URL, matching signature/key ID, cryptographic verification, tamper rejection and checksums.');
}
