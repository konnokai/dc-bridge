// 明日方舟幹員練度統計（一圖流 yituliu）：把全服持有者的專精與模組分布整理成建議。
//
// 統計端點只有 charId；幹員名、技能名與模組名要另一份幹員表。兩邊都是公開唯讀資料，
// 沒有金鑰。統計與幹員表快取在行程內；PRTS 的幹員別名（redirect）抓一次就寫進
// state/arknights-aliases.json 永久沿用，之後不再連 PRTS。
//
// 數值語意（對齊一圖流前端）：skillN 的 key 3 = 專精三、equipN 的 key 3 = 模組階段 3；
// key 4 以上是上游零星髒資料，忽略。分母固定用 own（持有者數）。
import {
  ALIAS_STATUS,
  buildAliasStore,
  normalizeName,
  readAliasStoreStatus,
  recordAlias,
  writeAliasStore,
} from './arknights-aliases.mjs';

const STATS_URL = 'https://auth.yituliu.cn/open/ak-operator-statistics/v2/result';
// 幹員表在別人的前端 repo；jsDelivr 快取久、raw.githubusercontent 是原始來源。
const TABLE_URLS = [
  'https://cdn.jsdelivr.net/gh/Arknights-yituliu/frontend-v2-plus@main/src/static/json/operator/character_table_simple.v2.json',
  'https://raw.githubusercontent.com/Arknights-yituliu/frontend-v2-plus/main/src/static/json/operator/character_table_simple.v2.json',
];
const PRTS_API = 'https://prts.wiki/api.php';
const STATS_TTL_MS = 6 * 60 * 60 * 1000;
const TABLE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const PRTS_TIMEOUT_MS = 15_000;
const PRTS_TOTAL_BUDGET_MS = 30_000;
const PRTS_BATCH = 50;
const ALIAS_RETRY_MS = 5 * 60 * 1000;

const PROFESSIONS = {
  PIONEER: '先鋒',
  SNIPER: '狙擊',
  MEDIC: '醫療',
  TANK: '重裝',
  WARRIOR: '近衛',
  SUPPORT: '輔助',
  CASTER: '術師',
  SPECIAL: '特種',
};

const cache = new Map(); // key -> { at, retryAt?, data }
let aliasRetryAt = 0;
let aliasFetchPromise = null;

const count = (value) => Number(value) || 0;
const fmt = (value) => String(count(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pct = (part, whole) => `${whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0'}%`;

/** check 回 true 才進快取；回字串代表格式不對，當成這次抓取失敗。 */
async function loadJson(key, urls, ttlMs, label, check = () => true) {
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.at < ttlMs || (hit.retryAt && Date.now() < hit.retryAt))) return hit.data;
  let failure;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const verdict = check(data);
      if (verdict !== true) throw new Error(verdict || `${label}格式不對`);
      cache.set(key, { at: Date.now(), data });
      return data;
    } catch (error) {
      failure = error;
    }
  }
  // 舊資料比沒有好：端點一時掛掉時照樣回答，只是可能落後一輪。
  // 記下重試時間，避免每次呼叫都先卡兩次逾時才回到舊資料。
  if (hit) {
    hit.retryAt = Date.now() + 60_000;
    return hit.data;
  }
  throw new Error(`${label}讀取失敗：${failure?.message ?? failure}`);
}

async function loadStats() {
  const doc = await loadJson('stats', [STATS_URL], STATS_TTL_MS, '練度統計', (data) => {
    if (data?.code !== 200) return `練度統計回應格式不對（code=${data?.code ?? '?'}）`;
    if (!Array.isArray(data.data) || data.data.length === 0) return '練度統計目前是空的（上游還沒跑完批次）';
    return true;
  });
  return doc.data;
}

