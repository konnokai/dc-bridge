// 回訪：模型自己排「N 分鐘後回來看」的提示。時間到了 bridge 送一個只有【回訪】的回合，
// 模型自己決定要不要說話；不是預先寫好文字的直接發送。
//
// 狀態只在記憶體，重啟就清掉（上限 180 分鐘；撐不過重啟的排程先不做）。
// 安靜期間（discord-quiet）由橋接延後送出，這裡只負責時間與額度。
import { defang } from './discord-batch.mjs';

export const FOLLOWUP_MIN_MINUTES = 5;
export const FOLLOWUP_MAX_MINUTES = 180;
export const FOLLOWUP_MAX_PER_KEY = 2;
export const FOLLOWUP_MAX_PER_DAY = 6;

const dayKey = (now) => {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/** 回訪的 prompt 本文：只有提示，要不要說話交給模型。 */
export function formatFollowupPrompt({ minutes, note } = {}) {
  return `【回訪】你 ${minutes} 分鐘前說要回來看：${note}\n（這是回訪，不是新訊息；想說話就呼叫 send_message，不想就別送。）`;
}

/**
 * @param options.now 測試用的時鐘
 * @param options.minMinutes / options.maxMinutes 允許的分鐘數
 * @param options.maxPerKey 同時最多排幾個
 * @param options.maxPerDay 每個會話每天最多排幾個
 */
export function createFollowupStore({
  now = Date.now,
  minMinutes = FOLLOWUP_MIN_MINUTES,
  maxMinutes = FOLLOWUP_MAX_MINUTES,
  maxPerKey = FOLLOWUP_MAX_PER_KEY,
  maxPerDay = FOLLOWUP_MAX_PER_DAY,
} = {}) {
  const entries = new Map(); // id -> { id, key, note, minutes, at }
  const dayCounts = new Map(); // key -> { day, count }
  let nextId = 0;

  function todayCount(key) {
    const today = dayKey(now());
    const state = dayCounts.get(key);
    return state?.day === today ? state.count : 0;
  }

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
    if (pending(key) >= maxPerKey) {
      return { error: `這個會話已經排了 ${maxPerKey} 個回訪，等其中一個到再排` };
    }
    if (todayCount(key) >= maxPerDay) {
      return { error: `今天已經排了 ${maxPerDay} 次回訪，明天再排` };
    }
    dayCounts.set(key, { day: dayKey(now()), count: todayCount(key) + 1 });
    const entry = { id: `f${nextId += 1}`, key, note: text, minutes: value, at: now() + value * 60_000 };
    entries.set(entry.id, entry);
    return { entry };
  }

  /** 到時間的回訪（不從表裡拿掉；送出前才 remove，安靜期間才能延後）。 */
  function due(at = now()) {
    return [...entries.values()].filter((entry) => entry.at <= at).sort((a, b) => a.at - b.at);
  }

  function remove(id) {
    return entries.delete(id);
  }

  /** 送回還沒送出的回訪（投遞時剛好進入安靜）：時間照原樣，下一輪 due() 會再撿到。 */
  function restore(entry) {
    if (entry?.id) entries.set(entry.id, entry);
  }

  /** /reset 或會話結束：取消這個 key 還排著的回訪。 */
  function forget(key) {
    let removed = 0;
    for (const [id, entry] of entries) {
      if (entry.key !== key) continue;
      entries.delete(id);
      removed += 1;
    }
    return removed;
  }

  const pending = (key) => [...entries.values()].filter((entry) => entry.key === key).length;

  return { add, due, remove, restore, forget, pending };
}
