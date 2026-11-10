// 回訪：模型自己排「N 分鐘後回來看」的提示。時間到了 bridge 送一個只有【回訪】的回合，
// 模型自己決定要不要說話；不是預先寫好文字的直接發送。
//
// 狀態寫進 state/discord-followups.json：部署會重啟程序，排好的回訪不該跟著消失。
// 停機超過 30 分鐘的回訪不再補送——那時候話題多半已經過了。安靜期間由橋接延後送出，
// 這裡只負責時間與額度。
import fs from 'node:fs';
import path from 'node:path';
import { defang } from './discord-batch.mjs';

export const FOLLOWUP_MIN_MINUTES = 2;
// 1 個月以 30 天算；分鐘數是唯一的輸入單位，長排程由 formatFollowupDelay 講成天。
export const FOLLOWUP_MAX_MINUTES = 30 * 24 * 60;
export const FOLLOWUP_MAX_PER_DAY = 6;
export const FOLLOWUP_VERSION = 1;
export const FOLLOWUP_STALE_MS = 30 * 60_000;
// 讀檔上限 1MB，超過會整份備份重建；筆數先擋住，別讓檔案長到那裡。
// 500 筆 ×（200 字 note + 欄位）約 400KB，一般用量遠低於這個數字。
export const FOLLOWUP_MAX_ENTRIES = 500;
// 正常情況只有幾十筆；上限只是防止壞檔把整個檔案讀進記憶體。
export const FOLLOWUP_MAX_BYTES = 1024 * 1024;

