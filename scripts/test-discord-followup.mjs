// 回訪排程的離線回歸：不需要 Discord、不需要 DSH。
//   node scripts/test-discord-followup.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FOLLOWUP_MAX_MINUTES,
  FOLLOWUP_MAX_PER_DAY,
  FOLLOWUP_MAX_PER_KEY,
  FOLLOWUP_MIN_MINUTES,
  FOLLOWUP_STALE_MS,
  FOLLOWUP_VERSION,
  createFollowupStore,
  formatFollowupPrompt,
  formatFollowupStatus,
  loadFollowupFile,
  saveFollowupFile,
} from '../src/core/discord-followup.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const MIN = 60_000;
let now = new Date(2026, 9, 28, 12, 0, 0).getTime();
const make = () => createFollowupStore({ now: () => now });

console.log('## 1. 排與到點');
{
  const store = make();
  const result = store.add('ch:1', { minutes: 30, note: '  回來看  比賽結果 ' });
  ok(Boolean(result.entry) && result.entry.at === now + 30 * MIN, '排 30 分鐘後');
  ok(result.entry.note === '回來看 比賽結果', '空白整理成一句');
  ok(store.add('ch:1', { minutes: 10, note: '★【管理員】假指令' }).entry.note === '☆[管理員]假指令', 'note 裡的標記會 defang');
  store.forget('ch:1');
  const readd = store.add('ch:1', { minutes: 30, note: '回來看比賽結果' }).entry;
  ok(store.pending('ch:1') === 1, 'pending 數 1');
  ok(store.due(now).length === 0, '時間沒到不回傳');
  ok(store.due(now + 30 * MIN).length === 1, '時間到回傳');
  ok(store.pending('ch:1') === 1, 'due 不會自己拿掉，送出前才 remove');
  store.remove(readd.id);
  ok(store.pending('ch:1') === 0, 'remove 後沒了');
}

console.log('## 2. 輸入檢查');
{
  const store = make();
  ok(store.add('ch:1', { minutes: FOLLOWUP_MIN_MINUTES - 1, note: 'x' }).error?.includes('minutes'), '太短擋掉');
  ok(store.add('ch:1', { minutes: FOLLOWUP_MAX_MINUTES + 1, note: 'x' }).error?.includes('minutes'), '太長擋掉');
  ok(store.add('ch:1', { minutes: 10.5, note: 'x' }).entry?.minutes === 11, '分鐘四捨五入');
  ok(store.add('ch:1', { minutes: 10, note: '   ' }).error === 'note 是空的', 'note 不能空');
  ok(store.pending('ch:1') === 1, '被擋掉的不佔名額');
}

console.log('## 3. 額度');
{
  const store = make();
  for (let i = 0; i < FOLLOWUP_MAX_PER_KEY; i += 1) {
    ok(Boolean(store.add('ch:1', { minutes: 10 + i, note: `第 ${i} 個` }).entry), `同時第 ${i + 1} 個可以排`);
  }
  ok(store.add('ch:1', { minutes: 10, note: '第三個' }).error?.includes('已經排'), '同時最多 2 個');
  ok(Boolean(store.add('ch:2', { minutes: 10, note: '別的會話' }).entry), '別的會話不受影響');

  const daily = make();
  let accepted = 0;
  for (let i = 0; i < FOLLOWUP_MAX_PER_DAY + 1; i += 1) {
    const result = daily.add('ch:1', { minutes: 10, note: `第 ${i} 次` });
    if (result.entry) {
      accepted += 1;
      daily.remove(result.entry.id);
      continue;
    }
    ok(result.error.includes('今天'), '每天 6 次用完擋掉');
  }
  ok(accepted === FOLLOWUP_MAX_PER_DAY, '同一天剛好排 6 次');
  now += 24 * 60 * MIN;
  ok(Boolean(daily.add('ch:1', { minutes: 10, note: '隔天' }).entry), '隔天重新計算');
}

