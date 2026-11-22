// 明日方舟幹員練度統計（一圖流 yituliu）：把全服持有者的專精與模組分布整理成建議。
//
// 統計端點只有 charId；幹員名、技能名與模組名要另一份幹員表。兩邊都是公開唯讀資料，
// 沒有金鑰，快取只在這個行程內。
//
// 數值語意（對齊一圖流前端）：skillN 的 key 3 = 專精三、equipN 的 key 3 = 模組階段 3；
// key 4 以上是上游零星髒資料，忽略。分母固定用 own（持有者數）。
import { Converter } from 'opencc-js';

const STATS_URL = 'https://auth.yituliu.cn/open/ak-operator-statistics/v2/result';
// 幹員表在別人的前端 repo；jsDelivr 快取久、raw.githubusercontent 是原始來源。
const TABLE_URLS = [
  'https://cdn.jsdelivr.net/gh/Arknights-yituliu/frontend-v2-plus@main/src/static/json/operator/character_table_simple.v2.json',
  'https://raw.githubusercontent.com/Arknights-yituliu/frontend-v2-plus/main/src/static/json/operator/character_table_simple.v2.json',
];
const STATS_TTL_MS = 6 * 60 * 60 * 1000;
const TABLE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

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

const toSimplified = Converter({ from: 'tw', to: 'cn' });
const cache = new Map(); // key -> { at, retryAt?, data }

const count = (value) => Number(value) || 0;
const fmt = (value) => String(count(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pct = (part, whole) => `${whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0'}%`;

/** 名稱比對用的正規化：繁轉簡、全形轉半形、去括號／間隔號／空白、不分大小寫。 */
const normalizeName = (value) => toSimplified(String(value ?? ''))
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s()·・•\[\]（）【】]/g, '');

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

const loadTable = () => loadJson('table', TABLE_URLS, TABLE_TTL_MS, '幹員表', (doc) => {
  if (!doc || typeof doc !== 'object') return '幹員表格式不對';
  const rows = Object.values(doc);
  if (!rows.every((op) => op && typeof op.name === 'string' && typeof op.charId === 'string')) return '幹員表格式不對';
  return true;
});

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
export async function lookupTraining(query) {
  const [table, stats] = await Promise.all([loadTable(), loadStats()]);
  const matched = matchOperator(query, table);
  if (matched.error) return matched.error;
  const stat = stats.find((row) => row.charId === matched.operator.charId);
  if (!stat) return `${matched.operator.name}（${matched.operator.charId}）還沒有練度統計資料。`;
  return formatTraining(matched.operator, stat);
}
