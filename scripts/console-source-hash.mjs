// console/ 原始碼的指紋：build 時寫進產物，--check 時重算，抓「改了原始碼忘了重建」。
// 用檔案內容而不是「重建一次再比對」，產物才不必在每台機器上逐位元組相同。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function consoleSourceHash(root) {
  const base = path.join(root, 'console');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(base, full).split(path.sep).join('/'));
    }
  })(base);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file + '\0');
    hash.update(fs.readFileSync(path.join(base, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
