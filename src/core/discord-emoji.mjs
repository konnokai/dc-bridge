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

/**
 * 挑貼圖：名稱、說明、tags 命中任一關鍵字就算。query 留空、或一張都沒命中，就回全部（matched=false）：
 * 一個伺服器的貼圖不多，列全部比讓模型以為沒有貼圖好。
 */
export function matchStickers(stickers, query, max = 30) {
  const tokens = [...queryTokens(query)];
  const hit = stickers.filter((s) => {
    const hay = `${s.name} ${s.description ?? ''} ${s.tags ?? ''}`.toLowerCase();
    return tokens.some((t) => hay.includes(t));
  });
  const matched = tokens.length === 0 || hit.length > 0;
  return { stickers: (tokens.length && matched ? hit : stickers).slice(0, max), matched };
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
 * 有查詢字時只回命中關鍵字的；查詢字是空的就列當前伺服器的，常用的排前面（usage：id → 次數）。
 */
export function retrieveEmojis(catalogs, { guildId = null, text = '', k = 12, maxChars = 600, usage = null } = {}) {
  if (!catalogs?.size) return [];
  const current = guildId === null || guildId === undefined ? null : String(guildId);
  const tokens = queryTokens(text);
  const browsing = tokens.size === 0;
  const rows = [];

  for (const [id, catalog] of catalogs) {
    for (const entry of catalog.entries ?? []) {
      if (!entry?.id || !entry?.name) continue;
      let score = current && id === current ? 6 : 0;
      // 只有「query 留空」才按使用次數排：關鍵字查詢時命中程度才是重點。
      if (browsing && current && id === current) score += Number(usage?.get?.(String(entry.id))) || 0;
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

/**
 * reaction 在快取裡的 key：自訂表情是表情 id，Unicode 是原文。
 * rendered 是 substituteEmojiNames 的結果；原始輸入認不出可用表情時回 null。
 */
export function reactionKey(rendered, name) {
  const custom = /^<a?:([^:]+):([^:>]+)>$/.exec(String(rendered ?? ''));
  if (custom) return custom[2];
  const value = String(name ?? '').trim().replace(/^:|:$/g, '');
  if (value.length <= 16 && /^\p{Extended_Pictographic}/u.test(value)) return value;
  return null;
}

/**
 * 這則訊息上「自己按的」那個 reaction；找不到或不是自己按的回 null。
 */
export function ownReaction(message, identifier) {
  const reaction = message?.reactions?.cache?.get?.(identifier);
  return reaction?.me ? reaction : null;
}

// ── 使用次數（README 工作包 K） ─────────────────────────────────────────────
// 只為了讓 search_emojis 的 query 留空時把常用的排前面；不進 prompt、不是評分。
// 檔案壞掉就從空的重建：這只是排序提示，不值得為它停機或備份。

const EMOJI_TAG = /<a?:\w{2,32}:(\d{15,25})>/g;

/** 從訊息內容數自訂表情（`<:name:id>`／`<a:name:id>`），回傳 Map<emojiId, 次數>。 */
export function countEmojiTags(text) {
  const out = new Map();
  const value = String(text ?? '');
  if (!value.includes('<')) return out;
  for (const match of value.matchAll(EMOJI_TAG)) out.set(match[1], (out.get(match[1]) ?? 0) + 1);
  return out;
}

/** 讀 `state/discord-emoji-usage.json`：`{ version: 1, guilds: { <guildId>: { <emojiId>: 次數 } } }`。 */
export function loadEmojiUsage(file) {
  const out = new Map();
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  if (doc?.version !== 1 || !doc.guilds || typeof doc.guilds !== 'object') return out;
  for (const [guildId, counts] of Object.entries(doc.guilds)) {
    const mine = Object.entries(counts ?? {}).filter(([, n]) => Number.isInteger(n) && n > 0);
    if (mine.length) out.set(String(guildId), new Map(mine));
  }
  return out;
}

/** 原子寫回；順手丟掉不在目錄裡的 id，讓檔案不會隨著刪掉的表情長大。 */
export function saveEmojiUsage(file, usage, { catalogs = null } = {}) {
  const guilds = {};
  for (const [guildId, counts] of usage) {
    const alive = catalogs?.get(String(guildId))
      ? new Set((catalogs.get(String(guildId)).entries ?? []).map((entry) => String(entry.id)))
      : null;
    const rows = [...counts].filter(([id]) => !alive || alive.has(String(id)));
    if (rows.length) guilds[guildId] = Object.fromEntries(rows);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, guilds }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 把一則訊息用到的自訂表情記進 usage（guildId → Map<emojiId, 次數>）；回傳記到幾種。 */
export function bumpEmojiUsage(usage, guildId, text, { entries = null, maxIds = 500 } = {}) {
  if (!guildId) return 0;
  const found = countEmojiTags(text);
  if (found.size === 0) return 0;
  // 只記目錄裡真的有的表情：群友貼假 id 撐不大檔案，也不會擠掉新表情。
  const allowed = entries ? new Set(entries.map((entry) => String(entry.id))) : null;
  const ids = [...found.keys()].filter((id) => !allowed || allowed.has(id));
  if (ids.length === 0) return 0;
  const key = String(guildId);
  let counts = usage.get(key);
  if (!counts) {
    counts = new Map();
    usage.set(key, counts);
  }
  // 一則訊息同一個表情只算一次：群友貼一排 kekw 不該把整個排序拉走。
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  if (counts.size > maxIds) {
    const keep = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxIds);
    counts.clear();
    for (const [id, n] of keep) counts.set(id, n);
  }
  return ids.length;
}
