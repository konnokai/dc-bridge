// 回訪排程的離線回歸：不需要 Discord、不需要 DSH。
//   node scripts/test-discord-followup.mjs
import {
  FOLLOWUP_MAX_MINUTES,
  FOLLOWUP_MAX_PER_DAY,
  FOLLOWUP_MAX_PER_KEY,
  FOLLOWUP_MIN_MINUTES,
  createFollowupStore,
  formatFollowupPrompt,
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

  const keep = make();
  const entry = keep.add('ch:1', { minutes: 10, note: '延後' }).entry;
  ok(keep.remove(entry.id) && keep.pending('ch:1') === 0, '送出前先 remove');
  keep.restore(entry);
  ok(keep.pending('ch:1') === 1 && keep.due(now + 10 * MIN).length === 1, 'restore 後下一輪再撿到');
  ok(keep.remove(entry.id) === true && keep.remove(entry.id) === false, 'remove 過就不會重複送');
}

console.log(failures === 0 ? '\n✅ 回訪排程離線回歸通過' : `\n❌ ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
