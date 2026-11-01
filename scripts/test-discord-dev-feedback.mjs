// 開發回饋的離線回歸：不需要 Discord、不需要 DSH。
//   node scripts/test-discord-dev-feedback.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEV_FEEDBACK_GLOBAL_24H,
  DEV_FEEDBACK_MAX_BYTES,
  DEV_FEEDBACK_MAX_CHARS,
  DEV_FEEDBACK_MAX_TOTAL,
  DEV_FEEDBACK_PER_KEY_24H,
  countRecentDevFeedback,
  createDevFeedbackStore,
  deleteDevFeedbackById,
  devFeedbackOverview,
  findDuplicateDevFeedback,
  formatDevFeedbackList,
  loadDevFeedbackFile,
  recentDevFeedback,
  recordDevFeedback,
  saveDevFeedbackFile,
  updateDevFeedback,
  validateDevFeedbackFields,
  validateDevFeedbackSubmit,
} from '../src/core/discord-dev-feedback.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const KEY = 'ch:444444444444444444';
const OTHER = 'ch:555555555555555555';
const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

const add = (store, over = {}) => recordDevFeedback(store, {
  key: KEY,
  sessionId: 'ses_0123456789abcdefghijklmn',
  guildId: '333333333333333333',
  channelId: '444444444444444444',
  label: '#閒聊 · 伺服器名',
  messageIds: ['123456789012345678'],
  reason: '沒有辦法畫表格',
  need: '希望有表格工具',
  expected: '可以直接排版簡單表格',
  now: NOW,
  ...over,
});

console.log('## 1. 記與查');
{
  const store = createDevFeedbackStore();
  ok(devFeedbackOverview(store).length === 0, '新 store 是空的');
  const item = add(store);
  ok(item?.reason === '沒有辦法畫表格' && item.need === '希望有表格工具' && item.expected === '可以直接排版簡單表格',
    '三個欄位都記下來');
  ok(item.key === KEY && item.sessionId.startsWith('ses_') && item.guildId && item.channelId && item.label,
    '會話與頻道上下文一起記');
  ok(item.messageIds.length === 1 && item.id.startsWith('df_'), '觸發訊息 id 與記錄 id');
  ok(item.at === new Date(NOW).toISOString(), '時間用 ISO');

  ok(add(store, { reason: '  ' }) === null, '原因是空的就不記');
  ok(add(store, { need: '' }) === null, '需求是空的就不記');
  ok(add(store, { expected: '' }) === null, '預期結果是空的就不記');
  ok(add(store, { key: '' }) === null, '沒有會話就不記');
  ok(add(store, { reason: '第一行\n第二行' }).reason === '第一行\n第二行', '換行保留給開發者看');
  const dirty = add(store, { reason: '前\u0001中\u202e後\u200b尾' });
  ok(dirty.reason === '前中後尾', '控制字元、反向顯示與零寬字元都清掉');
  const manyIds = add(store, { messageIds: Array.from({ length: 15 }, (_, i) => String(1000 + i)) });
  ok(manyIds.messageIds.length === 10, '觸發訊息 id 最多留 10 個');
  const withUsers = add(store, { users: [{ userId: '222222222222222222', name: '小明' }, { userId: '', name: '沒有 id' }] });
  ok(withUsers.users.length === 1 && withUsers.users[0].name === '小明', '觸發者只留有名單的人');
}

console.log('## 2. 長度與洗版上限');
{
  const store = createDevFeedbackStore();
  const long = '字'.repeat(DEV_FEEDBACK_MAX_CHARS + 100);
  const item = add(store, { reason: long });
  ok(item.reason.length === DEV_FEEDBACK_MAX_CHARS + 1 && item.reason.endsWith('…'), '過長截到上限並標省略');
  ok(countRecentDevFeedback(store, { key: KEY, now: NOW }) === 1, '同一個 key 數得到');
  ok(countRecentDevFeedback(store, { key: OTHER, now: NOW }) === 0, '別的 key 不算');
  ok(countRecentDevFeedback(store, { key: KEY, now: NOW + DAY + 1 }) === 0, '超過 24 小時不算');

  const fresh = createDevFeedbackStore();
  for (let i = 0; i < DEV_FEEDBACK_PER_KEY_24H; i += 1) add(fresh, { now: NOW + i });
  ok(countRecentDevFeedback(fresh, { key: KEY, now: NOW + DAY - 1 }) === DEV_FEEDBACK_PER_KEY_24H,
    `24 小時內 ${DEV_FEEDBACK_PER_KEY_24H} 筆都數得到`);
  ok(countRecentDevFeedback(fresh, { key: KEY, now: NOW + DAY * 2 }) === 0, '全部過期後歸零');
}

