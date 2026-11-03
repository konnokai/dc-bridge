// 把「引用」與「最近頻道訊息」整理成模型看得懂的文字。
//
// 為什麼不存歷史：DSH 的會話本身就有上下文，重複餵整段歷史會讓 token 爆掉。
// 這裡只補「模型沒看過的部分」——頻道裡不是對它說、但它應該知道的最近幾句。
// 取資料用 Discord 的 channel.messages.fetch（Read Message History 權限），
// 不需要 Message Content 特權意圖，也不用自己維護 ring buffer。
import { describeAge } from '../model-view.js';
import { defang, visibleName } from './discord-batch.mjs';

const clean = (value) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const cut = (value, max) => (value.length > max ? `${value.slice(0, max)}…` : value);

const values = (collection) => (Array.isArray(collection)
  ? collection
  : [...(collection?.values?.() ?? [])]);

// 模型看得到的媒體（圖片或影片）。沒有 contentType 時看副檔名；PDF、zip 不算，
// 不然 [圖片] 會標在模型其實看不到的附件上。
const MEDIA_NAME = /\.(png|jpe?g|gif|webp|avif|mp4|webm|mov)$/i;
const isMediaAttachment = (attachment) => {
  const type = String(attachment?.contentType ?? '');
  return type.startsWith('image/') || type.startsWith('video/') || MEDIA_NAME.test(String(attachment?.name ?? ''));
};

/**
 * 一則訊息看得到的內容：轉發本身是空的，文字與附件都在 messageSnapshots 裡。
 *
 * content 是本則自己的文字，forwarded 是快照組出來的 `[轉發] …`，text 是兩者併起來；
 * attachments、embeds、stickers、hasImage 是本則加全部快照。快照的 mention 一律用外層訊息解析：
 * discord.js 把快照的 guildId 填成來源伺服器，拿快照解析會讓別服的頻道名通過同伺服器檢查。
 */
export function messageParts(message) {
  const list = [message, ...values(message?.messageSnapshots)];
  const forwarded = list.slice(1)
    .map((snapshot) => ['[轉發]', String(snapshot?.content ?? '').trim()].filter(Boolean).join(' '))
    .join(' ');
  const content = String(message?.content ?? '');
  const attachments = list.flatMap((entry) => values(entry?.attachments));
  return {
    content,
    forwarded,
    text: [content, forwarded].filter(Boolean).join(' '),
    attachments,
    embeds: list.flatMap((entry) => values(entry?.embeds)),
    components: list.flatMap((entry) => values(entry?.components)),
    stickers: list.flatMap((entry) => values(entry?.stickers)),
    hasImage: attachments.some(isMediaAttachment),
  };
}

// Discord 的 component embed 與 Components V2 訊息把文字、圖片、按鈕放在 components 裡。
// 這裡只收模型看得到的內容，不碰 custom_id 這類互動資料；未知型別若還有子元件就繼續遞迴。
const COMPONENT_TEXT_MAX = 1200;
const COMPONENT_MEDIA_MAX = 20;
const COMPONENT_LINK_MAX = 5;

const componentName = (media, fallback) => {
  const id = String(media?.id ?? '').trim();
  if (id) return id.slice(0, 80);
  try {
    return new URL(String(media?.proxy_url ?? media?.proxyURL ?? media?.url ?? '')).pathname
      .split('/').filter(Boolean).pop()?.slice(0, 80) || fallback;
  } catch {
    return fallback;
  }
};

/**
 * 把 component 陣列拆成模型要的文字、連結按鈕與媒體。
 * discord.js 的 message.components 是 class 實例（toJSON 才是原始格式），
 * component embed 的 embed.data.components 已經是原始 snake_case，兩種都要收。
 */
