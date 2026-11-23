<script setup>
import { computed, onUpdated, reactive, ref, watch } from 'vue';
import { api, copyText } from '../api.js';
import { data, loadProviders, refresh } from '../store.js';
import { fmtAgo, lines, parseMentionChannels } from '../format.js';
import ProviderPicker from '../components/ProviderPicker.vue';

// 功能設定：path 對應 config.json 的 discord.*；數值範圍交給 normalize 驗證。
const FEATURE_FIELDS = [
  { path: 'typing', label: 'typing：顯示「正在輸入」', kind: 'bool' },
  { path: 'sendDelayMs', label: 'sendDelayMs：連續送出間隔（毫秒）', kind: 'number', min: 0, max: 5000, step: 50 },
  { path: 'maxMessageChars', label: 'maxMessageChars：單則訊息上限（字）', kind: 'number', min: 200, max: 2000, step: 50 },
  { path: 'autoCompactTokens', label: 'autoCompactTokens：自動壓縮門檻（0＝關，其餘最小 40000）', kind: 'number', min: 0, max: 1000000, step: 10000 },
  { path: 'ttftTimeoutMs', label: 'ttftTimeoutMs：等第一個 token 的上限（毫秒，0＝關）', kind: 'number', min: 0, max: 120000, step: 5000 },
  { path: 'ackMessage', label: 'ackMessage：收到訊息時的回應（留空＝不回）', kind: 'text', wide: true },
  { path: 'media.enabled', label: 'media.enabled：收圖片與影片', kind: 'bool' },
  { path: 'media.maxVideoSeconds', label: 'media.maxVideoSeconds：影片抽格秒數', kind: 'number', min: 5, max: 120, step: 1 },
  { path: 'videoLinks.enabled', label: 'videoLinks.enabled：YouTube 連結抽字幕與畫面', kind: 'bool' },
  { path: 'context.enabled', label: 'context.enabled：帶最近訊息當上下文', kind: 'bool' },
  { path: 'context.messages', label: 'context.messages：帶幾則（0＝關）', kind: 'number', min: 0, max: 50, step: 1 },
  { path: 'context.maxChars', label: 'context.maxChars：上下文上限（字）', kind: 'number', min: 0, max: 12000, step: 500 },
  { path: 'batch.debounceMs', label: 'batch.debounceMs：批次等待（毫秒）', kind: 'number', min: 500, max: 30000, step: 500 },
  { path: 'batch.maxWaitMs', label: 'batch.maxWaitMs：批次最長等待（毫秒）', kind: 'number', min: 1000, max: 120000, step: 1000 },
  { path: 'batch.maxMessages', label: 'batch.maxMessages：一批最多幾則', kind: 'number', min: 1, max: 50, step: 1 },
  { path: 'tts.enabled', label: 'tts.enabled：開放 send_voice', kind: 'bool' },
  { path: 'tts.model', label: 'tts.model：TTS 模型', kind: 'text' },
  { path: 'tts.accent', label: 'tts.accent：VoiceDesign 的口音提示', kind: 'text' },
  { path: 'tts.timeoutMs', label: 'tts.timeoutMs：合成逾時（毫秒）', kind: 'number', min: 5000, max: 90000, step: 1000 },
  { path: 'tts.maxChars', label: 'tts.maxChars：一句話上限（字）', kind: 'number', min: 1, max: 1000, step: 10 },
  { path: 'tts.cooldownSec', label: 'tts.cooldownSec：語音冷卻（秒）', kind: 'number', min: 0, max: 3600, step: 1 },
  { path: 'tts.maxPerTurn', label: 'tts.maxPerTurn：每輪上限', kind: 'number', min: 1, max: 5, step: 1 },
  { path: 'tts.refAudio', label: 'tts.refAudio：參考音檔（TTS 主機上的絕對路徑）', kind: 'text', wide: true },
  { path: 'tts.refText', label: 'tts.refText：參考音逐字稿', kind: 'text', wide: true },
  { path: 'tts.channels', label: 'tts.channels：開放語音的頻道（一行一個；留空＝全部）', kind: 'ids', wide: true },
  { path: 'security.blockSensitive', label: 'security.blockSensitive：攔下含敏感資訊的回覆', kind: 'bool' },
  { path: 'emoji.enabled', label: 'emoji.enabled：自訂表情目錄', kind: 'bool' },
  { path: 'emoji.maxCandidates', label: 'emoji.maxCandidates：候選數', kind: 'number', min: 3, max: 30, step: 1 },
  { path: 'emoji.maxChars', label: 'emoji.maxChars：注入上限（字）', kind: 'number', min: 100, max: 3000, step: 50 },
  { path: 'memes.enabled', label: 'memes.enabled：梗圖庫', kind: 'bool' },
  { path: 'memes.max', label: 'memes.max：每批帶幾張（0＝不帶）', kind: 'number', min: 0, max: 20, step: 1 },
  { path: 'reactions.enabled', label: 'reactions.enabled：自己加 reaction', kind: 'bool' },
  { path: 'reactions.probability', label: 'reactions.probability：機率（0～1）', kind: 'number', min: 0, max: 1, step: 0.01 },
  { path: 'reactions.cooldownMs', label: 'reactions.cooldownMs：冷卻（毫秒）', kind: 'number', min: 10000, max: 21600000, step: 10000 },
  { path: 'reactions.maxPerHour', label: 'reactions.maxPerHour：每小時上限', kind: 'number', min: 1, max: 100, step: 1 },
  { path: 'memory.enabled', label: 'memory.enabled：群友記憶', kind: 'bool' },
  { path: 'memory.maxFacts', label: 'memory.maxFacts：每人上限', kind: 'number', min: 5, max: 50, step: 1 },
  { path: 'memory.maxChars', label: 'memory.maxChars：注入上限（字）', kind: 'number', min: 200, max: 3000, step: 50 },
  { path: 'memory.profiles', label: 'memory.profiles：每天產生群友側寫（多一次模型呼叫）', kind: 'bool' },
  { path: 'historyArchive.enabled', label: 'historyArchive.enabled：歷史歸檔（重啟後生效；embedUrl 只能填在 config.json）', kind: 'bool' },
  { path: 'historyArchive.retentionDays', label: 'historyArchive.retentionDays：保留天數', kind: 'number', min: 1, max: 3650, step: 1 },
  { path: 'notes.enabled', label: 'notes.enabled：頻道筆記', kind: 'bool' },
  { path: 'notes.injectMax', label: 'notes.injectMax：帶幾條', kind: 'number', min: 1, max: 20, step: 1 },
  { path: 'notes.maxChars', label: 'notes.maxChars：注入上限（字）', kind: 'number', min: 100, max: 3000, step: 50 },
  { path: 'notes.dailySummary.enabled', label: 'notes.dailySummary.enabled：每日摘要', kind: 'bool' },
  { path: 'notes.dailySummary.hour', label: 'notes.dailySummary.hour：幾點（0～23）', kind: 'number', min: 0, max: 23, step: 1 },
  { path: 'knowledge.enabled', label: 'knowledge.enabled：群知識', kind: 'bool' },
  { path: 'knowledge.maxChars', label: 'knowledge.maxChars：注入上限（字）', kind: 'number', min: 300, max: 4000, step: 100 },
  { path: 'knowledge.toolMaxChars', label: 'knowledge.toolMaxChars：工具查詢上限（字）', kind: 'number', min: 300, max: 6000, step: 100 },
  { path: 'followup.enabled', label: 'followup.enabled：回訪排程', kind: 'bool' },
  { path: 'slang.enabled', label: 'slang.enabled：黑話學習', kind: 'bool' },
  { path: 'slang.injectMax', label: 'slang.injectMax：帶幾條', kind: 'number', min: 1, max: 30, step: 1 },
  { path: 'slang.maxChars', label: 'slang.maxChars：注入上限（字）', kind: 'number', min: 200, max: 4000, step: 50 },
  { path: 'slang.jev.mode', label: 'slang.jev.mode：Jev 自動分流（off／shadow／reject／auto）', kind: 'select', options: ['off', 'shadow', 'reject', 'auto'] },
  { path: 'slang.jev.confirmAt', label: 'slang.jev.confirmAt：自動確認門檻（0～1）', kind: 'number', min: 0, max: 1, step: 0.01 },
  { path: 'slang.jev.rejectBelow', label: 'slang.jev.rejectBelow：自動拒絕門檻（0～1；auto 模式必須低於 confirmAt）', kind: 'number', min: 0, max: 1, step: 0.01 },
];
// 分區看 path 第一段；沒有前綴的是對話行為。沒列到的前綴直接顯示原名，欄位不會消失。
const FEATURE_SECTIONS = {
  '': '對話行為', media: '媒體', videoLinks: '影片連結', context: '上下文', batch: '批次',
  tts: '語音（TTS）', security: '安全', emoji: '表情', memes: '梗圖', reactions: 'Reaction',
  memory: '群友記憶', notes: '頻道筆記', knowledge: '群知識', followup: '回訪排程', slang: '黑話', historyArchive: '歷史歸檔',
};

