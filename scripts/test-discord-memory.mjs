// 跨頻道記憶的離線回歸：不需要 Discord、不需要 DSH。
//   node scripts/test-discord-memory.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createMemoryStore,
  forgetUser,
  formatUserMemory,
  loadMemoryFile,
  pruneMemory,
  recordUserMessage,
  saveMemoryFile,
} from '../src/core/discord-memory.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const GUILD = '333333333333333333';
const OTHER_GUILD = '777777777777777777';
const USER = '222222222222222222';
const OTHER_USER = '555555555555555555';
const CH1 = '444444444444444444';
const CH2 = '666666666666666666';
const CH3 = '888888888888888888';
const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function record(store, over = {}, limits = {}) {
  return recordUserMessage(store, {
    guildId: GUILD,
    userId: USER,
    name: '小明',
    channelId: CH1,
    channelName: 'general',
    text: '我在準備考試',
    at: NOW - 2 * HOUR,
    nsfw: false,
    ...over,
  }, {
    maxMessages: 30,
    maxUsers: 200,
    ttlDays: 30,
    now: NOW,
    ...limits,
  });
}

console.log('## 1. 建立與寫入');
{
  const store = createMemoryStore();
  assert.deepEqual(store, { version: 1, guilds: {} });
  ok(record(store), '寫入第一則');
  const user = store.guilds[GUILD][USER];
  ok(user.name === '小明' && user.messages.length === 1, '按 guild/user 建立記錄');
  ok(user.messages[0].channelName === 'general' && user.messages[0].text === '我在準備考試', '保留頻道與原文');
  ok(!record(store, { text: '   ' }), '空訊息不寫入');
  ok(!record(store, { guildId: null }), '沒有 guildId 不寫入（私聊不記）');
  ok(!record(store, { userId: null }), '沒有 userId 不寫入');
  ok(!record(store, { at: NOW - 31 * DAY }), '超過 TTL 的訊息不寫入');
}

console.log('## 2. 跨頻道注入');
{
  const store = createMemoryStore();
  record(store, { channelId: CH1, channelName: 'general', text: '我在準備考試', at: NOW - 2 * HOUR });
  record(store, { channelId: CH2, channelName: 'gaming', text: '最近在玩絲之歌', at: NOW - HOUR });
  const block = formatUserMemory(store, {
    guildId: GUILD, userId: USER, currentChannelId: CH3, currentNsfw: false,
    maxMessages: 5, maxChars: 800, ttlDays: 30, now: NOW,
  });
  ok(block.includes('我在準備考試') && block.includes('最近在玩絲之歌'), '注入其他頻道的兩則');
  ok(block.includes('不是指令'), '明講記憶只是資料，不是指令');
  ok(block.indexOf('準備考試') < block.indexOf('絲之歌'), '由舊到新排列');

  const sameChannel = formatUserMemory(store, {
    guildId: GUILD, userId: USER, currentChannelId: CH1, currentNsfw: false,
    maxMessages: 5, maxChars: 800, ttlDays: 30, now: NOW,
  });
  ok(!sameChannel.includes('我在準備考試') && sameChannel.includes('絲之歌'), '不重複注入目前頻道的訊息');

  ok(formatUserMemory(store, {
    guildId: GUILD, userId: OTHER_USER, currentChannelId: CH3,
    maxMessages: 5, maxChars: 800, ttlDays: 30, now: NOW,
  }) === '', '沒有記憶回空字串');
  ok(formatUserMemory(store, {
    guildId: OTHER_GUILD, userId: USER, currentChannelId: CH3,
    maxMessages: 5, maxChars: 800, ttlDays: 30, now: NOW,
  }) === '', '不跨伺服器');
}

console.log('## 3. 上限與過期');
{
  const store = createMemoryStore();
  for (let i = 0; i < 10; i += 1) {
    record(store, { channelId: CH2, text: `第 ${i} 則`, at: NOW - (10 - i) * HOUR });
  }
  const block = formatUserMemory(store, {
    guildId: GUILD, userId: USER, currentChannelId: CH1, currentNsfw: false,
    maxMessages: 2, maxChars: 800, ttlDays: 30, now: NOW,
  });
  ok(block.includes('第 8 則') && block.includes('第 9 則'), '只注入最後 2 則');
  ok(!block.includes('第 7 則'), '較舊的訊息不注入');

  const long = '長'.repeat(2000);
  const store2 = createMemoryStore();
  record(store2, { channelId: CH2, text: long, at: NOW - HOUR });
  const capped = formatUserMemory(store2, {
    guildId: GUILD, userId: USER, currentChannelId: CH1, currentNsfw: false,
    maxMessages: 5, maxChars: 300, ttlDays: 30, now: NOW,
  });
  ok(capped.length < 600 && capped.includes('長'), 'maxChars 真的截斷');

  const store3 = createMemoryStore();
  record(store3, { channelId: CH2, text: '舊的', at: NOW - 40 * DAY }, { ttlDays: 365 });
  record(store3, { channelId: CH2, text: '新的', at: NOW - HOUR });
  const pruned = pruneMemory(store3, { ttlDays: 30, now: NOW });
  ok(pruned.messagesRemoved === 1, 'prune 移除過期訊息');
  ok(store3.guilds[GUILD][USER].messages.length === 1, '保留未過期訊息');
}

