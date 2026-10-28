// 跑 scripts/ 下全部 test-discord-*.mjs。
// 用 glob 而不是手寫清單：新增測試檔不用再改 package.json，也不會像以前那樣只跑到其中一個。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(scriptsDir)
  .filter((name) => /^test-discord-.+\.mjs$/.test(name) && name !== 'test-discord-all.mjs')
  .sort();

if (files.length === 0) {
  console.error('找不到任何 scripts/test-discord-*.mjs');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  console.log(`\nRunning ${file}`);
  const result = spawnSync(process.execPath, [path.join(scriptsDir, file)], { stdio: 'inherit', timeout: 180000 });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${file}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nDiscord suite: ${files.length - failed}/${files.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
