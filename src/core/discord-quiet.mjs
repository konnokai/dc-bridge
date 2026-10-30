// 安靜模式：模型自己設定一段時間不接沒叫它的訊息。
//
// 狀態只在記憶體，重啟就清掉。安靜期間丟掉的批次不會進會話，所以結束時要把
// primedKeys 裡的 key 拿掉，下一批重新帶一次頻道上下文。

export const QUIET_MAX_MINUTES = 120;

/**
 * @param options.now 測試用的時鐘
 */
export function createQuietState({ now = Date.now } = {}) {
  const untilByKey = new Map();

  /** @returns {{until: number|null, expired: boolean}} expired = 這次呼叫才發現安靜結束 */
  function state(key) {
    const until = untilByKey.get(key) ?? 0;
    if (!until) return { until: null, expired: false };
    if (until <= now()) {
      untilByKey.delete(key);
      return { until: null, expired: true };
    }
    return { until, expired: false };
  }

  /**
   * minutes = 0 表示提早結束；1~QUIET_MAX_MINUTES 設到幾分鐘後。
   * @returns {{until: number|null, ended: boolean, expired: boolean}}
   */
  function set(key, minutes) {
    const value = Math.min(QUIET_MAX_MINUTES, Math.max(0, Math.round(Number(minutes) || 0)));
    if (value === 0) {
      const had = untilByKey.delete(key);
      return { until: null, ended: had, expired: false };
    }
    const until = now() + value * 60_000;
    untilByKey.set(key, until);
    return { until, ended: false, expired: false };
  }

  function forget(key) {
    untilByKey.delete(key);
  }

  return { state, set, forget };
}

const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

/** 這批要不要因為安靜丟掉：只有沒叫 bot 的批次會被丟；系統訊息（生圖完成）一定要送。 */
export function isQuietBatchSkipped({ direct, quietUntil, system = false } = {}) {
  return !system && !direct && Boolean(quietUntil);
}

/** 安靜到幾點（bridge 主機時區，跟【現在】一致）。 */
export function formatQuietUntil(until) {
  const date = new Date(until);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
