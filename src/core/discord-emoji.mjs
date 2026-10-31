// Discord 自訂表情目錄：挑選、格式化、把 `:名稱:` 換成真正的 emoji tag。
//
// prompt 帶【常用表情】（本服 8＋跨服 4）和【本伺服器表情】的情緒索引；其餘用 search_emojis 查，背後是 retrieveEmojis。
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
const CUSTOM_EMOJI_TAG = /<a?:([a-zA-Z0-9_]{2,32}):(\d{15,25})>/g;
// 當前伺服器的加分：同名表情多一個伺服器時，先挑本地那張。
const CURRENT_GUILD_BONUS = 6;
const EMPTY_INDEX = new Map();
// emojiCatalogs 重新載入時會換成新的 Map；WeakMap 讓舊快取自己消失。
const EMOJI_INDEX_CACHE = new WeakMap();
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
      let score = current !== null && id === current ? CURRENT_GUILD_BONUS : 0;
      // 只有「query 留空」才按使用次數排：關鍵字查詢時命中程度才是重點。
      if (browsing && current !== null && id === current) score += Number(usage?.get?.(String(entry.id))) || 0;
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

const HINT_HEADER = '【常用表情（句子裡寫 :名稱:，reaction 直接寫名稱）】';
const INDEX_HEADER = '【本伺服器表情（按情緒分；句子裡寫 :名稱:，reaction 直接寫名稱）】';
const INDEX_MAX_CHARS = 2500;

/**
 * 情緒分組用的詞表：順序有意義，排前面的先配到。
 * 不放單一個字「笑」：會把「靦腆微笑」也分進「好笑」。
 */
export const EMOJI_MOODS = [
  ['好笑', ['大笑', '笑死', '好笑', '爆笑', '噴笑', '笑爛']],
  ['無語', ['無語', '呆滯', '傻眼', '無奈', '白眼', '放空']],
  ['困惑', ['困惑', '疑惑', '問號', '不懂']],
  ['驚訝', ['驚訝', '震驚', '嚇', '吃驚']],
  ['哭／委屈', ['大哭', '哭', '委屈', '難過', '眼淚']],
  ['崩潰', ['崩潰', '絕望', '抓狂']],
  ['生氣／嫌棄', ['生氣', '憤怒', '嫌棄', '鄙視', '不滿']],
  ['害羞／撒嬌', ['害羞', '撒嬌', '臉紅', '靦腆']],
  ['喜歡／愛心', ['愛心', '喜歡', '抱抱']],
  ['得意', ['得意', '自信', '炫耀', '壞笑']],
  ['期待／興奮', ['期待', '興奮', '好耶', '歡呼']],
  ['應援／拍手', ['應援', '螢光棒', '拍手', '加油']],
  ['打招呼', ['打招呼', '揮手', '早安', '晚安', '再見']],
  ['累／睡', ['睡', '累', '疲倦']],
  ['吃', ['吃', '餓']],
  ['開心', ['開心', '微笑', '滿足']],
  ['看戲', ['看戲', '圍觀', '偷看', '盯']],
];

/**
 * prompt 的【常用表情】：本伺服器用過的前 localMax 個，其他伺服器前 otherMax 個。
 * 只收有使用紀錄的：純目錄順序跟當下無關。同名只列一次，本伺服器優先。
 * 私聊沒有「本伺服器」，全部合起來取 localMax + otherMax。
 */