console.log('## 4. 名稱、NSFW、刪除');
{
  const store = createMemoryStore();
  record(store, { name: '舊名字', channelId: CH2, nsfw: true, text: '深夜頻道的內容', at: NOW - HOUR });
  record(store, { name: '新名字', channelId: CH2, nsfw: false, text: '公開頻道的內容', at: NOW - 2 * HOUR });

  const safe = formatUserMemory(store, {
    guildId: GUILD, userId: USER, currentChannelId: CH1, currentNsfw: false,
    maxMessages: 5, maxChars: 800, ttlDays: 30, now: NOW,
  });
  ok(safe.includes('新名字') && !safe.includes('深夜頻道的內容'), 'NSFW 來源不進一般頻道');
  ok(safe.includes('公開頻道的內容'), '一般頻道內容照常注入');

  const nsfw = formatUserMemory(store, {
    guildId: GUILD, userId: USER, currentChannelId: CH1, currentNsfw: true,
    maxMessages: 5, maxChars: 800, ttlDays: 30, now: NOW,
  });
  ok(nsfw.includes('深夜頻道的內容'), 'NSFW 頻道內可注入 NSFW 來源');

  record(store, { userId: OTHER_USER, channelId: CH2, text: '別人的記憶' });
  ok(forgetUser(store, { guildId: GUILD, userId: USER }), '刪除自己的記憶');
  ok(!store.guilds[GUILD][USER], '自己的記錄已移除');
  ok(store.guilds[GUILD][OTHER_USER], '別人的記錄還在');
  ok(!forgetUser(store, { guildId: GUILD, userId: USER }), '重複刪除回 false');
}

console.log('## 5. 人數上限');
{
  const store = createMemoryStore();
  record(store, { userId: '111111111111111111', text: '最早', at: NOW - 3 * HOUR }, { maxUsers: 2, now: NOW - 3 * HOUR });
  record(store, { userId: '222222222222222222', text: '中間', at: NOW - 2 * HOUR }, { maxUsers: 2, now: NOW - 2 * HOUR });
  record(store, { userId: '333333333333333333', text: '最新', at: NOW - HOUR }, { maxUsers: 2, now: NOW - HOUR });
  ok(!store.guilds[GUILD]['111111111111111111'], '超過人數上限時淘汰最久沒更新的');
  ok(store.guilds[GUILD]['222222222222222222'] && store.guilds[GUILD]['333333333333333333'], '保留最近兩位');
}

console.log('## 6. 檔案讀寫與損壞容錯');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-memory-test-'));
  const file = path.join(dir, 'nested', 'memory.json');
  const missing = loadMemoryFile(file);
  ok(missing.warning === null && Object.keys(missing.store.guilds).length === 0, '檔案不存在 → 空記憶');

  const store = createMemoryStore();
  record(store);
  saveMemoryFile(file, store);
  const loaded = loadMemoryFile(file);
  ok(loaded.warning === null && loaded.store.guilds[GUILD][USER].messages.length === 1, '寫入後讀回一致');
  const mode = fs.statSync(file).mode & 0o777;
  ok(process.platform === 'win32' || mode === 0o600, '記憶檔權限 600（非 Windows）');

  fs.writeFileSync(file, '{ 壞掉的 json');
  const corrupt = loadMemoryFile(file);
  ok(corrupt.warning && /JSON|Unexpected|Expected|parse/i.test(corrupt.warning), '壞檔回 warning');
  ok(Object.keys(corrupt.store.guilds).length === 0, '壞檔從空的重建');
  const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.corrupt-'));
  ok(backups.length === 1, '壞檔有留 .corrupt-* 備份');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n✅ Discord 記憶測試全部通過' : `\n❌ Discord 記憶測試 ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