export const loadTable = () => loadJson('table', TABLE_URLS, TABLE_TTL_MS, '幹員表', (doc) => {
  if (!doc || typeof doc !== 'object') return '幹員表格式不對';
  const rows = Object.values(doc);
  if (!rows.every((op) => op && typeof op.name === 'string' && typeof op.charId === 'string')) return '幹員表格式不對';
  return true;
});

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function prtsApi(params, deadline) {
  let failure;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline ? deadline - Date.now() : PRTS_TIMEOUT_MS;
    if (remaining <= 0) break;
    try {
      const url = new URL(PRTS_API);
      url.search = new URLSearchParams({ ...params, format: 'json' }).toString();
      const res = await fetch(url, {
        headers: { 'user-agent': 'dc-bridge-arknights/0.1' },
        signal: AbortSignal.timeout(Math.min(PRTS_TIMEOUT_MS, remaining)),
      });
      if (!res.ok) throw new Error(`PRTS API HTTP ${res.status}`);
      const doc = await res.json();
      // MediaWiki 的錯誤仍可能是 HTTP 200，錯誤放在 error 欄位；不能當成空結果。
      if (doc?.error) throw new Error(`PRTS API 錯誤：${doc.error.code ?? ''} ${doc.error.info ?? ''}`.trim());
      if (!doc?.query) throw new Error('PRTS 回應缺少 query');
      return doc;
    } catch (error) {
      failure = error;
      // 只重試逾時／連線類錯誤；HTTP 或 API 錯誤重試沒有意義。
      const retryable = /timeout|aborted|fetch failed|network/i.test(String(error?.message ?? error));
      if (!retryable || Date.now() + 1000 >= deadline) break;
      await sleep(500);
    }
  }
  throw failure ?? new Error('PRTS 別名抓取逾時');
}

