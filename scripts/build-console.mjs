// 控制台前端：console/ 的原始碼用 Vite + Vue 打包，產出單一檔案 public/discord-console.html。
// 產物要進版控（伺服器只做 git checkout + npm ci，不跑 build）。--check 比對產物裡的
// 原始碼指紋，抓「改了原始碼忘了重建」；不用重建，所以任何平台都能跑。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { consoleSourceHash } from './console-source-hash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'public', 'discord-console.html');
const CONFIG = path.join(ROOT, 'console', 'vite.config.mjs');
const STAMP = /<!-- console-source:([0-9a-f]{64}) -->/;

if (process.argv.includes('--check')) {
  let html = '';
  try {
    html = fs.readFileSync(TARGET, 'utf8');
  } catch { /* 下面一起報 */ }
  const match = STAMP.exec(html);
  if (!match) {
    console.log('FAIL 控制台產物沒有來源標記：跑 npm run build:console 後再提交');
    process.exit(1);
  }
  if (match[1] !== consoleSourceHash(ROOT)) {
    console.log('FAIL 控制台產物與 console/ 原始碼不一致：跑 npm run build:console 後再提交');
    process.exit(1);
  }
  console.log('OK   控制台產物與原始碼一致');
  process.exit(0);
}

function viteBin() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('vite/package.json');
    return path.join(path.dirname(pkg), 'bin', 'vite.js');
  } catch {
    return null;
  }
}

const bin = viteBin();
if (!bin) {
  console.log('找不到 vite，先 npm install');
  process.exit(1);
}

const result = spawnSync(process.execPath, [bin, 'build', '--config', CONFIG], { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status ?? 1);