export function componentParts(components) {
  const result = { texts: [], links: [], media: [], files: [] };
  let textChars = 0;

  const addText = (value) => {
    const text = clean(value);
    if (!text || textChars >= COMPONENT_TEXT_MAX) return;
    const kept = text.slice(0, COMPONENT_TEXT_MAX - textChars);
    result.texts.push(kept.length < text.length ? `${kept}…` : kept);
    textChars += kept.length;
  };

  const addMedia = (media, { kind, description = '', spoiler = false } = {}) => {
    if (result.media.length >= COMPONENT_MEDIA_MAX) return;
    const url = String(media?.proxy_url ?? media?.proxyURL ?? media?.url ?? '').trim();
    if (!url) return;
    result.media.push({
      name: componentName(media, `${kind || 'component'}.png`),
      url,
      contentType: String(media?.content_type ?? media?.contentType ?? ''),
      description: clean(description),
      spoiler: Boolean(spoiler),
      kind,
    });
  };

  const walk = (list, depth = 0) => {
    if (depth > 6) return;
    for (const raw of values(list)) {
      const component = raw?.toJSON?.() ?? raw;
      if (!component || typeof component !== 'object') continue;
      const type = Number(component.type);
      if (type === 10) {
        addText(component.content);
        continue;
      }
      if (type === 2) {
        if (component.style === 5 && component.url && result.links.length < COMPONENT_LINK_MAX) {
          result.links.push({
            label: clean(component.label ?? component.emoji?.name ?? '') || '連結',
            url: String(component.url).slice(0, 500),
          });
        }
        continue;
      }
      if (type === 11) {
        addMedia(component.media, {
          kind: 'thumbnail',
          description: component.description,
          spoiler: component.spoiler,
        });
        continue;
      }
      if (type === 12) {
        for (const item of values(component.items)) {
          addMedia(item?.media, {
            kind: 'gallery',
            description: item?.description,
            spoiler: item?.spoiler,
          });
        }
        continue;
      }
      if (type === 13) {
        const file = component.file ?? {};
        const name = clean(component.name ?? file.name ?? componentName(file, '檔案')) || '檔案';
        result.files.push({
          name,
          size: Number(component.size ?? file.size) || 0,
          attachmentId: String(file.attachment_id ?? file.attachmentId ?? ''),
          contentType: String(file.content_type ?? file.contentType ?? ''),
        });
        addMedia(file, { kind: 'file', spoiler: component.spoiler });
        continue;
      }
      if (Array.isArray(component.components)) walk(component.components, depth + 1);
      if (component.accessory) walk([component.accessory], depth + 1);
    }
  };

  walk(components);
  return result;
}

// Components V2 的附件預設不顯示，只有 File component 指到的才算看得到。
export function visibleAttachments(message, parts = messageParts(message)) {
  const entries = [message, ...values(message?.messageSnapshots)];
  const componentsV2 = entries.some((entry) => Number(entry?.flags ?? 0) & (1 << 15));
  if (!componentsV2) return parts.attachments;
  const files = entries.flatMap((entry) => componentParts(entry?.components).files);
  return parts.attachments.filter((attachment) => files.some((file) => (
    file.attachmentId === attachment.id || file.name === attachment.name
  )));
}

// Embed flags：Discord 內容掃描標記的敏感媒體，不把圖餵給模型。
const SENSITIVE_EMBED_FLAGS = (1 << 4) | (1 << 6) | (1 << 7);

export function embedIsSensitive(embed) {
  const flags = Number((embed?.data ?? embed)?.flags ?? 0);
  return (flags & SENSITIVE_EMBED_FLAGS) !== 0;
}

// 新會話第一批且有 ★：模型剛重置、還沒有自己的發言紀錄，給它一個看話題的提醒。
// 不強制用文字回；只有這批真的有人叫它時才帶，沒 ★ 的自由參與批次不加。
// persona 規定每則 ★ 都要接到（回一句或按 reaction），所以「跳過」只能講沒 ★ 的閒聊，不然模型會漏回 ★。
export const OPENING_HINT = '【開場】這是這個會話的第一批訊息。不用急著搶話，先看上面的話題你接不接得上。★ 的照規則要接到：接得上就用文字接一句，接不上就按 reaction。沒 ★ 的照工具協議，大多不接。';

/**
 * 引用訊息的一行摘要；沒有內容也沒有圖片就回空字串。
 * ref 是被引用那則的 #編號：原文只留 300 字，模型要用 view_message 看全文或看附件時靠它。
 */
export function formatQuote({ ref, author, content, hasImage, silent = false } = {}) {
  const who = `${silent ? '⊘' : ''}${clean(author) || '未知'}`;
  // 先截正文再接 [圖片]：反過來的話，長引文會把「有圖」這個唯一線索切掉。
  const text = [cut(clean(content), 300), hasImage ? '[圖片]' : ''].filter(Boolean).join(' ');
  if (!text) return '';
  return `[引用 ${ref ? `#${ref} ` : ''}${who}：${text}]`;
}

const absentMembers = new Set(); // `${guildId}:${userId}`：查不到的人，這個程序活著期間不再重試

