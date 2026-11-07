// Token 用量：把 DSH 會話事件餵進 QQ 版就在用的帳本（src/token-ledger.js）。
//
// 為什麼重用而不是在 Discord 版重寫：帳本的難點全在「權威累計＋冪等折疊＋峰谷計價」，
// 第二份實作只會多一組會漂移的語義。這裡只補 Discord 專屬的兩件事：
// 會話歸屬（頻道 / 學習會話 / 未歸屬）與快照、事件的形狀轉接。
import { createTokenLedger } from '../token-ledger.js';
import { ratesAt } from '../model-prices.js';

/** 控制台「花費」卡片可選的時間範圍（小時）。固定四檔，走勢圖的桶數才不會失控。 */
export const USAGE_RANGES = Object.freeze({ '24h': 24, '3d': 72, '7d': 168, '30d': 720 });

export function usageHours(range) {
  return USAGE_RANGES[range] ?? USAGE_RANGES['24h'];
}

/** 學習會話的歸屬名稱。與頻道分開，才看得出黑話學習自己花掉多少。 */
export const LEARNER_USAGE_KEY = 'internal:黑話學習';

/** 每日頻道摘要的歸屬名稱：跟黑話學習分開，才看得出 v2 每天花多少。 */
export const SUMMARY_USAGE_KEY = 'internal:頻道摘要';

/**
 * 建立用量追蹤器。
 * @param options.file            帳本檔（JSONL）
 * @param options.priceTable      `resolvePriceTable()` 的結果
 * @param options.log             日誌函式
 * @param options.reverse         sessionId -> 會話 key（橋接的 reverse Map）
 * @param options.learnerSessions 黑話學習用過的 sessionId 集合
 * @param options.summarySessions 每日頻道摘要用過的 sessionId 集合
 * @param options.nominalModel    沒收到模型事件時的保底模型（config 的 dsh.model）
 * @param options.provider
 */
export function createUsageTracker({
  file,
  priceTable,
  log = () => {},
  reverse,
  learnerSessions,
  summarySessions = new Set(),
  nominalModel,
  provider,
}) {
  const ledger = createTokenLedger({
    file,
    priceTable,
    log: (...args) => log(...args),
    // 查不到就回 undefined：帳本會沿用它記住的舊歸屬（/reset 後的舊會話、重啟後的學習會話）。
    // 回一個固定字串會蓋掉舊歸屬；從沒歸屬過的 session，帳本自己顯示成「未归属:<id>」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) ? LEARNER_USAGE_KEY : undefined)
      ?? (summarySessions.has(sessionId) ? SUMMARY_USAGE_KEY : undefined),
  });

  /** sessionId -> { model, provider }：換模型會讓單價差好幾倍，所以按會話記最近一次。 */
  const models = new Map();

  function rememberModel(sessionId, selection) {
    if (!sessionId || !selection) return;
    // DSH 不同版本把選中的模型放在 lastUsed / next / selected 或直接平鋪。
    const value = selection.lastUsed ?? selection.next ?? selection.selected ?? selection;
    const model = value?.model;
    if (typeof model === 'string' && model) models.set(sessionId, { model, provider: value.provider });
  }

  /** 攝入一條會話事件；任何異常都不能影響聊天主鏈路。 */
  function ingestEvent(sessionId, event) {
    if (!sessionId || !event?.type) return;
    try {
      if (event.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = models.get(sessionId);
      ledger.ingestEvent({
        sessionId,
        event,
        model: event.data?.usage?.model ?? known?.model,
        provider: event.data?.provider ?? known?.provider,
      });
    } catch (error) {
      log(`token 帳本：攝入事件失敗 ${error?.message ?? error}`);
    }
  }

  /**
   * 攝入 `session/follow` 的開場快照。
   * `projections.tokenUsage` 是整條會話日誌的權威累計（含橋接啟動前的歷史），
   * `records` 是最近事件，用來回填逐輪明細；兩者都由帳本做冪等折疊。
   */
  function ingestSnapshot(sessionId, snapshot) {
    if (!sessionId || !snapshot) return;
    try {
      rememberModel(sessionId, snapshot.projections?.values?.modelSelection);
      const known = models.get(sessionId);
      ledger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel,
        provider: known?.provider ?? provider,
      });
      // 逐條回填歷史事件：一定要走 ingestEvent（會帶上這個會話的模型），
      // 直接用帳本的 ingestSnapshotRecords 會少了 model，整段被當成未登記模型。
      for (const entry of snapshot.records ?? []) {
        const event = entry?.type === 'event' ? entry.event : entry;
        if (event?.type) ingestEvent(sessionId, event);
      }
    } catch (error) {
      log(`token 帳本：處理快照失敗 ${error?.message ?? error}`);
    }
  }

  return { ledger, rememberModel, ingestEvent, ingestSnapshot };
}

