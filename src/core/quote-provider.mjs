// 台股盤後報價來源：證交所與櫃買中心的 OpenAPI 日資料。
//
// 這裡只拿「最近一個交易日的官方收盤價」，不是盤中即時價。A 模式的下單不看這裡的價格，
// 只有結算與估值會用；收盤日期必須等於訂單的 trade_date 才成交，避免拿舊價硬算。
//
// 快取：兩個來源各自一份，5 分鐘內不重抓。抓失敗保留舊資料並記下錯誤，結算 job 會看到
// 「沒有當日資料」而延後，不會編一個價格出來。

const TWSE_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
const HOLIDAY_URL = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';

const CACHE_TTL_MS = 5 * 60_000;
const HOLIDAY_TTL_MS = 12 * 60 * 60_000;

function rocDateToIso(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{7}$/.test(text)) return '';
  const year = Number(text.slice(0, 3)) + 1911;
  const month = text.slice(3, 5);
  const day = text.slice(5, 7);
  return `${year}-${month}-${day}`;
}

function cents(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!text || text === '-' || text === '--') return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100);
}

function parseTwse(rows) {
  const byCode = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const symbol = String(row?.Code ?? '').trim();
    const date = rocDateToIso(row?.Date);
    const close = cents(row?.ClosingPrice);
    if (!symbol || !date || close === null || close <= 0) continue;
    const change = cents(row?.Change) ?? 0;
    byCode.set(symbol, {
      symbol,
      name: String(row?.Name ?? '').trim(),
      exchange: 'TWSE',
      source: 'TWSE OpenAPI',
      date,
      closeCents: close,
      changeCents: change,
      referenceCents: close - change,
      asOf: `${date} 13:30`,
    });
  }
  return byCode;
}