export function buildEmojiHint(catalogs, { guildId = null, usage = null, localMax = 8, otherMax = 4, maxChars = 600 } = {}) {
  if (!catalogs?.size || !usage?.size) return '';
  const current = guildId === null || guildId === undefined ? null : String(guildId);
  const local = [];
  const other = [];
  for (const [id, catalog] of catalogs) {
    for (const entry of catalog.entries ?? []) {
      if (!entry?.id || !entry?.name) continue;
      const count = Number(usage.get(id)?.get?.(String(entry.id))) || 0;
      if (count <= 0) continue;
      (current !== null && id === current ? local : other).push({ entry, count });
    }
  }
  const byCount = (a, b) => b.count - a.count || String(a.entry.name).localeCompare(String(b.entry.name));
  const picks = current === null
    ? other.sort(byCount).slice(0, localMax + otherMax)
    : [...local.sort(byCount).slice(0, localMax), ...other.sort(byCount).slice(0, otherMax)];

  const lines = [];
  const seen = new Set();
  let used = HINT_HEADER.length + 1;
  for (const { entry } of picks) {
    const key = String(entry.name).toLowerCase();
    if (seen.has(key)) continue;
    const line = `- ${entry.name}：${String(entry.usage || entry.description || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`;
    if (used + line.length + 1 > maxChars) break;
    seen.add(key);
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? `${HINT_HEADER}\n${lines.join('\n')}` : '';
}

/** 先用 usage 比對整張詞表，比不到再比 tags、description。 */
function moodOf(entry) {
  const fields = [
    entry.usage,
    Array.isArray(entry.tags) ? entry.tags.join(' ') : entry.tags,
    entry.description,
  ];
  for (const field of fields) {
    const hay = String(field ?? '').toLowerCase();
    if (!hay) continue;
    for (const [mood, words] of EMOJI_MOODS) {
      if (words.some((word) => hay.includes(word))) return mood;
    }
  }
  return null;
}

/**
 * 本伺服器其餘表情的索引：按情緒分組，只列名稱。
 * 名字多是「Buki_12」這種看不出意思的，只列名字沒用，靠分組讓模型知道大概在講什麼。
 * 分不到組的不列；exclude 是【常用表情】已經列過的名字。
 */
export function buildEmojiIndex(catalogs, { guildId = null, exclude = new Set(), maxChars = INDEX_MAX_CHARS } = {}) {
  if (!catalogs?.size || guildId === null || guildId === undefined) return '';
  const skip = new Set([...exclude].map((name) => String(name).toLowerCase()));
  const groups = new Map(EMOJI_MOODS.map(([mood]) => [mood, []]));
  for (const entry of catalogs.get(String(guildId))?.entries ?? []) {
    if (!entry?.id || !entry?.name) continue;
    const name = String(entry.name);
    if (skip.has(name.toLowerCase())) continue;
    const mood = moodOf(entry);
    if (mood) groups.get(mood).push(name);
  }

  const lines = [];
  let used = INDEX_HEADER.length + 1;
  for (const [mood, names] of groups) {
    if (!names.length) continue;
    names.sort((a, b) => a.localeCompare(b));
    const line = `- ${mood}：${names.join(' ')}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? `${INDEX_HEADER}\n${lines.join('\n')}` : '';
}

function emojiIndex(catalogs) {
  if (!catalogs?.size) return EMPTY_INDEX;
  const cached = EMOJI_INDEX_CACHE.get(catalogs);
  if (cached) return cached;
  const byId = new Map();
  for (const catalog of catalogs.values()) {
    for (const entry of catalog.entries ?? []) {
      if (entry?.id && entry?.name) byId.set(String(entry.id), entry);
    }
  }
  EMOJI_INDEX_CACHE.set(catalogs, byId);
  return byId;
}

/**
 * 進來的 `<:名稱:id>` / `<a:名稱:id>` → `[表情：名稱（目錄描述）]`。
 * 目錄有的用目錄名稱與外觀描述（視覺模型寫的），沒有就只留名稱。
 * 同一則訊息同一個表情只描述一次；描述裡的換行與括號會清掉，避免偽造標籤邊界。
 * 冒號字面詞、Unicode emoji、時間與 URL 不會命中。
 * 已知限制：程式碼區塊或跳脫過的 `<:名稱:id>` 也會被換掉；這種訊息很少，不特別處理。
 */
export function labelEmojiTags(text, catalogs) {
  const value = String(text ?? '');
  if (!value.includes('<')) return value;
  const byId = emojiIndex(catalogs);
  const seen = new Set();
  return value.replace(CUSTOM_EMOJI_TAG, (match, name, id) => {
    const entry = byId.get(id);
    const label = String(entry?.name || name);
    // 洗表情時不要把同一段描述貼好幾次，正文才有空間。
    if (seen.has(id)) return `[表情：${label}]`;
    seen.add(id);
    const desc = String(entry?.description || entry?.usage || '')
      .replace(/[\[\]［］（）()【】]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (!desc) return `[表情：${label}]`;
    // 目錄用拼圖格看動圖，描述常寫「六格」；先講是動圖，模型才不會當成六連圖。
    const animated = match.startsWith('<a:') || entry?.animated;
    return `[表情：${label}（${animated ? '動圖；' : ''}${desc}）]`;
  });
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

// 鍵帽（4️⃣）和國旗（🇹🇼）的開頭不是 Extended_Pictographic，要另外列。
const UNICODE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/u;

/** 看起來是一個 Unicode emoji；完整驗證交給 Discord，這裡只擋明顯不是的輸入。 */
export function isUnicodeEmoji(value) {
  const text = String(value ?? '');
  return text.length <= 16 && UNICODE_EMOJI.test(text);
}

/**
 * reaction 在快取裡的 key：自訂表情是表情 id，Unicode 是原文。
 * rendered 是 substituteEmojiNames 的結果；原始輸入認不出可用表情時回 null。
 */
export function reactionKey(rendered, name) {
  const custom = /^<a?:([^:]+):([^:>]+)>$/.exec(String(rendered ?? ''));
  if (custom) return custom[2];
  const value = String(name ?? '').trim().replace(/^:|:$/g, '');
  return isUnicodeEmoji(value) ? value : null;
}

/**
 * 這則訊息上「自己按的」那個 reaction；找不到或不是自己按的回 null。
 */
export function ownReaction(message, identifier) {
  const reaction = message?.reactions?.cache?.get?.(identifier);
  return reaction?.me ? reaction : null;
}

// ── 使用次數（README 工作包 K） ─────────────────────────────────────────────
// 讓 search_emojis 的 query 留空時把常用的排前面，也是【常用表情】的排序依據；不是評分。
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
