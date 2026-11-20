// Token 用量、回合紀錄與三個 provider 的額度查詢。
// 拆自 discord-bridge.js 的 main()：純接線層，deps 只餵設定與檔案路徑。
import path from 'node:path';
import { createCommandCodeQuota, createGoQuota, createUsageTracker, usageReport } from './discord-usage.mjs';
import { createTurnLog, turnRecord } from './discord-turns.mjs';
import { createCodexQuota, createCodexResetPinger, presetAllowsImageGen } from './discord-codex-quota.mjs';
import { readDshCredential } from '../web-search.js';
import { resolvePriceTable } from '../model-prices.js';

export function createUsageLayer({
  cfg,
  log,
  reverse,
  USAGE_FILE,
  TURNS_FILE,
  STATE_DIR,
  ROOT,
  CODEX_RESET_FILE,
}) {
  // ── Token 用量 ────────────────────────────────────────────────────────────
  // 權威累計取 DSH 的 tokenUsage 投影（整條會話日誌，含橋接啟動前的歷史），
  // 逐輪明細由 assistant/message 的 usage 折疊；金額在讀取時才按價目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const learnerSessions = new Set(); // 學習會話（用來歸到 internal:黑話學習）
  const summarySessions = new Set(); // 每日摘要會話（用來歸到 internal:頻道摘要）
  const usage = createUsageTracker({
    file: USAGE_FILE,
    priceTable,
    log,
    reverse,
    learnerSessions,
    summarySessions,
    nominalModel: cfg.dsh.model,
    provider: cfg.dsh.provider,
  });

  /** 背景會話只會愈開愈多；記住最近 200 個就夠歸屬，舊的 key 已存在帳本裡。 */
  function rememberSession(set, sessionId) {
    set.add(sessionId);
    if (set.size > 200) set.delete(set.values().next().value);
  }

  function rememberLearnerSession(sessionId) {
    rememberSession(learnerSessions, sessionId);
  }

  function rememberSummarySession(sessionId) {
    rememberSession(summarySessions, sessionId);
  }

  function usageInfo({ range = '24h', limit = 200 } = {}) {
    return usageReport({ ledger: usage.ledger, priceTable, nominalModel: cfg.dsh.model, range, limit });
  }

  const turnLog = createTurnLog({ file: TURNS_FILE, log });

  /** 寫一行回合紀錄；組紀錄或寫檔失敗都只留 log，不能影響聊天。 */
  function writeTurn(key, meta, decision, {
    reason = '', turn = null, sent = 0, tools = [], tokens = null, ttftMs = null, model = null, users, job = null,
    scope = 'batch',
  } = {}) {
    try {
      turnLog.write(turnRecord({
        key, job, meta, decision, reason, turn, sent, tools, tokens, ttftMs, model, users, scope,
      }));
    } catch (error) {
      log(`回合紀錄：組裝失敗 ${error?.message ?? error}`);
    }
  }

  // key 跟 DSH 共用同一把：DSH 的 Models 頁存在 .credentials.yaml 的 refs 裡。
  const goQuota = createGoQuota({
    getKey: () => process.env.OPENCODE_GO_API_KEY?.trim() || readDshCredential('OPENCODE_GO_API_KEY'),
  });
  const commandCodeQuota = createCommandCodeQuota({
    getKey: () => process.env.COMMANDCODE_API_KEY?.trim() || readDshCredential('COMMANDCODE_API_KEY'),
  });
  /** 單一 provider 的訂閱額度；沒有查詢來源時回 skipped。 */
  async function quotaFor(provider) {
    if (provider !== 'opencode-go' && provider !== 'commandcode') {
      return { ok: false, skipped: true, error: `provider 是 ${provider}，沒有對應的額度查詢` };
    }
    const result = provider === 'opencode-go' ? await goQuota.get() : await commandCodeQuota.get();
    return { ...result, provider };
  }

  /**
   * 目前 provider 的訂閱額度；hedge 用主線 provider 的額度。
   * withFallback 只給控制台用：hedge 開啟時多回一個 fallback，畫第二張卡。
   */
  async function quotaInfo({ withFallback = false } = {}) {
    const primaryProvider = cfg.dsh.provider === 'hedge' ? cfg.dsh.hedge.primaryProvider : cfg.dsh.provider;
    const primary = await quotaFor(primaryProvider);
    if (!withFallback || cfg.dsh.provider !== 'hedge' || !cfg.dsh.hedge.enabled) return primary;
    const fallbackProvider = cfg.dsh.hedge.fallbackProvider;
    if (!fallbackProvider || fallbackProvider === primaryProvider) return primary;
    return { ...primary, fallback: await quotaFor(fallbackProvider) };
  }

  // 生圖開關在 preset 的 dc-tool-restrict.config.allowImageGen；沒有開生圖就不查
  // Codex 額度，也不排 5 小時窗口的重置 ping。
  // 這裡只看預設 preset；dc-chat-open 必須維持同樣的守衛設定（測試會釘住兩份 preset 的其他行相同）。
  const codexImageGenEnabled = presetAllowsImageGen({ root: ROOT, presetId: cfg.discord.agentPreset });
  const codexQuota = codexImageGenEnabled ? createCodexQuota({ snapshotFile: path.join(STATE_DIR, 'discord-codex-quota.json') }) : null;
  async function codexQuotaInfo() {
    if (!codexQuota) return { ok: false, skipped: true };
    return codexQuota.get();
  }
  const codexResetPinger = codexQuota
    ? createCodexResetPinger({ quota: codexQuota, stateFile: CODEX_RESET_FILE, log })
    : null;
  if (!codexImageGenEnabled) log('Codex 額度：preset 沒有開 generate_image，跳過');
return {
    usage,
    usageInfo,
    writeTurn,
    quotaInfo,
    codexQuotaInfo,
    codexResetPinger,
    rememberLearnerSession,
    rememberSummarySession,
  };
}
