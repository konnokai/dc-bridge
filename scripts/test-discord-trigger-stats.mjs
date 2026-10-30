// 觸發對話統計的離線回歸：不需要 Discord、不需要 DSH。
//   node scripts/test-discord-trigger-stats.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TRIGGER_VERSION,
  createTriggerStore,
  loadTriggerFile,
  recordDraws,
  recordTriggers,
  saveTriggerFile,
  triggerStats,
  triggerUserList,
} from '../src/core/discord-trigger-stats.mjs';
import { triggerUsers } from '../src/core/discord-batch.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime(); // 2026-10-28 12:00 本地時間
const A = '111111111111111111';
const B = '222222222222222222';
const C = '333333333333333333';

console.log('## 1. 這批訊息是誰在叫 bot');
{
  ok(triggerUsers([
    { userId: A, author: '小明', direct: true },
    { userId: B, author: '小美', direct: false },
    { userId: A, author: '小明', direct: true },
  ]).map((user) => user.userId).join() === A, '有 ★ 時只算叫 bot 的人，同一個人只算一次');

  const all = triggerUsers([
    { userId: A, author: '小明', direct: false },
    { userId: B, author: '小美', direct: false },
    { userId: A, author: '小明二號', direct: false },
  ]);
  ok(all.length === 2 && all.find((user) => user.userId === A)?.name === '小明二號',
    '沒 ★ 時記整批發言者，名稱用最後一則');

  ok(triggerUsers([]).length === 0 && triggerUsers([{ author: '沒有 id' }]).length === 0, '空批次／缺 id 不記');
}

console.log('## 2. 累加與統計');
{
  const store = createTriggerStore();
  const first = recordTriggers(store, { users: [{ userId: A, name: '小明' }, { userId: B, name: '小美' }], key: 'ch:1', at: NOW - 2 * DAY });
  ok(first === 2 && store.entries === undefined && Object.keys(store.users).length === 2, '兩個新的人各記一次');

  recordTriggers(store, { users: [{ userId: A, name: '小明改' }, { userId: A, name: '重複' }, { userId: 'bad', name: '壞 id' }], key: 'ch:2', at: NOW });
  ok(store.users[A].count === 2 && store.users[A].name === '小明改', '同一個人累加次數、更新名稱、重複與壞 id 忽略');
  ok(store.users[B].count === 1 && store.users[B].lastKey === 'ch:1', '別人的次數與來源不受影響');

  const stats = triggerStats(store, { now: NOW, top: 3 });
  ok(stats.totalUsers === 2 && stats.totalTriggers === 3, '總人數與總次數');
  ok(stats.todayUsers === 1, '今天只算 lastAt 在今天的人');
  ok(stats.top[0].userId === A && stats.top[0].count === 2 && stats.top[1].userId === B, '最常觸發的人排前面');
  ok(triggerStats(store, { now: NOW, top: 0 }).top.length === 0, 'top 0 不回排行榜');
  ok(triggerUserList(store).map((user) => user.userId).join() === [A, B].join(), '完整名單照次數排序');
}

console.log('## 2b. 繪圖次數');
{
  const store = createTriggerStore();
  recordTriggers(store, { users: [{ userId: A, name: '小明' }], key: 'ch:1', at: NOW - DAY });
  const before = { count: store.users[A].count, lastAt: store.users[A].lastAt, lastKey: store.users[A].lastKey };
  const updated = recordDraws(store, {
    users: [{ userId: A, name: '小明改' }, { userId: A, name: '重複' }, { userId: B, name: '小美' }, { userId: 'bad', name: '壞 id' }],
    at: NOW,
  });
  ok(updated === 2 && store.users[A].drawCount === 1 && store.users[B].drawCount === 1, '兩個有效的人各加一次繪圖');
  ok(store.users[A].count === before.count && store.users[A].lastAt === before.lastAt && store.users[A].lastKey === before.lastKey,
    '只加繪圖次數，不動對話次數與最後觸發');
  ok(store.users[A].name === '小明改', '繪圖時也更新顯示名稱');

  const stats = triggerStats(store, { now: NOW, top: 3 });
  ok(stats.totalDraws === 2, '統計總繪圖次數');
  ok(stats.top.find((user) => user.userId === A)?.drawCount === 1, '排行榜帶每個人的繪圖次數');
}

console.log('## 3. 檔案讀寫與壞檔');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-trigger-'));
  try {
    const file = path.join(dir, 'discord-triggers.json');
    const store = createTriggerStore();
    recordTriggers(store, { users: [{ userId: A, name: '小明' }], key: 'ch:1', at: NOW });
    recordDraws(store, { users: [{ userId: A, name: '小明' }], at: NOW });
    recordDraws(store, { users: [{ userId: B, name: '小美' }], at: NOW });
    saveTriggerFile(file, store);
    const loaded = loadTriggerFile(file);
    ok(loaded.warning === null && loaded.store.users[A]?.count === 1 && loaded.store.users[A]?.name === '小明', '存檔後讀得回來');
    ok(loaded.store.users[A]?.drawCount === 1 && loaded.store.users[B]?.drawCount === 1,
      '繪圖次數存檔後讀得回來（只有畫圖的人也不會掉）');

    fs.writeFileSync(file, '{壞掉');
    const corrupt = loadTriggerFile(file);
    ok(corrupt.warning?.includes('不是合法 JSON') && Object.keys(corrupt.store.users).length === 0, '壞檔會警告並從空的重建');
    ok(fs.readdirSync(dir).some((name) => name.startsWith('discord-triggers.json.corrupt-')), '壞檔有備份');

    fs.writeFileSync(file, JSON.stringify({ version: TRIGGER_VERSION + 1, users: {} }));
    ok(loadTriggerFile(file).warning?.includes('格式錯誤'), '版本不認得也會備份重建');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('## 4. 人數上限');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-trigger-max-'));
  try {
    const store = createTriggerStore();
    for (let i = 0; i < 5; i += 1) {
      recordTriggers(store, {
        users: [{ userId: String(100000000000000000n + BigInt(i)), name: `人${i}` }],
        at: NOW - (5 - i) * DAY,
      });
    }
    const { dropped } = saveTriggerFile(path.join(dir, 'triggers.json'), store, { maxUsers: 2 });
    ok(dropped === 3 && Object.keys(store.users).length === 2, '超過上限丟最久沒觸發的人');
    ok(Object.values(store.users).every((entry) => entry.count === 1), '留下的人次數不變');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\n✅ Discord 觸發統計離線回歸通過' : `\n❌ ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