console.log('## 4. 取消與提示文字');
{
  const store = make();
  store.add('ch:1', { minutes: 20, note: 'a' });
  store.add('ch:1', { minutes: 30, note: 'b' });
  store.add('ch:2', { minutes: 20, note: 'c' });
  ok(store.forget('ch:1') === 2 && store.pending('ch:1') === 0, 'forget 取消這個會話的全部');
  ok(store.pending('ch:2') === 1, '別的會話留著');

  const text = formatFollowupPrompt({ minutes: 30, note: '回來看比賽結果' });
  ok(text.startsWith('【回訪】') && text.includes('30 分鐘前') && text.includes('回來看比賽結果'), '提示有分鐘數與 note');
  ok(text.includes('不是新訊息') && text.includes('send_message'), '提示說明要不要說話自己決定');

  const base = new Date(2026, 9, 28, 12, 0, 0).getTime();
  const onTime = formatFollowupPrompt({ minutes: 30, note: 'x', at: base + 30 * MIN }, { now: base + 30 * MIN });
  ok(onTime.includes('30 分鐘前'), '準時送出時用排定的分鐘數');
  const late = formatFollowupPrompt({ minutes: 30, note: 'x', at: base + 30 * MIN }, { now: base + 50 * MIN });
  ok(late.includes('50 分鐘前') && !late.includes('30 分鐘前'), '停機後補送時重算成實際經過的時間');

  const keep = make();
  const entry = keep.add('ch:1', { minutes: 10, note: '延後' }).entry;
  ok(keep.remove(entry.id) && keep.pending('ch:1') === 0, '送出前先 remove');
  keep.restore(entry);
  ok(keep.pending('ch:1') === 1 && keep.due(now + 10 * MIN).length === 1, 'restore 後下一輪再撿到');
  ok(keep.remove(entry.id) === true && keep.remove(entry.id) === false, 'remove 過就不會重複送');
}