/** 幹員分類的全部頁面＋每頁 redirect；任何一批失敗就整批放棄，不寫半套。 */
export async function fetchAliasPages(deadline = Date.now() + PRTS_TOTAL_BUDGET_MS) {
  const titles = [];
  let cont;
  do {
    const params = {
      action: 'query',
      list: 'categorymembers',
      cmtitle: 'Category:干员',
      cmlimit: '500',
      cmnamespace: '0',
    };
    if (cont) params.cmcontinue = cont;
    const doc = await prtsApi(params, deadline);
    for (const row of doc.query.categorymembers ?? []) titles.push(row.title);
    cont = doc?.continue?.cmcontinue;
  } while (cont);
  if (titles.length === 0) throw new Error('PRTS 幹員分類是空的');

  const pages = new Map(); // title -> { title, redirects }
  for (let i = 0; i < titles.length; i += PRTS_BATCH) {
    const batch = titles.slice(i, i + PRTS_BATCH);
    let rdcontinue;
    do {
      const params = {
        action: 'query',
        titles: batch.join('|'),
        prop: 'redirects',
        rdlimit: 'max',
        rdnamespace: '0',
      };
      if (rdcontinue) params.rdcontinue = rdcontinue;
      const doc = await prtsApi(params, deadline);
      const rows = Object.values(doc.query.pages ?? {});
      if (rows.length === 0) throw new Error('PRTS 回應沒有頁面');
      for (const page of rows) {
        const existing = pages.get(page.title);
        const redirects = page.redirects ?? [];
        if (existing) existing.redirects.push(...redirects);
        else pages.set(page.title, { title: page.title, redirects: [...redirects] });
      }
      rdcontinue = doc?.continue?.rdcontinue;
    } while (rdcontinue);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return [...pages.values()];
}

/**
 * 別名表：有檔案就用檔案（永久沿用），沒有才抓 PRTS 並寫檔。
 * 檔案損毀時不重建，避免把管理員的拒絕紀錄蓋掉；抓不到就跳過別名層。
 * 同一個程序同時進來的查詢共用同一次抓取。
 */
async function ensureAliasStore(table, aliasFile) {
  const status = readAliasStoreStatus(aliasFile);
  if (status.state === 'ok') return status.store;
  if (status.state === 'corrupt') {
    console.error(`[arknights] 別名檔損毀，先不重建（避免蓋掉拒絕紀錄）：${status.error}`);
    return null;
  }
  if (aliasFetchPromise) return aliasFetchPromise;
  if (aliasRetryAt && Date.now() < aliasRetryAt) return null;
  aliasRetryAt = Date.now() + ALIAS_RETRY_MS;
  aliasFetchPromise = (async () => {
    try {
      const store = buildAliasStore(await fetchAliasPages(), table);
      if (store.entries.length === 0) throw new Error('PRTS 別名表是空的');
      // 抓的期間可能有另一個程序先寫好（或管理員先改了）；已經有檔案就不覆蓋。
      const current = readAliasStoreStatus(aliasFile);
      if (current.state === 'ok') return current.store;
      if (current.state === 'corrupt') {
        console.error(`[arknights] 別名檔在抓取期間損毀，先不覆蓋：${current.error}`);
        return null;
      }
      writeAliasStore(store, aliasFile);
      aliasRetryAt = 0;
      return store;
    } catch (error) {
      console.error(`[arknights] 別名表抓取失敗：${error?.message ?? error}`);
      return null;
    } finally {
      aliasFetchPromise = null;
    }
  })();
  return aliasFetchPromise;
}

/** MCP 啟動後在背景把別名表準備好；已有檔案就不抓幹員表，也不連 PRTS。 */
export async function warmupAliases() {
  const status = readAliasStoreStatus();
  if (status.state === 'ok') return true;
  if (status.state === 'corrupt') {
    console.error(`[arknights] 別名檔損毀，跳過暖機（避免蓋掉拒絕紀錄）：${status.error}`);
    return false;
  }
  try {
    const table = await loadTable();
    const store = await ensureAliasStore(table);
    return Boolean(store);
  } catch (error) {
    console.error(`[arknights] 別名暖機失敗：${error?.message ?? error}`);
    return false;
  }
}

/**
 * 用別名表比對。精確命中優先；「飛天貓」這種查詢包含 PRTS 別名（天猫）時，
 * 只有這樣才不容易和單字名（阿、陳）搞混，所以單字別名不做包含比對。
 * 多條別名同時命中時，最長的那條若包住其他條（Angelina 包住 Lin），只取最長那條。
 */
export function matchAlias(query, table, store) {
  const raw = String(query ?? '').trim();
  const q = normalizeName(raw);
  if (!q || !store?.entries?.length) return null;
  if (store.entries.some((entry) => entry.id === q && entry.status === ALIAS_STATUS.REJECTED)) {
    return { error: `「${raw}」這個別名已被管理員拒絕；請用正式名稱或 charId。` };
  }
  const byId = new Map(Object.values(table).map((op) => [op.charId, op]));
  const active = store.entries.filter((entry) => entry.status === ALIAS_STATUS.ACTIVE);
  const exact = active.find((entry) => entry.id === q);
  const exactOperator = exact ? byId.get(exact.charId) : null;
  if (exactOperator) return { operator: exactOperator, aliasId: exact.id };
  const hits = new Map(); // charId -> { operator, aliasId }
  for (const entry of active) {
    if ([...entry.id].length < 2) continue;
    if (!q.includes(entry.id)) continue;
    const operator = byId.get(entry.charId);
    if (!operator) continue;
    const previous = hits.get(operator.charId);
    if (!previous || entry.id.length > previous.aliasId.length) {
      hits.set(operator.charId, { operator, aliasId: entry.id });
    }
  }
  const ranked = [...hits.values()].sort((a, b) => b.aliasId.length - a.aliasId.length);
  if (ranked.length === 1) return ranked[0];
  if (ranked.length > 1) {
    const [first, ...rest] = ranked;
    if (rest.every((item) => first.aliasId.includes(item.aliasId))) return first;
    return { error: candidateError(`「${raw}」對到多個暱稱`, ranked.map((item) => item.operator)) };
  }
  return null;
}

/** 名稱或 charId 對到唯一幹員；對不到或對到多個時回 { error }。 */
export function matchOperator(query, table) {
  const raw = String(query ?? '').trim();
  const q = normalizeName(raw);
  if (!q) return { error: '請給幹員名稱（簡體或繁體都可以）或 charId，例如「能天使」或 char_103_angel。' };
  const all = Object.values(table);
  const exact = all.find((op) => normalizeName(op.name) === q || String(op.charId).toLowerCase() === raw.toLowerCase());
  if (exact) return { operator: exact };
  const hits = all.filter((op) => normalizeName(op.name).includes(q));
  if (hits.length === 1) return { operator: hits[0] };
  if (hits.length > 1) return { error: candidateError(`「${raw}」對到多位幹員`, hits) };
  // 查詢裡包含幹員名（例如「麒麟夜刀」包含「夜刀」）不代表就是那位，
  // 單字名（阿、黑、空、陈…）尤其容易，所以回同系列候選，不自動選。
  const contained = all
    .map((op) => normalizeName(op.name))
    .filter((name) => q.includes(name))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
  if (contained) {
    const related = all.filter((op) => normalizeName(op.name).includes(contained));
    return { error: candidateError(`「${raw}」裡包含幹員名，但不確定是哪一位`, related) };
  }
  return { error: `找不到「${raw}」對應的幹員。名稱要用遊戲內的中文，或直接給 charId（例如 char_103_angel）。` };
}

function candidateError(reason, ops) {
  const names = ops.slice(0, 10).map((op) => op.name).join('、');
  const more = ops.length > 10 ? `等 ${ops.length} 位` : '';
  return `${reason}：${names}${more}。請用完整名稱或 charId 再查。`;
}

/** 把一位幹員的統計整理成排行榜文字。純函式，測試直接餵 fixture。 */
export function formatTraining(operator, stat) {
  const own = count(stat.own);
  // 一圖流 v2 幹員表的 rarity 已是 1~6 星，不要再加一。
  const rarity = count(operator.rarity);
  const profession = PROFESSIONS[operator.profession] ?? operator.profession ?? '';
  const lines = [
    `${operator.name}（${rarity}★ ${profession}，${operator.charId}）`,
    `一圖流練度統計：${fmt(own)} 人持有（精二 ${fmt(count((stat.elite ?? {})['2']))} 人；比率分母＝持有者）`,
  ];

  const skills = (operator.skills ?? []).map((skill, index) => {
    const dist = stat[`skill${index + 1}`] ?? {};
    return {
      index: index + 1,
      name: skill.skillName || `技能 ${index + 1}`,
      m1: count(dist['1']),
      m2: count(dist['2']),
      m3: count(dist['3']),
    };
  });
  if (skills.length === 0) {
    lines.push('專精：這名幹員沒有技能。');
  } else if (!skills.some((skill) => skill.m3 > 0)) {
    lines.push('專精：目前還沒有人把技能專三。');
  } else {
    lines.push('專精建議（依專三率）：');
    [...skills]
      .sort((a, b) => b.m3 - a.m3 || a.index - b.index)
      .forEach((skill, i) => {
        lines.push(`${i + 1}. 第 ${skill.index} 技能「${skill.name}」：M3 ${pct(skill.m3, own)}（M1 ${fmt(skill.m1)}／M2 ${fmt(skill.m2)}／M3 ${fmt(skill.m3)}）`);
      });
  }

  const modules = (operator.equip ?? []).map((equip) => {
    const type = equip.typeName2;
    const dist = stat[`equip${type}`] ?? {};
    const l3 = count(dist['3']);
    return {
      type,
      name: equip.uniEquipName || type,
      l3,
      // 階段 2、3 都要求先開模組，所以 1+2+3 就是「有開」的人數。
      open: count(dist['1']) + count(dist['2']) + l3,
    };
  });
  if (modules.length === 0) {
    lines.push('模組：這名幹員沒有模組。');
  } else if (!modules.some((module) => module.open > 0)) {
    lines.push('模組：目前還沒有人開模組。');
  } else {
    lines.push('模組建議（依階段 3 率）：');
    [...modules]
      .sort((a, b) => b.l3 - a.l3 || b.open - a.open)
      .forEach((module, i) => {
        lines.push(`${i + 1}. ${module.type} 模組「${module.name}」：階段3 ${pct(module.l3, own)}（${fmt(module.l3)} 人），開啟 ${pct(module.open, own)}（${fmt(module.open)} 人）`);
      });
  }

  return lines.join('\n');
}

/** 查一位幹員的專精／模組建議；失敗直接丟錯，由 MCP 工具轉成 isError。 */
export async function lookupTraining(query, { aliasFile } = {}) {
  const [table, stats] = await Promise.all([loadTable(), loadStats()]);
  const rawQuery = String(query ?? '').trim();
  const matched = matchOperator(query, table);
  let operator = matched.operator;
  if (!operator && rawQuery) {
    const store = await ensureAliasStore(table, aliasFile);
    const viaAlias = matchAlias(query, table, store);
    if (viaAlias?.operator) {
      operator = viaAlias.operator;
      // 查到就永久記下來；只收接近別名本身的查詢（「42专三」這種加料的不記）。
      const extra = [...rawQuery].length - [...viaAlias.aliasId].length;
      if (extra <= 1 && !/\s/.test(rawQuery) && recordAlias(store, {
        alias: rawQuery,
        charId: operator.charId,
        name: operator.name,
        source: 'query',
      })) {
        try { writeAliasStore(store, aliasFile); }
        catch (error) { console.error(`[arknights] 別名寫入失敗：${error?.message ?? error}`); }
      }
    } else if (viaAlias?.error) {
      return viaAlias.error;
    }
  }
  if (!operator) return matched.error;
  const stat = stats.find((row) => row.charId === operator.charId);
  if (!stat) return `${operator.name}（${operator.charId}）還沒有練度統計資料。`;
  return formatTraining(operator, stat);
}
