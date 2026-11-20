// 背景工作：黑話學習、小刻食堂輪詢、回訪排程、每日摘要與側寫。
// 拆自 discord-bridge.js 的 main()；後台提問（runAskJob）與共用回合簿記留入口，
// 由 deps 接回來。slang 與 ceobe 的執行期狀態由模組持有，控制台需要的
// slangDayKey／slangDayCount 走 getter。
import fs from 'node:fs';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { createTurnCollector, unwrap } from '../dsh-client.js';
import { isDeniedUser, isSkippedMessage } from './discord-core.mjs';
import { messageParts, warmMemberCache } from './discord-context.mjs';
import { buildSummaryPrompt, cleanSummary, dayKey, hasSummaryToday, NOTES_PER_CHANNEL, recordNote, SUMMARY_DAYS_DEFAULT, SUMMARY_MAX_CHARS } from './discord-notes.mjs';
import { buildProfilesPrompt, parseProfiles } from './discord-profiles.mjs';
import { profileCandidates, setProfile } from './discord-memory.mjs';
import { buildExtractionPrompt, parseExtractionJson, styleLabels, upsertCandidates } from './discord-slang.mjs';
import {
  CEOBE_POLL_MS,
  ceobeFinishPlan,
  createCeobeNonce,
  dispatchCeobeCookies,
  formatCeobeFallback,
  formatCeobePrompt,
  selectCeobeBatch,
} from './discord-ceobe.mjs';
import { askBlockReason, createAskTurn } from './discord-ask.mjs';
import { resolveMentions } from './discord-batch.mjs';
import { labelEmojiTags } from './discord-emoji.mjs';
import { findSensitive } from './discord-security.mjs';
import { truncateText } from './discord-media.mjs';