console.log('## 2b. 送出前檢查');
{
  const valid = { key: KEY, reason: '理由', need: '需求', expected: '預期', now: NOW };
  const first = validateDevFeedbackSubmit(createDevFeedbackStore(), valid);
  ok(first.fields?.reason === '理由' && !first.error, '第一筆可以送');

  const second = validateDevFeedbackSubmit(createDevFeedbackStore(), { ...valid, usedThisTurn: 1 });
  ok(second.status === 429 && /一輪最多/.test(second.error), '同一輪第二筆擋下');

  ok(validateDevFeedbackSubmit(createDevFeedbackStore(), { ...valid, reason: '  ' }).status === 400,
    '空的原因回 400');
  ok(validateDevFeedbackSubmit(createDevFeedbackStore(), { ...valid, expected: '字'.repeat(DEV_FEEDBACK_MAX_CHARS + 1) }).status === 400,
    '超過 500 字回 400');
  ok(validateDevFeedbackSubmit(createDevFeedbackStore(), { ...valid, reason: '\u200b\u0001\u202e' }).status === 400,
    '全是控制字元等於空的，回 400');
  ok(!validateDevFeedbackSubmit(createDevFeedbackStore(), {
    ...valid,
    reason: `${'字'.repeat(DEV_FEEDBACK_MAX_CHARS)}\u200b\u0001`,
  }).error, '500 個看得到的字加零寬仍放行');

  const perKey = createDevFeedbackStore();
  for (let i = 0; i < DEV_FEEDBACK_PER_KEY_24H; i += 1) recordDevFeedback(perKey, { ...valid, now: NOW + i });
  const sixth = validateDevFeedbackSubmit(perKey, { ...valid, need: '第六筆', now: NOW + (DEV_FEEDBACK_PER_KEY_24H - 1) });
  ok(sixth.status === 429 && /24 小時/.test(sixth.error), '同一個頻道／私聊第 6 筆擋下');
  ok(!validateDevFeedbackSubmit(perKey, { ...valid, key: OTHER, need: '別的頻道的新需求', now: NOW }).error, '別的頻道不受影響');
  ok(!validateDevFeedbackSubmit(perKey, { ...valid, now: NOW + DAY + 1000 }).error, '過了 24 小時就放行');

  const global = createDevFeedbackStore();
  for (let i = 0; i < DEV_FEEDBACK_GLOBAL_24H; i += 1) {
    recordDevFeedback(global, { ...valid, key: `ch:${1000 + i}`, now: NOW + i });
  }
  const overGlobal = validateDevFeedbackSubmit(global, { ...valid, need: '第二十一筆', now: NOW + DEV_FEEDBACK_GLOBAL_24H });
  ok(overGlobal.status === 429 && /回饋已經有/.test(overGlobal.error), `全部合計 ${DEV_FEEDBACK_GLOBAL_24H} 筆後擋下`);

  const cleaned = validateDevFeedbackSubmit(createDevFeedbackStore(), { ...valid, reason: '前\u0001中\u202e後\u200b尾' });
  ok(cleaned.fields.reason === '前中後尾', '檢查時先清掉控制字元，敏感資訊閘門才看得到原文');
}