const messages = reactive({
  config: { text: '', tone: '' }, provider: { text: '', tone: '' }, feature: { text: '', tone: '' },
  ceobe: { text: '', tone: '' }, trade: { text: '', tone: '' }, sandbox: { text: '', tone: '' },
});
function say(key, text, tone = '') {
  messages[key].text = text;
  messages[key].tone = tone;
}

const cfg = reactive({
  allowGuilds: '', allowChannels: '', allowUsers: '', ownerIds: '',
  denyGuilds: '', denyChannels: '', denyUsers: '', denySelf: '',
  mediaMaxBytes: '', mediaMaxModelBytes: '', mediaMaxLongEdge: '', mediaMaxCount: '', mediaTimeout: '',
  sandboxEnabled: false, sandboxChannels: '',
  requireMention: false, requireMentionDisabled: false, messageContentIntent: true, requireMentionChannels: '',
  chattyChannels: '', openPoliticsChannels: '',
  tradeEnabled: false, tradeGuilds: '', tradeChannels: '', tradeStartingCash: '', tradeMaxOrderPct: '',
  tradeFeeRate: '', tradeTaxRate: '', tradeMinFee: '', tradeSettleMinutes: '', tradeSettleAfter: '',
  tradeBotEnabled: false, tradeBotAnnounce: '', tradeBotTurns: '', tradeBotTrades: '', tradeBotInterval: '',
  tradeBotTokens: '', tradeBotSearches: '', tradeBotFetches: '', tradeBotReviewEnabled: false, tradeBotReviewAfter: '',
});

const featureValues = reactive({});
const joinLines = (value) => (value || []).join('\n');
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const setPath = (obj, path, value) => {
  const keys = path.split('.');
  let target = obj;
  for (const key of keys.slice(0, -1)) target = (target[key] ??= {});
  target[keys.at(-1)] = value;
};
const featureId = (field) => 'cf-' + field.path.replace(/\./g, '-');
const featureSectionKey = (path) => (path.includes('.') ? path.split('.')[0] : '');

const featureSections = computed(() => {
  const sections = new Map();
  for (const field of FEATURE_FIELDS) {
    const key = featureSectionKey(field.path);
    if (!sections.has(key)) sections.set(key, { key, title: FEATURE_SECTIONS[key] ?? key, fields: [] });
    sections.get(key).fields.push(field);
  }
  return [...sections.values()];
});