const dayKey = (now) => {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/** 分鐘數講成人看得懂的時間：一小時以上換成小時，一天以上換成天。 */
export function formatFollowupDelay(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value} 分鐘`;
  if (value < 1440) return `${Number((value / 60).toFixed(1))} 小時`;
  return `${Number((value / 1440).toFixed(1))} 天`;
}

/** 回訪的 prompt 本文：只有提示，要不要說話交給模型。
 *  openTopic：chatty 頻道回訪時，舊話題冷了可以直接起一個新的。 */
export function formatFollowupPrompt({ minutes, note, at } = {}, { openTopic = false, now = Date.now() } = {}) {
  // 停機後補送時，排定時的分鐘數已經不是實際經過的時間；有 at 就重算。
  const elapsed = Number.isFinite(at)
    ? Math.max(1, Math.round((now - (at - minutes * 60_000)) / 60_000))
    : minutes;
  const tail = openTopic
    ? '（這是回訪，不是新訊息。這個頻道可以自己開話題：舊話題冷了就直接起一個新的，不用硬接。想說話就呼叫 send_message，不想就別送。）'
    : '（這是回訪，不是新訊息；想說話就呼叫 send_message，不想就別送。）';
  return `【回訪】你 ${formatFollowupDelay(elapsed)}前說要回來看：${note}\n${tail}`;
}

/**
 * 每輪給模型看的「這個會話還排著哪些回訪」；沒有就回空字串。
 * 不講的話，模型會忘記自己排過，或以為自己沒有排程。
 */
export function formatFollowupStatus(entries, { now = Date.now(), max = 3 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const label = (entry) => {
    const left = Math.round((Number(entry.at) - now) / 60_000);
    const when = left > 0 ? `${formatFollowupDelay(left)}後` : '已到時間';
    const note = String(entry.note ?? '');
    return `${when}（${note.length > 24 ? `${note.slice(0, 24)}…` : note}）`;
  };
  const shown = entries.slice(0, max).map(label).join('；');
  const more = entries.length > max ? `；另外 ${entries.length - max} 個` : '';
  return `【排程】這個會話還排著 ${entries.length} 個回訪：${shown}${more}。到時間會提醒你，不用重複排。`;
}

/**
 * @param options.saved 上次存檔的內容（loadFollowupFile 的結果）；沒有就從空白的開始
 * @param options.onChange 排程變動時呼叫，參數是 snapshot()；由橋接負責寫檔
 * @param options.now 測試用的時鐘
 * @param options.minMinutes / options.maxMinutes 允許的分鐘數
 * @param options.maxPerDay 每個會話每天最多排幾個
 */
export function createFollowupStore({
  now = Date.now,
  minMinutes = FOLLOWUP_MIN_MINUTES,
  maxMinutes = FOLLOWUP_MAX_MINUTES,
  maxPerDay = FOLLOWUP_MAX_PER_DAY,
  saved = null,
  onChange = () => {},
} = {}) {
  const entries = new Map(); // id -> { id, key, note, minutes, at }
  const dayCounts = new Map(); // key -> { day, count }
  // 已經送完的回訪不在檔案裡，但 id 不能回收：控制台開著的舊分頁可能還拿著那個 id。
  let nextId = Math.max(0, Number(saved?.nextId) || 0);

  // 壞掉的單筆直接跳過，不讓一份壞資料把整個回訪系統停掉。
  for (const item of Array.isArray(saved?.entries) ? saved.entries : []) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' && /^f\d+$/.test(item.id) ? item.id : '';
    const key = typeof item.key === 'string' ? item.key : '';
    const note = typeof item.note === 'string' ? item.note : '';
    const minutes = Number(item.minutes);
    const at = Number(item.at);
    if (!id || !key || !note.trim() || !Number.isFinite(at)) continue;
    if (!Number.isInteger(minutes) || minutes < minMinutes || minutes > maxMinutes) continue;
    // 停機太久才回來的回訪不補送：話題已經過了，補送只會像突然冒出來。
    if (at < now() - FOLLOWUP_STALE_MS) continue;
    entries.set(id, { id, key, note, minutes, at });
    nextId = Math.max(nextId, Number(id.slice(1)) || 0);
  }
  const today = dayKey(now());
  for (const [key, value] of Object.entries(saved?.dayCounts ?? {})) {
    const count = Number(value?.count);
    if (value?.day !== today || !Number.isFinite(count) || count <= 0) continue;
    dayCounts.set(key, { day: today, count: Math.floor(count) });
  }

  const snapshot = () => ({
    version: FOLLOWUP_VERSION,
    entries: [...entries.values()].sort((a, b) => a.at - b.at),
    dayCounts: Object.fromEntries(dayCounts),
    nextId,
  });
  const commit = () => onChange(snapshot());

  function todayCount(key) {
    const today = dayKey(now());
    const state = dayCounts.get(key);
    return state?.day === today ? state.count : 0;
  }

  /** 這個會話排著的回訪，依時間排序。 */
  function list(key) {
    return [...entries.values()].filter((entry) => entry.key === key).sort((a, b) => a.at - b.at);
  }

  /** 全部會話的回訪，依時間排序（控制台用）。 */
  function all() {
    return [...entries.values()].sort((a, b) => a.at - b.at);
  }

  const pending = (key) => list(key).length;

  /**
   * @returns {{entry: object}|{error: string}}
   */
  function add(key, { minutes, note } = {}) {
    const value = Math.round(Number(minutes));
    if (!Number.isInteger(value) || value < minMinutes || value > maxMinutes) {
      return { error: `minutes 要在 ${minMinutes}~${maxMinutes} 之間` };
    }
    const text = defang(note).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return { error: 'note 是空的' };
    if (entries.size >= FOLLOWUP_MAX_ENTRIES) {
      return { error: '回訪排程太多，等一些到點再排' };
    }
    // 每個會話每天的上限，chatty 頻道也一樣。
    if (todayCount(key) >= maxPerDay) {
      return { error: `今天已經排了 ${maxPerDay} 次回訪，明天再排` };
    }
    dayCounts.set(key, { day: dayKey(now()), count: todayCount(key) + 1 });
    const entry = { id: `f${nextId += 1}`, key, note: text, minutes: value, at: now() + value * 60_000 };
    entries.set(entry.id, entry);
    commit();
    return { entry };
  }

  /** 到時間的回訪（不從表裡拿掉；送出前才 remove，安靜期間才能延後）。 */
  function due(at = now()) {
    return [...entries.values()].filter((entry) => entry.at <= at).sort((a, b) => a.at - b.at);
  }

  function remove(id) {
    const removed = entries.delete(id);
    if (removed) commit();
    return removed;
  }

  /** 送回還沒送出的回訪（投遞時剛好進入安靜）：時間照原樣，下一輪 due() 會再撿到。 */
  function restore(entry) {
    if (!entry?.id) return;
    entries.set(entry.id, entry);
    commit();
  }

  /** /reset 或會話結束：取消這個 key 還排著的回訪。 */
  function forget(key) {
    let removed = 0;
    for (const [id, entry] of entries) {
      if (entry.key !== key) continue;
      entries.delete(id);
      removed += 1;
    }
    if (removed > 0) commit();
    return removed;
  }

  return { add, due, remove, restore, forget, list, all, pending };
}

function backupCorrupt(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch { /* 備份失敗不影響從空的重建 */ }
}

/**
 * 讀回訪檔。壞檔／過大／版本不認得時，改名成 `<file>.corrupt-<timestamp>` 再從空的重建。
 * 逐筆驗證留給 createFollowupStore：這裡只確認外殼可讀。
 * @returns {{saved: object|null, warning: string|null}}
 */
export function loadFollowupFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { saved: null, warning: null };
    // 讀不到（權限、被佔用）不能讓橋接在啟動時當掉：排程先空白，檔案留給人處理。
    return { saved: null, warning: `回訪檔讀不到（${error?.code ?? error?.message ?? error}），先從空白的開始` };
  }
  const size = Buffer.byteLength(raw, 'utf8');
  if (size > FOLLOWUP_MAX_BYTES) {
    backupCorrupt(file);
    return { saved: null, warning: `回訪檔過大（${(size / 1024).toFixed(0)} KB），已備份並重建` };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    backupCorrupt(file);
    return { saved: null, warning: `回訪檔不是合法 JSON（${error?.message ?? error}），已備份並重建` };
  }
  if (doc?.version !== FOLLOWUP_VERSION || !Array.isArray(doc.entries)) {
    backupCorrupt(file);
    return { saved: null, warning: `回訪檔版本 ${doc?.version} 或格式不支援，已備份並重建` };
  }
  return { saved: doc, warning: null };
}

/** 原子寫：先寫 .tmp 再 rename；權限 600（Windows 上 mode 是空操作）。 */
export function saveFollowupFile(file, snapshot) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