console.log('## 2c. 查自己的與編輯');
{
  const store = createDevFeedbackStore();
  const first = add(store, { reason: 'A', need: '需求一', now: NOW });
  add(store, { reason: 'B', need: '需求二', now: NOW + 1 });
  add(store, { key: OTHER, reason: '別頻道', need: '需求三', now: NOW + 2 });
  add(store, { key: 'ch:777777777777777777', guildId: '888888888888888888', reason: '別伺服器', need: '需求四', now: NOW + 3 });
  add(store, { key: 'dm:666666666666666666', guildId: '', label: '私聊 · 小明', reason: '私聊', need: '需求五', now: NOW + 4 });

  const mine = recentDevFeedback(store);
  ok(mine.length === 5 && mine[0].reason === '私聊', '列出所有頻道／私聊，新的排前面');
  const otherEntry = store.items.find((item) => item.key === OTHER);
  const text = formatDevFeedbackList(mine);
  ok(text.includes(first.id) && text.includes('原因：A') && text.includes('需求：需求二'), '清單帶 id 與三個欄位');
  ok(text.includes(otherEntry.id) && text.includes('原因：別頻道'), '全域清單包含別的頻道全文與 id');
  ok(text.includes('需求：需求四') && text.includes('需求：需求五'), '別的伺服器與私聊也列出來');
  ok(text.includes('#閒聊 · 伺服器名') && text.includes('私聊'), '來源顯示頻道；私聊不顯示對方名字');
  ok(!text.includes('小明'), '私聊來源不顯示使用者名稱');
  ok(recentDevFeedback(store, { limit: 1 }).length === 1, '可以限制筆數');
  ok(formatDevFeedbackList([]) === '', '沒有回饋回空字串');
  const clipped = formatDevFeedbackList([{ ...first, reason: '字'.repeat(500) }], { maxChars: 10 });
  ok(clipped.includes('…') && clipped.includes(first.id), '太長時仍留一筆並截斷');
  const many = Array.from({ length: 12 }, (_, i) => ({ ...first, id: `df_${i}`, reason: `第${i}` }));
  ok(formatDevFeedbackList(many, { maxChars: 200 }).includes('省略較舊的'), '超過字數預算時標明省略幾筆');

  const dup = findDuplicateDevFeedback(store, { need: ' 需求一 ', now: NOW });
  ok(dup?.id === first.id, '同一件事忽略空白也認得');
  ok(findDuplicateDevFeedback(store, { need: '需求一', now: NOW + DAY + 1000 }) === null, '超過 24 小時不算重複');
  ok(findDuplicateDevFeedback(store, { need: '需求三', now: NOW })?.id === otherEntry.id,
    '別的頻道提過的也算重複');
  const submitDup = validateDevFeedbackSubmit(store, { key: KEY, reason: 'x', need: '需求一', expected: 'y', now: NOW });
  ok(submitDup.duplicate?.id === first.id, '送出前檢查會回既有那筆');

  const edited = updateDevFeedback(store, { id: first.id, key: KEY, reason: 'A2', need: '需求一', expected: 'E2', now: NOW + 10 });
  ok(edited.reason === 'A2' && edited.expected === 'E2' && edited.updatedAt, '改自己的回饋並記 updatedAt');
  ok(edited.at === first.at, '改內容不動原本時間');
  const crossEdited = updateDevFeedback(store, {
    id: otherEntry.id, key: KEY, label: '#閒聊 · 伺服器名', reason: '改別頻道', need: '需求三', expected: 'z',
  });
  ok(crossEdited.reason === '改別頻道' && crossEdited.updatedBy === KEY && crossEdited.updatedByLabel === '#閒聊 · 伺服器名',
    '可以改其他頻道的回饋，並記下改的來源');
  ok(updateDevFeedback(store, { id: 'nope', key: KEY, reason: 'x', need: 'y', expected: 'z' }) === null, '找不到 id 回 null');
  ok(validateDevFeedbackFields({ reason: 'r', need: 'n', expected: 'e' }).fields.reason === 'r', '編輯用的欄位檢查可用');
}

console.log('## 3. 總量上限與刪除');
{
  const store = createDevFeedbackStore();
  for (let i = 0; i < DEV_FEEDBACK_MAX_TOTAL + 5; i += 1) {
    add(store, { reason: `第 ${i} 筆`, now: NOW + i });
  }
  ok(store.items.length === DEV_FEEDBACK_MAX_TOTAL, `最多留 ${DEV_FEEDBACK_MAX_TOTAL} 筆`);
  ok(store.items[0].reason === '第 5 筆', '超過上限丟最舊的');
  const list = devFeedbackOverview(store);
  ok(list[0].reason === `第 ${DEV_FEEDBACK_MAX_TOTAL + 4} 筆` && list.at(-1).reason === '第 5 筆', '控制台清單新的排前面');
  ok(deleteDevFeedbackById(store, list[0].id) && store.items.length === DEV_FEEDBACK_MAX_TOTAL - 1, '用 id 刪掉一筆');
  ok(deleteDevFeedbackById(store, list[0].id) === false, '再刪一次回 false');
  ok(deleteDevFeedbackById(store, '') === false, '空 id 不刪');
}

