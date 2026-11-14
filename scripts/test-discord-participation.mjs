// chatty 頻道的離線回歸：設定驗證、提示詞、回訪開話題。不需要 Discord、不需要 DSH。
//   node scripts/test-discord-participation.mjs
import fs from 'node:fs';
import path from 'node:path';
import { isChattyChannel, normalizeDiscordConfig } from '../src/core/discord-core.mjs';
import { CHATTY_FOLLOWUP_HINT, CHATTY_HINT_LINES, formatParticipationHint, isBotNamed, isMediaOnlyBatch, shouldYield, YIELD_WINDOW_MS } from '../src/core/discord-batch.mjs';
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
  for (const phrase of ['【參與度】', '就算它標 ★、問「你」也一樣', '⊘ 的人只是不回他', '新話題、或有人問全頻道', '只有圖片、連結、貼圖']) {
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

console.log('## 5. 回訪的每日額度（chatty 跟一般一樣）');
{
  // 拿掉 chatty 每天 2 次的特殊上限之後，只剩每天 6 次的共同上限。
  const store = createFollowupStore({ now: () => 0 });
  let accepted = 0;
  for (let i = 0; i < 7; i += 1) {
    const result = store.add(`ch:${ID_A}`, { minutes: 10 + i, note: `第 ${i} 次` });
    if (result.entry) {
      accepted += 1;
      store.remove(result.entry.id);
      continue;
    }
    ok(result.error?.includes('6 次'), 'chatty 第 7 次被擋（跟一般頻道同一個上限）');
  }
  ok(accepted === 6, 'chatty 一天可以排 6 次');
}

console.log('## 6. 橋接有接上');
{
  const bridge = fs.readFileSync(path.resolve('src/discord-bridge.js'), 'utf8');
  ok(bridge.includes('formatParticipationHint(chatty, { followup: cfg.discord.followup.enabled })'), '批次 prompt 會帶【參與度】');
  ok(/chatty \? '' : formatActivityLine\(activity\.stats\(key\)\)/.test(bridge), 'chatty 頻道不印發言頻率');
  ok(bridge.includes('shouldYield({'), '讓位閘門有接上');
  ok(bridge.includes('botLastByUser.get(key)?.get(userId)'), '讓位只看 bot 回給 T 的那幾則');
  ok(bridge.includes('replyTargetId(last?.message)'), '讓位要求 T 真的回覆 bot 那一則');
  ok(bridge.includes('botRepliedOthersAfter'), '讓位要求 bot 也回過插話的人');
  ok(bridge.includes('const gateTurn = !job.followup'), '讓位閘門所有頻道都跑，純媒體仍只給 chatty');
  ok(bridge.includes('YIELD_GATE_SHADOW'), '讓位閘門影子模式開關存在');
  ok(bridge.includes('isMediaOnlyBatch(job.entries)'), '純媒體閘門有接上');
  ok(bridge.includes('mediaOnly: !fullText'), '批次有記 mediaOnly');
  ok(bridge.includes('noteHuman(key, message)'), '⊘／人類訊息有進讓位緩衝');
  ok(bridge.indexOf('noteHuman(key, message)') < bridge.indexOf('cfg.discord.deny.self.includes(message.author.id)'),
    'noteHuman 在 deny.self 的 return 之前');
  ok(bridge.includes('openTopic: isChattyChannel(cfg.discord, job.channel?.id)'), '回訪依頻道決定能不能開話題');
  ok(bridge.includes("job.channel?.guild ? formatBlacklistStatus(guildBlacklistNames(cfg.discord.deny.self, job.channel.guild)) : ''"), '回訪帶黑名單現況');
  ok(bridge.includes('const starredIds = new Set(job.entries'), '批次把這批 ★ 的退出者挑出來');
  ok(bridge.includes('cfg.discord.deny.self.filter((id) => !starredIds.has(String(id)))'),
    '⊘ 名單排除這批 ★ 的退出者');
  ok(bridge.includes('{ stars: guildBlacklistNames([...starredIds], job.channel.guild) }'),
    '★ 名單跟 ⊘ 名單用同一份成員資料');
  const persona = fs.readFileSync(path.resolve('dsh/agent-presets/dc-chat/agent.cordis.yml'), 'utf8');
  ok(persona.includes('這批有【參與度】區塊時'), 'persona 說明【參與度】優先');
  ok(persona.includes('★ 優先於黑名單'), 'persona 明講 ★ 優先於黑名單');
  ok(persona.includes('插話接手就退出'), 'persona 明講插話接手就退出');
  ok(persona.includes('就算標 ★、問「你」也一樣'), '插話接手連 ★ 也適用');
  ok(persona.includes('符合下面「插話接手就退出」的除外'), '★ 規則排除插話接手');
  ok(persona.includes('符合「插話接手就退出」的訊息'), 'reaction 該按清單收插話接手');
  ok(CHATTY_HINT_LINES.join('').includes('標 ★'), '【參與度】的插話退出也明講 ★ 不例外');
  ok(persona.includes('他其他沒標 ★ 的訊息仍然只看不回'), 'persona 的 ⊘ 例外只限退出者本人');
  ok(persona.includes('他說的話仍然算在對話裡'), 'persona 明講 ⊘ 的話仍算對話');
}

console.log('## 7. 讓位閘門');
{
  const T = '111111111111111111';
  const U = '222222222222222222';
  const botLast = { ids: ['1010'], at: 1_010_000, replyTo: { id: '1000', authorId: T } };
  const third = [{ id: '1015', authorId: U }];
  const call = (extra = {}) => ({
    botLast,
    recent: third,
    batch: [{ id: '1020', userId: T }],
    replyToId: '1010',
    botAfter: true,
    now: 1_021_000,
    ...extra,
  });
  ok(shouldYield(call()), 'T 回覆 bot 那一則，中間有人插話 → 讓位');
  ok(!shouldYield(call({ recent: [] })), '沒有插話 → 不讓位');
  ok(!shouldYield(call({ replyToId: '' })), '★ 但沒回覆 bot 那一則 → 不讓位');
  ok(!shouldYield(call({ replyToId: '1005' })), '回覆的不是 bot 給他的那一則 → 不讓位');
  ok(shouldYield(call({
    botLast: { ids: ['1010', '1012'], at: 1_010_000, replyTo: { id: '1000', authorId: T } },
  })), '長訊息切成多段，回覆第一段 → 讓位');
  ok(!shouldYield(call({ botAfter: false })), 'bot 沒回過插話的人 → 不讓位');
  ok(!shouldYield(call({ othersStar: true })), '同批有別人的 ★ → 不讓位');
  ok(!shouldYield(call({ named: true })), '叫名字不讓位');
  ok(!shouldYield(call({ botLast: { ids: ['1010'], at: 1_010_000, replyTo: null } })), 'bot 沒回過他 → 不讓位');
  ok(!shouldYield(call({ batch: [{ id: '1020', userId: U }] })), '最後一則是別人 → 新話題');
  ok(!shouldYield(call({ now: botLast.at + YIELD_WINDOW_MS + 1 })), '超過 5 分鐘不讓位');
  ok(!shouldYield(call({ recent: [{ id: '1005', authorId: U }] })), '插話在 bot 回覆之前 → 不算');
  ok(!shouldYield(call({ recent: [{ id: '1015', authorId: T }] })), '只有 T 自己回來 → 不讓位');
  ok(!shouldYield(call({ recent: [{ id: 'not-a-snowflake', authorId: U }] })), 'id 不是數字 → 放行');
}
{
  ok(isMediaOnlyBatch([{ mediaOnly: true }, { mediaOnly: true }]), '整批純媒體');
  ok(!isMediaOnlyBatch([{ mediaOnly: true }, { mediaOnly: false }]), '有文字就不是純媒體');
  ok(!isMediaOnlyBatch([]), '空批次不是純媒體');
  ok(isBotNamed('大肥魚 你看這個'), '叫名字有認出來');
  ok(!isBotNamed('大家好'), '沒叫名字');
}

console.log(failures === 0 ? '\n全部通過' : `\n${failures} 項失敗`);
process.exitCode = failures === 0 ? 0 : 1;
