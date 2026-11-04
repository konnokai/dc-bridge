// chatty 頻道的離線回歸：設定驗證、提示詞、回訪開話題。不需要 Discord、不需要 DSH。
//   node scripts/test-discord-participation.mjs
import fs from 'node:fs';
import path from 'node:path';
import { isChattyChannel, normalizeDiscordConfig } from '../src/core/discord-core.mjs';
import { CHATTY_FOLLOWUP_HINT, CHATTY_HINT_LINES, formatParticipationHint } from '../src/core/discord-batch.mjs';
import { createFollowupStore, formatFollowupPrompt } from '../src/core/discord-followup.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}
function throws(fn, pattern, label) {
  try {
    fn();
    ok(false, label);
  } catch (error) {
    ok(pattern.test(error?.message ?? ''), label);
  }
}

const ID_A = '111111111111111111';
const ID_B = '222222222222222222';

console.log('## 1. 設定');
{
  const cfg = normalizeDiscordConfig({ chattyChannels: [ID_A, ID_B] });
  ok(cfg.chattyChannels.length === 2 && cfg.chattyChannels.includes(ID_A), 'chattyChannels 保留頻道 ID');
  ok(normalizeDiscordConfig({}).chattyChannels.length === 0, '預設空');
  ok(normalizeDiscordConfig({ chattyChannels: null }).chattyChannels.length === 0, 'null 當成空');
  throws(() => normalizeDiscordConfig({ chattyChannels: ID_A }), /必須是陣列/, '不能是單一字串');
  throws(() => normalizeDiscordConfig({ chattyChannels: [Number(ID_A)] }), /字串/, '數字會掉精度，擋掉');
  throws(() => normalizeDiscordConfig({ chattyChannels: ['abc'] }), /非法 Discord ID/, '非 ID 擋掉');
}

console.log('## 2. 判斷');
{
  const cfg = normalizeDiscordConfig({ chattyChannels: [ID_A] });
  ok(isChattyChannel(cfg, ID_A), '名單內是 chatty');
  ok(!isChattyChannel(cfg, ID_B), '名單外不是 chatty');
  ok(!isChattyChannel({}, ID_A), '沒設定時不會爆');
  ok(!isChattyChannel(cfg, undefined), '沒頻道 ID 時不會爆');
}

console.log('## 3. 提示詞');
{
  ok(formatParticipationHint(false) === '', '一般頻道不帶【參與度】');
  ok(formatParticipationHint(undefined) === '', '沒傳值也不帶');
  const hint = formatParticipationHint(true);
  ok(hint.includes(CHATTY_HINT_LINES[0]), 'chatty 帶完整區塊');
  for (const phrase of ['【參與度】', '沒有 ★ 也可以接', '不用算發言頻率', '有人回你剛貼的圖']) {
    ok(hint.includes(phrase), `區塊包含「${phrase}」`);
  }
  ok(!hint.includes('schedule_followup'), 'followup 沒開就不叫它排回訪');
  const withFollowup = formatParticipationHint(true, { followup: true });
  ok(withFollowup.includes(CHATTY_FOLLOWUP_HINT) && withFollowup.includes('schedule_followup'), 'followup 開了才帶開話題提示');
  ok(!formatParticipationHint(false, { followup: true }).includes('schedule_followup'), '一般頻道開了 followup 也不帶');
}

console.log('## 4. 回訪開話題');
{
  const plain = formatFollowupPrompt({ minutes: 30, note: '回來看比賽' });
  ok(plain.includes('回來看比賽') && !plain.includes('開話題'), '一般回訪不提開話題');
  const open = formatFollowupPrompt({ minutes: 45, note: '看話題冷了沒' }, { openTopic: true });
  ok(open.includes('可以自己開話題') && open.includes('起一個新的'), 'chatty 回訪可以開新話題');
  ok(open.includes('看話題冷了沒'), 'note 原樣保留');
}

console.log('## 5. chatty 回訪的每日額度');
{
  const store = createFollowupStore({ now: () => 0 });
  for (let i = 0; i < 2; i += 1) {
    const result = store.add(`ch:${ID_A}`, { minutes: 10 + i, note: `第 ${i} 次`, maxPerDay: 2 });
    ok(Boolean(result.entry), `第 ${i + 1} 次可以排`);
    store.remove(result.entry.id);
  }
  const third = store.add(`ch:${ID_A}`, { minutes: 20, note: '第 3 次', maxPerDay: 2 });
  ok(third.error?.includes('2 次'), 'chatty 一天最多 2 次');

  const normal = createFollowupStore({ now: () => 0 });
  let accepted = 0;
  for (let i = 0; i < 6; i += 1) {
    const result = normal.add(`ch:${ID_B}`, { minutes: 10 + i, note: `一般 ${i}` });
    if (result.entry) { accepted += 1; normal.remove(result.entry.id); }
  }
  ok(accepted === 6, '一般頻道一天可以排 6 次');
  ok(normal.add(`ch:${ID_B}`, { minutes: 20, note: '第 7 次' }).error?.includes('6 次'), '一般頻道第 7 次被擋');
}

console.log('## 6. 橋接有接上');
{
  const bridge = fs.readFileSync(path.resolve('src/discord-bridge.js'), 'utf8');
  ok(bridge.includes('formatParticipationHint(chatty, { followup: cfg.discord.followup.enabled })'), '批次 prompt 會帶【參與度】');
  ok(/chatty \? '' : formatActivityLine\(activity\.stats\(key\)\)/.test(bridge), 'chatty 頻道不印發言頻率');
  ok(bridge.includes('openTopic: isChattyChannel(cfg.discord, job.channel?.id)'), '回訪依頻道決定能不能開話題');
  ok(bridge.includes("job.channel?.guild ? formatBlacklistStatus(guildBlacklistNames(cfg.discord.deny.self, job.channel.guild)) : ''"), '回訪帶黑名單現況');
  ok(bridge.includes('isChattyChannel(cfg.discord, key.slice(3)) ? 2 : undefined'), 'chatty 回訪套用每日 2 次');
  const persona = fs.readFileSync(path.resolve('dsh/agent-presets/dc-chat/agent.cordis.yml'), 'utf8');
  ok(persona.includes('這批有【參與度】區塊時'), 'persona 說明【參與度】優先');
}

console.log(failures === 0 ? '\n全部通過' : `\n${failures} 項失敗`);
process.exitCode = failures === 0 ? 0 : 1;
