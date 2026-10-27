// Discord 自訂表情目錄：挑選、格式化、把 `:名稱:` 換成真正的 emoji tag。
//
// 表情不再整張塞進 prompt：模型想用表情時呼叫 search_emojis 工具查，背後就是 retrieveEmojis。
// v1 用關鍵字（中文 bigram）排序，不碰 embedding；之後要換成向量檢索時，
// 只需替換 retrieveEmojis 的實作，工具介面與 `:名稱:` 協定都不用改。
//
// 為什麼 prompt 不直接給 `<:name:id>`：id 又長又容易抄錯，而且同名 emoji 在不同
// 伺服器有不同 id。給名稱、由橋接代換，模型只要輸出 `:名稱:`。
import fs from 'node:fs';
import path from 'node:path';

const ASCII_TOKEN = /[a-z0-9_]{2,}/g;
const CJK_RUN = /[\u3400-\u9fff]+/g;
const EMOJI_TOKEN = /(?<![\w:]):([a-zA-Z0-9_]{2,32}):(?![\w:])/g;
// 單字比對用的停用字：只留有意義的字，避免「的/了/是」把每個描述都命中。
const CJK_STOP = new Set('的了是我你他她它不在有和就都一這那個們嗎呢吧啊很太也還又但所以如果'.split(''));

/** 單一伺服器的目錄檔名。 */
export function catalogFile(dir, guildId) {
  return path.join(dir, `${guildId}.json`);
}

export function loadCatalog(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) return null;
    return doc;
  } catch {
    return null;
  }
}

/** 讀整個目錄夾（`<guildId>.json`）。壞檔跳過，不讓一個伺服器拖垮全部。 */
export function loadCatalogs(dir) {
  const out = new Map();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of files) {
    if (!/^\d+\.json$/.test(name)) continue;
    const doc = loadCatalog(path.join(dir, name));
    if (!doc) continue;
    out.set(String(doc.guildId ?? name.slice(0, -5)), doc);
  }
  return out;
}

/** 查詢字串 → 關鍵字集合（ASCII 詞 + 中文 bigram + 去停用字的單字）。 */
export function queryTokens(text) {
  const value = String(text ?? '').toLowerCase();
  const tokens = new Set(value.match(ASCII_TOKEN) ?? []);
  for (const run of value.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      if (!CJK_STOP.has(run)) tokens.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
    // 單字也收：描述通常很短（「大笑」「哭」），只靠 bigram 會漏掉「笑死」→「大笑」。
    for (const char of run) {
      if (!CJK_STOP.has(char)) tokens.add(char);
    }
  }
  return tokens;
}

function haystackOf(entry) {
  return [
    entry.name,
    entry.description,
    entry.usage,
    ...(Array.isArray(entry.tags) ? entry.tags : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

/** 目錄排序用的一行。 */
export function formatEmojiLine(entry) {
  const desc = entry.description || entry.usage || '';
  const usage = entry.description && entry.usage ? `（${entry.usage}）` : '';
  return `${entry.name}：${desc}${usage}`;
}

/**
 * 挑候選表情。
 * 規則：當前伺服器 +6、名稱命中 +4、其他關鍵字每命中 +2；按分數取前 k 個，受 maxChars 限制。
 * 有查詢字時只回命中關鍵字的；查詢字是空的就列當前伺服器的。
 */
export function retrieveEmojis(catalogs, { guildId = null, text = '', k = 12, maxChars = 600 } = {}) {
  if (!catalogs?.size) return [];
  const current = guildId === null || guildId === undefined ? null : String(guildId);
  const tokens = queryTokens(text);
  const rows = [];

  for (const [id, catalog] of catalogs) {
    for (const entry of catalog.entries ?? []) {
      if (!entry?.id || !entry?.name) continue;
      let score = current && id === current ? 6 : 0;
      let keywordScore = 0;
      const hay = haystackOf(entry);
      for (const token of tokens) {
        if (!hay.includes(token)) continue;
        const weight = token.length >= 2 ? 2 : 1;
        score += weight;
        keywordScore += weight;
      }
      if (tokens.has(String(entry.name).toLowerCase())) { score += 4; keywordScore += 4; }
      rows.push({ entry, guildId: id, score, keywordScore });
    }
  }
  rows.sort((a, b) => b.score - a.score || String(a.entry.name).localeCompare(String(b.entry.name)));

  // 有查詢字就只要命中關鍵字的：當前伺服器的 +6 會讓每個本服表情都大於 0 分，
  // 只看 score 會把結果塞滿不相關的。沒有查詢字就是「瀏覽」，照分數列出本服的。
  const picked = rows
    .filter((row) => (tokens.size > 0 ? row.keywordScore > 0 : row.score > 0))
    .slice(0, k);

  const out = [];
  let used = 0;
  for (const row of picked) {
    const line = formatEmojiLine(row.entry);
    if (used + line.length > maxChars) break;
    out.push({ ...row.entry, guildId: row.guildId, keywordScore: row.keywordScore });
    used += line.length + 1;
  }
  return out;
}

/**
 * 把模型輸出的 `:名稱:` 換成 `<:名稱:id>` / `<a:名稱:id>`。
 * 當前伺服器的同名表情優先；找不到就保留原文（不亂猜 id）。
 * URL 與時間（`http://`、`12:30`）不會命中，因為名稱必須存在目錄裡。
 */
export function substituteEmojiNames(text, { guildId = null, catalogs } = {}) {
  const value = String(text ?? '');
  if (!catalogs?.size || !value.includes(':')) return value;

  const current = guildId === null || guildId === undefined ? null : String(guildId);
  const byName = new Map();
  for (const [id, catalog] of catalogs) {
    if (current && id === current) continue;
    for (const entry of catalog.entries ?? []) {
      if (entry?.name && entry?.id) byName.set(String(entry.name).toLowerCase(), entry);
    }
  }
  if (current) {
    for (const entry of catalogs.get(current)?.entries ?? []) {
      if (entry?.name && entry?.id) byName.set(String(entry.name).toLowerCase(), entry);
    }
  }

  return value.replace(EMOJI_TOKEN, (match, name) => {
    const hit = byName.get(String(name).toLowerCase());
    if (!hit) return match;
    return `<${hit.animated ? 'a' : ''}:${hit.name}:${hit.id}>`;
  });
}