function parseTpex(rows) {
  const byCode = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const symbol = String(row?.SecuritiesCompanyCode ?? '').trim();
    const date = rocDateToIso(row?.Date);
    const close = cents(row?.Close);
    if (!symbol || !date || close === null || close <= 0) continue;
    const change = cents(row?.Change) ?? 0;
    byCode.set(symbol, {
      symbol,
      name: String(row?.CompanyName ?? '').trim(),
      exchange: 'TPEx',
      source: 'TPEx OpenAPI',
      date,
      closeCents: close,
      changeCents: change,
      referenceCents: close - change,
      asOf: `${date} 13:30`,
    });
  }
  return byCode;
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function createQuoteProvider({ fetchImpl = fetchJson, timeoutMs = 12_000, log = () => {} } = {}) {
  const sources = {
    TWSE: { url: TWSE_URL, parse: parseTwse, cache: null, error: null, checkedAt: 0 },
    TPEx: { url: TPEX_URL, parse: parseTpex, cache: null, error: null, checkedAt: 0 },
  };
  let holidays = { set: new Set(), at: 0, error: null, retryAt: 0 };
  let holidaysInflight = null;

  async function refresh(exchange, { force = false } = {}) {
    const source = sources[exchange];
    if (!source) return null;
    const now = Date.now();
    if (!force && source.cache && now - source.checkedAt < CACHE_TTL_MS) return source.cache;
    // 同一個來源同時被多個股票查價時只抓一次，避免持倉一多就打十次 OpenAPI。
    if (source.inflight) return source.inflight;
    const run = (async () => {
      try {
        const rows = await fetchImpl(source.url, timeoutMs);
        const byCode = source.parse(rows);
        if (byCode.size === 0) throw new Error('回傳空資料');
        const date = [...byCode.values()].map((item) => item.date).sort().at(-1);
        source.cache = { date, byCode, fetchedAt: new Date().toISOString() };
        source.error = null;
      } catch (error) {
        source.error = String(error?.message ?? error);
        log(`報價來源 ${exchange} 抓取失敗：${source.error}`);
      } finally {
        source.checkedAt = Date.now();
      }
      return source.cache;
    })();
    source.inflight = run;
    run.then(() => { if (source.inflight === run) source.inflight = null; },
      () => { if (source.inflight === run) source.inflight = null; });
    return run;
  }

  async function refreshAll({ force = false } = {}) {
    await Promise.allSettled([refresh('TWSE', { force }), refresh('TPEx', { force })]);
  }

  function pick(entry, date = null) {
    const source = sources[entry?.exchange];
    const row = source?.cache?.byCode?.get(String(entry?.symbol ?? ''));
    if (!row) return null;
    if (date && row.date !== date) return null;
    return row;
  }

  async function getLatest(entry, { force = false } = {}) {
    if (!entry?.exchange) return null;
    await refresh(entry.exchange, { force });
    return pick(entry);
  }

  /** 只有資料日期正好等於 trade_date 才算當日收盤；抓不到就回 null，結算會延後。 */
  async function getForDate(entry, date) {
    if (!entry?.exchange || !date) return null;
    await refresh(entry.exchange);
    return pick(entry, date);
  }

  /**
   * 用官方行情反查商品：商品主檔漏收時，要分得出「這支存在」與「代號打錯」。
   * 只認完整代號或完整名稱；來源抓不到就回 null，不猜。
   */
  async function lookup(query) {
    const text = String(query ?? '').trim();
    if (!text) return null;
    const code = text.toUpperCase();
    // 兩個來源同時抓：一次 miss 最多等一個 timeout，不要串成兩倍。
    await Promise.allSettled(Object.keys(sources).map((exchange) => refresh(exchange)));
    for (const exchange of Object.keys(sources)) {
      const byCode = sources[exchange].cache?.byCode;
      if (!byCode) continue;
      const row = byCode.get(code) ?? [...byCode.values()].find((item) => item.name === text);
      if (row) return { symbol: row.symbol, name: row.name, exchange };
    }
    return null;
  }

  /** 整份來源的資料日期（不是單一股票）：用來判斷「這檔股票當天根本沒資料」。 */
  async function dataDate(exchange) {
    const source = sources[exchange];
    if (!source) return null;
    await refresh(exchange);
    return source.cache?.date ?? null;
  }

  async function getHolidays() {
    const now = Date.now();
    if (holidays.at && now - holidays.at < HOLIDAY_TTL_MS) {
      // 失敗的空白清單只留 5 分鐘就重試，不要讓一次失敗蓋掉整個春節。
      if (!holidays.error || now < (holidays.retryAt ?? 0)) return holidays.set;
    }
    if (holidaysInflight) return holidaysInflight;
    const run = (async () => {
      try {
        const rows = await fetchImpl(HOLIDAY_URL, timeoutMs);
        const set = new Set();
        for (const row of Array.isArray(rows) ? rows : []) {
          const date = rocDateToIso(row?.Date);
          const weekday = String(row?.Weekday ?? '');
          const name = String(row?.Name ?? '');
          // 清單裡也包含「開始交易日」與「最後交易日」，那些是交易日不是休市日。
          if (!date || weekday === '六' || weekday === '日') continue;
          if (name.includes('開始交易') || name.includes('最後交易')) continue;
          set.add(date);
        }
        if (set.size === 0) throw new Error('回傳空清單');
        holidays = { set, at: Date.now(), error: null, retryAt: 0 };
      } catch (error) {
        holidays = { ...holidays, at: Date.now(), error: String(error?.message ?? error), retryAt: Date.now() + 5 * 60_000 };
        log(`台股行事曆抓取失敗：${holidays.error}`);
      }
      return holidays.set;
    })();
    holidaysInflight = run;
    run.then(() => { if (holidaysInflight === run) holidaysInflight = null; },
      () => { if (holidaysInflight === run) holidaysInflight = null; });
    return run;
  }

  /** 控制台用：來源、最後成功時間、資料日期、錯誤。 */
  function status() {
    return Object.entries(sources).map(([exchange, source]) => ({
      exchange,
      date: source.cache?.date ?? null,
      fetchedAt: source.cache?.fetchedAt ?? null,
      checkedAt: source.checkedAt ? new Date(source.checkedAt).toISOString() : null,
      count: source.cache?.byCode?.size ?? 0,
      error: source.error,
    })).concat([{
      exchange: 'calendar',
      date: null,
      fetchedAt: holidays.at ? new Date(holidays.at).toISOString() : null,
      checkedAt: holidays.at ? new Date(holidays.at).toISOString() : null,
      count: holidays.set.size,
      error: holidays.error,
    }]);
  }

  return { getLatest, getForDate, getHolidays, refreshAll, status, dataDate, lookup };
}