function applyConfig(c) {
  if (!c) return;
  cfg.allowGuilds = joinLines(c.allow?.guilds);
  cfg.allowChannels = joinLines(c.allow?.channels);
  cfg.allowUsers = joinLines(c.allow?.users);
  cfg.ownerIds = joinLines(c.ownerIds);
  cfg.denyGuilds = joinLines(c.deny?.guilds);
  cfg.denyChannels = joinLines(c.deny?.channels);
  cfg.denyUsers = joinLines(c.deny?.users);
  cfg.denySelf = joinLines(c.deny?.self);
  cfg.mediaMaxBytes = c.media?.maxBytes;
  cfg.mediaMaxModelBytes = c.media?.maxModelBytes;
  cfg.mediaMaxLongEdge = c.media?.maxLongEdge;
  cfg.mediaMaxCount = c.media?.maxCount;
  cfg.mediaTimeout = c.media?.timeoutMs;
  cfg.sandboxEnabled = c.sandbox?.enabled === true;
  cfg.sandboxChannels = joinLines(c.sandbox?.channels);
  cfg.messageContentIntent = c.messageContentIntent !== false;
  cfg.requireMention = c.requireMentionInGuild || !c.messageContentIntent;
  cfg.requireMentionDisabled = !c.messageContentIntent;
  cfg.requireMentionChannels = Object.entries(c.requireMentionInChannel ?? {}).map(([id, on]) => `${id}=${on}`).join('\n');
  cfg.chattyChannels = joinLines(c.chattyChannels);
  cfg.openPoliticsChannels = joinLines(c.openPoliticsChannels);
  const trade = c.trade ?? {};
  const fees = trade.fees ?? {};
  const settlement = trade.settlement ?? {};
  const bot = trade.bot ?? {};
  const review = bot.review ?? {};
  cfg.tradeEnabled = trade.enabled === true;
  cfg.tradeGuilds = joinLines(trade.allowedGuilds);
  cfg.tradeChannels = joinLines(trade.allowedChannels);
  cfg.tradeStartingCash = trade.startingCash ?? 1000000;
  cfg.tradeMaxOrderPct = trade.maxOrderPct ?? 30;
  cfg.tradeFeeRate = fees.twFeeRate ?? 0.001425;
  cfg.tradeTaxRate = fees.twTaxRate ?? 0.003;
  cfg.tradeMinFee = fees.minFee ?? 0;
  cfg.tradeSettleMinutes = settlement.twCheckMinutes ?? 10;
  cfg.tradeSettleAfter = settlement.twSettleAfter ?? '19:00';
  cfg.tradeBotEnabled = bot.enabled === true;
  cfg.tradeBotAnnounce = bot.announceChannelId ?? '';
  cfg.tradeBotTurns = bot.maxTurnsPerDay ?? 1;
  cfg.tradeBotTrades = bot.maxTradesPerDay ?? 1;
  cfg.tradeBotInterval = bot.minIntervalMin ?? 60;
  cfg.tradeBotTokens = bot.maxTokensPerDay ?? 20000;
  cfg.tradeBotSearches = bot.maxWebSearchesPerTurn ?? 3;
  cfg.tradeBotFetches = bot.maxWebFetchesPerTurn ?? 2;
  cfg.tradeBotReviewEnabled = review.enabled !== false;
  cfg.tradeBotReviewAfter = review.after ?? '19:10';

  for (const field of FEATURE_FIELDS) {
    const value = getPath(c, field.path);
    if (field.kind === 'bool') featureValues[field.path] = value === true;
    else if (field.kind === 'ids') featureValues[field.path] = joinLines(value);
    else if (field.kind === 'select') {
      const allowed = field.options ?? [];
      const text = typeof value === 'string' ? value : '';
      featureValues[field.path] = allowed.includes(text) ? text : (allowed[0] ?? '');
    } else featureValues[field.path] = value ?? '';
  }

  const conf = c.ceobe ?? { enabled: false, channels: {} };
  ceobe.enabled = conf.enabled === true;
  ceobe.rows = Object.entries(conf.channels ?? {}).map(([id, sources]) => ({ id, sources: [...sources] }));
  if (!ceobe.sources) {
    ceobe.status = '按「載入資料源」取得可選的來源。';
    if (conf.enabled || Object.keys(conf.channels ?? {}).length > 0) {
      void loadCeobeSources().catch(() => { ceobe.status = '資料源清單讀取失敗，按「載入資料源」再試。'; });
    }
  }
}

function featurePatch() {
  const patch = {};
  for (const field of FEATURE_FIELDS) {
    const value = featureValues[field.path];
    if (field.kind === 'bool') setPath(patch, field.path, value === true);
    else if (field.kind === 'number') {
      // 留空或非法值不要送：Number('') 是 0，會把 ttftTimeoutMs 這類欄位默默關掉。
      if (String(value ?? '').trim() === '') continue;
      const number = Number(value);
      if (!Number.isFinite(number)) continue;
      setPath(patch, field.path, number);
    } else if (field.kind === 'ids') setPath(patch, field.path, lines(value));
    else setPath(patch, field.path, String(value ?? '').trim());
  }
  return patch;
}

// ── 供應商 ────────────────────────────────────────────────────────────────
const providerChoice = reactive({ primary: null, fallback: null });
const providerFilters = reactive({ primary: '', fallback: '' });
const providerUi = reactive({
  activeText: '', ready: true, fallbackEnabled: false, afterMs: 12000,
  catalogOk: true, catalogError: '', keys: [], keysError: '',
});
const keyInputs = reactive({});

const providerItems = computed(() => {
  const groups = data.providers?.catalog?.ok ? data.providers.catalog.groups : [];
  return groups.flatMap((group) => group.models.map((model) => ({
    provider: group.id,
    providerName: group.name || group.id,
    model: model.id,
    name: model.name || model.id,
    description: model.description || '',
    efforts: model.efforts ?? [],
    defaultEffort: model.defaultEffort || '',
  })));
});

function applyProviders(payload) {
  if (!payload) return;
  if (payload.error) {
    providerUi.activeText = payload.error;
    providerUi.ready = false;
    providerUi.catalogOk = false;
    return;
  }
  const hedge = payload.hedge;
  providerUi.ready = payload.pluginReady !== false;
  providerUi.activeText = !hedge
    ? '橋接設定裡沒有 dsh.hedge。'
    : !providerUi.ready
      ? 'DSH 沒有 hedge provider：先跑 npm run setup:discord，再重啟 DSH。'
      : (payload.active
        ? `目前主模型：hedge（${hedge.primary.provider} / ${hedge.primary.model}）`
        : `目前主模型：${payload.primary.provider} / ${payload.primary.model}；儲存後切到 hedge`);
  providerChoice.primary = hedge?.primary?.model ? { ...hedge.primary } : null;
  providerChoice.fallback = hedge?.fallback?.model ? { ...hedge.fallback } : null;
  providerUi.fallbackEnabled = hedge ? hedge.enabled !== false : false;
  providerUi.afterMs = hedge?.afterMs ?? 12000;
  providerUi.catalogOk = payload.catalog?.ok === true;
  providerUi.catalogError = payload.catalog?.error ?? '';
  if (Array.isArray(payload.keys)) {
    providerUi.keys = payload.keys;
    providerUi.keysError = '';
  } else {
    providerUi.keys = [];
    providerUi.keysError = payload.keys?.error ? `讀不到金鑰狀態：${payload.keys.error}` : '讀不到金鑰狀態';
  }
}

