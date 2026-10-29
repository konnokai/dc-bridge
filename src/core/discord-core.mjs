// Discord 橋接的純邏輯：准入、會話鍵、@ 判斷、提問／審批配對、分條。
//
// 這裡刻意不 import discord.js 或網路程式碼：這些判斷是安全邊界（誰能講話、誰能審批），
// 必須能在沒有 Discord、沒有 DSH 的環境下單獨測（scripts/test-discord-bridge.mjs）。
// 副作用只有讀寫 sessions 檔，集中在檔案最下面。
import fs from 'node:fs';
import path from 'node:path';
import { splitForCharLimit } from '../md-to-plain.js';

/** Discord 一則訊息的上限。 */
export const DISCORD_MAX_CHARS = 2000;

/**
 * 邀請連結帶的 scope。`applications.commands` 不能省：少了它 slash command 不會註冊。
 */
export const INVITE_SCOPES = Object.freeze(['bot', 'applications.commands']);

/**
 * 邀請連結的權限：只列目前橋接真的會用到的能力（最小權限）。
 *
 * 不含 Administrator / Manage Guild / Manage Messages / Attach Files：
 * 這些目前都用不到。bit 值與 discord.js 的 PermissionFlagsBits 一致，
 * scripts/test-discord-bridge.mjs 會對賬。
 */
export const INVITE_PERMISSIONS = Object.freeze([
  { key: 'ViewChannel', label: '查看頻道', bit: 1n << 10n },
  { key: 'SendMessages', label: '傳送訊息', bit: 1n << 11n },
  { key: 'SendMessagesInThreads', label: '在討論串傳送訊息', bit: 1n << 38n },
  { key: 'ReadMessageHistory', label: '讀取訊息歷史', bit: 1n << 16n },
  { key: 'AddReactions', label: '新增反應', bit: 1n << 6n },
  { key: 'UseExternalEmojis', label: '使用外部表情', bit: 1n << 18n },
  { key: 'SendPolls', label: '建立投票', bit: 1n << 49n },
]);

export function invitePermissionsBitfield() {
  return INVITE_PERMISSIONS.reduce((sum, permission) => sum | permission.bit, 0n);
}