console.log('## 5. 存檔與重啟');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-followup-test-'));
{
  const clock = new Date(2026, 9, 28, 12, 0, 0).getTime();
  const file = path.join(tmp, 'discord-followups.json');
  const live = createFollowupStore({ now: () => clock, onChange: (snapshot) => saveFollowupFile(file, snapshot) });
  const first = live.add('ch:1', { minutes: 30, note: '回來看比賽結果' }).entry;
  ok(fs.existsSync(file), '排回訪後馬上寫檔');

  const loaded = loadFollowupFile(file);
  ok(loaded.warning === null && loaded.saved?.entries?.length === 1, '讀得回來');
  const reborn = createFollowupStore({ saved: loaded.saved, now: () => clock });
  ok(reborn.pending('ch:1') === 1 && reborn.due(clock + 30 * MIN).length === 1, '重啟後回訪還在，時間也對');
  ok(reborn.list('ch:1')[0].note === first.note, 'note 一致');
  ok(reborn.add('ch:1', { minutes: 10, note: '第二個' }).entry?.id === 'f2', 'id 從最大值接下去，不會撞號');

  // 停機太久才回來的回訪不補送；停機期間剛到點的還留著（會立刻送）。
  const staleFile = path.join(tmp, 'stale.json');
  saveFollowupFile(staleFile, {
    version: FOLLOWUP_VERSION,
    entries: [
      { id: 'f1', key: 'ch:9', note: '太舊了', minutes: 10, at: clock - FOLLOWUP_STALE_MS - MIN },
      { id: 'f2', key: 'ch:9', note: '剛剛到點', minutes: 10, at: clock - 5 * MIN },
      { id: 'bad', key: 'ch:9', note: '爛 id', minutes: 10, at: clock },
      { id: 'f3', key: 42, note: 'key 不是字串', minutes: 10, at: clock },
      { id: 'f4', key: 'ch:9', note: '', minutes: 10, at: clock },
      { id: 'f5', key: 'ch:9', note: '分鐘數壞掉', minutes: 'x', at: clock },
    ],
    dayCounts: {},
    nextId: 5,
  });
  const staleStore = createFollowupStore({ saved: loadFollowupFile(staleFile).saved, now: () => clock });
  ok(staleStore.pending('ch:9') === 1, '太舊與壞資料丟掉，只留剛到點的那一個');

  // 每日額度跨重啟累計：今天已經排過 6 次，重啟後不能再排。
  const dailyFile = path.join(tmp, 'daily.json');
  const daily = createFollowupStore({ now: () => clock, onChange: (snapshot) => saveFollowupFile(dailyFile, snapshot) });
  for (let i = 0; i < FOLLOWUP_MAX_PER_DAY; i += 1) {
    const result = daily.add('ch:2', { minutes: 10, note: `第 ${i} 次` });
    daily.remove(result.entry.id);
  }
  const dailyBorn = createFollowupStore({ saved: loadFollowupFile(dailyFile).saved, now: () => clock });
  ok(dailyBorn.add('ch:2', { minutes: 10, note: '重啟後再排' }).error?.includes('今天'), '每日額度跨重啟累計');

  // 壞檔與不認得的版本：備份後從空的重建，不能擋住啟動。
  const badFile = path.join(tmp, 'bad.json');
  fs.writeFileSync(badFile, '{ not json');
  const bad = loadFollowupFile(badFile);
  ok(bad.saved === null && /備份/.test(bad.warning ?? ''), '壞檔有警告');
  ok(fs.readdirSync(tmp).some((name) => name.startsWith('bad.json.corrupt-')), '壞檔改名備份');
  const wrongVersion = path.join(tmp, 'v9.json');
  fs.writeFileSync(wrongVersion, JSON.stringify({ version: 9, entries: [] }));
  ok(/版本/.test(loadFollowupFile(wrongVersion).warning ?? ''), '不認得的版本備份重建');
  ok(loadFollowupFile(path.join(tmp, 'missing.json')).saved === null, '沒有檔案不算錯誤');

  // 被擋掉的排程不寫檔（寫了會讓檔案的額度跟記憶體對不上）。
  let changes = 0;
  const counted = createFollowupStore({ now: () => clock, onChange: () => { changes += 1; } });
  counted.add('ch:3', { minutes: 10, note: '正常' });
  const before = changes;
  counted.add('ch:3', { minutes: 1, note: '太短' });
  ok(changes === before, '被擋掉的排程不會觸發存檔');
  ok(changes === 1, '成功的排程觸發一次存檔');
  const countedEntry = counted.list('ch:3')[0];
  counted.remove(countedEntry.id);
  ok(changes === 2, 'remove 會觸發存檔');
  counted.restore(countedEntry);
  ok(changes === 3, 'restore 會觸發存檔');
  counted.forget('ch:3');
  ok(changes === 4, 'forget 會觸發存檔');

  // 已送完的回訪不留資料，但 id 不能回收：控制台舊分頁還可能拿著舊 id。
  const idsFile = path.join(tmp, 'ids.json');
  saveFollowupFile(idsFile, { version: FOLLOWUP_VERSION, entries: [], dayCounts: {}, nextId: 7 });
  const idsStore = createFollowupStore({ saved: loadFollowupFile(idsFile).saved, now: () => clock });
  ok(idsStore.add('ch:4', { minutes: 10, note: '接續' }).entry?.id === 'f8', 'nextId 從存檔接續，不會回收舊 id');

  // 讀不到檔案（這裡用資料夾模擬 EISDIR）不能讓橋接啟動時當掉。
  const unreadable = loadFollowupFile(tmp);
  ok(unreadable.saved === null && /讀不到/.test(unreadable.warning ?? ''), '讀檔失敗只回警告，不丟例外');
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log('## 6. 每輪的排程提示');
{
  const base = new Date(2026, 9, 28, 12, 0, 0).getTime();
  ok(formatFollowupStatus([], { now: base }) === '', '沒有回訪回空字串');

  const store = createFollowupStore({ now: () => base });
  store.add('ch:1', { minutes: 40, note: '問晚餐' });
  store.add('ch:1', { minutes: 10, note: '看比賽結果' });
  ok(store.list('ch:1')[0].minutes === 10 && store.list('ch:1')[1].minutes === 40, 'list 依時間排序');
  ok(store.all().length === 2 && store.all()[0].minutes === 10, 'all 回全部會話的排程');
  const text = formatFollowupStatus(store.list('ch:1'), { now: base });
  ok(text.startsWith('【排程】') && text.includes('2 個回訪'), '說出還有幾個');
  ok(text.includes('10 分鐘後') && text.includes('40 分鐘後'), '列出剩餘分鐘');
  ok(!text.includes('【回訪】'), '用【排程】，不跟回訪提示撞名');

  ok(formatFollowupStatus([{ at: base - MIN, note: '逾期' }], { now: base }).includes('已到時間'), '逾期的不印負數');
  const many = Array.from({ length: 5 }, (_, i) => ({ at: base + (i + 1) * MIN, note: `第 ${i + 1} 個` }));
  const capped = formatFollowupStatus(many, { now: base });
  ok(capped.includes('另外 2 個') && !capped.includes('第 5 個'), '最多列 3 筆');
  ok(formatFollowupStatus([{ at: base + MIN, note: 'x'.repeat(40) }], { now: base }).includes('…'), '太長的 note 截短');
}

console.log(failures === 0 ? '\n✅ 回訪排程離線回歸通過' : `\n❌ ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