/** OpenCode Go 的額度端點（PR anomalyco/opencode#16513；跟 opencode.ai 後台額度頁同一份資料）。 */
export const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const GO_WINDOWS = [['rolling', '5 小時'], ['weekly', '每週'], ['monthly', '每月']];

/**
 * 把一次查詢包成「含失敗一起快取、同一時間只打一次」。
 * 控制台每 5 秒刷新，不能每次都打出去；查詢失敗也照樣快取，才不會一直重打。
 */
function cachedLoader(load, { ttlMs, now }) {
  let cached = null;
  let inflight = null;
  return async function get() {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    inflight ??= load().then((value) => {
      cached = { value, at: now() };
      return value;
    }).finally(() => { inflight = null; });
    return inflight;
  };
}

/**
 * 查 OpenCode Go 訂閱額度。
 * @returns {{ get: () => Promise<{ok: true, windows: object[], fetchedAt: number} | {ok: false, error: string}> }}
 */
export function createGoQuota({ getKey, fetchImpl = fetch, ttlMs = 60_000, timeoutMs = 10_000, now = Date.now }) {
  async function load() {
    const key = getKey();
    if (!key) return { ok: false, error: '沒有 OpenCode Go API key（環境變數 OPENCODE_GO_API_KEY 或 DSH 的 .credentials.yaml）' };
    let res;
    try {
      res = await fetchImpl(GO_USAGE_URL, {
        headers: { authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // 錯誤訊息不帶 key：fetch 的錯誤只會有網址與原因。
      return { ok: false, error: `連不上 OpenCode：${error?.name === 'TimeoutError' ? '逾時' : (error?.message ?? error)}` };
    }
    if (!res.ok) return { ok: false, error: `OpenCode 回 HTTP ${res.status}` };
    const usage = (await res.json().catch(() => null))?.usage;
    const windows = GO_WINDOWS
      .filter(([name]) => Number.isFinite(usage?.[name]?.percent))
      .map(([name, label]) => ({
        key: name,
        label,
        status: String(usage[name].status ?? ''),
        // 端點給的是已用百分比；卡片和 /status 跟 Codex 一樣顯示剩餘，從 100% 往下扣。
        remainingPercent: Math.max(0, Math.min(100, 100 - usage[name].percent)),
        resetsAt: Date.parse(usage[name].resetsAt) || null,
      }));
    if (windows.length === 0) return { ok: false, error: 'OpenCode 回的格式看不懂' };
    return { ok: true, windows, fetchedAt: now() };
  }

  return { get: cachedLoader(load, { ttlMs, now }) };
}

/** Command Code 的帳號端點：外掛的用量頁讀同一支，回應單位是金額（美元）不是百分比。 */
export const COMMAND_CODE_API_BASE = 'https://api.commandcode.ai';
const COMMAND_CODE_WINDOWS = [['fiveHour', '5 小時'], ['weekly', '每週']];

/**
 * GOAT 的每月額度上限（美元）。
 *
 * API 不報這個值：`credits` 只有 `monthlyCredits`（已扣到剩多少），`windowLimits` 只有 5 小時與
 * 每週。官方文件寫「up to $100」是逐模型的最佳情況（DeepSeek V4.1 Flash $100、GLM-5.2 $70……），
 * 不是每個 GOAT 帳號都拿得到：實測這個帳號的 5 小時 $14、每週 $35、月池 $70，都是公告值的 0.7 倍。
 *
 * shortcut: 只支援 GOAT，換方案要改這裡。
 */
export const GOAT_MONTHLY_CREDITS = 70;

/**
 * 查 Command Code 訂閱額度（GOAT 的每月 / 5 小時 / 每週）。
 *
 * `windowLimits.<window>` 給的是 `{ used, cap, exceeded, resetAt }`，卡面要的是剩餘百分比，
 * 所以自己算 `100 - used / cap * 100`。`accept-encoding: identity` 跟外掛一致：
 * DSH 換過 undici 的 dispatcher，壓縮過的回應有可能解不開。
 * 快取與失敗處理跟 createGoQuota 相同（控制台每 5 秒刷新，不能每次都打出去）。
 *
 * shortcut: 不帶 orgId（多組織帳號可能拿到別的組織）, 真的遇到多組織再補 `/alpha/whoami`。
 */
export function createCommandCodeQuota({ getKey, fetchImpl = fetch, ttlMs = 60_000, timeoutMs = 10_000, now = Date.now }) {
  async function load() {
    const key = getKey();
    if (!key) return { ok: false, error: '沒有 Command Code API key（環境變數 COMMANDCODE_API_KEY 或 DSH 的 .credentials.yaml）' };
    let res;
    try {
      res = await fetchImpl(`${COMMAND_CODE_API_BASE}/alpha/billing/credits`, {
        headers: { authorization: `Bearer ${key}`, 'accept-encoding': 'identity' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, error: `連不上 Command Code：${error?.name === 'TimeoutError' ? '逾時' : (error?.message ?? error)}` };
    }
    if (!res.ok) return { ok: false, error: `Command Code 回 HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const limits = body?.windowLimits;
    if (!limits || typeof limits !== 'object') return { ok: false, error: 'Command Code 回的格式看不懂' };
    const windows = [];
    // 每月只有「剩多少」：上限是方案常數，用量由兩者相減。卡片會再多一列顯示剩下的金額。
    const remaining = Number(body?.credits?.monthlyCredits);
    const monthly = Number.isFinite(remaining)
      ? { cap: GOAT_MONTHLY_CREDITS, remaining, used: Math.max(0, GOAT_MONTHLY_CREDITS - remaining) }
      : null;
    if (monthly) {
      windows.push({
        key: 'monthly',
        label: '月額度',
        status: remaining <= 0 ? '已用完' : 'ok',
        remainingPercent: Math.max(0, Math.min(100, (remaining / GOAT_MONTHLY_CREDITS) * 100)),
        resetsAt: null,
      });
    }
    // cap 不是正數或 used 不是數字就跳過那個視窗：畫一條 0% 或 100% 的假額度比不畫更糟。
    for (const [name, label] of COMMAND_CODE_WINDOWS) {
      const block = limits[name];
      const cap = Number(block?.cap);
      const used = Number(block?.used);
      if (!(cap > 0) || !Number.isFinite(used)) continue;
      windows.push({
        key: name,
        label,
        status: block.exceeded ? '已超限' : 'ok',
        remainingPercent: Math.max(0, Math.min(100, 100 - (used / cap) * 100)),
        resetsAt: Number(block.resetAt) || null,
      });
    }
    if (windows.length === 0) return { ok: false, error: 'Command Code 沒有回報額度上限' };
    return { ok: true, windows, monthly, fetchedAt: now() };
  }

  return { get: cachedLoader(load, { ttlMs, now }) };
}

export function untilText(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days} 天 ${hours} 小時`;
  if (hours > 0) return `${hours} 小時 ${minutes % 60} 分`;
  return `${minutes} 分`;
}

/** provider id 對到卡片／`/status` 的顯示名稱。 */
const QUOTA_NAMES = { 'opencode-go': 'OpenCode Go', commandcode: 'Command Code' };

/** `/status` 用的一行；provider 沒有額度查詢（skipped）時回空字串。 */
export function formatQuota(result, now = Date.now()) {
  if (!result || result.skipped) return '';
  const name = QUOTA_NAMES[result.provider] ?? '訂閱';
  if (!result.ok) return `${name} 額度：查不到（${result.error ?? '未知原因'}）`;
  const parts = result.windows.map((w) => `${w.label}剩 ${Math.round(w.remainingPercent)}%`
    + (w.status && w.status !== 'ok' ? `（${w.status}）` : '')
    + (w.resetsAt ? `，${untilText(w.resetsAt - now)}後重置` : ''));
  return `${name} 額度：${parts.join('｜')}`;
}

/** 控制台「花費」卡片一次要的資料：總計、每個會話、走勢、目前價位。 */
export function usageReport({ ledger, priceTable, nominalModel, range = '24h', limit = 200, now = Date.now() }) {
  const summary = ledger.summary({ limit });
  return {
    ok: true,
    range,
    hours: usageHours(range),
    totals: summary.totals,
    conversations: summary.conversations,
    series: ledger.series({ hours: usageHours(range) }),
    prices: {
      version: priceTable.version,
      currency: priceTable.currency,
      symbol: priceTable.symbol,
      unit: priceTable.unit,
      peakMultiplier: priceTable.peakMultiplier,
      // 目前模型在此刻的實際單價（尖峰／離線已折算），卡片直接顯示。
      now: ratesAt(nominalModel, now, priceTable),
    },
    ledger: ledger.stats(),
  };
}