export function createBackgroundJobs({
  cfg,
  log,
  api,
  client,
  sessions,
  reverse,
  sessionPresets,
  STATE_DIR,
  ASK_TIMEOUT_MS,
  ASK_CANCEL_FAILED_GRACE_MS,
  ASK_ABANDONED_TTL_MS,
  PRIVATE_ASK_HEADER,
  PRIVATE_TURN_READY_TIMEOUT_MS,
  PRIVATE_TURN_READY_POLL_MS,
  SLANG_WINDOW_MAX,
  SUMMARY_MIN_MESSAGES,
  SUMMARY_MAX_MESSAGES,
  SUMMARY_TRANSCRIPT_CHARS,
  SUMMARY_INTERVAL_MS,
  turnGate,
  ensureSession,
  requirePreset,
  enqueuePrompt,
  epochOf,
  agentSender,
  agentSecrets,
  authorName,
  flat,
  withStickers,
  isChannelAllowed,
  sendLong,
  renameSession,
  resolveChannel,
  quietUntil,
  sleep,
  withTimeout,
  ceobeState,
  ceobeClient,
  channelCache,
  followups,
  ignoredUser,
  memoryStore,
  notesStore,
  slangStore,
  runtime,
  openTurns,
  lastTurns,
  collectors,
  snapshotReady,
  askTurns,
  askAbandonedTurns,
  sessionWaiters,
  botTokenSink,
  rememberLearnerSession,
  rememberSummarySession,
  markMemoryDirty,
  markNotesDirty,
  markSlangDirty,
  triageSlang,
  stopAskSession,
  clearAbandonedTurn,
  pruneArchive,
}) {
  const slangWindows = new Map(); // channelId -> 最近訊息（記憶體 ring buffer）
  const slangQueue = [];
  const slangQueued = new Set();
  let slangRunning = false;
  let slangTimer = null;
  let slangLastRunAt = 0;
  let slangDayKey = '';
  let slangDayCount = 0;
  let backgroundWorkspaceId = null;
  let ceobeSources = null; // { at, list }
  let ceobeComb = { key: '', id: '' };
  let ceobeList = { cookieId: '', cookies: [] };
  let ceobePolling = false;
  let ceobeLastPollAt = 0;
  let ceobeLastError = '';
  let ceobeErrorAt = 0;
  const ceobeSkipLogAt = new Map(); // key -> 上次寫「跳過這個頻道」的時間

  // ── 黑話學習 ─────────────────────────────────────────────────────────────

  function localDayKey(now = Date.now()) {
    const d = new Date(now);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function takeSlangSlot() {
    const day = localDayKey();
    if (day !== slangDayKey) { slangDayKey = day; slangDayCount = 0; }
    if (slangDayCount >= cfg.discord.slang.maxPerDay) return false;
    slangDayCount += 1;
    return true;
  }

  function scheduleSlangTimer(ms) {
    if (slangTimer) return;
    slangTimer = setTimeout(() => {
      slangTimer = null;
      void drainSlangQueue();
    }, Math.max(1000, ms));
    slangTimer.unref?.();
  }

  /**
   * 收集一則語料。允許的伺服器頻道都收（含不給 @everyone 看的、NSFW）：每個詞都要管理員確認才注入，
   * 私密頻道的內容不會自己流到別處。指令、機器人、私聊不收。
   */
  function collectSlangSample(message, text) {
    if (!cfg.discord.slang.enabled || !message?.guildId) return;
    const value = String(text ?? '').trim();
    if (!value || /^[!/]/.test(value)) return;
    // 含本機路徑／憑證特徵的訊息不送進學習會話（也沒有必要學）。
    if (findSensitive(value)) return;

    const channelId = String(message.channelId);
    const window = slangWindows.get(channelId) ?? [];
    if (window.some((sample) => sample.id === message.id)) return;
    window.push({
      id: message.id,
      channelId,
      userId: message.author?.id ?? '',
      author: authorName(message),
      text: truncateText(value, 300),
      at: Number(message.createdTimestamp) || Date.now(),
    });
    if (window.length > SLANG_WINDOW_MAX) window.splice(0, window.length - SLANG_WINDOW_MAX);
    slangWindows.set(channelId, window);

    if (window.length >= cfg.discord.slang.extractMinMessages) {
      scheduleSlangExtraction(message.guildId, channelId);
    }
  }

  function scheduleSlangExtraction(guildId, channelId) {
    if (!cfg.discord.slang.enabled) return;
    if (slangQueued.has(channelId)) return;
    slangQueued.add(channelId);
    slangQueue.push({ guildId: String(guildId), channelId: String(channelId) });
    void drainSlangQueue();
  }
  /**
   * 指令回合的等待：排到閘門最前面時，DSH 可能還在跑別的回合、事件流還沒同步，
   * 或佇列裡有 DSH 後台送進來的訊息。等它乾淨再問，不要叫使用者「再試一次」。
   */
  async function waitForPrivateTurn(key, sessionId, epoch, cancelled) {
    const deadline = Date.now() + PRIVATE_TURN_READY_TIMEOUT_MS;
    let lastError = null;
    while (true) {
      const stopped = cancelled?.();
      if (stopped) throw stopped;
      if (sessions[key] !== sessionId || epochOf(key) !== epoch) throw new Error('會話已重置');
      let queued = 0;
      let error = null;
      if (snapshotReady.has(sessionId)) {
        try {
          queued = await api.pendingPrompts(sessionId, AbortSignal.timeout(8000));
        } catch (caught) {
          error = caught;
        }
      }
      if (!error) {
        const blocked = askBlockReason({
          snapshotReady: snapshotReady.has(sessionId),
          queued,
          gateBusy: false, // 這一輪已經拿到閘門；等的是 DSH 自己跑的其他回合
          collectorActive: collectors.has(sessionId),
          openTurns: openTurns.get(sessionId)?.size ?? 0,
          askActive: askTurns.has(sessionId),
        });
        if (!blocked) return;
      }
      lastError = error ?? lastError;
      if (Date.now() >= deadline) {
        throw new Error(lastError
          ? `等不到空閒的會話（${lastError?.message ?? lastError}）`
          : '等不到空閒的會話（還有回合在跑）');
      }
      await sleep(PRIVATE_TURN_READY_POLL_MS);
    }
  }

  /**
   * /ask 與重載提示進閘門後才開始跑：問答獨佔一輪，頻道訊息壓到問完才送。
   *
   * 回合歸屬、逾時收尾都在 core/discord-ask.mjs；這裡只接 DSH 與 Discord 兩邊。
   * 進閘門後先 mute 再送 prompt：事件流的 turn/start 可能漏掉，不能等看到才擋工具。
   */
  async function runAskJob(key, job, ticket) {
    const {
      question,
      resolve,
      reject,
      header = PRIVATE_ASK_HEADER,
      holdAfterAnswer = false,
    } = job.ask;
    job.ask.ticket = ticket;
    const muteToken = {};
    let settled = false;
    let cancelled = null;
    job.ask.cancel = (error) => { cancelled = error ?? new Error('已取消'); };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const fail = (error) => {
      settle(reject, error);
      agentSender.clearMuted(key, muteToken);
      turnGate.release(key, ticket);
    };
    const stopped = () => cancelled;

    // 排隊期間可能已經 /reset 或重載過；用真正跑起來當下的會話，不要用送單時的。
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      fail(error);
      return;
    }
    if (cancelled) {
      fail(cancelled);
      return;
    }
    const epoch = epochOf(key);
    try {
      await waitForPrivateTurn(key, sessionId, epoch, stopped);
    } catch (error) {
      fail(error);
      return;
    }
    if (cancelled) {
      fail(cancelled);
      return;
    }

    // 先 mute 再送 prompt：事件流的 turn/start 有可能漏掉，等到 onStart 才 mute 會留下工具外洩的窗口。
    agentSender.setMuted(key, muteToken);

    let tracker;
    tracker = createAskTurn({
      baselineTurn: lastTurns.get(sessionId) ?? 0,
      timeoutMs: ASK_TIMEOUT_MS,
      closeGraceMs: 20_000, // 大於 stopSessionWork 的 15 秒，讓取消有機會先完成
      onStart: (_turn, { late }) => {
        agentSender.setMuted(key, muteToken);
        // 逾時後才開始跑的排隊問題：立刻停掉，不要讓它變成公開回合。
        if (late) void stopAskSession(sessionId, tracker);
      },
      onSettle: (result) => {
        if (result.kind === 'answer' && result.text) {
          // 重載提示：拿到摘要後先鎖住佇列，等 retireSession 換完代次再放行後續訊息。
          if (holdAfterAnswer) turnGate.hold(key, ticket);
          settle(resolve, result.text);
        } else if (result.kind === 'answer') {
          settle(reject, new Error('模型沒有輸出文字'));
        } else if (result.kind === 'timeout') {
          settle(reject, new Error(`等不到回答（${ASK_TIMEOUT_MS / 1000} 秒）`));
        } else if (result.kind === 'ended') {
          settle(reject, new Error(`這一輪被中斷（${result.reason?.kind ?? 'unknown'}）`));
        } else {
          settle(reject, result.error ?? new Error('後台提問失敗'));
        }
      },
      onTimeout: () => { void stopAskSession(sessionId, tracker); },
      onClose: ({ turn, ended }) => {
        if (askTurns.get(sessionId) === tracker) askTurns.delete(sessionId);
        if (turn !== null && !ended) {
          // 保底時間到了還沒看到這一輪的 turn/end：不能解除 mute，否則晚到的工具呼叫會公開。
          // 記下來讓公開路徑繼續吞掉它，真的等到 turn/end（或 TTL）才清。
          const entry = { key, muteToken, ticket, timer: null };
          const turns = askAbandonedTurns.get(sessionId) ?? new Map();
          turns.set(turn, entry);
          askAbandonedTurns.set(sessionId, turns);
          entry.timer = setTimeout(() => {
            log(`⚠️ 後台提問的回合 ${turn} 一直沒結束，強制解除保護（${key}）`);
            clearAbandonedTurn(sessionId, turn);
          }, ASK_ABANDONED_TTL_MS);
          entry.timer.unref?.();
          return;
        }
        agentSender.clearMuted(key, muteToken);
        turnGate.release(key, ticket);
      },
    });
    askTurns.set(sessionId, tracker);

    void (async () => {
      try {
        const accepted = await api.sessions.prompt({
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: `${header}\n${question}` }],
        });
        if (!accepted.result?.ok) {
          const error = accepted.result?.error;
          throw new Error(`${error?.code ?? '未知錯誤'}${error?.message ? `：${error.message}` : ''}`);
        }
        if (accepted.result.value?.command) throw new Error('DSH 把問題當成斜線命令，沒有送進模型');
        if (tracker.phase === 'closed') {
          // 回應太慢，waiter 已經收尾：把可能排進去的問題清掉，不能讓它之後才跑成公開回合。
          log(`後台提問回應晚於收尾，清掉 DSH 佇列（${key}）`);
          void stopAskSession(sessionId, tracker);
        }
      } catch (error) {
        // prompt 可能已進 DSH 但回應失敗：先停掉那一輪，再讓 waiter 收尾，不能直接解除 mute。
        void stopAskSession(sessionId, tracker);
        tracker.abort(error, ASK_CANCEL_FAILED_GRACE_MS);
      }
    })();
  }

  /**
   * 背景會話：建一個獨立 session、只收文字、結束就歸檔。
   * 黑話抽取、每日摘要與 Bot 交易共用；preset 預設是 dc.slang.learnerPreset。
   *
   * registerKey：Bot 交易要讓工具端用得到會話令牌，會暫時登記進 sessions/reverse，
   * 回合結束就移除；一般背景整理不登記。
   */
  async function runBackgroundPrompt({
    prompt, timeoutMs, label, title, key = null, usageKind = 'learner',
    preset = cfg.discord.slang.learnerPreset, registerKey = null, onSession = null,
  }) {
    await requirePreset(preset);

    if (!backgroundWorkspaceId) {
      const dir = cfg.discord.sessionDir || path.join(STATE_DIR, 'discord-agents');
      fs.mkdirSync(dir, { recursive: true });
      const workspace = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
      backgroundWorkspaceId = workspace.workspace.workspaceId;
    }
    const created = unwrap(await api.sessions.create({
      workspaceId: backgroundWorkspaceId,
      agentPreset: preset,
    }), 'session.create');
    const sessionId = created.sessionId;
    if (usageKind === 'summary') rememberSummarySession(sessionId);
    else if (usageKind === 'learner') rememberLearnerSession(sessionId);
    await renameSession(sessionId, key, title);
    if (registerKey) {
      sessions[registerKey] = sessionId;
      reverse.set(sessionId, registerKey);
      // 一次性會話只活在記憶體；控制台看得到時要顯示正確 preset。
      sessionPresets[sessionId] = preset;
    }
    onSession?.(sessionId);

    try {
      // 背景整理不需要深度推理；模型不支援 low 時沿用預設，不讓整個工作失敗。
      try {
        unwrap(await api.sessions.selectModel({
          sessionId,
          provider: cfg.dsh.provider,
          model: cfg.dsh.model,
          reasoningEffort: 'low',
        }), 'session.selectModel');
      } catch (error) {
        log(`${label}：選模型失敗（沿用預設）：${error?.message ?? error}`);
      }
      api.events.follow(sessionId);

      const collector = createTurnCollector();
      let settled = false;
      let timer = null;
      const ended = new Promise((resolve, reject) => {
        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          sessionWaiters.delete(sessionId);
          fn(value);
        };
        timer = setTimeout(() => settle(reject, new Error(`${label}回合逾時`)), timeoutMs);
        timer.unref?.();
        sessionWaiters.set(sessionId, {
          collector,
          started: false,
          finish: (result) => settle(resolve, result),
          fail: (error) => settle(reject, error),
        });
      });
      // 真正的等待在下面；先掛一個 handler，避免收尾時變成 unhandledRejection。
      ended.catch(() => {});

      const accepted = await api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      });
      if (!accepted.result?.ok) {
        const error = accepted.result?.error;
        throw new Error(`${error?.code ?? '未知錯誤'}${error?.message ? `：${error.message}` : ''}`);
      }
      const result = await ended;
      if (result.reason?.kind !== 'completed') {
        throw new Error(`${label}回合結束於 ${result.reason?.kind ?? 'unknown'}`);
      }
      return result.text;
    } finally {
      sessionWaiters.get(sessionId)?.fail(new Error(`${label}回合收尾`));
      // 背景會話結束就不再回頭，跟 /reset 用同一份清理清單，不要在這裡手寫第二份。
      runtime.forgetSession(sessionId);
      botTokenSink.delete(sessionId);
      if (registerKey) {
        if (sessions[registerKey] === sessionId) delete sessions[registerKey];
        if (reverse.get(sessionId) === registerKey) reverse.delete(sessionId);
        delete sessionPresets[sessionId];
        agentSender.forget(sessionId);
      }
      try { await withTimeout(api.stopSessionWork(sessionId), 15_000, 'stopSessionWork'); } catch { /* 已結束 */ }
      try { await withTimeout(api.workspace.archiveSession({ sessionId }), 15_000, 'archiveSession'); } catch { /* 已歸檔 */ }
    }
  }

  async function runSlangExtraction(samples, labels) {
    const text = await runBackgroundPrompt({
      prompt: buildExtractionPrompt(samples, { styleLabels: labels }),
      timeoutMs: cfg.discord.slang.timeoutMs,
      label: '黑話學習',
      title: 'Discord 黑話學習',
    });
    return parseExtractionJson(text, { max: 5 });
  }

  // ── 小刻食堂（餅） ────────────────────────────────────────────────────────
  // 橋接自己輪詢，不是讓模型拉：模型只要在頻道會話裡把餅轉述出去。
  let ceobeTimer = null;

  function ceobeSkip(key, message) {
    const now = Date.now();
    if (now - (ceobeSkipLogAt.get(key) ?? 0) < 60 * 60_000) return;
    ceobeSkipLogAt.set(key, now);
    log(`餅：${message}（${key}）`);
  }

  async function ensureCeobeSources({ refresh = false } = {}) {
    const cached = ceobeSources && Date.now() - ceobeSources.at < 24 * 60 * 60_000;
    if (!refresh && cached) return ceobeSources.list;
    const list = await ceobeClient.listSources();
    ceobeSources = { at: Date.now(), list };
    return list;
  }

  /** 餅回合的收尾：補連結，或模型完全沒送時發保底。回傳橋接自己補了幾則。 */
  async function finishCeobeTurn(key, ceobeMeta, sentTexts, sentCount) {
    if (quietUntil(key)) {
      log(`餅：安靜中，略過收尾（${key}）`);
      return 0;
    }
    const plan = ceobeFinishPlan({ sentCount, sentTexts, urls: ceobeMeta?.urls ?? [] });
    if (plan.fallback) {
      if (!ceobeMeta?.fallback) return 0;
      try {
        await sendLong(key, ceobeMeta.fallback);
        return 1;
      } catch (error) {
        log(`餅：保底訊息送出失敗（${key}）：${error?.message ?? error}`);
        return 0;
      }
    }
    if (plan.missing.length === 0) return 0;
    try {
      await sendLong(key, plan.missing.map((url) => `-# 原文：${url}`).join('\n'));
      return 1;
    } catch (error) {
      log(`餅：補原文連結失敗（${key}）：${error?.message ?? error}`);
      return 0;
    }
  }

  async function pollCeobe() {
    const conf = cfg.discord.ceobe;
    if (!conf.enabled || ceobePolling) return;
    const channels = Object.entries(conf.channels);
    if (channels.length === 0) return;
    ceobePolling = true;
    try {
      const sources = await ensureCeobeSources();
      // 控制台存檔會換掉整個 ceobe 物件；中途改設定就放棄這一輪，避免用舊的清單投遞。
      const stale = () => cfg.discord.ceobe !== conf;
      if (stale()) return;
      const sourceByUniqueId = new Map(sources.map((source) => [String(source.unique_id), source]));
      // 只把有訂閱的來源放進組合：上游回來的列表才不會被沒訂閱的資料源擠到第二頁。
      const union = [...new Set(channels.flatMap(([, sourceIds]) => sourceIds))].sort();
      const combKey = union.join(',');
      if (!ceobeComb.id || ceobeComb.key !== combKey) {
        ceobeComb = { key: combKey, id: await ceobeClient.getCombId(union) };
        if (stale()) return;
      }
      let latest;
      try {
        latest = await ceobeClient.getLatestCookieId(ceobeComb.id);
      } catch (error) {
        // comb id 過期或暫時讀不到：下一次重新算一組再試。
        ceobeComb = { key: '', id: '' };
        throw error;
      }
      if (stale()) return;
      if (!latest) throw new Error('小刻食堂沒有回傳 cookie id');
      if (latest !== ceobeList.cookieId) {
        // 列表留在記憶體：重啟後抓一次，靠 seen 去重，不用多存一個 cookie id。
        ceobeList = { cookieId: latest, cookies: await ceobeClient.getCookies(ceobeComb.id, latest) };
        if (stale()) return;
      }
      const { byChannel } = dispatchCeobeCookies(ceobeList.cookies, { channels: conf.channels, sources });
      const now = Date.now();
      for (const [channelId, sourceIds] of channels) {
        if (stale()) break;
        // 新的（頻道, 來源）先建水位；這一輪不送，下一輪才開始算新餅。
        for (const sourceId of sourceIds) ceobeState.ensurePair(channelId, sourceId);
        const items = byChannel.get(channelId) ?? [];
        if (items.length === 0) continue;
        const { take, expired } = selectCeobeBatch({ items, channelId, state: ceobeState, now });
        if (expired.length > 0) ceobeState.markSeen(channelId, expired.map((key) => ({ key, at: now })));
        if (take.length === 0) continue;
        const key = `ch:${channelId}`;
        if (quietUntil(key)) continue;
        let channel;
        try {
          // 不用 resolveChannel 的快取：頻道刪掉後快取還留著，會一直投給不存在的頻道。
          channel = await client.channels.fetch(channelId);
          channelCache.set(key, channel);
        } catch (error) {
          ceobeSkip(key, `找不到頻道：${error?.message ?? error}`);
          continue;
        }
        if (!channel?.isTextBased?.()) {
          ceobeSkip(key, '不是文字頻道');
          continue;
        }
        if (!isChannelAllowed(key, channel)) {
          ceobeSkip(key, '不在白名單');
          continue;
        }
        const permissions = channel.permissionsFor?.(client.user);
        // 討論串看的是 SendMessagesInThreads，不是 SendMessages。
        const sendPermission = channel.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
        if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(sendPermission)) {
          ceobeSkip(key, '沒有查看或傳送訊息的權限');
          continue;
        }
        // 抓頻道是 async，期間可能有人設了安靜或改了設定。
        if (stale()) break;
        if (quietUntil(key)) continue;
        const promptItems = take.map(({ cookie, uniqueId }) => ({ cookie, uniqueId }));
        const { text, urls } = formatCeobePrompt({
          items: promptItems,
          sourceByUniqueId,
          nonce: createCeobeNonce(),
        });
        const fallback = formatCeobeFallback(take.map(({ cookie, uniqueId }) => ({
          cookie,
          uniqueId,
          source: sourceByUniqueId.get(uniqueId),
        })));
        enqueuePrompt(key, {
          channel,
          guildId: channel.guildId ?? null,
          entries: [],
          direct: false,
          system: true,
          epoch: epochOf(key),
          text,
          ceobe: { urls, fallback },
        });
        // at-most-once：排進閘門就標已讀。之後 /reset 或 DSH 掛掉丟掉這一輪，寧可漏也不要重複。
        ceobeState.markSeen(channelId, take.map(({ seenKey }) => ({ key: seenKey, at: now })));
        log(`已投遞餅 ${key}（${take.length} 則）`);
      }
    } catch (error) {
      ceobeLastError = String(error?.message ?? error);
      if (Date.now() - ceobeErrorAt > 10 * 60_000) {
        ceobeErrorAt = Date.now();
        log(`小刻食堂輪詢失敗：${ceobeLastError}`);
      }
    } finally {
      ceobePolling = false;
      ceobeLastPollAt = Date.now();
    }
  }

  function scheduleCeobeCheck(delay = 15_000) {
    if (ceobeTimer) return;
    setTimeout(() => { void pollCeobe(); }, delay).unref?.();
    ceobeTimer = setInterval(() => { void pollCeobe(); }, CEOBE_POLL_MS);
    ceobeTimer.unref?.();
  }

  async function ceobeInfo({ refresh = false } = {}) {
    let sources = [];
    let sourceError = '';
    try {
      sources = await ensureCeobeSources({ refresh });
    } catch (error) {
      sourceError = String(error?.message ?? error);
    }
    return {
      sources: sources.map((source) => ({
        unique_id: String(source.unique_id ?? ''),
        nickname: String(source.nickname ?? ''),
        platform: String(source.platform ?? ''),
        datasource: String(source.datasource ?? ''),
        avatar: String(source.avatar ?? ''),
        jump_url: String(source.jump_url ?? ''),
      })),
      sourceError,
      status: {
        enabled: cfg.discord.ceobe.enabled,
        polling: ceobePolling,
        lastPollAt: ceobeLastPollAt || null,
        lastError: ceobeLastError,
        sourcesCachedAt: ceobeSources?.at ?? null,
        cookieId: ceobeList.cookieId || null,
        cookies: ceobeList.cookies.length,
      },
    };
  }

  // ── 回訪（工作包 I） ──────────────────────────────────────────────────────
  // 時間到了只送一個【回訪】提示；模型自己決定要不要說話，跟一般批次一樣走閘門。
  let followupTimer = null;

  function scheduleFollowupCheck() {
    if (followupTimer) return;
    followupTimer = setInterval(() => { void runFollowups(); }, 60_000);
    followupTimer.unref?.();
  }

  async function runFollowups() {
    if (!cfg.discord.followup.enabled) return;
    for (const entry of followups.due()) {
      // 沒有會話就沒得回訪，直接丟掉；安靜或回合還在跑就先留著，下一分鐘再看。
      if (!sessions[entry.key]) { followups.remove(entry.id); continue; }
      if (quietUntil(entry.key) || turnGate.isBusy(entry.key)) continue;
      let channel;
      try {
        channel = await resolveChannel(entry.key);
      } catch (error) {
        // 頻道被刪、bot 被踢：留著只會每分鐘重試，直接丟掉。
        followups.remove(entry.id);
        log(`回訪失敗，放棄（${entry.key}）：${error?.message ?? error}`);
        continue;
      }
      // 抓頻道是 async，期間可能開始了新回合、或 /reset 取消了這個回訪；
      // 這裡到 enqueuePrompt 之間不能再 await。
      if (turnGate.isBusy(entry.key) || !followups.remove(entry.id)) continue;
      enqueuePrompt(entry.key, {
        channel,
        guildId: channel.guildId ?? null,
        entries: [],
        direct: false,
        epoch: epochOf(entry.key),
        followup: entry,
      });
    }
  }

  // ── 每日頻道摘要（v2） ───────────────────────────────────────────────────
  let summaryTimer = null;
  let summaryRunning = false;
  const summaryTried = new Set(); // `${key}:${day}`：今天試過就不再重試，避免失敗一直燒 token

  function summaryDue(now = Date.now()) {
    const conf = cfg.discord.notes;
    return conf.enabled && conf.dailySummary.enabled && new Date(now).getHours() >= conf.dailySummary.hour;
  }

  function scheduleSummaryCheck(delay = 60_000) {
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => {
      summaryTimer = null;
      // 兩件事共用同一個背景工作區：依序跑，避免重啟後同時建兩次 workspace。
      void (async () => {
        await runDailySummaries();
        await runDailyProfiles();
        await pruneArchive();
      })()
        .catch((error) => log(`每日背景工作失敗：${error?.message ?? error}`))
        .finally(() => scheduleSummaryCheck(SUMMARY_INTERVAL_MS));
    }, delay);
    summaryTimer.unref?.();
  }

  async function runDailySummaries() {
    if (summaryRunning || !summaryDue()) return;
    summaryRunning = true;
    try {
      for (const key of Object.keys(sessions)) {
        if (!key.startsWith('ch:')) continue;
        const marker = `${key}:${dayKey()}`;
        if (summaryTried.has(marker)) continue;
        let channel;
        try { channel = await resolveChannel(key); } catch { continue; }
        if (!channel || !isChannelAllowed(key, channel)) continue;
        if (hasSummaryToday(notesStore, { channelId: channel.id })) continue;
        summaryTried.add(marker);
        try {
          const fetched = await channel.messages.fetch({ limit: SUMMARY_MAX_MESSAGES, cache: false });
          const since = Date.now() - 24 * 60 * 60 * 1000;
          const transcript = [...fetched.values()]
            .filter((message) => message.createdTimestamp >= since)
            .filter((message) => !isDeniedUser(cfg.discord, message.author?.id))
            .filter((message) => !ignoredUser(message.author?.id))
            .filter((message) => message.author?.bot || !isSkippedMessage(message.content, client.user.id));
          // 摘要是 REST 抓的，重啟後補成員才不會把同一個人寫成兩個名字；只補抓真的會進摘要的人。
          await warmMemberCache(channel.guild, transcript);
          const messages = transcript
            .map((message) => ({
              at: message.createdTimestamp,
              author: `${authorName(message)}${message.author?.id === client.user.id ? '（你）' : ''}`,
              text: flat(labelEmojiTags(resolveMentions(withStickers(message), message), null), 300) || (messageParts(message).hasImage ? '[圖片]' : ''),
            }))
            .filter((message) => message.text);
          if (messages.length < SUMMARY_MIN_MESSAGES) continue;
          const summary = cleanSummary(await runBackgroundPrompt({
            prompt: buildSummaryPrompt({
              channelName: channel.name,
              messages,
              maxChars: SUMMARY_TRANSCRIPT_CHARS,
            }),
            timeoutMs: cfg.discord.slang.timeoutMs,
            label: '頻道摘要',
            title: `Discord #${channel.name ?? '頻道'}｜頻道摘要`,
            usageKind: 'summary',
          }));
          if (!summary) {
            log(`頻道摘要 ${key}：沒有明顯重點，跳過`);
            continue;
          }
          if (cfg.discord.security.blockSensitive && findSensitive(summary, agentSecrets())) {
            log(`頻道摘要 ${key}：命中敏感資訊閘門，跳過`);
            continue;
          }
          recordNote(notesStore, {
            guildId: channel.guildId,
            channelId: channel.id,
            text: summary,
            by: 'summary',
            days: SUMMARY_DAYS_DEFAULT,
            maxChars: SUMMARY_MAX_CHARS,
            maxPerChannel: NOTES_PER_CHANNEL,
          });
          markNotesDirty();
          log(`頻道摘要 ${key}：已寫入筆記（${summary.length} 字）`);
        } catch (error) {
          log(`頻道摘要 ${key} 失敗：${error?.message ?? error}`);
        }
      }
    } finally {
      summaryRunning = false;
    }
  }

  // ── 群友側寫（每天一次） ──────────────────────────────────────────────
  // 事實夠多的人才有側寫：兩條事實換句話說沒有意義。一天最多一輪，跟每日摘要共用小時設定。
  let profileRunning = false;
  const profileTried = new Set();

  async function runDailyProfiles(now = Date.now()) {
    if (profileRunning || !cfg.discord.memory.enabled || !cfg.discord.memory.profiles) return;
    if (new Date(now).getHours() < cfg.discord.notes.dailySummary.hour) return;
    const marker = dayKey(now);
    if (profileTried.has(marker)) return;
    const candidates = profileCandidates(memoryStore, {
      now,
      exclude: (userId) => isDeniedUser(cfg.discord, userId) || ignoredUser(userId),
    });
    if (!candidates.length) return;
    profileTried.add(marker);
    profileRunning = true;
    try {
      const text = await runBackgroundPrompt({
        prompt: buildProfilesPrompt(candidates),
        timeoutMs: cfg.discord.slang.timeoutMs,
        label: '群友側寫',
        title: 'Discord｜群友側寫',
        usageKind: 'summary',
      });
      // 只認這次送出的候選：模型被注入時不能替別人寫側寫。
      const byId = new Map(candidates.map((entry) => [entry.userId, entry]));
      let changed = 0;
      for (const { userId, profile } of parseProfiles(text, { allowed: new Set(byId.keys()) })) {
        if (cfg.discord.security.blockSensitive && findSensitive(profile, agentSecrets())) {
          log(`群友側寫：${userId} 命中敏感資訊閘門，跳過`);
          continue;
        }
        // 產生期間事實又被改、或本人 /forget 後 entry 重建：不要用舊事實的側寫蓋上去。
        if (setProfile(memoryStore, {
          userId,
          profile,
          now: Date.now(),
          expectUpdatedAt: byId.get(userId)?.updatedAt,
        })) changed += 1;
      }
      if (changed) markMemoryDirty();
      log(`群友側寫：更新 ${changed}/${candidates.length} 人`);
    } catch (error) {
      log(`群友側寫失敗：${error?.message ?? error}`);
    } finally {
      profileRunning = false;
    }
  }

  async function drainSlangQueue() {
    if (slangRunning || slangQueue.length === 0) return;
    slangRunning = true;
    try {
      while (slangQueue.length > 0) {
        const conf = cfg.discord.slang;
        const wait = slangLastRunAt + conf.extractCooldownMs - Date.now();
        if (wait > 0) {
          scheduleSlangTimer(wait);
          return;
        }
        const job = slangQueue[0];
        const window = slangWindows.get(job.channelId) ?? [];
        if (window.length < conf.extractMinMessages) {
          slangQueue.shift();
          slangQueued.delete(job.channelId);
          continue;
        }
        if (!takeSlangSlot()) {
          slangQueue.length = 0;
          slangQueued.clear();
          log('黑話學習已達每日上限，今天不再抽取');
          return;
        }
        slangQueue.shift();
        slangQueued.delete(job.channelId);

        const samples = window.slice(-Math.max(conf.extractMinMessages, 40));
        let items;
        try {
          items = await runSlangExtraction(samples, styleLabels(slangStore, job.channelId));
        } catch (error) {
          // 失敗也吃冷卻：避免 DSH 出問題時每則訊息都重試、燒 token。
          slangLastRunAt = Date.now();
          log(`黑話學習失敗（${job.channelId}）：${error?.message ?? error}`);
          continue;
        }
        slangLastRunAt = Date.now();

        const stats = upsertCandidates(slangStore, { guildId: job.guildId, channelId: job.channelId, items, samples });
        const processed = new Set(samples.map((sample) => sample.id));
        const rest = (slangWindows.get(job.channelId) ?? []).filter((sample) => !processed.has(sample.id));
        if (rest.length > 0) slangWindows.set(job.channelId, rest);
        else slangWindows.delete(job.channelId);

        if (stats.added > 0 || stats.updated > 0) {
          markSlangDirty();
          log(`黑話學習：新增 ${stats.added}、更新 ${stats.updated}（${job.channelId}）`);
        } else {
          log(`黑話學習：這次沒有新詞（${job.channelId}）`);
        }
        // 只判這次新增的詞；重複出現的詞不重判，免得 log 一直長、同一個詞反覆改狀態。
        if (stats.addedIds.length) {
          void triageSlang(stats.addedIds, job).catch((error) => log(`黑話 Jev：${error?.message ?? error}`));
        }
      }
    } finally {
      slangRunning = false;
    }
  }
return {
    finishCeobeTurn,
    collectSlangSample,
    ceobeInfo,
    runBackgroundPrompt,
    runAskJob,
    scheduleSummaryCheck,
    scheduleFollowupCheck,
    scheduleCeobeCheck,
    localDayKey,
    getSlangDayKey: () => slangDayKey,
    getSlangDayCount: () => slangDayCount,
  };
}
