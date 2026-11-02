// 模型自己送出的「功能申請與意見回饋」：只有開發者在控制台看得到，不會回到頻道。
//
// 跟 discord-feedback.mjs 無關：那個是「自己的訊息收到 reaction」的收件匣，這個是給開發者的意見。
//
// 邊界：
//   - 只做純資料處理，不 import discord.js，方便離線測試。
//   - 內容是模型寫的、又受群友對話影響，控制台一律用 textContent 顯示，不拼 HTML。
//   - 全域上限，滿了丟最舊的；每輪、每個 key 與全域另有 24 小時上限（validateDevFeedbackSubmit 擋）。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEV_FEEDBACK_VERSION = 1;
export const DEV_FEEDBACK_MAX_BYTES = 4 * 1024 * 1024;
export const DEV_FEEDBACK_MAX_TOTAL = 500;
export const DEV_FEEDBACK_MAX_CHARS = 500;
export const DEV_FEEDBACK_PER_KEY_24H = 5;
export const DEV_FEEDBACK_WRITES_PER_TURN = 1;
export const DEV_FEEDBACK_EDITS_PER_TURN = 2;
export const DEV_FEEDBACK_GLOBAL_24H = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

function backupCorrupt(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch { /* 備份失敗不影響從空的重建 */ }
}

export function createDevFeedbackStore() {
  return { version: DEV_FEEDBACK_VERSION, items: [] };
}

