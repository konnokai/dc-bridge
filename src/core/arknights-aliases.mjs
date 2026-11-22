// 明日方舟幹員別名：PRTS 幹員頁的 redirect 當來源。
//
// 別名第一次由 mcp-arknights 抓下來後寫進 state/arknights-aliases.json，之後永久沿用；
// 控制台讀同一個檔，管理員可以拒絕（模型不用）或刪除。MCP 查到新的查詢別名也會直接補進來。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Converter } from 'opencc-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 可用環境變數覆蓋，方便測試或換位置。
export const ALIAS_FILE = process.env.ARKNIGHTS_ALIAS_FILE || path.join(ROOT, 'state', 'arknights-aliases.json');
export const ALIAS_STATUS = { ACTIVE: 'active', REJECTED: 'rejected' };
export const ALIAS_VERSION = 1;

const toSimplified = Converter({ from: 'tw', to: 'cn' });
const toTraditional = Converter({ from: 'cn', to: 'tw' });

/** 名稱比對用的正規化：繁轉簡、全形轉半形、去括號／間隔號／空白、不分大小寫。 */
export const normalizeName = (value) => toSimplified(String(value ?? ''))
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s()·・•\[\]（）【】?!！？~～。，,]/g, '');

/** 讀別名檔的狀態：missing（沒有檔）、corrupt（讀不到／格式不對）、ok。 */
export function readAliasStoreStatus(file = ALIAS_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'corrupt', error: error?.message ?? String(error) };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { state: 'corrupt', error: `JSON 解析失敗：${error?.message ?? error}` };
  }
  if (doc?.version !== ALIAS_VERSION) return { state: 'corrupt', error: `版本 ${doc?.version ?? '?'} 不支援` };
  if (!Array.isArray(doc.entries)) return { state: 'corrupt', error: 'entries 不是陣列' };
  const entries = doc.entries.filter((entry) => entry
    && typeof entry.id === 'string' && entry.id
    && typeof entry.alias === 'string' && entry.alias
    && typeof entry.charId === 'string' && entry.charId
    && typeof entry.name === 'string' && entry.name
    && (entry.status === ALIAS_STATUS.ACTIVE || entry.status === ALIAS_STATUS.REJECTED));
  return {
    state: 'ok',
    store: {
      version: ALIAS_VERSION,
      builtAt: typeof doc.builtAt === 'string' ? doc.builtAt : null,
      source: typeof doc.source === 'string' ? doc.source : '',
      entries,
    },
  };
}

/** 讀別名檔；沒有或格式不對回 null。要分清楚是哪一種就用 readAliasStoreStatus。 */
export function readAliasStore(file = ALIAS_FILE) {
  const result = readAliasStoreStatus(file);
  return result.state === 'ok' ? result.store : null;
}

/** 原子寫入：先寫暫存檔再 rename，避免控制台讀到半個 JSON。 */
export function writeAliasStore(store, file = ALIAS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 固定檔名在兩個程序同時寫時會互相覆蓋或 rename ENOENT，所以帶 pid 與隨機碼。
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({
      version: ALIAS_VERSION,
      builtAt: store.builtAt ?? null,
      source: store.source ?? '',
      entries: store.entries,
    }));
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉就算了 */ }
    throw error;
  }
}

/**
 * 把 PRTS 幹員頁與 redirect 組成別名表。純函式，測試直接餵 fixture。
 * 只留對得到一圖流幹員的頁；別名等於正式名、或兩個幹員搶同一個別名時跳過。
 */
export function buildAliasStore(pages, table, now = new Date().toISOString()) {
  const byName = new Map();
  for (const op of Object.values(table)) {
    const key = normalizeName(op.name);
    if (key && !byName.has(key)) byName.set(key, op);
  }
  const canonical = new Set(byName.keys());
  const entries = [];
  const index = new Map(); // id -> entry
  const ambiguous = new Set();
  for (const page of pages) {
    const pageKey = normalizeName(page.title);
    const target = byName.get(pageKey);
    if (!target) continue;
    for (const redirect of page.redirects ?? []) {
      if (typeof redirect?.title !== 'string' || !redirect.title.trim()) continue;
      const id = normalizeName(redirect.title);
      if (!id || id === pageKey || canonical.has(id)) continue;
      const existing = index.get(id);
      if (existing) {
        if (existing.charId !== target.charId) ambiguous.add(id);
        continue;
      }
      const entry = {
        id,
        alias: String(redirect.title).trim(),
        aliasTw: toTraditional(String(redirect.title).trim()),
        charId: target.charId,
        name: target.name,
        nameTw: toTraditional(target.name),
        status: ALIAS_STATUS.ACTIVE,
        source: 'prts',
        addedAt: now,
      };
      index.set(id, entry);
      entries.push(entry);
    }
  }
  return {
    version: ALIAS_VERSION,
    builtAt: now,
    source: 'prts.wiki Category:干员 redirects',
    entries: entries.filter((entry) => !ambiguous.has(entry.id)),
  };
}

/** 查詢命中別名時補進表；已有的（含已拒絕）不動。 */
export function recordAlias(store, { alias, charId, name, source = 'query' }, now = new Date().toISOString()) {
  const id = normalizeName(alias);
  if (!id || !charId || !name) return null;
  if (store.entries.some((entry) => entry.id === id)) return null;
  const entry = {
    id,
    alias: String(alias).trim(),
    aliasTw: toTraditional(String(alias).trim()),
    charId,
    name,
    nameTw: toTraditional(name),
    status: ALIAS_STATUS.ACTIVE,
    source,
    addedAt: now,
  };
  store.entries.push(entry);
  return entry;
}

/** 手動新增：幹員先由呼叫端解析成 charId 與正式名稱，這裡只負責驗證與寫入。 */
export function addManualAlias(store, { alias, charId, name }, now = new Date().toISOString()) {
  const text = String(alias ?? '').trim();
  const id = normalizeName(text);
  if (!id) return { error: '缺少別名' };
  if (!charId || !name) return { error: '缺少幹員' };
  if (id === normalizeName(name)) return { error: '別名不能跟正式名稱相同' };
  if (store.entries.some((entry) => entry.id === id)) return { error: '這個別名已經有了' };
  const entry = {
    id,
    alias: text,
    aliasTw: toTraditional(text),
    charId,
    name,
    nameTw: toTraditional(name),
    status: ALIAS_STATUS.ACTIVE,
    source: 'manual',
    addedAt: now,
  };
  store.entries.push(entry);
  return { entry };
}

export function setAliasStatus(store, ids, status) {
  if (status !== ALIAS_STATUS.ACTIVE && status !== ALIAS_STATUS.REJECTED) return 0;
  const wanted = new Set(ids);
  let changed = 0;
  for (const entry of store.entries) {
    if (!wanted.has(entry.id) || entry.status === status) continue;
    entry.status = status;
    changed += 1;
  }
  return changed;
}

export function deleteAliases(store, ids) {
  const wanted = new Set(ids);
  const before = store.entries.length;
  store.entries = store.entries.filter((entry) => !wanted.has(entry.id));
  return before - store.entries.length;
}

export function aliasStats(store) {
  const stats = { total: 0, active: 0, rejected: 0 };
  for (const entry of store?.entries ?? []) {
    stats.total += 1;
    if (entry.status === ALIAS_STATUS.ACTIVE) stats.active += 1;
    else if (entry.status === ALIAS_STATUS.REJECTED) stats.rejected += 1;
  }
  return stats;
}
