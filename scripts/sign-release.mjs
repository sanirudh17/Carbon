import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const version=process.argv[2];
if(!/^\d+\.\d+\.\d+$/.test(version||''))throw Error('Usage: node scripts/sign-release.mjs VERSION');
const targetDir=process.env.CARGO_TARGET_DIR||'src-tauri/target';
const target=path.resolve(targetDir,'release/bundle/nsis','Carbon_'+version+'_x64-setup.exe');
if(!fs.existsSync(target))throw Error('Build the requested installer first.');
const env={...process.env};
if(!env.TAURI_SIGNING_PRIVATE_KEY){
 const keyPath=env.CARBON_SIGNING_KEY_PATH;
 if(!keyPath)throw Error('Set CARBON_SIGNING_KEY_PATH to an existing private key outside Git.');
 env.TAURI_SIGNING_PRIVATE_KEY=fs.readFileSync(keyPath,'utf8').trim();
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD??='';
const cli=path.resolve('node_modules/@tauri-apps/cli/tauri.js');
const result=spawnSync(process.execPath,[cli,'signer','sign',target],{env,encoding:'utf8',windowsHide:true});
if(result.status!==0)throw Error('Updater signing failed. Check the external key/password; signing output was withheld.');
if(!fs.existsSync(target+'.sig'))throw Error('Signer did not write the signature file.');
console.log('Updater signature written for Carbon '+version+'.');
