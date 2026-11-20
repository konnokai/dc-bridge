// Discord 控制台靜態校驗：在無法跑 Playwright 的環境裡檢查前端結構契約。
// 前端原始碼在 console/（Vite + Vue），產物是單一檔案 public/discord-console.html。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const vueFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(relative);
    else if (entry.name.endsWith('.vue')) vueFiles.push(relative);
  }
})('console/src');
const source = vueFiles.map(read).join('\n');
const store = read('console/src/store.js');
const settings = read('console/src/tabs/SettingsTab.vue');
const consoleCore = read('src/core/discord-bridge-console.mjs');

console.log('## Discord 控制台');
{
  // ID 唯一：只比對模板裡寫死的 id，動態綁定（:id）由元件自己組合，不在這裡重複檢查。
  const ids = [...source.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((match) => match[1]);
  const dups = [...new Set(ids.filter((value, index) => ids.indexOf(value) !== index))];
  ok(dups.length === 0, 'Vue 模板的靜態 id 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);

  const built = read('public/discord-console.html');
  ok(/<div id="app"><\/div>/.test(built), '產物有掛載點 #app');
  ok(!/<script[^>]+src=/.test(built) && !/<link[^>]+rel="stylesheet"/.test(built), '產物是單一檔案：沒有外部 JS／CSS');
  for (const endpoint of ['/api/config', '/api/providers', '/api/usage', '/api/slang', '/api/knowledge', '/api/archive/list', '/api/memes/image', '/api/ceobe']) {
    ok(built.includes(endpoint), `產物打包了 ${endpoint}`);
  }

  ok(/id="style-channel"[^>]*aria-label="頻道"|aria-label="頻道"[^>]*id="style-channel"/.test(source), '频道风格卡片有频道下拉选单');
  ok(/id="require-mention-channels"/.test(source), '設定有單頻道 requireMentionInChannel 欄位');
  ok(/id="chatty-channels"/.test(source), '設定有 chattyChannels 欄位');
  ok(/chattyChannels:\s*lines\(cfg\.chattyChannels\)/.test(settings), '儲存會送 chattyChannels');
  ok(/chattyChannels:\s*next\.chattyChannels/.test(consoleCore), 'chattyChannels 會寫回 config.json');
  ok(/id="open-politics-channels"/.test(source), '設定有 openPoliticsChannels 欄位');
  ok(/openPoliticsChannels:\s*lines\(cfg\.openPoliticsChannels\)/.test(settings), '儲存會送 openPoliticsChannels');
  ok(/openPoliticsChannels:\s*next\.openPoliticsChannels/.test(consoleCore), 'openPoliticsChannels 會寫回 config.json');
  ok(/session\.preset \|\| '未知'/.test(source), '會話表顯示每個會話的 preset');
  ok(/openPoliticsChannels:\s*patch\?\.openPoliticsChannels \?\? cfg\.discord\.openPoliticsChannels/.test(consoleCore),
    '只送其他欄位時 openPoliticsChannels 沿用目前值');
  ok(/cfg\.requireMentionDisabled \? \{\} : \{[\s\S]*requireMentionInChannel:/.test(settings),
    '沒開意圖（勾選框鎖住）時不送 requireMentionInChannel，不蓋掉 config.json');
  ok(/mentionOverrides/.test(source), '總覽的頻道模式列出單頻道覆寫數');
  ok(/id="notes-count"/.test(source) && /id="note-rows"/.test(source), '頻道筆記卡片有計數與表格');
  ok(/api\('\/api\/notes'\)/.test(store) && /api\('\/api\/notes\/delete'/.test(source), '頻道筆記卡片接上查詢與刪除端點');
  ok(/id="memes-count"/.test(source) && /id="meme-rows"/.test(source), '梗圖卡片有計數與表格');
  ok(/api\('\/api\/memes'\)/.test(store) && /api\('\/api\/memes\/delete'/.test(source) && /\/api\/memes\/image\?id=/.test(store),
    '梗圖卡片接上查詢、刪除與縮圖端點');
  ok(/authorization: 'Bearer ' \+ auth\.token/.test(store), '梗圖縮圖用標頭帶 token，不放進網址');
  ok(/img-src 'self' blob:/.test(read('src/core/discord-console.mjs')), '控制台 CSP 允許 blob: 圖片（縮圖用）');
  ok(/id="archive-rows"/.test(source) && /id="archive-pager"/.test(source) && /id="archive-channel"/.test(source),
    '歷史歸檔卡片有表格、分頁與頻道選單');
  ok(/api\('\/api\/archive\/list'/.test(store) && /api\('\/api\/archive\/search'/.test(store)
    && /api\('\/api\/archive\/delete'/.test(source) && /api\('\/api\/archive\/channels'/.test(store),
  '歷史歸檔卡片接上瀏覽、搜尋、刪除與頻道端點');
  ok(/從歸檔刪掉這則/.test(source), '歸檔刪除要二次確認');
  ok(/id="ceobe-targets"/.test(source) && /id="ceobe-form"/.test(source), '小刻食堂卡片有頻道表單');
  ok(/api\('\/api\/ceobe'/.test(source), '小刻食堂卡片接上資料源端點');
  ok(/cfg\.discord\.ceobe = next\.ceobe/.test(consoleCore), '餅的設定會套用到記憶體');
  ok(/table\s*\{[^}]*table-layout:\s*fixed/.test(read('console/src/styles.css')), '所有表格固定欄寬');
  ok(/\.entry-table\s*\{[^}]*min-width/.test(read('console/src/styles.css'))
    && /\.entry-table tbody td\s*\{[^}]*height:\s*84px/.test(read('console/src/styles.css')), '黑話／頻道表固定列高');

  const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-console.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  ok(check.status === 0, '控制台產物與 console/ 原始碼一致（沒忘記重建）', (check.stdout || check.stderr || '').trim().split('\n').at(-1) ?? '');
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
