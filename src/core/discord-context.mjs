// 把「引用」與「最近頻道訊息」整理成模型看得懂的文字。
//
// 為什麼不存歷史：DSH 的會話本身就有上下文，重複餵整段歷史會讓 token 爆掉。
// 這裡只補「模型沒看過的部分」——頻道裡不是對它說、但它應該知道的最近幾句。
// 取資料用 Discord 的 channel.messages.fetch（Read Message History 權限），
// 不需要 Message Content 特權意圖，也不用自己維護 ring buffer。
import { describeAge } from '../qq-model-view.js';
import { defang } from './discord-batch.mjs';

const clean = (value) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const cut = (value, max) => (value.length > max ? `${value.slice(0, max)}…` : value);

/** 引用訊息的一行摘要；沒有內容也沒有圖片就回空字串。 */
export function formatQuote({ author, content, hasImage } = {}) {
  const who = clean(author) || '未知';
  const text = clean(content) || (hasImage ? '[圖片]' : '');
  if (!text) return '';
  return `[引用 ${who}：${cut(text, 300)}]`;
}

/**
 * 這則回覆的是哪一則。快取裡有就直接用，不打 API；快取沒有時只有叫 bot 的才去抓，
 * 自由參與時每則都抓會被 Discord 的 rate limit 卡住。不是回覆、或沒抓就回 null。
 *
 * 只認同一個頻道的一般回覆（type 0）：轉發與討論串起點會指到別的頻道，那裡可能不在白名單。
 * 所以也不用 fetchReference()，它會照 reference.channelId 去任何快取裡的頻道抓。
 */
export async function referencedMessage(message, direct) {
  const reference = message?.reference;
  const id = reference?.messageId;
  if (!id || (reference.type ?? 0) !== 0 || reference.channelId !== message.channelId) return null;
  const cached = message.channel?.messages?.cache?.get(id);
  if (cached) return cached;
  return direct ? message.channel.messages.fetch(id) : null;
}

const WEEKDAYS =['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

/**
 * 現在時間 + 訊息年齡。放在 prompt 最後，讓模型在動筆前看到。
 * 訊息超過 15 分鐘才提醒「剛看到」，避免正常秒回也道歉。
 */
export function formatTimeContext({ now = Date.now(), messageAt = 0 } = {}) {
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) return '';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const clock = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const age = Number(messageAt) > 0 ? now - Number(messageAt) : 0;
  const late = age >= 15 * 60_000
    ? `\n（這則訊息是 ${describeAge(messageAt, now)} 前發的；先自然說一句剛看到，不要用秒回語氣。）`
    : '';
  return `【現在】${clock}（${timeZone}）${late}`;
}

/**
 * 最近訊息區塊。entries 依時間先後（舊→新）。
 * 從最新往回裝，超過 maxChars 就停；回傳空字串代表沒有可用內容。
 */
export function formatRecentContext(entries, { maxMessages = 12, maxChars = 3000 } = {}) {
  const list = (entries ?? [])
    .filter((e) => e && (clean(e.content) || e.hasImage))
    .slice(-Math.max(0, maxMessages));
  if (list.length === 0 || maxChars <= 0) return '';

  const lines = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    const reply = entry.replyName ? ` ↪回覆 ${clean(defang(entry.replyName)) || '未知'}` : '';
    const author = `${entry.ref ? `#${entry.ref} ` : ''}${clean(defang(entry.author)) || '未知'}${entry.bot ? '（你）' : ''}${reply}`;
    const body = cut(clean(defang(entry.content)) || '[圖片]', 400);
    const line = `${author}：${body}`;
    if (used + line.length > maxChars) {
      // 最新一則再長也要留一點，不然整個上下文會變空的。
      if (lines.length === 0) {
        const room = Math.max(10, maxChars - author.length - 1);
        lines.unshift(`${author}：${cut(body, room)}`);
      }
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';
  return `【最近頻道訊息】\n${lines.join('\n')}`;
}
