// Discord 控制台靜態校驗：在無法跑 Playwright 的環境裡檢查 HTML/JS 結構契約。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## Discord 控制台');
{
  const dc = fs.readFileSync(path.join(ROOT, 'public', 'discord-console.html'), 'utf8');
  const dcIds = [...dc.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const dcDups = [...new Set(dcIds.filter((v, i) => dcIds.indexOf(v) !== i))];
  ok(dcDups.length === 0, 'discord-console.html ID 唯一', dcDups.length ? `重复：${dcDups.join(', ')}` : `共 ${dcIds.length} 个`);
  ok(/<select id="style-channel"[^>]*aria-label="頻道"/.test(dc), '频道风格卡片有频道下拉选单');
  ok(/id="require-mention-channels"/.test(dc), '設定有單頻道 requireMentionInChannel 欄位');
  ok(/id="chatty-channels"/.test(dc), '設定有 chattyChannels 欄位');
  ok(/chattyChannels:\s*lines\(\$\('chatty-channels'\)\.value\)/.test(dc), '儲存會送 chattyChannels');
  ok(/chattyChannels:\s*next\.chattyChannels/.test(fs.readFileSync(path.join(ROOT, 'src', 'discord-bridge.js'), 'utf8')),
    'chattyChannels 會寫回 config.json');
  ok(/id="open-politics-channels"/.test(dc), '設定有 openPoliticsChannels 欄位');
  ok(/openPoliticsChannels:\s*lines\(\$\('open-politics-channels'\)\.value\)/.test(dc), '儲存會送 openPoliticsChannels');
  ok(/openPoliticsChannels:\s*next\.openPoliticsChannels/.test(fs.readFileSync(path.join(ROOT, 'src', 'discord-bridge.js'), 'utf8')),
    'openPoliticsChannels 會寫回 config.json');
  ok(/<th>Preset<\/th>/.test(dc) && /s\.preset \|\| '未知'/.test(dc), '會話表顯示每個會話的 preset');
  ok(/openPoliticsChannels:\s*patch\?\.openPoliticsChannels \?\? cfg\.discord\.openPoliticsChannels/
    .test(fs.readFileSync(path.join(ROOT, 'src', 'discord-bridge.js'), 'utf8')),
  '只送其他欄位時 openPoliticsChannels 沿用目前值');
  ok(/\.\.\.\(\$\('require-mention'\)\.disabled \? \{\} : \{[^}]*requireMentionInChannel:/.test(dc),
    '沒開意圖（勾選框鎖住）時不送 requireMentionInChannel，不蓋掉 config.json');
  ok(/mentionOverrides/.test(dc), '總覽的頻道模式列出單頻道覆寫數');
  ok(/id="notes-count"/.test(dc) && /id="note-rows"/.test(dc), '頻道筆記卡片有計數與表格');
  ok(/api\('\/api\/notes'\)/.test(dc) && /api\('\/api\/notes\/delete'/.test(dc), '頻道筆記卡片接上查詢與刪除端點');
  ok(/id="memes-count"/.test(dc) && /id="meme-rows"/.test(dc), '梗圖卡片有計數與表格');
  ok(/api\('\/api\/memes'\)/.test(dc) && /api\('\/api\/memes\/delete'/.test(dc) && /\/api\/memes\/image\?id=/.test(dc),
    '梗圖卡片接上查詢、刪除與縮圖端點');
  ok(/authorization: 'Bearer ' \+ token/.test(dc.slice(dc.indexOf('async function fetchMemeThumb'), dc.indexOf('function renderMemes'))),
    '梗圖縮圖用標頭帶 token，不放進網址');
  ok(/img-src 'self' blob:/.test(fs.readFileSync(path.join(ROOT, 'src', 'core', 'discord-console.mjs'), 'utf8')),
    '控制台 CSP 允許 blob: 圖片（縮圖用）');
  ok(/table\s*\{[^}]*table-layout:\s*fixed/.test(dc), '所有表格固定欄寬');
  ok(/\.entry-table\s*\{[^}]*min-width/.test(dc) && /\.entry-table tbody td\s*\{[^}]*height:\s*84px/.test(dc), '黑話／頻道表固定列高');
  const dcScript = [...dc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0] ?? '';
  try { new Function(dcScript); ok(true, 'discord-console.html 前端 JS 可解析'); }
  catch (e) { ok(false, 'discord-console.html 前端 JS 可解析', e.message); }
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