async function saveConfig() {
  say('config', '儲存中…');
  try {
    const result = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        allow: { guilds: lines(cfg.allowGuilds), channels: lines(cfg.allowChannels), users: lines(cfg.allowUsers) },
        deny: {
          guilds: lines(cfg.denyGuilds), channels: lines(cfg.denyChannels), users: lines(cfg.denyUsers), self: lines(cfg.denySelf),
        },
        ownerIds: lines(cfg.ownerIds),
        media: {
          maxBytes: Number(cfg.mediaMaxBytes),
          maxModelBytes: Number(cfg.mediaMaxModelBytes),
          maxLongEdge: Number(cfg.mediaMaxLongEdge),
          maxCount: Number(cfg.mediaMaxCount),
          timeoutMs: Number(cfg.mediaTimeout),
        },
        // disabled 時沒得選，不送，免得把 config.json 裡原本的值蓋掉
        ...(cfg.requireMentionDisabled ? {} : {
          requireMentionInGuild: cfg.requireMention,
          requireMentionInChannel: parseMentionChannels(cfg.requireMentionChannels),
        }),
        // chattyChannels 不受 messageContentIntent 鎖定：先設定好，開了意圖就生效。
        chattyChannels: lines(cfg.chattyChannels),
        openPoliticsChannels: lines(cfg.openPoliticsChannels),
      }),
    });
    data.config = result.config;
    say('config', '已儲存（立即生效）', 'ok');
    await refresh();
  } catch (error) {
    say('config', error.message, 'err');
  }
}

async function saveFeatures() {
  say('feature', '儲存中…');
  try {
    const result = await api('/api/config', { method: 'POST', body: JSON.stringify(featurePatch()) });
    data.config = result.config;
    say('feature', '已儲存（立即生效）', 'ok');
    await refresh();
  } catch (error) {
    say('feature', error.message, 'err');
  }
}

async function saveTrade() {
  say('trade', '儲存中…');
  try {
    const result = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        trade: {
          enabled: cfg.tradeEnabled,
          allowedGuilds: lines(cfg.tradeGuilds),
          allowedChannels: lines(cfg.tradeChannels),
          startingCash: Number(cfg.tradeStartingCash),
          maxOrderPct: Number(cfg.tradeMaxOrderPct),
          fees: {
            twFeeRate: Number(cfg.tradeFeeRate),
            twTaxRate: Number(cfg.tradeTaxRate),
            minFee: Number(cfg.tradeMinFee),
          },
          settlement: { twCheckMinutes: Number(cfg.tradeSettleMinutes), twSettleAfter: cfg.tradeSettleAfter },
          bot: {
            enabled: cfg.tradeBotEnabled,
            announceChannelId: cfg.tradeBotAnnounce.trim(),
            maxTurnsPerDay: Number(cfg.tradeBotTurns),
            maxTradesPerDay: Number(cfg.tradeBotTrades),
            minIntervalMin: Number(cfg.tradeBotInterval),
            maxTokensPerDay: Number(cfg.tradeBotTokens),
            maxWebSearchesPerTurn: Number(cfg.tradeBotSearches),
            maxWebFetchesPerTurn: Number(cfg.tradeBotFetches),
            review: { enabled: cfg.tradeBotReviewEnabled, after: cfg.tradeBotReviewAfter },
          },
        },
      }),
    });
    data.config = result.config;
    say('trade', '已儲存（立即生效）', 'ok');
    await refresh();
  } catch (error) {
    say('trade', error.message, 'err');
  }
}

async function saveSandbox() {
  say('sandbox', '儲存中…');
  try {
    const result = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ sandbox: { enabled: cfg.sandboxEnabled, channels: lines(cfg.sandboxChannels) } }),
    });
    data.config = result.config;
    say('sandbox', '已儲存（立即生效）', 'ok');
  } catch (error) {
    say('sandbox', error.message, 'err');
  }
}

async function saveProviders() {
  if (!providerChoice.primary) {
    say('provider', '請先選主模型', 'err');
    return;
  }
  if (providerUi.fallbackEnabled && !providerChoice.fallback) {
    say('provider', '開啟備援前先選備援模型', 'err');
    return;
  }
  say('provider', '儲存中…');
  try {
    const result = await api('/api/providers', {
      method: 'POST',
      body: JSON.stringify({
        enabled: providerUi.fallbackEnabled,
        afterMs: Number(providerUi.afterMs),
        primary: providerChoice.primary,
        fallback: providerChoice.fallback ?? { provider: '', model: '', reasoningEffort: '' },
      }),
    });
    applyProviders(result);
    if (result.synced === false) {
      say('provider', `設定已存到 config.json，但推到 DSH 失敗：${result.syncError ?? '未知錯誤'}（重新儲存或重啟 DSH 後會再推）`, 'err');
    } else {
      say('provider', '已儲存（下一批生效）', 'ok');
    }
  } catch (error) {
    say('provider', error.message, 'err');
  }
}

async function providerKeyAction(key, action) {
  const provider = key.provider;
  const value = keyInputs[provider] ?? '';
  if (action === 'set' && !value.trim()) {
    say('provider', '請先輸入新的 API Key', 'err');
    return;
  }
  if (action === 'clear' && !confirm(`清除 ${provider} 的 API Key？之後這個 provider 的請求會失敗。`)) return;
  say('provider', '處理中…');
  try {
    await api('/api/providers/key', { method: 'POST', body: JSON.stringify({ provider, action, value }) });
    keyInputs[provider] = '';
    await loadProviders();
    say('provider', action === 'set' ? '已寫入 DSH 憑證檔' : '已清除', 'ok');
  } catch (error) {
    say('provider', error.message, 'err');
  }
}

// ── 小刻食堂（餅） ────────────────────────────────────────────────────────
const ceobe = reactive({ enabled: false, rows: [], sources: null, status: '' });

