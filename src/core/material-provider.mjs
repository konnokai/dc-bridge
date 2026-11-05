// 上市／上櫃每日重大訊息（MOPS）。
//
// 收盤後才抓得到當天公告；OpenAPI 的「發言日期」是公告日，「出表日期」是資料匯出日。
// 只收公告日等於復盤日的資料；抓不到就回 available=false，讓復盤等到 19:40 再決定。

const TWSE_URL = 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L';
const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O';

function rocDateToIso(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{7}$/.test(text)) return '';
  return `${Number(text.slice(0, 3)) + 1911}-${text.slice(3, 5)}-${text.slice(5, 7)}`;
}

function clock(value) {
  const text = String(value ?? '').trim().padStart(6, '0');
  if (!/^\d{6}$/.test(text)) return '';
  return `${text.slice(0, 2)}:${text.slice(2, 4)}`;
}

function text(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function parseTwseMaterial(rows, date, since = date) {
  const bySymbol = new Map();
  let total = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const announcementDate = rocDateToIso(row?.['發言日期']);
    if (!announcementDate || announcementDate < since || announcementDate > date) continue;
    total += 1;
    const symbol = String(row?.['公司代號'] ?? '').trim();
    if (!symbol) continue;
    const item = {
      date: announcementDate,
      time: clock(row?.['發言時間']),
      symbol,
      name: text(row?.['公司名稱'], 60),
      subject: text(row?.['主旨 '] ?? row?.['主旨'], 300),
      clause: text(row?.['符合條款'], 40),
      detail: text(row?.['說明'], 500),
      source: 'TWSE MOPS',
    };
    const list = bySymbol.get(symbol) ?? [];
    list.push(item);
    bySymbol.set(symbol, list);
  }
  return { total, bySymbol };
}

export function parseTpexMaterial(rows, date, since = date) {
  const bySymbol = new Map();
  let total = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const announcementDate = rocDateToIso(row?.['發言日期']);
    if (!announcementDate || announcementDate < since || announcementDate > date) continue;
    total += 1;
    const symbol = String(row?.SecuritiesCompanyCode ?? '').trim();
    if (!symbol) continue;
    const item = {
      date: announcementDate,
      time: clock(row?.['發言時間']),
      symbol,
      name: text(row?.CompanyName, 60),
      subject: text(row?.['主旨'], 300),
      clause: text(row?.['符合條款'], 40),
      detail: text(row?.['說明'], 500),
      source: 'TPEx MOPS',
    };
    const list = bySymbol.get(symbol) ?? [];
    list.push(item);
    bySymbol.set(symbol, list);
  }
  return { total, bySymbol };
}

export function createMaterialProvider({ fetchImpl = fetchJson, timeoutMs = 12_000, log = () => {} } = {}) {
  const cache = new Map(); // `${date}|${since}` -> { available, bySymbol, errors }

  async function load(date, since) {
    const key = `${date}|${since}`;
    if (cache.has(key)) return cache.get(key);
    const errors = [];
    let twse = { total: 0, bySymbol: new Map() };
    let tpex = { total: 0, bySymbol: new Map() };
    const [twseResult, tpexResult] = await Promise.allSettled([
      (async () => parseTwseMaterial(await fetchImpl(TWSE_URL, timeoutMs), date, since))(),
      (async () => parseTpexMaterial(await fetchImpl(TPEX_URL, timeoutMs), date, since))(),
    ]);
    if (twseResult.status === 'fulfilled') twse = twseResult.value;
    else {
      errors.push('TWSE');
      log(`重大訊息 TWSE 抓取失敗：${twseResult.reason?.message ?? twseResult.reason}`);
    }
    if (tpexResult.status === 'fulfilled') tpex = tpexResult.value;
    else {
      errors.push('TPEx');
      log(`重大訊息 TPEx 抓取失敗：${tpexResult.reason?.message ?? tpexResult.reason}`);
    }
    const bySymbol = new Map([...twse.bySymbol, ...tpex.bySymbol]);
    const result = {
      available: twse.total + tpex.total > 0,
      bySymbol,
      errors,
      total: twse.total + tpex.total,
    };
    // 空資料不快取：可能還沒更新，下一輪要重抓。
    if (result.available) {
      cache.clear();
      cache.set(key, result);
    }
    return result;
  }

  async function getForSymbols(entries, date, { since = date } = {}) {
    const all = await load(date, since);
    const bySymbol = new Map();
    for (const entry of entries) {
      const items = all.bySymbol.get(entry.symbol) ?? [];
      const unique = new Map();
      for (const item of items) unique.set(`${item.date}|${item.time}|${item.subject}`, item);
      const sorted = [...unique.values()]
        .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`))
        .slice(0, 3);
      if (sorted.length) bySymbol.set(entry.symbol, sorted);
    }
    return { date, available: all.available, bySymbol, errors: all.errors, total: all.total };
  }

  return { getForSymbols };
}