/**
 * 補抓歷史訊息缺的成員，讓 `message.member` 之後查得到伺服器暱稱。
 *
 * bot 沒有 `GuildMembers` 意圖，成員快取只在有人說話時才有資料；重啟後讀歷史，
 * REST 抓回來的訊息不帶 `member`，名稱就會掉回全域名稱，跟頻道顯示的不一樣。
 * 一人抓一次，抓回來就進快取；離開伺服器的人查不到，交給呼叫端退回顯示名稱。
 */
export async function warmMemberCache(guild, messages) {
  if (!guild?.members?.fetch) return;
  const missing = new Map();
  for (const message of messages ?? []) {
    const id = message?.author?.id;
    if (!id || message.author.bot || message.webhookId || message.member) continue;
    const key = `${guild.id}:${id}`;
    if (!absentMembers.has(key)) missing.set(key, id);
  }
  await Promise.all([...missing].map(([key, id]) => guild.members.fetch(id).catch((error) => {
    // 只有 Discord 明確說「沒有這個人」才記住；網路錯誤、5xx 下一批還要能重試。
    if (error?.code === 10007 || error?.code === 10013) absentMembers.add(key);
    return null;
  })));
}

/**
 * 這則回覆的是哪一則。快取裡有就直接用；快取沒有就抓那一則（一次 API 呼叫）。
 * 引用是群友自己帶進對話的內容，少了它模型看不懂在回什麼，所以沒叫 bot 也要拿。
 *
 * 只認同一個頻道的一般回覆（type 0）：轉發與討論串起點會指到別的頻道，不能讓批次 prompt
 * 順便抓其他頻道的內容。所以也不用 fetchReference()，它會照 reference.channelId 去任何快取裡的頻道抓。
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
    const mark = entry.silent ? '⊘' : '';
    const author = `${entry.ref ? `#${entry.ref} ` : ''}${mark}${clean(defang(entry.author)) || '未知'}${entry.bot ? '（你）' : ''}${reply}`;
    const bodyText = cut(clean(defang(entry.content)), 400);
    const imageTag = entry.hasImage ? '[圖片]' : '';
    const body = [bodyText, imageTag].filter(Boolean).join(' ');
    const line = `${author}：${body}`;
    if (used + line.length > maxChars) {
      // 最新一則再長也要留一點，不然整個上下文會變空的。
      if (lines.length === 0) {
        // [圖片] 不算進留給正文的字數，不然長文一截圖就沒了。
        const room = Math.max(10, maxChars - author.length - 1 - (imageTag ? imageTag.length + 1 : 0));
        lines.unshift(`${author}：${[cut(bodyText, room), imageTag].filter(Boolean).join(' ')}`);
      }
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';
  const legend = lines.some((line) => line.includes('⊘')) ? '（⊘ = 已退出，只看不回；跨批的舊 ⊘ 看【黑名單現況】）' : '';
  return `【最近頻道訊息】${legend}\n${lines.join('\n')}`;
}

/**
 * 每一批都重算的黑名單現況。
 * 模型會把舊 prompt 與壓縮摘要裡的 ⊘ 當成現在，這一行是唯一可信的當下名單。
 */
export function formatBlacklistStatus(names, { max = 20 } = {}) {
  const list = [...new Set((names ?? []).map((name) => clean(defang(name))).filter(Boolean))];
  if (list.length === 0) {
    return '【黑名單現況】名單上目前沒有人；這一批訊息標 ⊘ 的人仍然只看不回，更早 prompt 或摘要裡的 ⊘ 只是當時的狀態。';
  }
  const shown = list.slice(0, max).map((name) => `「${name}」`).join('、');
  const more = list.length > max ? `…等 ${list.length} 人` : '';
  return `【黑名單現況】⊘ 只看不回：${shown}${more}。這一批訊息標 ⊘ 的人一樣只看不回；更早 prompt 或摘要裡的 ⊘ 只是當時的狀態，名單有沒有解除以這一行為準。`;
}

/**
 * 這批 prompt 要列的黑名單名稱：只認這個伺服器的成員，取法跟作者名稱一致（伺服器暱稱優先）。
 * 快取沒有成員就跳過：不印 id，免得模型把 id 當成另一個人，或把別伺服器的人列進來。
 */
export function guildBlacklistNames(ids, guild) {
  return (ids ?? []).flatMap((id) => {
    const member = guild?.members?.cache?.get?.(String(id));
    if (!member) return [];
    const name = visibleName(member.displayName, member.user?.displayName, member.user?.username);
    return name ? [name] : [];
  });
}
