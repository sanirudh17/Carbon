import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const keyContents = fs.readFileSync('.updater-key-v017', 'utf8').trim();
const env = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: keyContents,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""
};

const target = path.resolve('src-tauri/target/release/bundle/nsis/Carbon_0.1.18_x64-setup.exe');
console.log(`Signing ${target}...`);
const output = execSync(`npx tauri signer sign "${target}"`, { env, stdio: 'pipe' });
console.log(output.toString());
