// GIPHY 搜尋（只讀）。GIPHY 的 API 條款要求不快取回應與媒體、不改寫回傳的網址、
// 媒體交給客戶端（Discord）直接載入；所以這裡只回當次請求的結果，什麼都不存。

const SEARCH_URL = 'https://api.giphy.com/v1/gifs/search';

/** GIPHY 的 q 最長 50 字，超過會回 414。 */
export const GIF_QUERY_MAX = 50;

/** beta key 的 limit 上限是 50；一次回 5 個給模型挑剛好。 */
const GIF_RESULT_COUNT = 5;

/** GIPHY 的 MPAA 分級；bridge 的 config 也用這份清單。 */
export const GIF_RATINGS = Object.freeze(['g', 'pg', 'pg-13', 'r']);

/**
 * 只收 GIPHY 自家的 https 媒體網址。回應是外部資料，網址要進模型、進頻道，
 * 不能讓它變成任意連結的通道。
 */
function mediaUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return '';
    if (host !== 'giphy.com' && !host.endsWith('.giphy.com')) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * @param {object} options
 * @param {string} options.apiKey GIPHY API key
 * @param {string} options.query 搜尋詞（超過 50 字截斷）
 * @param {string} [options.rating] g / pg / pg-13 / r，預設 pg
 * @param {Function} [options.fetchImpl] 測試注入
 * @returns {Promise<Array<{ title: string, gif: string }>>}
 */
export async function searchGifs({
  apiKey,
  query,
  rating = 'pg',
  fetchImpl = globalThis.fetch,
}) {
  const text = Array.from(String(query ?? '').trim()).slice(0, GIF_QUERY_MAX).join('');
  if (!text) throw Object.assign(new Error('query 不能是空的'), { statusCode: 400 });
  if (!apiKey) {
    throw Object.assign(
      new Error('GIPHY 沒設定 API key：config.json 的 giphy.apiKey，或環境變數 GIPHY_API_KEY'),
      { statusCode: 503 },
    );
  }

  const url = new URL(SEARCH_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('q', text);
  url.searchParams.set('limit', String(GIF_RESULT_COUNT));
  url.searchParams.set('rating', GIF_RATINGS.includes(rating) ? rating : 'pg');

  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw Object.assign(new Error(`連不上 GIPHY：${error?.message ?? error}`), { statusCode: 502 });
  }

  let payload = null;
  try { payload = await res.json(); } catch { /* 下面依狀態碼回報 */ }

  if (res.status === 429) {
    throw Object.assign(
      new Error('GIPHY 的額度用完了（beta key 每小時 100 次）：這一小時先不要再找 GIF'),
      // bridge 用這個標記啟動冷卻，避免每個頻道、每一輪都再打一次 GIPHY。
      { statusCode: 429, giphyRateLimited: true },
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(
      new Error('GIPHY 拒絕這個 API key：檢查 config.json 的 giphy.apiKey'),
      { statusCode: 502 },
    );
  }
  if (!res.ok) {
    const message = typeof payload?.message === 'string'
      ? payload.message.replace(/\s+/g, ' ').trim().slice(0, 100)
      : '';
    throw Object.assign(new Error(`GIPHY 回應 HTTP ${res.status}${message ? `：${message}` : ''}`), { statusCode: 502 });
  }
  // 合成回應：下游故障時 GIPHY 仍回 200，但 response_id 空、沒有資料。
  if (!Array.isArray(payload?.data)) {
    throw Object.assign(new Error('GIPHY 回應格式不對（可能正在維護）'), { statusCode: 502 });
  }
  if (payload.data.length === 0 && payload?.meta?.response_id === '') {
    throw Object.assign(new Error('GIPHY 暫時故障（回應是空的）：等一下再試'), { statusCode: 502 });
  }

  return payload.data
    .map((item) => ({
      title: String(item?.title || item?.alt_text || '').trim(),
      gif: mediaUrl(item?.images?.downsized?.url)
        || mediaUrl(item?.images?.original?.url)
        || mediaUrl(item?.images?.fixed_height?.url),
    }))
    .filter((item) => item.gif);
}
