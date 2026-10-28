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
 * 查 OpenCode Go 訂閱額度，結果（含失敗）快取 ttlMs：控制台每 5 秒刷新，不能每次都打出去。
 * @returns {{ get: () => Promise<{ok: true, windows: object[], fetchedAt: number} | {ok: false, error: string}> }}
 */
export function createGoQuota({ getKey, fetchImpl = fetch, ttlMs = 60_000, timeoutMs = 10_000, now = Date.now }) {
  let cached = null;
  let inflight = null;

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
        percent: usage[name].percent,
        resetsAt: Date.parse(usage[name].resetsAt) || null,
      }));
    if (windows.length === 0) return { ok: false, error: 'OpenCode 回的格式看不懂' };
    return { ok: true, windows, fetchedAt: now() };
  }

  return {
    async get() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      inflight ??= load().then((value) => {
        cached = { value, at: now() };
        return value;
      }).finally(() => { inflight = null; });
      return inflight;
    },
  };
}

function untilText(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days} 天 ${hours} 小時`;
  if (hours > 0) return `${hours} 小時 ${minutes % 60} 分`;
  return `${minutes} 分`;
}

/** `/status` 用的一行；provider 不是 opencode-go（skipped）時回空字串。 */
export function formatGoQuota(result, now = Date.now()) {
  if (!result || result.skipped) return '';
  if (!result.ok) return `OpenCode Go 額度：查不到（${result.error ?? '未知原因'}）`;
  const parts = result.windows.map((w) => `${w.label} ${w.percent}%`
    + (w.status && w.status !== 'ok' ? `（${w.status}）` : '')
    + (w.resetsAt ? `，${untilText(w.resetsAt - now)}後重置` : ''));
  return `OpenCode Go 額度：${parts.join('｜')}`;
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