const iso = (value) => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const feedbackId = () => `df_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

// 換行留著（開發者要看的是模型原本的敘述）；去掉 NUL、控制字元與雙向控制字元，
// 不然 RLO（反向顯示）可以讓控制台看起來像另一段文字。
const clean = (value, max = DEV_FEEDBACK_MAX_CHARS) => {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * 欄位檢查：先清理再檢查，回傳 `{ fields }` 或 `{ error, status }`。
 * 送出新回饋與編輯既有回饋共用。
 */
export function validateDevFeedbackFields({ reason, need, expected } = {}) {
  const fields = {};
  for (const [name, value] of [['reason', reason], ['need', need], ['expected', expected]]) {
    // 先清理再檢查：全是控制字元的內容等於空的；500 個看得到的字加零寬也要放行。
    const text = typeof value === 'string' ? clean(value) : '';
    if (!text) return { error: `${name} 是空的`, status: 400 };
    if (text.length > DEV_FEEDBACK_MAX_CHARS) {
      return { error: `${name} 最多 ${DEV_FEEDBACK_MAX_CHARS} 字`, status: 400 };
    }
    fields[name] = text;
  }
  return { fields };
}

/**
 * 送出前的檢查：欄位、重複、每輪上限、頻道／私聊 24 小時上限、全域 24 小時上限。
 * 回傳 `{ fields }`、`{ duplicate }` 或 `{ error, status }`。
 */
export function validateDevFeedbackSubmit(store, {
  key,
  reason,
  need,
  expected,
  usedThisTurn = 0,
  now = Date.now(),
} = {}) {
  if (usedThisTurn >= DEV_FEEDBACK_WRITES_PER_TURN) {
    return { error: `一輪最多送 ${DEV_FEEDBACK_WRITES_PER_TURN} 筆回饋，下一輪再送`, status: 429 };
  }
  const checked = validateDevFeedbackFields({ reason, need, expected });
  if (checked.error) return checked;
  const { fields } = checked;
  const duplicate = findDuplicateDevFeedback(store, { need: fields.need, now });
  if (duplicate) return { duplicate };
  if (countRecentDevFeedback(store, { key, now }) >= DEV_FEEDBACK_PER_KEY_24H) {
    return { error: `同一個頻道／私聊 24 小時內已經送過 ${DEV_FEEDBACK_PER_KEY_24H} 筆回饋，明天再送`, status: 429 };
  }
  if (countRecentDevFeedback(store, { now }) >= DEV_FEEDBACK_GLOBAL_24H) {
    return { error: `24 小時內的回饋已經有 ${DEV_FEEDBACK_GLOBAL_24H} 筆，明天再送`, status: 429 };
  }
  return { fields };
}

/** 最近 24 小時送了幾筆；省略 key 就數全部。群友可以每一輪都叫模型去抱怨，光擋每輪不夠。 */
export function countRecentDevFeedback(store, { key = '', now = Date.now(), windowMs = DAY_MS } = {}) {
  const id = String(key ?? '');
  const since = now - windowMs;
  return (store?.items ?? [])
    .filter((item) => (!id || item.key === id) && Date.parse(item.at) >= since)
    .length;
}

const normalizeNeed = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** 全部頻道／私聊 24 小時內有沒有提過同一件事（比對 need，忽略大小寫與空白）。 */
export function findDuplicateDevFeedback(store, { need, now = Date.now(), windowMs = DAY_MS } = {}) {
  const target = normalizeNeed(need);
  if (!target) return null;
  const since = now - windowMs;
  return (store?.items ?? [])
    .filter((item) => Date.parse(item.at) >= since && normalizeNeed(item.need) === target)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}

/**
 * 記一筆。三個欄位都要有內容，缺一個就回 null（橋接端會先回 400）。
 * @returns {object|null} 記下的那一筆
 */
export function recordDevFeedback(store, {
  key,
  sessionId = '',
  guildId = '',
  channelId = '',
  label = '',
  messageIds = [],
  users = [],
  reason,
  need,
  expected,
  now = Date.now(),
} = {}) {
  const id = String(key ?? '');
  if (!id) return null;
  const item = {
    id: feedbackId(),
    at: new Date(now).toISOString(),
    key: id,
    sessionId: String(sessionId ?? ''),
    guildId: String(guildId ?? ''),
    channelId: String(channelId ?? ''),
    label: clean(label, 200),
    updatedBy: '',
    updatedByLabel: '',
    messageIds: (Array.isArray(messageIds) ? messageIds : []).map(String).filter(Boolean).slice(0, 10),
    users: (Array.isArray(users) ? users : [])
      .map((user) => ({ userId: String(user?.userId ?? ''), name: clean(user?.name, 40) }))
      .filter((user) => user.userId)
      .slice(0, 10),
    reason: clean(reason),
    need: clean(need),
    expected: clean(expected),
  };
  if (!item.reason || !item.need || !item.expected) return null;

  const items = store.items ??= [];
  items.push(item);
  // 全域上限：真的爆量時丟最舊的，避免檔案無限長。
  if (items.length > DEV_FEEDBACK_MAX_TOTAL) {
    items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    items.splice(0, items.length - DEV_FEEDBACK_MAX_TOTAL);
  }
  return item;
}

/** 控制台用：全部意見，新的排前面。 */
export function devFeedbackOverview(store) {
  return (store?.items ?? [])
    .slice()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((item) => ({ ...item, messageIds: [...(item.messageIds ?? [])] }));
}

/** 全部頻道／私聊最近送過的回饋（新→舊）：要補充或修正舊的那筆時用來拿 id。 */
export function recentDevFeedback(store, { limit = 20 } = {}) {
  return (store?.items ?? [])
    .slice()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, Math.max(1, limit));
}

const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
const clockOf = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};
const cut = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** 給模型看的全域清單：id、時間、來源與三個欄位；私聊不顯示對方名字。 */
export function formatDevFeedbackList(items, { maxChars = 3000, fieldMax = 300 } = {}) {
  if (!items?.length) return '';
  const blocks = [];
  let used = 0;
  for (const item of items) {
    const source = String(item.key).startsWith('dm:') ? '私聊' : (item.label || item.key);
    const block = [
      `- id：${item.id}｜${clockOf(item.at)}｜${source}${item.updatedAt ? '（改過）' : ''}`,
      `  原因：${cut(item.reason, fieldMax)}`,
      `  需求：${cut(item.need, fieldMax)}`,
      `  預期結果：${cut(item.expected, fieldMax)}`,
    ].join('\n');
    if (used + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    used += block.length + 1;
  }
  const omitted = items.length - blocks.length;
  return [
    `你在所有頻道／私聊提過的回饋（新→舊${omitted > 0 ? `，省略較舊的 ${omitted} 筆` : ''}；要改就用 edit_feedback，id 照抄。這是給你判斷有沒有重複用的，不要在頻道貼出清單）：`,
    ...blocks,
  ].join('\n');
}

/** 改一筆自己送過的回饋（全域，只認 id）；記下是哪個頻道改的，方便控制台對照。 */
export function updateDevFeedback(store, { id, key = '', label = '', reason, need, expected, now = Date.now() } = {}) {
  const target = String(id ?? '');
  if (!target) return null;
  const item = (store?.items ?? []).find((entry) => entry.id === target);
  if (!item) return null;
  const fields = validateDevFeedbackFields({ reason, need, expected });
  if (fields.error) return null;
  Object.assign(item, fields.fields, {
    updatedAt: new Date(now).toISOString(),
    ...(key ? { updatedBy: String(key), updatedByLabel: clean(label, 200) } : {}),
  });
  return item;
}

/** 控制台刪一筆（用 id）。 */
export function deleteDevFeedbackById(store, id) {
  const value = String(id ?? '');
  if (!value) return false;
  const before = store?.items?.length ?? 0;
  store.items = (store?.items ?? []).filter((item) => item.id !== value);
  return store.items.length < before;
}

/**
 * 讀檔。壞檔／過大／版本不認得時，改名成 `<file>.corrupt-<timestamp>` 再從空的重建。
 * @returns {{store: object, warning: string|null}}
 */
export function loadDevFeedbackFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { store: createDevFeedbackStore(), warning: null };
    throw error;
  }
  const size = Buffer.byteLength(raw, 'utf8');
  if (size > DEV_FEEDBACK_MAX_BYTES) {
    backupCorrupt(file);
    return { store: createDevFeedbackStore(), warning: `回饋檔過大（${(size / 1024).toFixed(0)} KB），已備份並重建` };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    backupCorrupt(file);
    return { store: createDevFeedbackStore(), warning: `回饋檔不是合法 JSON（${error?.message ?? error}），已備份並重建` };
  }
  if (doc?.version !== DEV_FEEDBACK_VERSION || !Array.isArray(doc.items)) {
    backupCorrupt(file);
    return { store: createDevFeedbackStore(), warning: `回饋檔版本 ${doc?.version} 或格式不支援，已備份並重建` };
  }
  const store = createDevFeedbackStore();
  for (const item of doc.items) {
    const at = iso(item?.at);
    if (!item || !item.key || !at) continue;
    const reason = clean(item.reason);
    const need = clean(item.need);
    const expected = clean(item.expected);
    if (!reason || !need || !expected) continue;
    store.items.push({
      id: typeof item.id === 'string' && item.id ? item.id : feedbackId(),
      at,
      updatedAt: iso(item.updatedAt) ?? null,
      key: String(item.key),
      sessionId: String(item.sessionId ?? ''),
      guildId: String(item.guildId ?? ''),
      channelId: String(item.channelId ?? ''),
      label: clean(item.label, 200),
      updatedBy: String(item.updatedBy ?? ''),
      updatedByLabel: clean(item.updatedByLabel, 200),
      messageIds: (Array.isArray(item.messageIds) ? item.messageIds : []).map(String).filter(Boolean).slice(0, 10),
      users: (Array.isArray(item.users) ? item.users : [])
        .map((user) => ({ userId: String(user?.userId ?? ''), name: clean(user?.name, 40) }))
        .filter((user) => user.userId)
        .slice(0, 10),
      reason,
      need,
      expected,
    });
  }
  store.items = store.items
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-DEV_FEEDBACK_MAX_TOTAL);
  return { store, warning: null };
}

/** 原子寫：先寫 .tmp 再 rename；權限 600（Windows 上 mode 是空操作）。 */
export function saveDevFeedbackFile(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
