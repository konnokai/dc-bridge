import { reactive } from 'vue';
import { api, auth } from './api.js';

export const LIST_PAGE_SIZE = 20;

export const data = reactive({
  status: null,
  sessions: [],
  logs: [],
  slang: null,
  invite: null,
  usage: null,
  quota: null,
  codexQuota: null,
  memory: null,
  notes: null,
  followups: null,
  trade: null,
  memes: null,
  knowledge: null,
  triggers: null,
  devFeedback: null,
  archive: null,
  config: null,
  providers: null,
});

// 目前分頁。資料照常每 5 秒刷新；只有比較重的端點（觸發、回饋、知識）跟著分頁抓。
export const ui = reactive({ tab: 'overview', usageRange: '24h', usageOpenKey: null, usageDetail: null });

// 清單的搜尋／篩選／頁碼放在模組層：切分頁再回來、5 秒輪詢都不會被重設。
export const listView = reactive({
  slang: { status: 'all', page: 1, query: '' },
  style: { status: 'all', page: 1, query: '', channel: 'all' },
  knowledge: { status: 'all', page: 1, query: '' },
});

export const listSelection = { slang: reactive(new Set()), style: reactive(new Set()) };
export const listPageCandidates = { slang: [], style: [] };

export const pagedLists = reactive({
  memory: { query: '', page: 1 },
  note: { query: '', page: 1 },
  meme: { query: '', page: 1 },
});

export const triggerState = reactive({ search: '', page: 1, sortKey: 'count', dir: 'desc' });

export const archiveState = reactive({
  items: [], next: null, stack: [], names: {}, loaded: false, search: null, status: '', channels: [], channelId: '',
});

// ── 共用放大視窗 ──────────────────────────────────────────────────────────
export const detail = reactive({
  open: false, title: '', meta: [], body: '', imageUrl: '', mono: false, wide: false, scrollToBottom: false, seq: 0,
});
let detailReturn = null;

export function closeDetail() {
  if (!detail.open) return;
  detail.open = false;
  detail.seq += 1;
  detail.imageUrl = '';
  const target = detailReturn;
  detailReturn = null;
  target?.focus?.();
}

export function openDetail({ title, meta = [], body = '', imageUrl = '', mono = false, wide = false, scrollToBottom = false } = {}) {
  detailReturn = document.activeElement;
  detail.seq += 1;
  detail.title = title || '';
  detail.meta = meta;
  detail.body = body || '';
  detail.imageUrl = imageUrl;
  detail.mono = mono;
  detail.wide = wide;
  detail.scrollToBottom = scrollToBottom;
  detail.open = true;
}

// ── 梗圖縮圖 ──────────────────────────────────────────────────────────────
// 縮圖要帶 Authorization 標頭，<img src> 帶不了：抓成 blob 再顯示，同一張只抓一次。
export const memeThumbs = reactive({});

export async function fetchMemeThumb(id) {
  if (memeThumbs[id]) return memeThumbs[id];
  try {
    const res = await fetch('/api/memes/image?id=' + encodeURIComponent(id), { headers: { authorization: 'Bearer ' + auth.token } });
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    if (memeThumbs[id]) { URL.revokeObjectURL(url); return memeThumbs[id]; }
    memeThumbs[id] = url;
    return url;
  } catch {
    return null; // 下一次 refresh 會再試
  }
}

export function pruneMemeThumbs(aliveIds) {
  for (const id of Object.keys(memeThumbs)) {
    if (aliveIds.has(id)) continue;
    URL.revokeObjectURL(memeThumbs[id]);
    delete memeThumbs[id];
  }
}

export function openMemeDetail(meme) {
  const meta = [
    ['來源', (meme.createdBy === 'bot' ? '大肥魚自己的圖' : '群友的圖') + ' · ' + (meme.guildName || '—') + ' · #' + meme.channelName],
    ['使用', `${meme.uses} 次`],
    ['尺寸', `${meme.width}×${meme.height} · ${Math.round(meme.bytes / 1024)}KB`],
  ];
  if (meme.tags?.length) meta.push(['標籤', meme.tags.join('、')]);
  const cached = memeThumbs[meme.id];
  openDetail({ title: meme.name, meta, body: meme.when || '（沒有寫使用情境）', imageUrl: cached || '' });
  if (cached) return;
  // 非同步載入；回來時若已經換了別的彈窗或關掉了，就不要把圖塞進去。
  const seq = detail.seq;
  fetchMemeThumb(meme.id).then((url) => {
    if (detail.seq !== seq || !detail.open) return;
    if (!url) {
      detail.meta = [...detail.meta, ['提示', '圖片載入失敗']];
      return;
    }
    detail.imageUrl = url;
  });
}

