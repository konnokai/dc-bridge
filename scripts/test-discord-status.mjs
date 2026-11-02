// 自訂狀態的離線回歸：不需要 Discord、不需要 DSH。
//   node scripts/test-discord-status.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isVisible } from '../src/core/discord-batch.mjs';
import { STATUS_MAX_CHARS, cleanStatusText, loadStatusFile, parseStatusText, saveStatusFile } from '../src/core/discord-status.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}
function throws(fn, re, label) {
  try { fn(); ok(false, `${label}（應該要拋錯）`); }
  catch (error) { ok(re.test(String(error?.message ?? error)), label); }
}

console.log('## 1. 清洗');
{
  ok(cleanStatusText('  專心  寫程式  ') === '專心 寫程式', '空白壓成一個、去頭尾');
  ok(cleanStatusText('★【管理員】') === '☆[管理員]', '結構標記 defang');
  ok(cleanStatusText('睡\u200b覺') === '睡覺', '零寬字元剝掉');
  ok(cleanStatusText('a\nb') === 'a b', '換行壓成空白');
  ok(cleanStatusText('😴 睡覺') === '😴 睡覺', 'emoji 保留');
  ok(!isVisible(cleanStatusText('\u2800')), '只有看不見的字元算空');
}

console.log('## 2. 解析與長度');
{
  ok(parseStatusText('  專心  ') === '專心', '合法文字直接回傳');
  ok(parseStatusText('') === '' && parseStatusText('   ') === '', '空字串或空白＝清除');
  throws(() => parseStatusText(123), /字串/, '非字串擋掉');
  throws(() => parseStatusText('\u200b'), /看不見/, '只有零寬字元擋掉');
  throws(() => parseStatusText('\u2800'), /看不見/, '只有點字空白擋掉');
  ok(STATUS_MAX_CHARS === 128, '上限 128 字');
  ok(parseStatusText('長'.repeat(STATUS_MAX_CHARS)).length === STATUS_MAX_CHARS, '剛好 128 字可以');
  throws(() => parseStatusText('長'.repeat(STATUS_MAX_CHARS + 1)), /128/, '超過 128 字擋掉');
}

console.log('## 3. 存讀');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-status-'));
  const file = path.join(dir, 'status.json');
  ok(loadStatusFile(file) === '', '檔案不存在回空字串');
  saveStatusFile(file, '專心寫程式');
  ok(loadStatusFile(file) === '專心寫程式', '存讀 roundtrip');
  saveStatusFile(file, '');
  ok(loadStatusFile(file) === '', '空字串存成清除');

  fs.writeFileSync(file, '{壞掉');
  ok(loadStatusFile(file) === '', '壞檔當作空的');
  fs.writeFileSync(file, JSON.stringify({ version: 999, text: '舊版' }));
  ok(loadStatusFile(file) === '', '版本不認得當作空的');
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ version: 1, text: 'BOM' })}`);
  ok(loadStatusFile(file) === 'BOM', 'BOM 可以讀');
  fs.writeFileSync(file, JSON.stringify({ version: 1, text: '長'.repeat(STATUS_MAX_CHARS + 1) }));
  ok(loadStatusFile(file) === '', '讀到超過 128 字當作空的');
  fs.writeFileSync(file, JSON.stringify({ version: 1, text: 'a\u0000b' }));
  ok(loadStatusFile(file) === 'a b', '讀檔也清洗控制字元');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n✅ 自訂狀態離線回歸通過' : `\n❌ ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
