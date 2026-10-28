// 發言頻率：每個會話記最近 10 分鐘的訊息，讓模型知道自己是不是講太多。
//
// 只放記憶體：這是「最近的節奏」，重啟後重新累積就好。
// 群友訊息在 handleMessage 最前面記（早於所有 return），bot 自己的則在工具送出成功時記。

export const ACTIVITY_WINDOW_MINUTES = 10;
export const ACTIVITY_WINDOW_MS = ACTIVITY_WINDOW_MINUTES * 60_000;

/**
 * @param options.windowMs 只看最近多久
 * @param options.max      每個 key 最多留幾筆（爆量時丟最舊的）
 * @param options.now      測試用的時鐘
 */
export function createActivityTracker({ windowMs = ACTIVITY_WINDOW_MS, max = 500, now = Date.now } = {}) {
  const byKey = new Map(); // key -> { at, bot }[]

  const live = (list) => {
    const cutoff = now() - windowMs;
    return list.filter((entry) => entry.at > cutoff).slice(-max);
  };

  function record(key, { bot = false, at = now() } = {}) {
    const list = byKey.get(key) ?? [];
    list.push({ at, bot: Boolean(bot) });
    byKey.set(key, list.length > max ? list.slice(-max) : list);
  }

  function stats(key) {
    const list = live(byKey.get(key) ?? []);
    if (list.length > 0) byKey.set(key, list);
    else byKey.delete(key);
    return { bot: list.filter((entry) => entry.bot).length, total: list.length };
  }

  return { record, stats };
}

/** 太少訊息時不報比例，免得「頻道共 1 則」變噪音。 */
export function formatActivityLine({ bot = 0, total = 0 } = {}) {
  if (total < 3) return '';
  return `你最近 ${ACTIVITY_WINDOW_MINUTES} 分鐘送了 ${bot} 則；這段時間頻道共 ${total} 則`;
}
