// 觸發對話統計：模型真的送出訊息時，記下這批訊息裡叫 bot 的人。
//
// 只做資料處理（不 import discord.js），方便離線測試：
//   - `state/discord-triggers.json` 的讀寫（原子寫、壞檔備份、人數上限）
//   - 同一個人重複觸發只累加次數，不重複佔一筆
//
// 什麼時候算一次：模型呼叫 send_message／send_sticker／create_poll 成功時，
// 這批訊息裡有 ★（直接叫 bot）的人優先；都沒 ★（自由參與）就記整批的發言者。
// 同一個回合送好幾則只算一次，避免模型連發把數字洗高。
import fs from 'node:fs';
import path from 'node:path';
import { truncateText } from '../md-to-plain.js';

export const TRIGGER_VERSION = 1;
export const TRIGGER_MAX_USERS = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const cleanName = (value) => truncateText(String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim(), 32);

export function createTriggerStore() {
  return { version: TRIGGER_VERSION, users: {} };
}

function backupCorrupt(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch { /* 備份失敗不影響從空的重建 */ }
}

/**
 * 讀觸發統計。壞檔／過大／版本不認得時改名備份再從空的重建。
 * @returns {{store: object, warning: string|null}}
 */
export function loadTriggerFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { store: createTriggerStore(), warning: null };
    throw error;
  }
  const size = Buffer.byteLength(raw, 'utf8');
  if (size > MAX_FILE_BYTES) {
    backupCorrupt(file);
    return { store: createTriggerStore(), warning: `觸發統計過大（${(size / 1048576).toFixed(1)} MB），已備份並重建` };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    backupCorrupt(file);
    return { store: createTriggerStore(), warning: `觸發統計不是合法 JSON（${error?.message ?? error}），已備份並重建` };
  }
  if (doc?.version !== TRIGGER_VERSION || !doc.users || typeof doc.users !== 'object' || Array.isArray(doc.users)) {
    backupCorrupt(file);
    return { store: createTriggerStore(), warning: '觸發統計格式錯誤，已備份並重建' };
  }
  const store = createTriggerStore();
  for (const [userId, entry] of Object.entries(doc.users)) {
    if (!entry || typeof entry !== 'object') continue;
    const count = Math.max(0, Math.round(Number(entry.count) || 0));
    if (!/^\d{5,25}$/.test(userId) || count === 0) continue;
    store.users[userId] = {
      name: cleanName(entry.name),
      count,
      firstAt: Number(entry.firstAt) || 0,
      lastAt: Number(entry.lastAt) || 0,
      lastKey: String(entry.lastKey ?? '').slice(0, 80),
    };
  }
  return { store, warning: null };
}

/** 原子寫；超過人數上限先丟最久沒觸發的人。 */
export function saveTriggerFile(file, store, { maxUsers = TRIGGER_MAX_USERS } = {}) {
  const users = store?.users ?? {};
  const ids = Object.keys(users);
  let dropped = 0;
  if (ids.length > maxUsers) {
    const oldest = ids.sort((a, b) => (users[a].lastAt ?? 0) - (users[b].lastAt ?? 0));
    for (const id of oldest.slice(0, ids.length - maxUsers)) {
      delete users[id];
      dropped += 1;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 已不在 */ }
    throw error;
  }
  return { dropped };
}

/**
 * 記一次觸發。`users` 是同一個回合的觸發者；同一個人只算一次。
 * @returns {number} 這次更新了幾個人
 */
export function recordTriggers(store, { users = [], key = '', at = Date.now() } = {}) {
  store.users ??= {};
  const seen = new Set();
  let updated = 0;
  for (const user of users) {
    const userId = String(user?.userId ?? '').trim();
    if (!/^\d{5,25}$/.test(userId) || seen.has(userId)) continue;
    seen.add(userId);
    const entry = store.users[userId] ?? {
      name: '',
      count: 0,
      firstAt: at,
      lastAt: at,
      lastKey: '',
    };
    entry.count += 1;
    entry.lastAt = at;
    entry.lastKey = String(key ?? '').slice(0, 80);
    const name = cleanName(user?.name);
    if (name) entry.name = name;
    store.users[userId] = entry;
    updated += 1;
  }
  return updated;
}

/** 全部觸發者（次數多的排前面），控制台分頁用。 */
export function triggerUserList(store) {
  return Object.entries(store?.users ?? {})
    .map(([userId, entry]) => ({ userId, ...entry }))
    .sort((a, b) => (b.count || 0) - (a.count || 0) || (b.lastAt || 0) - (a.lastAt || 0));
}

/** 控制台用：總人數、今天有觸發的人數、總次數、最常觸發的人。 */
export function triggerStats(store, { now = Date.now(), top = 5 } = {}) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const users = triggerUserList(store);
  const totalTriggers = users.reduce((sum, entry) => sum + (entry.count || 0), 0);
  const limit = Math.max(0, Math.min(20, Number.isFinite(Number(top)) ? Number(top) : 5));
  return {
    totalUsers: users.length,
    todayUsers: users.filter((entry) => (entry.lastAt ?? 0) >= startMs).length,
    totalTriggers,
    top: users.slice(0, limit).map((entry) => ({
      userId: entry.userId,
      name: entry.name,
      count: entry.count,
      lastAt: entry.lastAt,
    })),
  };
}