function sourceOptions(row) {
  const options = (ceobe.sources ?? []).map((source) => ({
    id: source.unique_id,
    label: `${source.nickname || source.unique_id}（${source.platform || source.datasource || '未知'}）`,
  }));
  const known = new Set(options.map((option) => option.id));
  // 上游暫時拿掉的來源照樣留著，使用者才不會在重新載入清單時被靜靜刪掉。
  for (const id of row.sources) if (!known.has(id)) options.push({ id, label: `${id}（目錄裡找不到）` });
  return options;
}

function toggleSource(row, id, checked) {
  if (checked) { if (!row.sources.includes(id)) row.sources.push(id); }
  else row.sources = row.sources.filter((value) => value !== id);
}

function addCeobeRow() {
  ceobe.rows.push({ id: '', sources: [] });
}

async function loadCeobeSources({ refreshSources = false } = {}) {
  const payload = await api('/api/ceobe' + (refreshSources ? '?refresh=1' : ''));
  ceobe.sources = Array.isArray(payload.sources) ? payload.sources : [];
  const status = payload.status;
  if (status) {
    const at = status.lastPollAt ? fmtAgo(status.lastPollAt) : '還沒輪詢';
    const error = status.lastError ? `；最近錯誤：${status.lastError}` : '';
    ceobe.status = status.enabled
      ? `輪詢中，上次 ${at}，目前列表 ${status.cookies ?? 0} 則${error}`
      : '功能關閉';
  }
  if (payload.sourceError) ceobe.status = `資料源清單讀取失敗：${payload.sourceError}`;
  else if (ceobe.sources.length === 0) ceobe.status = '資料源清單是空的。';
}

async function reloadCeobeSources() {
  say('ceobe', '載入中…');
  try {
    await loadCeobeSources({ refreshSources: true });
    say('ceobe', '資料源已更新', 'ok');
  } catch (error) {
    say('ceobe', error.message, 'err');
  }
}

async function saveCeobe() {
  const channels = {};
  const problems = [];
  const seen = new Set();
  for (const row of ceobe.rows) {
    const id = String(row.id ?? '').trim();
    if (!id) continue;
    if (!/^\d{5,25}$/.test(id)) { problems.push(`頻道 ID 不是數字：${id}`); continue; }
    if (seen.has(id)) { problems.push(`頻道 ID 重複：${id}`); continue; }
    seen.add(id);
    if (row.sources.length === 0) { problems.push(`頻道 ${id} 還沒勾來源`); continue; }
    channels[id] = [...row.sources];
  }
  if (problems.length) {
    say('ceobe', problems.join('；'), 'err');
    return;
  }
  say('ceobe', '儲存中…');
  try {
    const result = await api('/api/config', { method: 'POST', body: JSON.stringify({ ceobe: { enabled: ceobe.enabled, channels } }) });
    data.config = result.config;
    void loadCeobeSources().catch(() => {});
    say('ceobe', '已儲存（立即生效）', 'ok');
  } catch (error) {
    say('ceobe', error.message, 'err');
  }
}

// ── 邀請與表情 ────────────────────────────────────────────────────────────
const invite = computed(() => data.invite ?? {});
const invitePerms = computed(() => {
  const permissions = invite.value.permissions ?? [];
  return permissions.length ? `權限：${permissions.map((permission) => permission.label).join('、')}（bitfield ${invite.value.bitfield}）` : '';
});

async function copyInvite() {
  const url = invite.value.url ?? '';
  if (!url) return;
  const copied = await copyText(url);
  inviteMessage.text = copied ? '已複製' : '請手動複製上面的連結';
  inviteMessage.tone = copied ? 'ok' : 'err';
  setTimeout(() => { inviteMessage.text = ''; }, 2500);
}
const inviteMessage = reactive({ text: '', tone: '' });

function openInvite() {
  const url = invite.value.url;
  if (url) window.open(url, '_blank', 'noopener');
}