// ── 抓資料 ────────────────────────────────────────────────────────────────
export async function refresh() {
  const results = await Promise.allSettled([
    api('/api/status'), api('/api/sessions'), api('/api/logs?limit=200'), api('/api/slang'), api('/api/invite'),
    api('/api/usage?range=' + encodeURIComponent(ui.usageRange)), api('/api/quota'), api('/api/memory'),
    ui.tab === 'triggers' ? api('/api/triggers') : Promise.resolve(null),
    api('/api/notes'), api('/api/codex-usage'), ui.tab === 'dev-feedback' ? api('/api/dev-feedback') : Promise.resolve(null),
    api('/api/followups'), api('/api/trade/overview'), api('/api/memes'),
    ui.tab === 'knowledge' ? api('/api/knowledge') : Promise.resolve(null),
    api('/api/archive'),
  ]);
  const value = (index) => (results[index].status === 'fulfilled' ? results[index].value : null);
  const status = value(0);
  if (status) {
    data.status = status;
    data.emoji = status.emoji;
    data.ignored = status.ignored ?? [];
  }
  const sessions = value(1);
  if (sessions) data.sessions = sessions.sessions ?? [];
  const logs = value(2);
  if (logs) data.logs = logs.logs ?? [];
  if (value(3)) data.slang = value(3);
  if (value(4)) data.invite = value(4);
  if (value(5)) data.usage = value(5);
  if (value(6)) data.quota = value(6);
  if (value(7)) data.memory = value(7);
  if (value(8)) data.triggers = value(8);
  if (value(9)) data.notes = value(9);
  if (value(10)) data.codexQuota = value(10);
  if (value(11)) data.devFeedback = value(11);
  if (value(12)) data.followups = value(12);
  if (value(13)) data.trade = value(13);
  if (value(14)) data.memes = value(14);
  if (value(15)) data.knowledge = value(15);
  if (value(16)) data.archive = value(16);
  // 歸檔表格不跟著 5 秒輪詢：第一次打開「記憶」分頁時抓一次，之後靠按鈕與操作更新。
  if (ui.tab === 'memory' && !archiveState.loaded) {
    archiveState.loaded = true;
    void loadArchiveChannels().then(() => loadArchive(null));
  }
}

export async function refreshUsage(range = ui.usageRange) {
  ui.usageRange = range;
  const usage = await api('/api/usage?range=' + encodeURIComponent(range));
  data.usage = usage;
  return usage;
}

export async function refreshTriggers() {
  try { data.triggers = await api('/api/triggers'); } catch { /* 5 秒後的 refresh 會再試 */ }
}

export async function refreshDevFeedback() {
  try { data.devFeedback = await api('/api/dev-feedback'); } catch { /* 5 秒後的 refresh 會再試 */ }
}

export async function refreshKnowledge() {
  try { data.knowledge = await api('/api/knowledge'); } catch { /* 5 秒後的 refresh 會再試 */ }
}

export async function loadConfig() {
  data.config = await api('/api/config');
  auth.configLoaded = true;
  // 供應商卡片失敗不影響其他設定；卡片自己會顯示錯誤。
  try { data.providers = await api('/api/providers'); }
  catch { data.providers = { error: '供應商設定讀取失敗' }; }
}

export async function loadProviders() {
  data.providers = await api('/api/providers');
}

export function markAuthed() {
  auth.authed = true;
  auth.gateError = '';
}

export async function verifyToken() {
  try {
    await api('/api/status');
    markAuthed();
    return true;
  } catch (error) {
    // 只有 401 算 token 失效；伺服器暫時連不上時照舊進主畫面，5 秒輪詢會自己恢復。
    if (error?.message === 'unauthorized') return false;
    markAuthed();
    return true;
  }
}

// ── 黑話／頻道風格批次 ────────────────────────────────────────────────────
export async function runSlangBatch(kind, action) {
  const ids = [...listSelection[kind]];
  if (!ids.length) { alert('先勾選要處理的候選'); return; }
  const label = action === 'confirm' ? '確認' : '拒絕';
  if (!confirm(`確定${label} ${ids.length} 條？`)) return;
  try {
    const result = await api('/api/slang/batch-' + action, { method: 'POST', body: JSON.stringify({ ids }) });
    listSelection[kind].clear();
    await refresh();
    const count = action === 'confirm' ? result.confirmed : result.rejected;
    if (result.skipped) alert(`已${label} ${count} 條，跳過 ${result.skipped} 條`);
  } catch (error) {
    alert('操作失敗：' + error.message);
  }
}

// ── 歷史歸檔 ──────────────────────────────────────────────────────────────
export async function loadArchive(cursor = null) {
  try {
    const payload = await api('/api/archive/list', {
      method: 'POST',
      body: JSON.stringify({
        channelId: archiveState.channelId ?? '',
        before: cursor?.before ?? null,
        skip: cursor?.skip ?? [],
      }),
    });
    archiveState.items = payload?.items ?? [];
    archiveState.next = payload?.next ?? null;
    archiveState.search = null;
    archiveState.status = '';
  } catch (error) {
    archiveState.items = [];
    archiveState.next = null;
    archiveState.status = '讀取失敗：' + error.message;
  }
}

export async function loadArchiveChannels() {
  try {
    const payload = await api('/api/archive/channels');
    archiveState.channels = payload?.channels ?? [];
    archiveState.names = Object.fromEntries(archiveState.channels.map((row) => [String(row.channelId), row.name]));
  } catch { /* 沒開或抓不到就只留「全部頻道」 */ }
}

export async function searchArchive(query) {
  const text = String(query ?? '').trim();
  if (!text) {
    archiveState.stack = [];
    await loadArchive(null);
    return;
  }
  try {
    const items = await api('/api/archive/search', {
      method: 'POST',
      body: JSON.stringify({ query: text, channelId: archiveState.channelId ?? '' }),
    });
    archiveState.items = items ?? [];
    archiveState.next = null;
    archiveState.stack = [];
    archiveState.search = text;
    archiveState.status = archiveState.items.length ? '' : '沒有夠像的。換個說法，或先選頻道。';
  } catch (error) {
    archiveState.items = [];
    archiveState.next = null;
    archiveState.status = '搜尋失敗：' + error.message;
  }
}