/** 產生 bot 邀請連結；clientId 一定要是數字字串，避免把錯的 ID 貼出去。 */
export function buildInviteUrl(clientId) {
  const id = String(clientId ?? '').trim();
  if (!/^\d{5,25}$/.test(id)) throw new TypeError('clientId 必須是數字字串');
  const params = new URLSearchParams({
    client_id: id,
    permissions: invitePermissionsBitfield().toString(),
    scope: INVITE_SCOPES.join(' '),
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** `/console` 的連結按鈕：DSH 後台，加上帶 token 的 bridge 控制台（控制台關閉就不列）。 */
export function adminLinks({ dshBaseUrl, console: panel, consoleToken }) {
  const links = [{ label: 'DSH 後台', url: dshBaseUrl }];
  if (panel.enabled) {
    const host = panel.host.includes(':') ? `[${panel.host}]` : panel.host;
    links.push({ label: 'Bridge 控制台', url: `http://${host}:${panel.port}/?token=${encodeURIComponent(consoleToken)}` });
  }
  return links;
}

const APPROVE_WORDS = new Set(['通過', '通过', '同意', '允許', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒絕', '拒绝', '不同意', '不允許', '不允许', '駁回', '驳回', 'no', 'n', 'reject', 'deny']);

/**
 * 把 config.json 的 discord 段收斂成固定形狀。
 *
 * 型別錯誤直接拋：這是使用者手寫的檔案，寫錯就該在啟動時大聲失敗，而不是套預設值
 * 把白名單悄悄變成空的（或更糟：全部放行）。
 */
export function normalizeDiscordConfig(raw) {
  const src = raw ?? {};
  if (typeof src !== 'object' || Array.isArray(src)) throw new TypeError('config.json 的 discord 段必須是物件');

  const clamp = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

  return {
    token: typeof src.token === 'string' ? src.token.trim() : '',
    agentPreset: text(src.agentPreset, 'dc-chat'),
    workspaceTitle: text(src.workspaceTitle, 'Discord 聊天'),
    ownerIds: idList(src.ownerIds, 'discord.ownerIds'),
    allow: {
      guilds: idList(src.allow?.guilds, 'discord.allow.guilds'),
      channels: idList(src.allow?.channels, 'discord.allow.channels'),
      users: idList(src.allow?.users, 'discord.allow.users'),
    },
    deny: {
      guilds: idList(src.deny?.guilds, 'discord.deny.guilds'),
      channels: idList(src.deny?.channels, 'discord.deny.channels'),
      users: idList(src.deny?.users, 'discord.deny.users'),
      // 自己用 /blacklist 退出的名單：只有這份允許「@bot 或回覆 bot」的例外。
      self: idList(src.deny?.self, 'discord.deny.self'),
    },
    allowAllWhenEmpty: src.allowAllWhenEmpty === true,
    requireMentionInGuild: src.requireMentionInGuild !== false,
    messageContentIntent: src.messageContentIntent !== false,
    ackMessage: typeof src.ackMessage === 'string' ? src.ackMessage : '',
    maxMessageChars: clamp(src.maxMessageChars, DISCORD_MAX_CHARS, 200, DISCORD_MAX_CHARS),
    questionTimeoutMs: clamp(src.questionTimeoutMs, 5 * 60 * 1000, 10_000, 60 * 60 * 1000),
    autoCompactTokens: src.autoCompactTokens === 0 ? 0 : clamp(src.autoCompactTokens, 80_000, 10_000, 1_000_000),
    // 模型多久沒吐出第一個 token 就取消這一輪；0 = 關閉。工具已經開始跑就不受這個限制。
    ttftTimeoutMs: src.ttftTimeoutMs === 0 ? 0 : clamp(src.ttftTimeoutMs, 30_000, 5_000, 120_000),
    typing: src.typing !== false,
    sendDelayMs: clamp(src.sendDelayMs, 300, 0, 5000),
    sessionDir: typeof src.sessionDir === 'string' ? src.sessionDir.trim() : '',
    console: {
      enabled: src.console?.enabled !== false,
      // 預設只綁 loopback；要從別台開就填 LAN IP（或 0.0.0.0）。token 永遠是必須的。
      host: consoleHost(src.console?.host),
      port: clamp(src.console?.port, 3110, 1024, 65535),
      token: typeof src.console?.token === 'string' ? src.console.token.trim() : '',
    },
    media: {
      // 附件（圖片）轉發。關掉就只送文字。
      enabled: src.media?.enabled !== false,
      // 下載上限：超過就不抓（避免一條訊息拖垮橋接）。
      maxBytes: clamp(src.media?.maxBytes, 8 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
      // 送進模型前的單張上限；超過就本地縮圖（ffmpeg）。
      maxModelBytes: clamp(src.media?.maxModelBytes, 1024 * 1024, 128 * 1024, 3 * 1024 * 1024),
      // 縮圖後的長邊上限。256~2048 是 normalizeImageForModel 的硬範圍。
      maxLongEdge: clamp(src.media?.maxLongEdge, 1280, 256, 2048),
      maxCount: clamp(src.media?.maxCount, 4, 1, 8),
      timeoutMs: clamp(src.media?.timeoutMs, 25_000, 2000, 60_000),
    },
    context: {
      // 被 @／回覆時，抓最近幾則頻道訊息一起送進 prompt（Read Message History 權限）。
      enabled: src.context?.enabled !== false,
      messages: clamp(src.context?.messages, 12, 0, 50),
      maxChars: clamp(src.context?.maxChars, 3000, 0, 12000),
    },
    batch: {
      // 同一會話的訊息先等一下再合成一批送出，一批只開一個模型回合。
      debounceMs: clamp(src.batch?.debounceMs, 3000, 500, 30_000),
      maxWaitMs: clamp(src.batch?.maxWaitMs, 15_000, 1000, 120_000),
      maxMessages: clamp(src.batch?.maxMessages, 20, 1, 50),
    },
    security: {
      // 模型回覆若含本機路徑／憑證特徵或已知令牌，整條攔掉不送。
      blockSensitive: src.security?.blockSensitive !== false,
    },
    queue: {
      // DSH 連不上時的記憶體佇列（重啟會消失，跟 QQ 版一樣）。
      max: clamp(src.queue?.max, 50, 1, 200),
      retryMs: clamp(src.queue?.retryMs, 10_000, 2000, 60_000),
    },
    emoji: {
      // 每伺服器一份自訂表情目錄（scripts/build-discord-emojis.mjs 產生）。
      enabled: src.emoji?.enabled !== false,
      dir: typeof src.emoji?.dir === 'string' ? src.emoji.dir.trim() : '',
      maxCandidates: clamp(src.emoji?.maxCandidates, 12, 3, 30),
      maxChars: clamp(src.emoji?.maxChars, 600, 100, 3000),
    },
    reactions: {
      // 沒被 @ 的頻道訊息，偶爾加一個 reaction（不廢話）。
      enabled: src.reactions?.enabled === true,
      probability: clamp(src.reactions?.probability, 0.15, 0, 1),
      cooldownMs: clamp(src.reactions?.cooldownMs, 10 * 60_000, 10_000, 6 * 3600_000),
      maxPerHour: clamp(src.reactions?.maxPerHour, 10, 1, 100),
      minKeywordScore: clamp(src.reactions?.minKeywordScore, 2, 1, 10),
    },
    memory: {
      // 群友記憶：模型用 remember_user 記下的事。預設關閉（會保存關於使用者的文字）。
      enabled: src.memory?.enabled === true,
      maxFacts: clamp(src.memory?.maxFacts, 20, 5, 50),
      maxChars: clamp(src.memory?.maxChars, 800, 200, 3000),
    },
    notes: {
      // 頻道事件筆記：預設關閉（會保存頻道文字；自動摘要還會另外花 token）。
      enabled: src.notes?.enabled === true,
      injectMax: clamp(src.notes?.injectMax, 5, 1, 20),
      maxChars: clamp(src.notes?.maxChars, 600, 100, 3000),
      dailySummary: {
        enabled: src.notes?.dailySummary?.enabled === true,
        hour: clamp(src.notes?.dailySummary?.hour, 4, 0, 23),
      },
    },
    followup: {
      // 回訪：模型自己排「N 分鐘後回來看」。預設關閉（時間到了會多一個模型回合）。
      enabled: src.followup?.enabled === true,
    },
    slang: {
      // 黑話學習：從允許的頻道收集語料，學習會話產生候選，人工確認後才注入。
      // 預設關閉：會把頻道文字送去模型（成本 + 隱私），要開再開。
      enabled: src.slang?.enabled === true,
      extractMinMessages: clamp(src.slang?.extractMinMessages, 20, 5, 200),
      extractCooldownMs: clamp(src.slang?.extractCooldownMs, 10 * 60_000, 60_000, 6 * 3600_000),
      maxPerDay: clamp(src.slang?.maxPerDay, 40, 1, 500),
      injectMax: clamp(src.slang?.injectMax, 8, 1, 30),
      maxChars: clamp(src.slang?.maxChars, 1500, 200, 4000),
      maxCandidates: clamp(src.slang?.maxCandidates, 200, 10, 2000),
      maxConfirmed: clamp(src.slang?.maxConfirmed, 500, 10, 5000),
      learnerPreset: text(src.slang?.learnerPreset, 'dc-learner'),
      timeoutMs: clamp(src.slang?.timeoutMs, 90_000, 15_000, 300_000),
    },
  };
}

/** 控制台綁定位址：只擋空白/超長；IP 或 hostname 都交給 listen() 解析。 */function consoleHost(value) {
  if (value === undefined || value === null || value === '') return '127.0.0.1';
  if (typeof value !== 'string') throw new TypeError('discord.console.host 必須是字串');
  const host = value.trim();
  if (!host || host.length > 255 || /\s/.test(host)) throw new TypeError('discord.console.host 不是合法位址');
  return host;
}

/**
 * Discord ID 清單。
 *
 * 只收字串：snowflake 是 19 位數字，超過 Number.MAX_SAFE_INTEGER，寫成 JSON 數字在
 * JSON.parse 就已經掉精度了 —— 那時再轉字串只會得到一個錯的 ID，而且錯得很安靜。
 */
function idList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} 必須是陣列`);
  return value.map((item) => {
    if (typeof item !== 'string') {
      throw new TypeError(`${label} 的每一項都必須是字串（Discord ID 寫成數字會掉精度）：${JSON.stringify(item)}`);
    }
    const id = item.trim();
    if (!/^\d{5,25}$/.test(id)) throw new TypeError(`${label} 含非法 Discord ID：${JSON.stringify(item)}`);
    return id;
  });
}

/**
 * 會話鍵。伺服器頻道與討論串都用 channel id；私聊用對方的 user id。
 * 全程字串，不經 Number()。
 */
export function conversationKeyFor({ guildId, channelId, userId }) {
  if (guildId) {
    if (!channelId) throw new TypeError('伺服器訊息缺少 channelId');
    return `ch:${String(channelId)}`;
  }
  if (!userId) throw new TypeError('私聊訊息缺少 userId');
  return `dm:${String(userId)}`;
}

/** DSH 會話標題。用固定格式鎖住標題，DSH 才不會拿第一則 prompt 叫模型生摘要；名字查不到就用 ID。 */
export function sessionTitleFor(key, { guildName, channelName, userName } = {}) {
  const id = key.slice(key.indexOf(':') + 1);
  if (key.startsWith('dm:')) return `Discord 私聊｜${userName || id}`;
  return `Discord #${channelName || id}${guildName ? `｜${guildName}` : ''}`;
}

/**
 * 這則訊息所在的會話是否被允許。
 *
 * 伺服器頻道：guild 或 channel 命中白名單才放行；`allow.users` 不授權頻道
 * （否則「允許某人私聊」會意外變成「他到哪個伺服器都能用」）。
 * 私聊：只看 user。
 *
 * 討論串：白名單只看自己的 id（文件寫明），黑名單連母頻道（parentId）一起看；
 * 否則在被禁的頻道開一個討論串就能繞過黑名單。
 *
 * `ignoreUserDeny`：自己用 /blacklist 退出的人（`deny.self`）@bot 或回覆 bot 時，呼叫端傳 true，
 * 只跳過 self 那一關（而且只在伺服器頻道生效）。`deny.users` 是管理員封鎖，一律擋，沒有例外。
 */
export function isConversationAllowed(cfg, { guildId, channelId, parentId = null, userId, ignoreUserDeny = false }) {
  const id = String(userId);
  if (cfg.deny.users.includes(id)) return false;
  if (!(ignoreUserDeny && guildId) && cfg.deny.self.includes(id)) return false;

  if (guildId) {
    const guild = String(guildId);
    const channel = String(channelId);
    if (cfg.deny.guilds.includes(guild) || cfg.deny.channels.includes(channel)) return false;
    if (parentId && cfg.deny.channels.includes(String(parentId))) return false;
    if (cfg.allow.guilds.includes(guild) || cfg.allow.channels.includes(channel)) return true;
    const noGuildRules = cfg.allow.guilds.length === 0 && cfg.allow.channels.length === 0;
    return noGuildRules && cfg.allowAllWhenEmpty;
  }

  if (cfg.allow.users.includes(String(userId))) return true;
  return cfg.allow.users.length === 0 && cfg.allowAllWhenEmpty;
}

/**
 * 一輪結束時要不要替會話送 /compact。這是 DSH 自動壓縮沒觸發時的備援。
 * 冷卻時間防止壓完還是很大（例如保留的原文本來就長）時每輪都壓。
 */
export function shouldAutoCompact({ tokens, threshold, lastAt, now, cooldownMs }) {
  return threshold > 0 && Number.isFinite(tokens) && tokens > threshold && now - lastAt >= cooldownMs;
}

const MANAGE_GUILD = 1n << 5n;

/**
 * `/reset` 誰能用：bot 擁有者，或那個伺服器裡有「管理伺服器」權限的人（discord.js 的 has() 會把 Administrator 算進去）。
 * bot 開放給別人管的伺服器時，那邊的管理員要能自己清掉 bot 的上下文。私聊沒有伺服器權限可看，只給擁有者。
 */
export function canResetConversation({ isOwner, guildId, permissions }) {
  if (isOwner) return true;
  return Boolean(guildId) && Boolean(permissions?.has?.(MANAGE_GUILD));
}

/** 這個人的訊息要不要當成「沒看到」：管理員封鎖（deny.users）或自己退出（deny.self）。 */
export function isDeniedUser(cfg, userId) {
  const id = String(userId ?? '');
  return cfg.deny.users.includes(id) || cfg.deny.self.includes(id);
}

/**
 * 模型能不能讀這一則訊息。`deny.users`（管理員封鎖）一律不行；
 * `deny.self` 只有 @bot／回覆 bot 的那一則可以，因為那一則本來就照正常流程處理。
 * 私聊沒有這個例外。
 */
export function canReadMessage(cfg, message, botUserId) {
  const id = String(message?.author?.id ?? '');
  if (cfg.deny.users.includes(id)) return false;
  if (!cfg.deny.self.includes(id)) return true;
  if (!message?.guildId) return false;
  // discord.js 的 Message 給 Map + repliedUser；搜尋 API 的原始訊息只有 mention 陣列，認不出回覆對象。
  const mentions = message.mentions;
  const mentionedUserIds = Array.isArray(mentions)
    ? mentions.map((user) => user?.id)
    : [...(mentions?.users?.keys() ?? [])];
  return shouldHandleGuildMessage({
    mentionedUserIds,
    repliedUserId: Array.isArray(mentions)
      ? message?.referenced_message?.author?.id ?? null
      : mentions?.repliedUser?.id ?? null,
  }, botUserId, true);
}

/** `/blacklist`：把一個人加入或移出 deny.self（自己退出的名單），其他欄位原樣保留。 */
export function withSelfMutedUser(deny, userId, muted) {
  const id = String(userId);
  const others = deny.self.filter((user) => user !== id);
  return { ...deny, self: muted ? [...others, id] : others };
}

const PROGRESS_DETAIL_MAX = 80;
const PROGRESS_LINES_MAX = 6;
// 發訊息、貼圖、reaction、投票、修改、收回本身就看得到，不用再列進度。
const PROGRESS_SILENT = new Set([
  'mcp__discord__send_message', 'mcp__discord__send_sticker', 'mcp__discord__add_reaction',
  'mcp__discord__remove_reaction', 'mcp__discord__set_quiet', 'mcp__discord__schedule_followup',
  'mcp__discord__create_poll', 'mcp__discord__edit_message', 'mcp__discord__delete_message',
  'mcp__slang__lookup_slang', 'mcp__slang__record_slang', 'mcp__slang__record_channel_tag',
]);
const PROGRESS_LABELS = {
  'mcp__web-search-safe__web_search': ['🔍 搜尋', (args) => args.query],
  'mcp__web-search-safe__web_fetch': ['🌐 讀取網頁', (args) => { try { return new URL(args.url).host; } catch { return ''; } }],
  'mcp__discord__read_history': ['📜 翻聊天紀錄'],
  'mcp__discord__search_history': ['🔎 搜尋聊天紀錄', (args) => args.query],
  'mcp__discord__view_message': ['🔎 看一則訊息'],
  'mcp__discord__user_info': ['👤 查看群友資料'],
  'mcp__discord__server_info': ['🏠 查看伺服器資訊'],
  'mcp__discord__conversation_stats': ['📊 查對話次數'],
  'mcp__discord__search_emojis': ['😀 找表情'],
  'mcp__discord__search_stickers': ['🖼️ 找貼圖'],
  'mcp__discord__remember_user': ['📝 記下群友的事'],
  'mcp__discord__forget_user_fact': ['🗑️ 刪掉一條記憶'],
  'mcp__discord__note_event': ['📝 記下頻道事件'],
  'mcp__discord__search_notes': ['📝 查頻道筆記', (args) => args.query],
  'mcp__discord__forget_note': ['🗑️ 刪頻道筆記'],
};

/** 一次工具呼叫在 Discord 進度訊息裡的那一行；不用列的回 null。args 是 DSH 事件裡的 JSON 字串。 */
export function describeToolCall(name, args) {
  if (PROGRESS_SILENT.has(name)) return null;
  const known = PROGRESS_LABELS[name];
  if (!known) return `🔧 使用工具：${String(name).split('__').at(-1)}`;
  const [label, pick] = known;
  let detail = '';
  try {
    detail = String(pick?.(JSON.parse(args)) ?? '');
  } catch { /* 參數壞掉就只顯示動作 */ }
  detail = detail.replace(/[\s`]+/g, ' ').trim();
  if (detail.length > PROGRESS_DETAIL_MAX) detail = `${detail.slice(0, PROGRESS_DETAIL_MAX)}…`;
  return detail ? `${label}：${detail}` : label;
}

/** 進度訊息內容：Discord 的 `-#` 小字，只留最後幾步。 */
export function formatProgress(lines) {
  return lines.slice(-PROGRESS_LINES_MAX).map((line) => `-# ${line}`).join('\n');
}

const SEARCH_TERMS_MAX = 8;

/** search_history 的搜尋詞：全形轉半形、轉小寫，用空白分開。 */
export function searchTerms(query) {
  return String(query ?? '').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).slice(0, SEARCH_TERMS_MAX);
}

/** 每個詞都出現才算符合；沒有詞不算（只用 from 找人時另外判斷）。 */
export function matchesTerms(text, terms) {
  if (!terms.length) return false;
  const haystack = String(text ?? '').normalize('NFKC').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** DSH 壓縮上下文期間貼在頻道的提示：壓縮要十幾秒，只有「正在輸入」看不出在做什麼。 */
export const COMPACT_NOTICE = '-# 🗜️ 聊天紀錄太長，正在壓縮，稍等一下…';

/**
 * 頻道訊息是否在叫 bot。
 *
 * 判斷依據只有兩個，都來自 Discord 的結構化欄位：@ 到 bot，或回覆的對象是 bot。
 * 不去猜「這句話像不像在問我」——那會讓 bot 在別人的對話裡亂接話。
 */
export function shouldHandleGuildMessage({ mentionedUserIds, repliedUserId }, botUserId, requireMention) {
  if (!requireMention) return true;
  const bot = String(botUserId);
  if ((mentionedUserIds ?? []).map(String).includes(bot)) return true;
  return repliedUserId !== null && repliedUserId !== undefined && String(repliedUserId) === bot;
}

/** 去掉訊息裡的 @bot，避免把 mention 原文送進模型。 */
export function stripBotMention(content, botUserId) {
  if (!/^\d+$/.test(String(botUserId))) throw new TypeError('botUserId 必須是數字字串');
  return String(content ?? '').replace(new RegExp(`<@!?${botUserId}>`, 'g'), ' ').trim();
}

/**
 * 這則訊息要不要整則跳過？開頭打 `\//` 就是「只給人看」。
 * Discord 客戶端會攔截 `/` 開頭、跳出指令選單，所以實際要打 `\//`；
 * 畫面會吃掉反斜線，其他人看到的是 `//`。`\o/` 這類顏文字不會中。
 */
export function isSkippedMessage(content, botUserId) {
  return /^\\?\/\//.test(stripBotMention(content, botUserId).normalize('NFKC'));
}

/** 審批回答 → DSH 的 outcome；看不懂就回 null（呼叫端會再問一次）。 */
export function parseApprovalAnswer(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (APPROVE_WORDS.has(t)) return 'allowed-once';
  if (REJECT_WORDS.has(t)) return 'rejected';
  return null;
}

/**
 * 把一則回覆配到 agent 的提問上。
 * 命中選項文字 → `selected`；否則整段當自訂答案（`custom`）。
 */
export function questionAnswersFor(questions, text) {
  const answer = String(text ?? '').trim();
  const key = answer.toLowerCase();
  return (questions ?? []).map((q) => {
    const hit = (q.options ?? []).find((o) => String(o.label ?? '').trim().toLowerCase() === key);
    if (hit) return { id: q.id, selected: [hit.label] };
    return { id: q.id, selected: [], custom: answer };
  });
}

/**
 * 依 Discord 上限切段。內容原樣保留（Discord 吃 Markdown），只處理長度與代理對。
 * 重用共用切法：它在換行邊界切、不切開 emoji。
 */
export function splitDiscordMessage(text, max = DISCORD_MAX_CHARS) {
  return splitForCharLimit(String(text ?? ''), max);
}

/**
 * 讀會話映射。
 *
 * 檔案壞掉就拋：靜默重建成空映射會讓每個頻道都開新會話（上下文全失），
 * 而緊接著的存檔會把那份空映射寫回磁碟，變成永久遺失。
 */
export function loadSessions(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { sessions: {} };
    throw error;
  }
  if (!raw.trim()) return { sessions: {} };
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} 格式錯誤`);
  const sessions = {};
  for (const [key, sessionId] of Object.entries(doc.sessions ?? {})) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error(`${file} 的 ${key} 不是有效的 session id`);
    }
    sessions[key] = sessionId;
  }
  return { sessions };
}

/** 原子寫：先寫 .tmp 再 rename，避免半截檔案。 */
export function saveSessions(file, sessions) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 這個 DSH 錯誤是「現在連不上，等一下再試」還是「再試也沒用」。
 *
 * 只有前者會進斷線佇列；session/not-found、model-unavailable、preset 缺失之類的
 * 重試只會無限循環，必須直接回報給使用者。
 */
export function isTransientDshError(error) {
  const message = String(error?.message ?? error ?? '');
  if (!message) return false;
  if (/session\/|model-unavailable|preset |not-found|invalid request/i.test(message)) return false;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network|timeout|逾時|invalid server-response|DSH 鉴权|401|502|503|504/i.test(message);
}