const emoji = computed(() => data.status?.emoji ?? { items: [], entries: 0, guilds: 0, job: null });
const emojiJobText = computed(() => {
  const job = emoji.value.job;
  const log = job?.log ?? [];
  if (job?.running) {
    const last = log[log.length - 1] ?? '';
    const match = last.match(/(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/);
    return '更新中…' + (match ? `（${match[2]}/${match[3]}）` : '');
  }
  if (job?.exitCode === 0 && job?.finishedAt) return '上次更新成功（' + new Date(job.finishedAt).toLocaleString() + '）';
  if (job?.error) return '上次失敗：' + job.error;
  if (job?.exitCode != null) return '上次結束 exit ' + job.exitCode;
  if (log.length > 0) return /完成：更新/.test(log[log.length - 1]) ? '上次建置完成（重啟後只留日誌）' : '上次建置結束';
  return '';
});

const rebuilding = ref(false);
const emojiLog = ref(null);
const emojiStick = ref(true);

function onEmojiScroll() {
  const el = emojiLog.value;
  if (!el) return;
  emojiStick.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
}
onUpdated(() => {
  if (emojiStick.value && emojiLog.value) emojiLog.value.scrollTop = emojiLog.value.scrollHeight;
});

async function rebuildEmojis() {
  rebuilding.value = true;
  try {
    await api('/api/emojis/rebuild', { method: 'POST', body: JSON.stringify({}) });
    await refresh();
  } catch (error) {
    alert('更新失敗：' + error.message);
  } finally {
    rebuilding.value = false;
  }
}

watch(() => data.config, (value) => { if (value) applyConfig(value); }, { immediate: true });
watch(() => data.providers, (value) => { if (value) applyProviders(value); }, { immediate: true });
</script>

<template>
<section class="card">
  <h2>白名單與媒體</h2>
  <form id="config-form" class="grid" @submit.prevent="saveConfig">
    <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text)">
      <input id="require-mention" v-model="cfg.requireMention" type="checkbox" style="width:auto;margin:0" :disabled="cfg.requireMentionDisabled">
      requireMentionInGuild：頻道要 @bot 或回覆 bot 才回（取消勾選＝自由參與）
    </label>
    <p id="require-mention-note" class="muted" style="grid-column:1/-1;margin:0" :hidden="cfg.messageContentIntent">沒開 messageContentIntent：收不到沒 @bot 的訊息內容，一律要 @bot。</p>
    <label style="grid-column:1/-1">requireMentionInChannel（一行一個：頻道ID=true／false。true = 只能 @bot；false = 自由參與；沒列出的頻道跟上面的預設）
      <textarea id="require-mention-channels" v-model="cfg.requireMentionChannels" placeholder="123456789012345678=true" :disabled="cfg.requireMentionDisabled"></textarea>
    </label>
    <label style="grid-column:1/-1">chattyChannels（一行一個頻道 ID。這些頻道不看 10 分鐘發言比例，沒 @bot 也可以接；需要 messageContentIntent）
      <textarea id="chatty-channels" v-model="cfg.chattyChannels" placeholder="123456789012345678"></textarea>
    </label>
    <label style="grid-column:1/-1">openPoliticsChannels（一行一個頻道 ID。這些頻道開新會話時改用 dc-chat-open 人格：不套用「政治不碰」基線；已開著的頻道要 /reset 或 /reload-system-prompt 才換）
      <textarea id="open-politics-channels" v-model="cfg.openPoliticsChannels" placeholder="123456789012345678"></textarea>
    </label>
    <label>allow.guilds<textarea id="allow-guilds" v-model="cfg.allowGuilds" placeholder="一行一個 ID"></textarea></label>
    <label>allow.channels<textarea id="allow-channels" v-model="cfg.allowChannels" placeholder="一行一個 ID"></textarea></label>
    <label>allow.users（私聊）<textarea id="allow-users" v-model="cfg.allowUsers" placeholder="一行一個 ID"></textarea></label>
    <label>ownerIds<textarea id="owner-ids" v-model="cfg.ownerIds" placeholder="一行一個 ID"></textarea></label>
    <label>deny.guilds<textarea id="deny-guilds" v-model="cfg.denyGuilds"></textarea></label>
    <label>deny.channels<textarea id="deny-channels" v-model="cfg.denyChannels"></textarea></label>
    <label>deny.users（管理員封鎖）<textarea id="deny-users" v-model="cfg.denyUsers"></textarea></label>
    <label>deny.self（/blacklist 退出）<textarea id="deny-self" v-model="cfg.denySelf"></textarea></label>
    <label>media.maxBytes<input id="media-max-bytes" v-model="cfg.mediaMaxBytes" type="number" min="65536" step="any"></label>
    <label>media.maxModelBytes<input id="media-max-model-bytes" v-model="cfg.mediaMaxModelBytes" type="number" min="131072" step="131072"></label>
    <label>media.maxLongEdge<input id="media-max-long-edge" v-model="cfg.mediaMaxLongEdge" type="number" min="256" max="2048" step="64"></label>
    <label>media.maxCount<input id="media-max-count" v-model="cfg.mediaMaxCount" type="number" min="1" max="8"></label>
    <label>media.timeoutMs<input id="media-timeout" v-model="cfg.mediaTimeout" type="number" min="2000" max="60000" step="1000"></label>
    <div class="row" style="grid-column:1/-1">
      <button type="submit">儲存</button>
      <span id="config-msg" class="msg" :class="messages.config.tone" role="status">{{ messages.config.text }}</span>
    </div>
  </form>
  <p class="muted" style="margin:10px 0 0">每行一個 Discord ID（字串）。preset、模型、port、token 請改 config.json 後重啟。</p>
</section>

<section class="card">
  <h2>供應商</h2>
  <form id="provider-form" class="grid" novalidate @submit.prevent="saveProviders">
    <div id="provider-active" class="muted" style="grid-column:1/-1">{{ providerUi.activeText }}</div>
    <ProviderPicker side="primary" heading="主模型" :model="providerChoice.primary" :items="providerItems"
                   :filter="providerFilters.primary" :disabled="!providerUi.catalogOk"
                   :error="providerUi.catalogOk ? '' : '模型目錄讀不到：' + (providerUi.catalogError || '未知錯誤')"
                   @update:model="providerChoice.primary = $event" @update:filter="providerFilters.primary = $event" />
    <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text)">
      <input id="provider-fallback-enabled" v-model="providerUi.fallbackEnabled" type="checkbox" style="width:auto;margin:0">
      fallback.enabled：主線超過門檻還沒吐 token 時，並行打備援
    </label>
    <label>備援門檻（毫秒）<input id="provider-after-ms" v-model="providerUi.afterMs" type="number" min="3000" max="115000" step="500"></label>
    <ProviderPicker side="fallback" heading="備援模型" :model="providerChoice.fallback" :items="providerItems"
                   :filter="providerFilters.fallback" :disabled="!providerUi.catalogOk"
                   @update:model="providerChoice.fallback = $event" @update:filter="providerFilters.fallback = $event" />
    <div id="provider-keys" style="grid-column:1/-1">
      <template v-if="providerUi.keysError">{{ providerUi.keysError }}</template>
      <div v-for="key in providerUi.keys" :key="key.provider" class="provider-key">
        <div>
          <strong>{{ key.label }}</strong>
          <div class="muted" style="font-size:11px">{{ `${key.configured ? '已輸入' : '未設定'}${key.source ? ` · ${key.source}` : ''}${key.writable ? '' : ' · 不可寫'}` }}</div>
        </div>
        <input type="password" autocomplete="new-password" spellcheck="false" placeholder="輸入新的 API Key（留空＝不改）"
               :data-key-input="key.provider" :disabled="!key.writable" v-model="keyInputs[key.provider]">
        <button type="button" class="ghost" :data-key-set="key.provider" :disabled="!key.writable" @click="providerKeyAction(key, 'set')">更新</button>
        <button type="button" class="danger" :data-key-clear="key.provider" :disabled="!key.writable" @click="providerKeyAction(key, 'clear')">清除</button>
      </div>
    </div>
    <div class="row" style="grid-column:1/-1">
      <button type="submit" :disabled="!providerUi.ready">儲存</button>
      <span id="provider-msg" class="msg" :class="messages.provider.tone" role="status">{{ messages.provider.text }}</span>
    </div>
  </form>
  <p class="muted" style="margin:10px 0 0">主模型與備援都來自 DSH 的 <code>session/modelCatalog</code>，provider 與 model 成對選。儲存後主模型會切到 <code>hedge</code>；現有會話下一批生效。API Key 只顯示「已輸入」／「未設定」，輸入新值才會替換。金鑰經 LAN 明文 HTTP 傳送，建議用 SSH tunnel 從 127.0.0.1 開控制台。</p>