console.log('## 4. 檔案讀寫');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dev-feedback-'));
  const file = path.join(dir, 'dev-feedback.json');
  const empty = loadDevFeedbackFile(file);
  ok(empty.store.items.length === 0 && !empty.warning, '檔案不存在 → 空 store');

  const store = createDevFeedbackStore();
  add(store, { now: NOW, users: [{ userId: '222222222222222222', name: '小明' }] });
  add(store, { key: OTHER, reason: '另一個頻道', now: NOW + 1 });
  saveDevFeedbackFile(file, store);
  const loaded = loadDevFeedbackFile(file);
  ok(loaded.store.items.length === 2 && !loaded.warning, '寫入後讀回一致');
  ok(loaded.store.items[0].reason === '沒有辦法畫表格' && loaded.store.items[1].messageIds.length === 1,
    '讀回時欄位還在');
  ok(loaded.store.items[0].users[0].name === '小明', '觸發者讀回來');
  updateDevFeedback(loaded.store, {
    id: loaded.store.items[0].id, key: KEY, label: '私聊 · 小明', reason: '改過', need: '改過', expected: '改過', now: NOW + 5,
  });
  saveDevFeedbackFile(file, loaded.store);
  const reloaded = loadDevFeedbackFile(file).store.items.find((item) => item.id === loaded.store.items[0].id);
  ok(reloaded?.updatedAt && reloaded.updatedBy === KEY && reloaded.updatedByLabel === '私聊 · 小明',
    '改過的 updatedAt 與改的來源都存得回來');

  const bomFile = path.join(dir, 'bom.json');
  fs.writeFileSync(bomFile, `\ufeff${JSON.stringify({ version: 1, items: [{ at: new Date(NOW).toISOString(), key: KEY, reason: 'r', need: 'n', expected: 'e' }] })}`);
  ok(loadDevFeedbackFile(bomFile).store.items.length === 1, '有 BOM 的檔案也讀得進來');

  const manyFile = path.join(dir, 'many.json');
  const many = Array.from({ length: DEV_FEEDBACK_MAX_TOTAL + 5 }, (_, i) => ({
    id: `df_${i}`, at: new Date(NOW + i).toISOString(), key: KEY, reason: `第 ${i} 筆`, need: 'n', expected: 'e',
  }));
  fs.writeFileSync(manyFile, JSON.stringify({ version: 1, items: many }));
  const manyLoaded = loadDevFeedbackFile(manyFile);
  ok(manyLoaded.store.items.length === DEV_FEEDBACK_MAX_TOTAL
    && manyLoaded.store.items.at(-1).reason === `第 ${DEV_FEEDBACK_MAX_TOTAL + 4} 筆`, '讀檔超過上限時只留最新的');

  const hugeFile = path.join(dir, 'huge.json');
  fs.writeFileSync(hugeFile, 'x'.repeat(DEV_FEEDBACK_MAX_BYTES + 1));
  const huge = loadDevFeedbackFile(hugeFile);
  ok(huge.store.items.length === 0 && /過大/.test(huge.warning), '檔案過大備份後重建');

  const badEntries = {
    version: 1,
    items: [
      { at: new Date(NOW).toISOString(), key: KEY, reason: 'r', need: 'n' },
      { at: '不是時間', key: KEY, reason: 'r', need: 'n', expected: 'e' },
      { at: new Date(NOW).toISOString(), key: '', reason: 'r', need: 'n', expected: 'e' },
      { at: new Date(NOW).toISOString(), key: KEY, reason: 'r', need: 'n', expected: 'e' },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(badEntries));
  const filtered = loadDevFeedbackFile(file);
  ok(filtered.store.items.length === 1 && filtered.store.items[0].expected === 'e', '缺欄位、壞時間、沒有 key 的資料丟掉');

  fs.writeFileSync(file, '{ 壞掉的 json');
  const corrupt = loadDevFeedbackFile(file);
  ok(corrupt.store.items.length === 0 && /JSON/.test(corrupt.warning), '壞檔備份後重建，並回警告');
  ok(fs.readdirSync(dir).some((name) => name.startsWith('dev-feedback.json.corrupt-')), '壞檔有留備份');

  fs.writeFileSync(file, JSON.stringify({ version: 999, items: [] }));
  const wrongVersion = loadDevFeedbackFile(file);
  ok(wrongVersion.store.items.length === 0 && /版本/.test(wrongVersion.warning), '不認得的版本備份後重建');

  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} 項失敗`);
  process.exit(1);
}
console.log('\n全部通過');
