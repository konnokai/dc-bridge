// 三大法人買賣超日報。
//
// 台股收盤後才有完整資料；TWSE 用 T86、TPEx 用 OpenAPI。數字是「股」，
// 顯示時再換成張。抓不到就回空，不編數字；復盤 prompt 會標「查不到」。

const TWSE_URL = 'https://www.twse.com.tw/rwd/zh/fund/T86';
const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading';

function shares(value) {
  const number = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(number) ? number : null;
}

function rocDateToIso(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{7}$/.test(text)) return '';
  return `${Number(text.slice(0, 3)) + 1911}-${text.slice(3, 5)}-${text.slice(5, 7)}`;
}

function twseParam(date) {
  return String(date ?? '').replace(/-/g, '');
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** TWSE T86 回傳的是「欄位名 + 資料列」，用欄位名找索引，不硬寫位置。 */
export function parseTwseInstitutional(doc, date) {
  const fields = Array.isArray(doc?.fields) ? doc.fields : [];
  const index = (label) => {
    const exact = fields.findIndex((field) => String(field).trim() === label);
    return exact >= 0 ? exact : fields.findIndex((field) => String(field).includes(label));
  };
  const iForeign = index('外陸資買賣超股數');
  const iTrust = index('投信買賣超股數');
  const iDealer = index('自營商買賣超股數');
  const iTotal = index('三大法人買賣超股數');
  if ([iForeign, iTrust, iDealer, iTotal].some((indexValue) => indexValue < 0)) return new Map();
  if (String(doc?.date ?? '') !== twseParam(date)) return new Map();
  const bySymbol = new Map();
  for (const row of Array.isArray(doc?.data) ? doc.data : []) {
    const symbol = String(row?.[0] ?? '').trim();
    if (!symbol) continue;
    bySymbol.set(symbol, {
      symbol,
      name: String(row?.[1] ?? '').trim(),
      date,
      foreignNet: shares(row?.[iForeign]),
      trustNet: shares(row?.[iTrust]),
      dealerNet: shares(row?.[iDealer]),
      totalNet: shares(row?.[iTotal]),
      source: 'TWSE T86',
    });
  }
  return bySymbol;
}

/** TPEx OpenAPI 一次回傳最新一天；只收指定日期。 */
export function parseTpexInstitutional(rows, date) {
  const bySymbol = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (rocDateToIso(row?.Date) !== date) continue;
    const symbol = String(row?.SecuritiesCompanyCode ?? '').trim();
    if (!symbol) continue;
    bySymbol.set(symbol, {
      symbol,
      name: String(row?.CompanyName ?? '').trim(),
      date,
      foreignNet: shares(row?.['Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference']),
      trustNet: shares(row?.['SecuritiesInvestmentTrustCompanies-Difference']),
      dealerNet: shares(row?.['Dealers-Difference']),
      totalNet: shares(row?.['TotalDifference']),
      source: 'TPEx OpenAPI',
    });
  }
  return bySymbol;
}

export function createInstitutionalProvider({ fetchImpl = fetchJson, timeoutMs = 12_000, log = () => {} } = {}) {
  const cache = new Map(); // `${source}|${date}` -> Map

  async function load(source, date, loadFn) {
    const key = `${source}|${date}`;
    if (cache.has(key)) return cache.get(key);
    try {
      const map = await loadFn(date);
      if (map.size > 0) cache.set(key, map);
      return map;
    } catch (error) {
      log(`法人資料 ${source} 抓取失敗：${error?.message ?? error}`);
      return null;
    }
  }

  async function loadTwse(date) {
    return load('TWSE', date, async () => {
      const doc = await fetchImpl(`${TWSE_URL}?date=${twseParam(date)}&selectType=ALL&response=json`, timeoutMs);
      return parseTwseInstitutional(doc, date);
    });
  }

  async function loadTpex(date) {
    return load('TPEx', date, async () => {
      const rows = await fetchImpl(TPEX_URL, timeoutMs);
      return parseTpexInstitutional(rows, date);
    });
  }

  /** entries 是商品主檔：{ symbol, exchange }。 */
  async function getForSymbols(entries, date) {
    const bySymbol = new Map();
    const missing = [];
    const errors = [];
    const twse = entries.filter((entry) => entry.exchange === 'TWSE');
    const tpex = entries.filter((entry) => entry.exchange === 'TPEx');
    if (twse.length) {
      const map = await loadTwse(date);
      if (!map) errors.push('TWSE');
      for (const entry of twse) {
        const data = map?.get(entry.symbol);
        if (data) bySymbol.set(entry.symbol, data);
        else missing.push(entry.symbol);
      }
    }
    if (tpex.length) {
      const map = await loadTpex(date);
      if (!map) errors.push('TPEx');
      for (const entry of tpex) {
        const data = map?.get(entry.symbol);
        if (data) bySymbol.set(entry.symbol, data);
        else missing.push(entry.symbol);
      }
    }
    return { date, bySymbol, missing, errors };
  }

  return { getForSymbols };
}