</section>

<section class="card">
  <h2>功能設定</h2>
  <form id="feature-form" class="grid" novalidate @submit.prevent="saveFeatures">
    <div id="feature-fields" style="grid-column:1/-1">
      <div v-for="section in featureSections" :id="'fsec-' + (section.key || 'chat')" :key="section.key" class="fsec"
           role="group" :aria-labelledby="'fsec-' + (section.key || 'chat') + '-title'">
        <h3 :id="'fsec-' + (section.key || 'chat') + '-title'">{{ section.title }}<small v-if="section.key">{{ section.key }}.*</small></h3>
        <div class="grid">
          <template v-for="field in section.fields" :key="field.path">
            <label v-if="field.kind === 'bool'" style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);grid-column:1/-1">
              <input :id="featureId(field)" v-model="featureValues[field.path]" type="checkbox" style="width:auto;margin:0;flex:none">
              {{ field.label }}
            </label>
            <label v-else :style="field.wide ? 'grid-column:1/-1' : ''">{{ field.label }}
              <select v-if="field.kind === 'select'" :id="featureId(field)" v-model="featureValues[field.path]">
                <option v-for="option in field.options ?? []" :key="option" :value="option">{{ option }}</option>
              </select>
              <textarea v-else-if="field.kind === 'ids'" :id="featureId(field)" v-model="featureValues[field.path]"></textarea>
              <input v-else :id="featureId(field)" v-model="featureValues[field.path]"
                     :type="field.kind === 'number' ? 'number' : 'text'"
                     :min="field.min" :max="field.max" :step="field.step ?? 1">
            </label>
          </template>
        </div>
      </div>
    </div>
    <div class="row" style="grid-column:1/-1">
      <button type="submit">儲存</button>
      <span id="feature-msg" class="msg" :class="messages.feature.tone" role="status">{{ messages.feature.text }}</span>
    </div>
  </form>
  <p class="muted" style="margin:10px 0 0">數值超出範圍會由 config 驗證擋下並顯示原因。改完立即生效，不需要重啟。</p>
</section>

<section class="card">
  <h2>小刻食堂（餅）</h2>
  <form id="ceobe-form" class="grid" novalidate @submit.prevent="saveCeobe">
    <div class="fsec" style="grid-column:1/-1">
      <h3>頻道與來源<small>ceobe.*</small></h3>
      <div class="grid">
        <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text)">
          <input id="ceobe-enabled" v-model="ceobe.enabled" type="checkbox" style="width:auto;margin:0;flex:none">
          ceobe.enabled：把小刻食堂的新餅投給下面列出的頻道
        </label>
        <div id="ceobe-targets" style="grid-column:1/-1">
          <div v-for="(row, index) in ceobe.rows" :key="index" class="ceobe-target">
            <div class="row">
              <label>頻道 ID <input v-model="row.id" class="ceobe-channel" type="text" inputmode="numeric" placeholder="頻道 ID"></label>
              <button type="button" class="ghost danger" @click="ceobe.rows.splice(index, 1)">刪除</button>
            </div>
            <details>
              <summary>來源（已選 {{ row.sources.length }} 個）</summary>
              <div class="ceobe-source-list">
                <p v-if="!ceobe.sources" class="muted" style="margin:0;font-size:12px">按下面的「載入資料源」取得清單。</p>
                <label v-for="source in sourceOptions(row)" :key="source.id">
                  <input type="checkbox" :value="source.id" :checked="row.sources.includes(source.id)"
                         @change="toggleSource(row, source.id, $event.target.checked)">
                  {{ source.label }}
                </label>
              </div>
            </details>
          </div>
          <p v-if="!ceobe.rows.length" class="muted" style="margin:0;font-size:12px">還沒有頻道。按「新增頻道」開始。</p>
        </div>
        <div class="row" style="grid-column:1/-1">
          <button type="button" id="ceobe-add" class="ghost" @click="addCeobeRow">新增頻道</button>
          <button type="button" id="ceobe-load" class="ghost" @click="reloadCeobeSources">載入資料源</button>
          <button type="submit">儲存</button>
          <span id="ceobe-msg" class="msg" :class="messages.ceobe.tone" role="status">{{ messages.ceobe.text }}</span>
        </div>
      </div>
    </div>
  </form>
  <p id="ceobe-status" class="muted" style="margin:10px 0 0;font-size:12px">{{ ceobe.status }}</p>
</section>

