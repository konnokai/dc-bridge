// search_history 的翻頁與排序（純邏輯，測試在 scripts/test-discord-bridge.mjs）。
// Discord 不管 before 或 after 都回「新→舊」，這裡統一成掃描順序，
// 呼叫端只決定往前（backward）或往後（forward）找。
//
// after 回的是游標後最舊的一批（實測）；before 回的是游標前最新的一批。

/** 訊息依 snowflake 排序：createdAt 只到毫秒，同一毫秒會分不出先後。 */
export const bySnowflake = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

export async function scanHistoryMessages({
  direction,
  pages,
  limit,
  pageSize = 100,
  startAfter = null,
  fetchPage,
  matches,
}) {
  const found = [];
  let scanned = 0;
  let before = null;
  let after = startAfter;
  for (let page = 0; page < pages && found.length < limit; page += 1) {
    const fetched = await fetchPage({ before, after });
    const messages = [...fetched.values()].sort(bySnowflake);
    const ordered = direction === 'forward' ? messages : [...messages].reverse();
    for (const message of ordered) {
      scanned += 1;
      if (!matches(message)) continue;
      found.push(message);
      if (found.length >= limit) break;
    }
    if (fetched.size < pageSize) break;
    // 往後翻用這頁最新的；往前翻用這頁最舊的。
    if (direction === 'forward') after = messages[messages.length - 1].id;
    else before = messages[0].id;
  }
  // 往前找是先看到新的；回傳一律舊→新。
  if (direction !== 'forward') found.reverse();
  return { found, scanned };
}
