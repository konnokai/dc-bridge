// 模擬股票：服務建立、結算、Bot 交易員與復盤排程。
// 拆自 discord-bridge.js 的 main()；trade 相關的 let 由模組持有，
// 控制台改設定走 applyTradeConfig，agentTools 拿 tradeService／botActiveRun 走 getter。
import { MessageFlags } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { splitDiscordMessage } from './discord-core.mjs';
import { findSymbol } from './trade-symbols.mjs';
import {
  buildBotPrompt,
  buildReviewPrompt,
  canRunBot,
  canRunReview,
  formatPlayerNotice,
  formatReviewNotice,
  formatTradeNotice,
} from './bot-trader.mjs';
import { createQuoteProvider } from './quote-provider.mjs';
import { createInstitutionalProvider } from './institutional-provider.mjs';
import { createMaterialProvider } from './material-provider.mjs';
import { createTradeService, parseHhmm, playerAccountId } from './discord-trade.mjs';
import { openTradeDb } from './discord-trade-db.mjs';
import { findSensitive, formatSensitiveHit } from './discord-security.mjs';

export function createTradeRuntime({
  cfg,
  log,
  client,
  agentSecrets,
  stripPublicLinks,
  STATE_DIR,
  botTokenSink,
  runBackgroundPrompt,
}) {
  // 模擬股票：交易域獨立 SQLite；報價、結算與 Bot 排程都在 login 之後才啟動。
  let tradeDb = null;
  let tradeQuotes = null;
  let tradeInstitutional = null;
  let tradeMaterial = null;
  let tradeService = null;
  let botActiveRun = null;
  let tradeSettlementTimer = null;
  let botTraderTimer = null;
  let botReviewTimer = null;
  let botReviewRunning = false;
  let tradeSettling = false;
  let botStarting = false;
  // ── 模擬股票 ──────────────────────────────────────────────────────────────
  function writeTradeLimits() {
    try {
      const file = path.join(STATE_DIR, 'discord-trade-limits.json');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({
        maxWebSearchesPerTurn: cfg.discord.trade.bot.maxWebSearchesPerTurn,
        maxWebFetchesPerTurn: cfg.discord.trade.bot.maxWebFetchesPerTurn,
      })}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      log(`模擬股票：寫入搜尋上限失敗：${error?.message ?? error}`);
    }
  }

  function initTrade() {
    const dbFile = path.join(STATE_DIR, 'discord-trade.sqlite');
    if (!cfg.discord.trade.enabled) {
      // 交易關閉但 DB 還在：建立 enabled:false 的 service，讓排隊中的單繼續結算。
      if (!fs.existsSync(dbFile)) {
        log('模擬股票：未開啟');
        return false;
      }
      try {
        if (!tradeDb) tradeDb = openTradeDb(dbFile);
        if (!tradeQuotes) tradeQuotes = createQuoteProvider({ log });
        if (!tradeInstitutional) tradeInstitutional = createInstitutionalProvider({ log });
        if (!tradeMaterial) tradeMaterial = createMaterialProvider({ log });
        tradeService = createTradeService({
          db: tradeDb,
          config: cfg.discord.trade,
          quotes: tradeQuotes,
          botId: client.user.id,
          log,
        });
        writeTradeLimits();
        log('模擬股票：未開啟（只結算既有訂單）');
      } catch (error) {
        tradeService = null;
        log(`⚠️ 模擬股票關閉狀態啟動失敗：${error?.message ?? error}`);
      }
      return false;
    }
    try {
      if (!tradeDb) tradeDb = openTradeDb(dbFile);
      if (!tradeQuotes) tradeQuotes = createQuoteProvider({ log });
      if (!tradeInstitutional) tradeInstitutional = createInstitutionalProvider({ log });
      if (!tradeMaterial) tradeMaterial = createMaterialProvider({ log });
      tradeService = createTradeService({
        db: tradeDb,
        config: cfg.discord.trade,
        quotes: tradeQuotes,
        botId: client.user.id,
        log,
      });
      writeTradeLimits();
      void tradeQuotes.getHolidays();
      void tradeQuotes.refreshAll();
      log(`模擬股票：已開啟（台股，${dbFile}）`);
      return true;
    } catch (error) {
      // DB 開不起來就停用交易，不要自動重建一個空 DB 蓋掉帳。
      tradeService = null;
      log(`⚠️ 模擬股票啟動失敗，交易停用：${error?.message ?? error}`);
      return false;
    }
  }

  async function sendTradeNotice(channelId, text) {
    if (!channelId) return;
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased?.()) return;
      // 復盤可能被模型寫爆；最多兩則，避免公告頻道被洗版。
      const parts = splitDiscordMessage(text, cfg.discord.maxMessageChars);
      if (parts.length > 2) {
        const suffix = '…（內容過長，已省略）';
        let tail = parts[1].slice(0, cfg.discord.maxMessageChars - suffix.length);
        if (/[\uD800-\uDBFF]$/.test(tail)) tail = tail.slice(0, -1);
        parts.length = 2;
        parts[1] = `${tail}${suffix}`;
      }
      for (const part of parts) {
        await channel.send({ content: part, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
      }
    } catch (error) {
      log(`模擬股票通知失敗（${channelId}）：${error?.message ?? error}`);
    }
  }

  async function playerDisplayName(order) {
    if (!order.channel_id || !order.account_id?.startsWith('user:')) return '';
    try {
      const channel = await client.channels.fetch(order.channel_id);
      const userId = order.account_id.slice('user:'.length);
      const member = channel?.guild?.members.cache.get(userId)
        ?? await channel?.guild?.members.fetch(userId).catch(() => null);
      return member?.displayName ?? '';
    } catch {
      return '';
    }
  }

  async function runTradeSettlement() {
    if (!tradeService || tradeSettling) return;
    tradeSettling = true;
    try {
      let events;
      try {
        events = await tradeService.settleDue();
      } catch (error) {
        log(`模擬股票結算失敗：${error?.message ?? error}`);
        return;
      }
      for (const event of events) {
        const order = event.order;
        const name = findSymbol(order.symbol)?.name ?? order.symbol;
        const isBot = order.actor === 'bot';
        const displayName = isBot ? '' : await playerDisplayName(order);
        const prefix = displayName ? `（${displayName} 的模擬訂單）` : '';
        const body = isBot
          ? formatTradeNotice(order, name, event.type)
          : formatPlayerNotice(order, name, event.type);
        const text = `${prefix}${body}`;
        const channelId = isBot ? cfg.discord.trade.bot.announceChannelId : order.channel_id;
        if (channelId) {
          await sendTradeNotice(channelId, text);
        } else if (!isBot && order.account_id?.startsWith('user:')) {
          // 私聊下的單沒有 channel_id：用 DM 通知本人。
          const userId = order.account_id.slice('user:'.length);
          try {
            const user = await client.users.fetch(userId);
            await user.send({ content: text, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
          } catch (error) {
            log(`模擬股票私聊通知失敗（${userId}）：${error?.message ?? error}`);
          }
        }
        log(`模擬股票結算 ${order.id}：${event.type}${event.reason ? `（${event.reason}）` : ''}`);
      }
      await backupTradeDb();
    } finally {
      tradeSettling = false;
    }
  }

  /** 每日結算後備份一次，保留 7 份。 */
  async function backupTradeDb() {
    if (!tradeDb) return;
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(/-/g, '');
    const dir = path.join(STATE_DIR, 'backups');
    const file = path.join(dir, `discord-trade-${day}.sqlite`);
    if (fs.existsSync(file)) return;
    const tmp = `${file}.tmp`;
    try {
      tradeDb.backup(tmp);
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch { /* Windows 沒有 POSIX 權限 */ }
      const keep = fs.readdirSync(dir)
        .filter((name) => /^discord-trade-\d{8}\.sqlite$/.test(name))
        .sort();
      for (const old of keep.slice(0, Math.max(0, keep.length - 7))) {
        fs.rmSync(path.join(dir, old), { force: true });
      }
      log(`模擬股票：已備份 ${file}`);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 沒留下半個檔 */ }
      log(`模擬股票備份失敗：${error?.message ?? error}`);
    }
  }

  async function runBotTrader() {
    if (!tradeService || !tradeService.config.enabled || !cfg.discord.trade.bot.enabled || botActiveRun || botReviewRunning || botStarting) return;
    botStarting = true;
    try {
      const market = await tradeService.state();
      const dayStart = new Date(Date.parse(`${market.date}T00:00:00+08:00`)).toISOString();
      const allRuns = tradeDb.botRunsSince(dayStart);
      const runs = allRuns.filter((run) => run.kind !== 'review');
      const tradesToday = tradeDb.countBotOrdersSince(dayStart);
      const lastRunAt = runs[0] ? Date.parse(runs[0].started_at) : 0;
      const gate = canRunBot({
        config: { enabled: true, ...cfg.discord.trade.bot },
        market,
        runsToday: runs.length,
        tradesToday,
        lastRunAt,
      });
      if (!gate.ok) return;
      const tokensToday = allRuns.reduce((sum, run) => sum + (run.tokens ?? 0), 0);
      if (tokensToday >= cfg.discord.trade.bot.maxTokensPerDay) {
        log(`模擬股票 Bot：今天 token 已達上限（${tokensToday}）`);
        return;
      }
      const portfolio = await tradeService.portfolio(tradeService.botAccountId);
      const lastReviewRaw = tradeDb.latestReviewBefore(market.date);
      const lastReview = lastReviewRaw && market.prevPrevTradingDate && lastReviewRaw.date >= market.prevPrevTradingDate
        ? lastReviewRaw
        : null;
      const prompt = buildBotPrompt({ portfolio, market, config: cfg.discord.trade.bot, lastReview });
      const runId = `br-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const sink = { tokens: 0 };
      tradeDb.insertBotRun({ id: runId, kind: 'decision', startedAt: new Date().toISOString(), market: 'TW', status: 'running' });
      botActiveRun = { runId, sessionId: '', ordered: false };
      let status = 'hold';
      let reason = '';
      try {
        const text = await runBackgroundPrompt({
          prompt,
          timeoutMs: 3 * 60_000,
          label: 'Bot 交易',
          title: 'Discord 模擬交易員',
          preset: cfg.discord.trade.bot.preset,
          registerKey: 'bot:trader',
          usageKind: 'bot',
          onSession: (sessionId) => {
            botActiveRun.sessionId = sessionId;
            botTokenSink.set(sessionId, sink);
          },
        });
        reason = String(text ?? '').trim().slice(0, 300);
        status = botActiveRun.ordered ? 'pending' : 'hold';
      } catch (error) {
        status = 'error';
        reason = String(error?.message ?? error).slice(0, 300);
        log(`模擬股票 Bot 失敗：${reason}`);
      } finally {
        tradeDb.updateBotRun(runId, {
          endedAt: new Date().toISOString(),
          status,
          tokens: sink.tokens,
          reason,
        });
        botActiveRun = null;
      }
      log(`模擬股票 Bot ${runId}：${status}（${sink.tokens} tokens）${reason ? `｜${reason.slice(0, 80)}` : ''}`);
    } catch (error) {
      botActiveRun = null;
      log(`模擬股票 Bot 排程失敗：${error?.message ?? error}`);
    } finally {
      botStarting = false;
    }
  }

  function stopTradeJobs() {
    if (tradeSettlementTimer) { clearInterval(tradeSettlementTimer); tradeSettlementTimer = null; }
    if (botTraderTimer) { clearInterval(botTraderTimer); botTraderTimer = null; }
    if (botReviewTimer) { clearInterval(botReviewTimer); botReviewTimer = null; }
  }

  async function runBotReview() {
    const review = cfg.discord.trade.bot.review;
    if (!tradeService || !tradeService.config.enabled || !cfg.discord.trade.bot.enabled || !review?.enabled) return;
    if (botActiveRun || botStarting || botReviewRunning) return;
    botReviewRunning = true;
    try {
      const market = await tradeService.state();
      const dayStart = new Date(Date.parse(`${market.date}T00:00:00+08:00`)).toISOString();
      const allRuns = tradeDb.botRunsSince(dayStart);
      const reviewRuns = allRuns.filter((run) => run.kind === 'review');
      const tokensToday = allRuns.reduce((sum, run) => sum + (run.tokens ?? 0), 0);
      const gate = canRunReview({
        config: review,
        market,
        runsToday: reviewRuns.length,
        tokensToday,
        maxTokensPerDay: cfg.discord.trade.bot.maxTokensPerDay,
      });
      if (!gate.ok) return;
      // 先讓 19:00 的結算跑一次；資料還沒到就照樣復盤，只是持倉可能還是結算前狀態。
      await runTradeSettlement();
      const portfolio = await tradeService.portfolio(tradeService.botAccountId);
      const entries = portfolio.exists
        ? portfolio.positions
          .filter((position) => position.exchange)
          .map((position) => ({ symbol: position.symbol, name: position.name, exchange: position.exchange }))
        : [];
      const institutional = entries.length
        ? await tradeInstitutional.getForSymbols(entries, market.date)
        : { bySymbol: new Map(), missing: [], errors: [] };
      const material = entries.length
        ? await tradeMaterial.getForSymbols(entries, market.date, { since: market.prevTradingDate || market.date })
        : { available: true, bySymbol: new Map(), errors: [] };
      // 19:10 只等法人；重大訊息 API 常常隔天才更新，不等它，prompt 會標最近交易日。
      const waiting = institutional.missing.length > 0;
      if (waiting && market.minutes < parseHhmm(review.after) + 30) {
        log(`模擬股票復盤：等法人資料（${institutional.missing.join(', ')}）`);
        return;
      }
      const prompt = buildReviewPrompt({
        portfolio,
        market,
        institutional: institutional.bySymbol,
        material: material.bySymbol,
        now: new Date(),
      });
      const runId = `rv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const sink = { tokens: 0 };
      tradeDb.insertBotRun({ id: runId, kind: 'review', startedAt: new Date().toISOString(), market: 'TW', status: 'running' });
      let status = 'ok';
      let reason = '';
      let summary = '';
      try {
        const text = await runBackgroundPrompt({
          prompt,
          timeoutMs: 3 * 60_000,
          label: '當日復盤',
          title: 'Discord 模擬交易復盤',
          preset: cfg.discord.trade.bot.preset,
          registerKey: 'bot:review',
          usageKind: 'bot',
          onSession: (sessionId) => { botTokenSink.set(sessionId, sink); },
        });
        summary = String(text ?? '').trim();
        reason = summary.slice(0, 300);
        if (!summary) {
          status = 'error';
          reason = '復盤回覆是空的';
        } else {
          const publicSummary = stripPublicLinks(summary);
          const hit = cfg.discord.security.blockSensitive ? findSensitive(publicSummary, agentSecrets()) : null;
          if (hit) {
            status = 'error';
            reason = `復盤內容命中敏感資訊：${formatSensitiveHit(hit)}`;
            log(`模擬股票復盤 ${runId}：${reason}，不發布`);
          } else {
            tradeDb.saveDailyReview({ date: market.date, createdAt: new Date().toISOString(), summary: publicSummary, tokens: sink.tokens });
            if (cfg.discord.trade.bot.announceChannelId) {
              await sendTradeNotice(cfg.discord.trade.bot.announceChannelId, formatReviewNotice(market.date, publicSummary));
            }
          }
        }
      } catch (error) {
        status = 'error';
        reason = String(error?.message ?? error).slice(0, 300);
        log(`模擬股票復盤失敗：${reason}`);
      } finally {
        tradeDb.updateBotRun(runId, { endedAt: new Date().toISOString(), status, tokens: sink.tokens, reason });
      }
      log(`模擬股票復盤 ${runId}：${status}（${sink.tokens} tokens）`);
    } catch (error) {
      log(`模擬股票復盤排程失敗：${error?.message ?? error}`);
    } finally {
      botReviewRunning = false;
    }
  }
  function scheduleTradeJobs() {
    stopTradeJobs();
    if (!tradeService) return;
    const minutes = Math.max(1, cfg.discord.trade.settlement.twCheckMinutes);
    tradeSettlementTimer = setInterval(() => { void runTradeSettlement(); }, minutes * 60_000);
    tradeSettlementTimer.unref?.();
    setTimeout(() => { void runTradeSettlement(); }, 20_000).unref?.();
    botTraderTimer = setInterval(() => { void runBotTrader(); }, 5 * 60_000);
    botTraderTimer.unref?.();
    botReviewTimer = setInterval(() => { void runBotReview(); }, 5 * 60_000);
    botReviewTimer.unref?.();
    setTimeout(() => { void runBotTrader(); }, 45_000).unref?.();
    setTimeout(() => { void runBotReview(); }, 60_000).unref?.();
  }

  /** /forget 刪交易帳號：沒開交易時 DB 檔存在也只為了這裡開一下，不啟動排程。 */
  function forgetTradeAccount(userId) {
    if (tradeService) return tradeService.forgetAccount(userId);
    const dbFile = path.join(STATE_DIR, 'discord-trade.sqlite');
    if (!fs.existsSync(dbFile)) return false;
    if (!tradeDb) tradeDb = openTradeDb(dbFile);
    return tradeDb.deleteAccount(playerAccountId(userId));
  }

  /** 控制台改 discord.trade 設定：重建 service 讓新費率／上限立刻生效。 */
  function applyTradeConfig(next) {
    // 交易設定改了：用同一個 DB 重建 service，讓新費率／上限立刻生效；已建立的訂單
    // 各自記著下單當時的費率，不會被新設定影響。關閉時保留 service（enabled=false）
    // 讓已排隊的單繼續結算，只是不再接受新單。
    if (!next.trade.enabled) {
      if (tradeDb) {
        if (!tradeQuotes) tradeQuotes = createQuoteProvider({ log });
        if (!tradeInstitutional) tradeInstitutional = createInstitutionalProvider({ log });
        if (!tradeMaterial) tradeMaterial = createMaterialProvider({ log });
        tradeService = createTradeService({
          db: tradeDb,
          config: next.trade,
          quotes: tradeQuotes,
          botId: client.user.id,
          log,
        });
      } else {
        tradeService = null;
      }
      stopTradeJobs();
      if (tradeService) scheduleTradeJobs();
      writeTradeLimits();
    } else {
      if (!tradeService) initTrade();
      else {
        try {
          tradeService = createTradeService({
            db: tradeDb,
            config: next.trade,
            quotes: tradeQuotes,
            botId: client.user.id,
            log,
          });
          writeTradeLimits();
        } catch (error) {
          tradeService = null;
          log(`模擬股票：套用新設定失敗：${error?.message ?? error}`);
        }
      }
      scheduleTradeJobs();
  }
  }

  return {
    initTrade,
    scheduleTradeJobs,
    stopTradeJobs,
    applyTradeConfig,
    forgetTradeAccount,
    getTradeService: () => tradeService,
    getBotActiveRun: () => botActiveRun,
  };
}
