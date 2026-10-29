// 把「引用」與「最近頻道訊息」整理成模型看得懂的文字。
//
// 為什麼不存歷史：DSH 的會話本身就有上下文，重複餵整段歷史會讓 token 爆掉。
// 這裡只補「模型沒看過的部分」——頻道裡不是對它說、但它應該知道的最近幾句。
// 取資料用 Discord 的 channel.messages.fetch（Read Message History 權限），
// 不需要 Message Content 特權意圖，也不用自己維護 ring buffer。
import { describeAge } from '../model-view.js';
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
 * 這則回覆的是哪一則。快取裡有就直接用；快取沒有就抓那一則（一次 API 呼叫）。
 * 引用是群友自己帶進對話的內容，少了它模型看不懂在回什麼，所以沒叫 bot 也要拿。
 *
 * 只認同一個頻道的一般回覆（type 0）：轉發與討論串起點會指到別的頻道，那裡可能不在白名單。
 * 所以也不用 fetchReference()，它會照 reference.channelId 去任何快取裡的頻道抓。
 */
export async function referencedMessage(message) {
  const reference = message?.reference;
  const id = reference?.messageId;
  if (!id || (reference.type ?? 0) !== 0 || reference.channelId !== message.channelId) return null;
  const cached = message.channel?.messages?.cache?.get(id);
  if (cached && !cached.partial) return cached;
  return message.channel.messages.fetch(id);
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
 * 訊息裡的連結「身分」：只看路徑，至少要有兩段。X／Facebook／Threads／IG 的修復服務
 * 常把網域換掉（fxtwitter、fixupx、ddinstagram…），路徑不變，所以用路徑認出同一條連結。
 * 只留兩段以上，避免不同網站剛好同一個短路徑也被當成同一條。
 */
export function linkPaths(text) {
  return [...String(text ?? '').matchAll(/https?:\/\/\S+/g)]
    .map((match) => {
      try {
        return new URL(match[0].replace(/[)>）\]，。]+$/, '')).pathname.replace(/\/+$/, '');
      } catch { return ''; }
    })
    .filter((path) => path.indexOf('/', 1) > 1);
}

/**
 * read_history／search_history 的 date：`YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`，用 bridge 主機時區。
 * 格式不對或日期不存在（例如 2 月 30 日）回 null。
 */
export function parseHistoryDate(value) {
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!matched) return null;
  const [, year, month, day, hour = '0', minute = '0'] = matched;
  const at = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  // Date 會把 2 月 30 日自動進位成 3 月，回讀比對才擋得住。
  if (at.getFullYear() !== Number(year) || at.getMonth() !== Number(month) - 1 || at.getDate() !== Number(day)
    || at.getHours() !== Number(hour) || at.getMinutes() !== Number(minute)) return null;
  return at;
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