<section class="card">
  <h2>模擬股票</h2>
  <form id="trade-form" class="grid" @submit.prevent="saveTrade">
    <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text)">
      <input id="trade-enabled" v-model="cfg.tradeEnabled" type="checkbox" style="width:auto;margin:0">
      trade.enabled：開放模擬股票（第一版只有台股）
    </label>
    <label style="grid-column:1/-1">allowedGuilds（一行一個伺服器 ID；空白＝不限制）
      <textarea id="trade-guilds" v-model="cfg.tradeGuilds" placeholder="123456789012345678"></textarea>
    </label>
    <label style="grid-column:1/-1">allowedChannels（一行一個頻道 ID；空白＝不限制）
      <textarea id="trade-channels" v-model="cfg.tradeChannels" placeholder="123456789012345678"></textarea>
    </label>
    <label>起始資金（NT$）<input id="trade-starting-cash" v-model="cfg.tradeStartingCash" type="number" min="1000" step="1000"></label>
    <label>單筆上限（帳戶淨值 %）<input id="trade-max-order-pct" v-model="cfg.tradeMaxOrderPct" type="number" min="1" max="100" step="1"></label>
    <label>手續費率<input id="trade-fee-rate" v-model="cfg.tradeFeeRate" type="number" min="0" max="0.1" step="0.000001"></label>
    <label>證交稅率<input id="trade-tax-rate" v-model="cfg.tradeTaxRate" type="number" min="0" max="0.1" step="0.000001"></label>
    <label>最低手續費（NT$）<input id="trade-min-fee" v-model="cfg.tradeMinFee" type="number" min="0" step="1"></label>
    <label>結算檢查間隔（分鐘）<input id="trade-settle-minutes" v-model="cfg.tradeSettleMinutes" type="number" min="1" max="120" step="1"></label>
    <label>結算開始時間<input id="trade-settle-after" v-model="cfg.tradeSettleAfter" type="time"></label>
    <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text)">
      <input id="trade-bot-enabled" v-model="cfg.tradeBotEnabled" type="checkbox" style="width:auto;margin:0">
      bot.enabled：讓 Bot 交易員在盤中自己決策
    </label>
    <label>公告頻道 ID<input id="trade-bot-announce" v-model="cfg.tradeBotAnnounce" placeholder="123456789012345678"></label>
    <label>每日決策次數<input id="trade-bot-turns" v-model="cfg.tradeBotTurns" type="number" min="1" max="24"></label>
    <label>每日下單次數<input id="trade-bot-trades" v-model="cfg.tradeBotTrades" type="number" min="1" max="24"></label>
    <label>兩次決策間隔（分鐘）<input id="trade-bot-interval" v-model="cfg.tradeBotInterval" type="number" min="1" max="1440"></label>
    <label>每日 token 上限<input id="trade-bot-tokens" v-model="cfg.tradeBotTokens" type="number" min="1000" step="1000"></label>
    <label>每回合搜尋上限<input id="trade-bot-searches" v-model="cfg.tradeBotSearches" type="number" min="0" max="10"></label>
    <label>每回合抓取上限<input id="trade-bot-fetches" v-model="cfg.tradeBotFetches" type="number" min="0" max="10"></label>
    <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text)">
      <input id="trade-bot-review-enabled" v-model="cfg.tradeBotReviewEnabled" type="checkbox" style="width:auto;margin:0">
      bot.review.enabled：收盤後跑一次當日復盤（收盤價、法人、新聞）
    </label>
    <label>復盤開始時間<input id="trade-bot-review-after" v-model="cfg.tradeBotReviewAfter" type="time"></label>
    <div class="row" style="grid-column:1/-1">
      <button type="submit">儲存</button>
      <span id="trade-msg" class="msg" :class="messages.trade.tone" role="status">{{ messages.trade.text }}</span>
    </div>
  </form>
  <p class="muted" style="margin:10px 0 0">Bot 使用 dc-trader preset，一次決策開一個一次性會話。費率改了不影響已建立的訂單（每筆單記著下單當時的費率）。</p>
</section>

<section class="card">
  <h2>執行程式（沙箱）</h2>
  <form id="sandbox-form" class="grid" @submit.prevent="saveSandbox">
    <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text)">
      <input id="sandbox-enabled" v-model="cfg.sandboxEnabled" type="checkbox" style="width:auto;margin:0">
      sandbox.enabled：開放 run_script（一次性 Docker 容器，沒有網路、沒有主機檔案）
    </label>
    <label style="grid-column:1/-1">sandbox.channels（一行一個頻道 ID；只有這些頻道能跑，私聊一律不行）
      <textarea id="sandbox-channels" v-model="cfg.sandboxChannels" placeholder="123456789012345678"></textarea>
    </label>
    <div class="row" style="grid-column:1/-1">
      <button type="submit">儲存</button>
      <span id="sandbox-msg" class="msg" :class="messages.sandbox.tone" role="status">{{ messages.sandbox.text }}</span>
    </div>
  </form>
  <p class="muted" style="margin:10px 0 0">要先在橋接主機 pull image（<code>python:3.12-alpine</code>／<code>node:24-alpine</code>）。只有這裡列出的頻道能跑；任何能在那個頻道講話的人，只要說服模型就能跑程式。image、逾時與輸出上限請改 <code>config.json</code>。</p>
</section>

<section class="card">
  <h2>邀請機器人 <span class="muted">（管理員）</span></h2>
  <p class="muted" style="margin:0 0 10px">連結已包含目前所有功能的權限。貼給要邀請 bot 的人，或在 Discord 開啟。</p>
  <div class="row" style="margin-bottom:8px">
    <button id="invite-open" :disabled="!invite.url" @click="openInvite">開啟邀請頁</button>
    <button id="invite-copy" class="ghost" :disabled="!invite.url" @click="copyInvite">複製連結</button>
    <span id="invite-msg" class="msg" :class="inviteMessage.tone" role="status">{{ inviteMessage.text }}</span>
  </div>
  <input id="invite-url" readonly placeholder="載入中…" :value="invite.url ?? ''">
  <div id="invite-perms" class="muted" style="margin-top:8px;font-size:12px">{{ invitePerms }}</div>
</section>

<section class="card">
  <h2>表情目錄 <span id="emoji-count" class="muted">（{{ emoji.entries ?? 0 }} 條 / {{ emoji.guilds ?? 0 }} 個伺服器）</span></h2>
  <div class="row" style="margin-bottom:10px">
    <button id="emoji-rebuild" :disabled="rebuilding || Boolean(emoji.job?.running)" @click="rebuildEmojis">更新目錄</button>
    <span id="emoji-job" class="muted">{{ emojiJobText }}</span>
  </div>
  <div class="table-wrap">
    <table style="min-width:420px">
      <colgroup><col style="width:30%"><col style="width:12%"><col></colgroup>
      <thead><tr><th>伺服器</th><th>條目</th><th>建立時間</th></tr></thead>
      <tbody id="emoji-guilds">
        <tr v-for="guild in emoji.items ?? []" :key="guild.guildId">
          <td>{{ guild.guildName || guild.guildId }}</td>
          <td>{{ guild.entries }}</td>
          <td>{{ guild.builtAt ? new Date(guild.builtAt).toLocaleString() : '—' }}</td>
        </tr>
        <tr v-if="!(emoji.items ?? []).length"><td colspan="3" class="muted">還沒有目錄；按「更新目錄」跑一次。</td></tr>
      </tbody>
    </table>
  </div>
  <pre id="emoji-log" ref="emojiLog" :class="{ hidden: !(emoji.job?.log ?? []).length }" @scroll="onEmojiScroll">{{ (emoji.job?.log ?? []).join('\n') }}</pre>
</section>
</template>
