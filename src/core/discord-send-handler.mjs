// MCP `/send` 的處理器：只有送出成功才記觸發與繪圖次數。
//
// 抽成獨立模組是為了離線測試「純文字不算畫圖、送出失敗不算、
// 同一個回合送多張圖只算一次對話但每張都算畫圖」。
import path from 'node:path';
import { recordDraws, recordTriggers } from './discord-trigger-stats.mjs';

const textArg = (value, max = 100) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * @param options.agentSender  createAgentSender 的回傳值
 * @param options.turnUsers    key -> 這個回合的觸發者
 * @param options.turnTriggerRecorded key -> 這個回合已經記過對話
 * @param options.triggerStore 觸發統計 store
 * @param options.markTriggerDirty 標記統計要存檔
 * @param options.recordBotMessages 記 bot 發言頻率
 * @param options.takeDrawUsers (key, file) => users：背景生圖完成後送圖的回合沒有觸發者；用檔名拿生圖開始時記下的人
 * @param options.log
 */
export function createAgentSendHandler({
  agentSender,
  turnUsers,
  turnTriggerRecorded,
  triggerStore,
  markTriggerDirty,
  recordBotMessages,
  takeDrawUsers = () => [],
  log = () => {},
}) {
  function recordSent(key, file) {
    const users = turnUsers.get(key) ?? [];
    const drawUsers = file ? takeDrawUsers(key, file) : [];
    let changed = false;
    if (users.length > 0 && !turnTriggerRecorded.has(key)) {
      turnTriggerRecorded.add(key);
      if (recordTriggers(triggerStore, { users, key, at: Date.now() }) > 0) changed = true;
    }
    // 背景生圖完成後送圖的回合不一定有觸發者；有先記下檔名對應的人就用那組。
    const credited = drawUsers.length > 0 ? drawUsers : users;
    if (file && credited.length > 0 && recordDraws(triggerStore, { users: credited, at: Date.now() }) > 0) changed = true;
    if (changed) markTriggerDirty();
  }

  return async function send(body) {
    const content = typeof body.content === 'string' ? body.content : '';
    const file = textArg(body.file, 500);
    const result = await agentSender.send({
      token: body.token,
      content,
      replyTo: textArg(body.reply_to),
      sticker: textArg(body.sticker),
      file,
    });
    recordSent(result.key, file);
    recordBotMessages(result.key, result.refs?.length);
    log(`MCP 送出 ${result.key}（${content.length} 字${body.reply_to ? `，回覆 ${textArg(body.reply_to)}` : ''}${body.sticker ? `，貼圖 ${textArg(body.sticker)}` : ''}${file ? `，圖片 ${path.basename(file)}` : ''}）`);
    return result;
  };
}
