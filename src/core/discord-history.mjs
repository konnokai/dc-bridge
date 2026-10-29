// search_history 的翻頁與排序（純邏輯，測試在 scripts/test-discord-bridge.mjs）。
// Discord 不管 before 或 after 都回「新→舊」，這裡統一成掃描順序，
// 呼叫端只決定往前（backward）或往後（forward）找。
//
// after 回的是游標後最舊的一批（實測）；before 回的是游標前最新的一批。

/** 訊息依 snowflake 排序：createdAt 只到毫秒，同一毫秒會分不出先後。 */
export const bySnowflake = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

/** Discord 搜尋 API 單頁上限。 */
export const SEARCH_PAGE_MAX = 25;

/**
 * 伺服器搜尋 API 的查詢參數。
 * 沒給日期取最新的一批（desc），給了日期用 min_id 限定起點、從舊的開始取（asc）：
 * 「知道是哪一天」時要看的是那天之後最早發生的事，跟 read_history 的 date 一致。
 */
export function guildSearchParams({
  channelId, query = '', authorId = null, afterId = null, limit, oldestFirst,
  offset = 0, includeNsfw = false,
}) {
  const params = new URLSearchParams({
    channel_id: String(channelId),
    limit: String(Math.min(limit, SEARCH_PAGE_MAX)),
    sort_by: 'timestamp',
    sort_order: oldestFirst ? 'asc' : 'desc',
  });
  if (query) params.set('content', query);
  if (authorId) params.set('author_id', String(authorId));
  if (afterId) params.set('min_id', String(afterId));
  if (offset) params.set('offset', String(offset));
  // Discord 搜尋預設可能濾掉 NSFW 頻道，帶這個才搜得到。參數本身實測會被接受，
  // 但沒有 NSFW 頻道可以比對結果。
  // shortcut: include_nsfw 沒在真的 NSFW 頻道驗證過，有這種頻道時要補測。
  if (includeNsfw) params.set('include_nsfw', 'true');
  return params;
}

/**
 * 搜尋結果按「頻道 + 討論串」分組，攤平後只留這個頻道的訊息，回傳舊→新。
 * total 是 Discord 算的全部符合數，不是這一頁的數量。
 */
export function orderSearchHits({ messages, total_results: total } = {}, channelId, limit, oldestFirst) {
  const hits = (messages ?? []).flat()
    .filter((message) => String(message.channel_id) === String(channelId))
    .sort(bySnowflake);
  return { total: Number(total) || 0, hits: oldestFirst ? hits.slice(0, limit) : hits.slice(-limit) };
}

/**
 * 一頁一頁蒐集搜尋結果，湊滿 limit 就停。篩選後不夠時再翻下一頁：
 * 被封鎖的人與 `\//` 也佔搜尋結果的名額，只抓一頁會少回。
 * 回傳一律舊→新：desc 是新的一頁先來，最後才統一排序。
 */
export async function collectSearchHits({ pages, limit, channelId, oldestFirst, fetchPage, visible = () => true }) {
  const picked = [];
  let total = 0;
  for (let page = 0; page < pages && picked.length < limit; page += 1) {
    const data = await fetchPage(page * SEARCH_PAGE_MAX);
    total = Number(data?.total_results) || 0;
    const { hits } = orderSearchHits(data, channelId, SEARCH_PAGE_MAX, oldestFirst);
    const visibleHits = hits.filter(visible);
    // desc 時每頁新→舊排：同頁裡新的在後面，先翻過來才接得上下一頁。
    picked.push(...(oldestFirst ? visibleHits : visibleHits.reverse()));
    if (hits.length < SEARCH_PAGE_MAX) break;
  }
  return { total, hits: picked.slice(0, limit).sort(bySnowflake) };
}

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
