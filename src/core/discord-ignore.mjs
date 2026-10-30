// 模型自己的「暫時不理」名單，加上重複拒絕的判斷。
//
// 三份名單各管各的，不要混在一起：
//   - deny.users（管理員封鎖）與 deny.self（本人用 /blacklist）：在 config.json，管理面。
//   - 這份名單：模型用 ignore_user 設，帶到期時間，存在 state/discord-ignore.json。
//     @bot 也不處理，重啟後仍然有效；控制台看得到。
//
// 重複拒絕：同一個人在同一個頻道短時間內一直踩線時，橋接不再送同一句罐頭拒絕，
// 改成對他的訊息按 ❌。判斷靠 persona 裡的固定句子，改那幾句要同步 REFUSAL_LINES。
import fs from 'node:fs';
import path from 'node:path';
import { truncateText } from '../md-to-plain.js';

export const IGNORE_VERSION = 1;
export const IGNORE_MAX_MINUTES = 1440;
export const IGNORE_MAX_USERS = 200;
export const REFUSAL_WINDOW_MS = 10 * 60_000;

const MAX_FILE_BYTES = 256 * 1024;

// 去掉空白與標點後再比對，模型加上句號或全形逗號也認得。
const REFUSAL_LINES = new Set([
  '這題我不碰換一個',
  '這題我不碰',
  '這題不回',
  '這個不聊',
  '我只會當大肥魚',
]);

const cleanText = (value, max) => truncateText(String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim(), max);

/** 這一則是不是 persona 規定的固定拒絕句；是的話呼叫端可以考慮改按 ❌。 */
export function isRefusalMessage(text) {
  const line = String(text ?? '')
    .normalize('NFKC')
    // 模型常會在句尾補表情或伺服器表情（:名稱:），那些不算內容。
    .replace(/:[a-z0-9_]+:/gi, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/[\s，,。.!！?？「」『』"'（）()~～]+/g, '');
  return REFUSAL_LINES.has(line);
}

export function createIgnoreStore() {
  return { version: IGNORE_VERSION, users: {} };
}

function backupCorrupt(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch { /* 備份失敗不影響從空的重建 */ }
}

/**
 * 讀不理名單。壞檔／過大／版本不認得時改名備份再從空的重建。
 * 過期的條目直接跳過；`now` 只給測試用。
 * @returns {{store: object, warning: string|null}}
 */
export function loadIgnoreFile(file, { now = Date.now() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { store: createIgnoreStore(), warning: null };
    throw error;
  }
  const size = Buffer.byteLength(raw, 'utf8');
  if (size > MAX_FILE_BYTES) {
    backupCorrupt(file);
    return { store: createIgnoreStore(), warning: `不理名單過大（${(size / 1024).toFixed(1)} KB），已備份並重建` };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    backupCorrupt(file);
    return { store: createIgnoreStore(), warning: `不理名單不是合法 JSON（${error?.message ?? error}），已備份並重建` };
  }
  if (doc?.version !== IGNORE_VERSION || !doc.users || typeof doc.users !== 'object' || Array.isArray(doc.users)) {
    backupCorrupt(file);
    return { store: createIgnoreStore(), warning: '不理名單格式錯誤，已備份並重建' };
  }
  const store = createIgnoreStore();
  for (const [userId, entry] of Object.entries(doc.users)) {
    if (!/^\d{5,25}$/.test(userId) || !entry || typeof entry !== 'object') continue;
    const until = Number(entry.until) || 0;
    if (until <= now) continue;
    store.users[userId] = {
      name: cleanText(entry.name, 40),
      reason: cleanText(entry.reason, 100),
      at: Number(entry.at) || 0,
      until,
    };
  }
  return { store, warning: null };
}

/** 原子寫。人數上限由呼叫端在新增前擋，這裡不改呼叫端的 store。 */
export function saveIgnoreFile(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 已不在 */ }
    throw error;
  }
}

/** 設一段時間不理；minutes 一定要 1~IGNORE_MAX_MINUTES（0 由呼叫端走 unignore）。 */
export function setIgnored(store, { userId, name = '', minutes, reason = '', at = Date.now() } = {}) {
  const id = String(userId ?? '').trim();
  if (!/^\d{5,25}$/.test(id)) throw new TypeError('userId 必須是 Discord ID');
  const value = Math.round(Number(minutes));
  if (!Number.isInteger(value) || value < 1 || value > IGNORE_MAX_MINUTES) {
    throw new TypeError(`minutes 要在 1~${IGNORE_MAX_MINUTES} 之間`);
  }
  const entry = {
    name: cleanText(name, 40),
    reason: cleanText(reason, 100),
    at,
    until: at + value * 60_000,
  };
  store.users ??= {};
  store.users[id] = entry;
  return entry;
}

export function unignore(store, userId) {
  if (!store?.users) return false;
  return delete store.users[String(userId)];
}

/** 還沒到期的條目；過期就當作沒有。 */
export function ignoreEntry(store, userId, now = Date.now()) {
  const entry = store?.users?.[String(userId)];
  return entry && Number(entry.until) > now ? entry : null;
}

export function isIgnoring(store, userId, now = Date.now()) {
  return Boolean(ignoreEntry(store, userId, now));
}

/** 控制台用：還沒到期的人，最快到期的排前面。 */
export function ignoreList(store, { now = Date.now() } = {}) {
  return Object.entries(store?.users ?? {})
    .map(([userId, entry]) => ({ userId, ...entry }))
    .filter((entry) => Number(entry.until) > now)
    .sort((a, b) => a.until - b.until);
}

/** 給模型與日誌看的到期時間（bridge 主機時區，含月日）。 */
export function formatIgnoreUntil(until) {
  const date = new Date(until);
  if (Number.isNaN(date.getTime())) return '';
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 同一個會話、同一個人被拒絕的次數（滾動窗口）。
 * 第 2 次起呼叫端改按 ❌；窗口內每次重設時間，持續踩線就一直是 ❌。
 */
export function createRefusalTracker({ windowMs = REFUSAL_WINDOW_MS, now = Date.now } = {}) {
  const seen = new Map(); // `${key}:${userId}` -> { at, count }

  function note(key, userId) {
    const id = `${key}:${String(userId ?? '')}`;
    const at = now();
    const previous = seen.get(id);
    const count = previous && at - previous.at <= windowMs ? previous.count + 1 : 1;
    seen.set(id, { at, count });
    return count;
  }

  /** 目前窗口內已經算過幾次；不累加，呼叫端要在真的送出後才 note。 */
  function count(key, userId) {
    const previous = seen.get(`${key}:${String(userId ?? '')}`);
    return previous && now() - previous.at <= windowMs ? previous.count : 0;
  }

  function forget(key) {
    const prefix = `${key}:`;
    for (const id of seen.keys()) {
      if (id.startsWith(prefix)) seen.delete(id);
    }
  }

  return { note, count, forget };
}
