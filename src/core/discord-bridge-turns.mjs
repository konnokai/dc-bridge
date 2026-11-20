// 回合層：提問與審批、事件流、自動壓縮、TTFT。
//
// 這一段是「DSH 問問題／要審批 → 貼到頻道 → 等人回答 → 回覆 DSH」，加上事件流本身。
// 只有它會碰 pending 這個 Map，所以搬出來仍然只有一個寫入者。
import { canAnswerPending, describeToolCall, isChattyChannel, isSilentMessage, isSkippedMessage, parseApprovalAnswer, questionAnswersFor, questionAudience, requireMentionForChannel, shouldAutoCompact } from './discord-core.mjs';
import { formatMemoryBlock, pruneStaleGuesses } from './discord-memory.mjs';
import { formatNotesBlock, pruneNotes } from './discord-notes.mjs';
import { formatKnowledgeBlock } from './discord-knowledge.mjs';
import { memeHint } from './discord-memes.mjs';
import { buildSlangHint, buildStyleHint, onceInSession } from './discord-slang.mjs';
import { buildEmojiHint, buildEmojiIndex, labelEmojiTags, retrieveEmojis } from './discord-emoji.mjs';
import { OPENING_HINT, embedIsSensitive, formatBlacklistStatus, formatQuote, formatRecentContext, formatTimeContext, guildBlacklistNames, messageParts, referencedMessage, replyTargetId, warmMemberCache } from './discord-context.mjs';
import { formatActivityLine } from './discord-activity.mjs';
import { formatBatch, formatParticipationHint, imageRefTag, isBotNamed, isMediaOnlyBatch, repliedName, resolveMentions, shouldYield, triggerUsers } from './discord-batch.mjs';
import { formatFollowupDelay, formatFollowupPrompt, formatFollowupStatus } from './discord-followup.mjs';
import { formatReactionInbox } from './discord-feedback.mjs';
import { formatQuietUntil, isQuietBatchSkipped } from './discord-quiet.mjs';
import { describeSkipped, embedImages, fetchDiscordMedia, prepareMediaBlock } from './discord-media.mjs';
import { formatReloadSummary, peekReloadSummary, takeReloadSummary } from './discord-reload.mjs';

const MEMORY_USERS_PER_BATCH = 5; // 一批最多帶幾個人的群友記憶
const MEMORY_REFRESH_MS = 30 * 60 * 1000; // 同一會話隔這麼久再帶一次（DSH 可能已經壓縮掉了）

export function createTurns(deps) {
  const {
    api,
    log,
    pending,
    cfg,
    sendLong,
    reverse,
    askTurns,
    askAbandonedTurns,
    turnUsers,
    ASK_CANCEL_FAILED_GRACE_MS,
    DSH_COMMAND_TIMEOUT_MS,
    createTurnCollector,
    unwrap,
    findSensitive,
    sessions,
    sleep,
    turnsFromRecords,
    NO_TOOL_REMINDER,
    NO_TOOL_REMINDER_MS,
    addProgress,
    agentSecrets,
    agentSender,
    botTokenSink,
    clearAbandonedTurn,
    defaultDirect,
    epochOf,
    finishCeobeTurn,
    finishProgress,
    hideCompactNotice,
    lastActive,
    markTurnEnded,
    markTurnOpen,
    progress,
    quietUntil,
    resolveChannel,
    sessionWaiters,
    showCompactNotice,
    startProgress,
    startTyping,
    stopAskSession,
    stopTyping,
    syncHedgeSettings,
    usage,
    writeTurn,
    collectors,
    compactNotices,
    devFeedbackEdits,
    devFeedbackWrites,
    emojiShown,
    knowledgeWrites,
    lastTurns,
    memeSaves,
    memoryWrites,
    noToolRemindedAt,
    noteWrites,
    openTurns,
    pendingDirect,
    pendingDirectMessages,
    pendingLastMessages,
    pendingUsers,
    sandboxRuns,
    slangWrites,
    snapshotReady,
    ttftAbandonedTurns,
    ttftTimeouts,
    ttftTimers,
    turnDirect,
    turnDirectMessages,
    turnFollowupHeld,
    turnFollowupTaken,
    turnLastMessage,
    turnMeta,
    turnSentTexts,
    turnStartedAt,
    turnTickets,
    turnTools,
    turnTriggerRecorded,
    turnTtftMs,
    typingTimers,
    voicePerTurn,
    turnGate,
    YIELD_GATE_SHADOW,
    activity,
    authorName,
    client,
    collectSlangSample,
    embedPreview,
    getEmojiCatalogs,
    emojiUsage,
    getEnsureSession,
    flat,
    followups,
    ignoredUser,
    knowledgeStore,
    markMemoryDirty,
    markNotesDirty,
    memeStore,
    memoryStore,
    messageRefs,
    notesStore,
    reactionInbox,
    reactionLastAt,
    reactionTimes,
    refreshEmojiCatalogs,
    reloadStore,
    saveReloadStore,
    slangStore,
    triggerStore,
    withStickers,
    memoryShown,
    notesShown,
    knowledgeShown,
    slangShown,
    primedKeys,
    silentPending,
    botLastByUser,
    recentHumans,
    offlineQueue,
    offlineHintAt,
    needsOpening,
  } = deps;

  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      await api.respond({
        clientId: entry.clientId,
        eventId: entry.eventId,
        outcome: {
          kind: 'result',
          value: entry.kind === 'approval' ? 'rejected' : { answers: [] },
        },
      });
    } catch (error) {
      log(`取消掛起請求失敗：${error?.message ?? error}`);
    }
  }

  function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      void cancelPendingEntry(existing);
    }
    const timer = setTimeout(() => {
      if (pending.get(key) !== entry) return;
      pending.delete(key);
      void cancelPendingEntry(entry);
      sendLong(key, '⏰ 等待回答逾時，已取消這個請求').catch(() => {});
    }, cfg.discord.questionTimeoutMs);
    timer.unref?.();
    entry.timer = timer;
    pending.set(key, entry);
  }

  async function answerPending(p, text, key, isOwner, userId) {
    if (!canAnswerPending({ kind: p.kind, isOwner, userId, askedUserIds: p.askedUserIds })) return false;
    if (p.kind === 'question') {
      try {
        await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers: questionAnswersFor(p.questions, text) } },
        });
        if (pending.get(key) === p) {
          clearTimeout(p.timer);
          pending.delete(key);
        }
      } catch (error) {
        log(`回答提問失敗（保留掛起以便重試）：${error?.message ?? error}`);
        await sendLong(key, '⚠️ 回答送出失敗，請再回一次。');
      }
      return true;
    }

    const outcome = parseApprovalAnswer(text);
    if (!outcome) {
      await sendLong(key, '請回覆「通過」或「拒絕」來決定這個審批。');
      return true;
    }
    try {
      await api.respond({ clientId: p.clientId, eventId: p.eventId, outcome: { kind: 'result', value: outcome } });
      if (pending.get(key) === p) {
        clearTimeout(p.timer);
        pending.delete(key);
      }
      await sendLong(key, outcome === 'allowed-once' ? '✅ 已通過審批' : '❌ 已拒絕審批');
    } catch (error) {
      log(`送出審批失敗（保留掛起以便重試）：${error?.message ?? error}`);
      await sendLong(key, '⚠️ 審批送出失敗，請再回一次「通過」或「拒絕」。');
    }
    return true;
  }

  // ── 事件流 ───────────────────────────────────────────────────────────────

  async function handleQuestion(frame) {
    const key = reverse.get(frame.sessionId);
    // 後台提問進行中：提問不能貼到頻道，直接取消，模型改回文字。
    // 寧可錯擋別的回合一次，也不要把私人回合的問題貼出去。
    const ask = askTurns.get(frame.sessionId);
    if (!key || ask || askAbandonedTurns.get(frame.sessionId)?.size) {
      await cancelPendingEntry({ kind: 'question', clientId: frame.clientId, eventId: frame.eventId });
      return;
    }
    const askedUserIds = questionAudience(turnUsers.get(key));
    // 排程回訪、重連補建的回合沒有觸發者：貼出去只會卡到逾時，直接回空答案讓模型繼續。
    if (!askedUserIds.length) {
      log(`提問沒有可回答的觸發者，直接取消（${key}）`);
      await cancelPendingEntry({ kind: 'question', clientId: frame.clientId, eventId: frame.eventId });
      return;
    }
    const lines = (frame.questions ?? []).map((q, i) => {
      const text = `${i + 1}. ${String(q.question ?? '')}`;
      const options = q.options ?? [];
      return options.length ? `${text}\n   ${options.map((o) => `「${String(o.label ?? '')}」`).join(' ')}` : text;
    });
    registerPending(key, {
      kind: 'question',
      clientId: frame.clientId,
      eventId: frame.eventId,
      questions: frame.questions ?? [],
      // 只讓這一輪叫 bot 的人回答。
      askedUserIds,
    });
    // 先掛起再送出：送出失敗時至少還有一條逾時路徑會取消，不會讓 DSH 一直等。
    try {
      // 頻道裡只有叫 bot 的訊息才算回答（見 handleMessage），提示要講清楚，不然答案會被當成閒聊。
      // sendLong 關了 mention 解析，所以用名字點名，不用 <@id>。
      const names = [...new Set((turnUsers.get(key) ?? [])
        .map((user) => String(user?.name ?? '').trim()).filter(Boolean))];
      const how = key.startsWith('dm:')
        ? '直接回覆'
        : `${names.length ? `${names.join('、')} ` : ''}請 @我或回覆這則訊息`;
      await sendLong(key, `❓ agent 需要你回答：\n${lines.join('\n')}\n（${how}，寫選項文字或你的回答）`);
    } catch (error) {
      log(`送出提問失敗 (${key})：${error?.message ?? error}`);
    }
  }

  async function handleApproval(frame) {
    const key = reverse.get(frame.sessionId);
    // 後台提問進行中：審批同樣不能公開；這一輪的工具動作本來就全部封鎖。
    const ask = askTurns.get(frame.sessionId);
    if (!key || ask || askAbandonedTurns.get(frame.sessionId)?.size) {
      await cancelPendingEntry({ kind: 'approval', clientId: frame.clientId, eventId: frame.eventId });
      return;
    }
    const reason = String(frame.reason ?? '');
    registerPending(key, { kind: 'approval', clientId: frame.clientId, eventId: frame.eventId });
    try {
      await sendLong(key, `🔐 agent 請求審批：${String(frame.toolName ?? '未知工具')}${reason ? `\n理由：${reason}` : ''}\n回覆「通過」或「拒絕」`);
    } catch (error) {
      log(`送出審批請求失敗 (${key})：${error?.message ?? error}`);
    }
  }

  // 自動壓縮與 TTFT：要 turnGate，用 late 晚綁定（它在入口比較晚建立）。
  const contextTokens = new Map(); // sessionId -> 上一次請求的 totalTokens

  async function autoCompact(key, sessionId, ticket) {
    log(`自動壓縮 ${key}（context ${contextTokens.get(sessionId)} token，門檻 ${cfg.discord.autoCompactTokens}）`);
    try {
      // 走 commands/execute 才會真的執行 /compact；直接 prompt 只會變成一則使用者訊息。
      const accepted = await api.commands.execute({
        agentId: sessionId,
        line: '/compact',
        submittedAttachments: [],
      }, AbortSignal.timeout(DSH_COMMAND_TIMEOUT_MS));
      const result = unwrap(accepted, 'commands.execute');
      const outcome = result?.result;
      log(`自動壓縮結果 ${key}：${outcome?.kind === 'success'
        ? (outcome.text ?? '完成')
        : (outcome?.text ?? 'DSH 沒有 /compact 指令')}`);
    } catch (error) {
      log(`自動壓縮失敗 ${key}：${error?.message ?? error}`);
    } finally {
      contextTokens.delete(sessionId);
      // 壓縮最多等 180 秒，5 分鐘保險絲可能已經放掉這一輪、下一批也出發了；只放自己那一張票。
      // 沒有票時就不碰閘門：那代表這一輪本來就不屬於橋接排的批次。
      if (ticket !== undefined) turnGate.releaseNormal(key, ticket);
    }
  }

  /**
   * 等第一個 token 的計時器。只從 turn/start 開始算，而且是橋接自己排進去的批次；
   * 壓縮指令不會開回合，不會走到這裡。收到 assistant/first-token（DSH 串流第一個 chunk）、
   * assistant/message 或 tool/call 就停錶：模型已經開始輸出或跑工具，後面多久都不歸這個機制管。
   */
  function clearTtftTimer(sessionId) {
    const entry = ttftTimers.get(sessionId);
    if (!entry) return;
    entry.done = true;
    clearTimeout(entry.timer);
    ttftTimers.delete(sessionId);
  }

  function clearAllTtftTimers() {
    for (const entry of ttftTimers.values()) {
      entry.done = true;
      clearTimeout(entry.timer);
    }
    ttftTimers.clear();
    ttftTimeouts.clear();
    ttftAbandonedTurns.clear();
  }

  function armTtftTimer(key, sessionId, turn) {
    clearTtftTimer(sessionId);
    const timeoutMs = cfg.discord.ttftTimeoutMs;
    if (!timeoutMs) return;
    const entry = { key, done: false, startedAt: Date.now(), timer: null };
    entry.timer = setTimeout(() => {
      if (entry.done) return;
      entry.done = true;
      ttftTimers.delete(sessionId);
      if (sessions[key] !== sessionId) return;
      log(`TTFT 超過 ${Math.round(timeoutMs / 1000)} 秒，取消本輪（${key}）`);
      ttftTimeouts.set(key, timeoutMs);
      let releaseTimer = null;
      void api.cancelSession(sessionId).catch((error) => {
        ttftTimeouts.delete(key);
        if (releaseTimer) clearTimeout(releaseTimer);
        // 取消失敗時不要放行 gate：回合多半還在跑，放行會讓兩批重疊。
        // 真的卡住還有 turnGate 的 5 分鐘保險絲。
        log(`取消超時回合失敗（${key}）：${error?.message ?? error}`);
      });
      // 取消成功但 DSH 沒送 turn/end 時，別讓頻道卡到 5 分鐘保險絲。
      // 一定要確認還是同一個 session、而且這次超時還沒被 turn/start／reset／斷線清掉；
      // 否則會放到下一個回合的 gate。
      releaseTimer = setTimeout(() => {
        if (sessions[key] !== sessionId || !ttftTimeouts.has(key)) return;
        ttftTimeouts.delete(key);
        log(`取消後等不到 turn/end，先放行（${key}）`);
        if (turn !== undefined && turn !== null) {
          const abandoned = ttftAbandonedTurns.get(key) ?? new Set();
          abandoned.add(turn);
          ttftAbandonedTurns.set(key, abandoned);
        }
        collectors.delete(sessionId);
        turnMeta.delete(key);
        turnTools.delete(key);
        turnTtftMs.delete(key);
        stopTyping(key);
        finishProgress(key);
        // 這一輪的票先取出來：遲到的 turn/end 走 abandoned 分支，不會再碰 gate。
        turnGate.releaseNormal(key, turnTickets.get(key)?.ticket ?? turnGate.currentTicket(key));
        turnTickets.delete(key);
        if (turnDirect.get(key) ?? defaultDirect(key)) {
          void sendLong(key, `⚠️ 模型這次想太久（超過 ${Math.round(timeoutMs / 1000)} 秒），先取消這一輪；可以再問一次。`).catch(() => {});
        }
      }, 5000);
      releaseTimer.unref?.();
    }, timeoutMs);
    entry.timer.unref?.();
    ttftTimers.set(sessionId, entry);
  }

  async function handleSessionEvent(frame) {
    const event = frame.event;
    if (!event?.type) return;

    // 先記帳再分流：學習會話也要算錢，只是在控制台歸到 internal，不送回 Discord。
    usage.ingestEvent(frame.sessionId, event);
    // Bot 交易回合的 token 上限用這裡的累計；會話跑完就歸檔。
    const tokenSink = botTokenSink.get(frame.sessionId);
    if (tokenSink && event.type === 'assistant/message') {
      tokenSink.tokens += Number(event.data?.usage?.totalTokens) || 0;
    }

    // 記住看過的最大 turn：/ask 用它排除提問前就存在的回合。
    const eventTurn = event.data?.turn;
    const previousLastTurn = lastTurns.get(frame.sessionId) ?? 0;
    if (typeof eventTurn === 'number' && eventTurn > previousLastTurn) {
      lastTurns.set(frame.sessionId, eventTurn);
    }
    if (typeof eventTurn === 'number') {
      if (event.type === 'turn/start') markTurnOpen(frame.sessionId, eventTurn);
      else if (event.type === 'turn/end') markTurnEnded(frame.sessionId, eventTurn);
    }

    // 被放棄的回合（收尾時還沒等到 turn/end）：整段吞掉，不能讓它變成公開回合。
    const abandoned = askAbandonedTurns.get(frame.sessionId);
    if (abandoned) {
      if (typeof eventTurn !== 'number') return; // 分不出是哪一輪，先吞掉
      if (abandoned.has(eventTurn)) {
        if (event.type === 'turn/end') clearAbandonedTurn(frame.sessionId, eventTurn);
        return;
      }
    }

    // 學習會話：只收文字，不進公開回覆。
    const privateTurn = sessionWaiters.get(frame.sessionId);
    if (privateTurn) {
      const turn = event.data?.turn;
      if (!privateTurn.started && event.type === 'assistant/message' && turn !== undefined && turn !== null) {
        privateTurn.started = true;
        privateTurn.collector.push({ type: 'turn/start', data: { turn } });
      }
      if (event.type === 'turn/start') privateTurn.started = true;
      const endedPrivate = privateTurn.collector.push(event);
      if (endedPrivate) privateTurn.finish(endedPrivate);
      return;
    }

    // 後台提問：只吞屬於這次提問的回合，其他回合照常走公開路徑。
    const ask = askTurns.get(frame.sessionId);
    if (ask?.push(event)) return;

    const key = reverse.get(frame.sessionId);
    if (!key) return;

    // 新的 step 才放掉補句 hold：同一個 step 的其他 send 不能只送出後半句。
    if (event.type === 'step/start') turnFollowupHeld.delete(key);

    // 模型已經開始輸出或跑工具、或這一輪結束了：停掉等第一個 token 的計時器。
    if (event.type === 'assistant/first-token') {
      const entry = ttftTimers.get(frame.sessionId);
      if (entry) {
        const ms = Date.now() - entry.startedAt;
        turnTtftMs.set(key, ms);
        if (ms > 10_000) log(`TTFT ${(ms / 1000).toFixed(1)} 秒（${key}）`);
      }
    }
    if (event.type === 'assistant/first-token' || event.type === 'assistant/chunk' || event.type === 'assistant/message'
      || event.type === 'tool/call' || event.type === 'turn/end' || event.type === 'compaction/start') {
      clearTtftTimer(frame.sessionId);
    }
    if (event.type === 'tool/call' && ttftTimeouts.has(key)) {
      log(`TTFT 已取消，但工具剛開始跑（${key}）；沿用取消`);
    }

    // 新的一輪開始：清掉上一輪的發送紀錄。
    if (event.type === 'turn/start') {
      clearTtftTimer(frame.sessionId);
      agentSender.startTurn(key);
      voicePerTurn.delete(key);
      memoryWrites.delete(key);
      noteWrites.delete(key);
      knowledgeWrites.delete(key);
      memeSaves.delete(key);
      devFeedbackWrites.delete(key);
      devFeedbackEdits.delete(key);
      slangWrites.delete(key);
      ttftTimeouts.delete(key);
      turnTools.delete(key);
      turnTtftMs.delete(key);
    }
    if (event.type === 'compaction/start') showCompactNotice(key);
    if (event.type === 'compaction/end') {
      hideCompactNotice(key);
      // 壓縮後【常用表情】和索引可能被吃掉；下一批重帶一次。
      if (event.data?.error) log(`壓縮失敗 ${key}：${String(event.data.error).slice(0, 200)}`);
      else emojiShown.delete(key);
    }
    const usageTokens = event.type === 'assistant/message' ? event.data?.usage?.totalTokens : undefined;
    if (Number.isFinite(usageTokens)) contextTokens.set(frame.sessionId, usageTokens);
    // 只有對得到橋接自己那一批的 turn/end 才放行下一批；重連後補送的舊 turn/end 對不到，
    // 放掉會讓剛投遞的批次提早出發。真的等不到還有 5 分鐘保險絲。
    // context 太大時先壓縮再放行：/compact 要會話閒著才跑得動。
    if (event.type === 'turn/end') {
      const abandoned = ttftAbandonedTurns.get(key);
      if (abandoned?.has(event.data?.turn)) {
        abandoned.delete(event.data.turn);
        if (abandoned.size === 0) ttftAbandonedTurns.delete(key);
        // 5 秒保底已經放行過這一輪；遲到的 turn/end 不能再放掉下一批的 gate。
        log(`略過遲到的 turn/end（${key}，turn ${event.data.turn}）`);
      } else {
        const pending = turnTickets.get(key);
        let ticket;
        if (pending) {
          if (eventTurn === undefined || pending.turn === eventTurn) ticket = pending.ticket;
        } else if (eventTurn !== undefined && eventTurn > previousLastTurn) {
          // turn/start 漏接，但這一輪是新的：用還壓在佇列裡、而且真的持有閘門的那批。
          const head = pendingDirect.get(key)?.[0];
          if (head && turnGate.owns(key, head.ticket)) ticket = head.ticket;
        }
        if (ticket === undefined) {
          // 重連後補送的舊 turn/end、或不是橋接排的回合：閘門不是它的，不能放。
          if (pending) log(`略過對不到批次的 turn/end（${key}，turn ${eventTurn}）`);
        } else {
          turnTickets.delete(key);
          const compact = shouldAutoCompact({
            tokens: contextTokens.get(frame.sessionId),
            threshold: cfg.discord.autoCompactTokens,
          });
          if (compact) void autoCompact(key, frame.sessionId, ticket);
          // /ask 拿著閘門時，公開路徑收到的 turn/end 一定是別的回合；不能因此放掉提問的閘門。
          else if (!askTurns.has(frame.sessionId)) turnGate.releaseNormal(key, ticket);
        }
      }
    }
    // 只用來分辨日誌：模型是「試過但失敗」（令牌過期、權限不足）還是根本沒呼叫。
    if (event.type === 'tool/call') {
      const name = String(event.data?.name ?? event.data?.toolName ?? '');
      const shortName = name.replace(/^mcp__discord__/, '');
      if (shortName) {
        const called = turnTools.get(key) ?? new Set();
        called.add(shortName);
        turnTools.set(key, called);
      }
      if (/^mcp__discord__(send_message|send_image|send_voice|send_voice_file|send_sticker|add_reaction|remove_reaction|edit_message|delete_message|create_poll)$/.test(name)) agentSender.noteAttempt(key);
      const state = progress.get(key);
      if (state && /^mcp__discord__(send_message|send_image|send_voice|send_voice_file|send_sticker|create_poll)$/.test(name)) state.replied = true;
      const line = state ? describeToolCall(name, event.data?.arguments) : null;
      if (line) {
        const leaks = cfg.discord.security.blockSensitive && findSensitive(line, agentSecrets());
        addProgress(key, leaks ? '🔧 使用工具' : line);
      }
    }

    let collector = collectors.get(frame.sessionId);
    // 事件流接得太晚時，真正的 turn/start 會漏掉（follow 還在排隊、prompt 已經開跑）。
    // assistant/message 帶的是完整正文，所以用它補一個合成的起點；沒有這一步，
    // 該回合的 turn/end 會被當成「沒有對應 turn/start」而整段丟掉，使用者什麼都收不到。
    const turn = event.data?.turn;
    const missedStart = event.type === 'assistant/message' && turn !== undefined && turn !== null;
    if (!collector && (event.type === 'turn/start' || missedStart)) {
      collector = createTurnCollector();
      if (missedStart) collector.push({ type: 'turn/start', data: { turn } });
      collectors.set(frame.sessionId, collector);
      const queued = pendingDirect.get(key);
      // 漏接 turn/start 會留下一筆多出來的 entry；它已經不持閘門，丟掉才不會讓之後每一批都配錯。
      let stale = 0;
      while (queued?.length && !turnGate.owns(key, queued[0].ticket)) {
        queued.shift();
        stale += 1;
      }
      for (const queue of [pendingUsers.get(key), pendingDirectMessages.get(key), pendingLastMessages.get(key)]) {
        if (stale > 0) queue?.splice(0, stale);
      }
      const batch = queued?.length ? queued.shift() : null;
      const hadQueued = batch !== null;
      turnDirect.set(key, batch ? batch.direct : defaultDirect(key));
      // 不是橋接排進去的回合（DSH Web GUI 直接開的）沒有 meta，結束時不寫回合紀錄。
      turnMeta.set(key, batch?.meta ?? null);
      if (batch?.ticket !== undefined) turnTickets.set(key, { turn, ticket: batch.ticket });
      else turnTickets.delete(key);
      const queuedUsers = pendingUsers.get(key);
      turnUsers.set(key, queuedUsers?.length ? queuedUsers.shift() : []);
      const queuedMessages = pendingDirectMessages.get(key);
      turnDirectMessages.set(key, queuedMessages?.length ? queuedMessages.shift() : []);
      turnStartedAt.set(key, Date.now());
      turnFollowupTaken.delete(key);
      turnFollowupHeld.delete(key);
      turnSentTexts.delete(key);
      sandboxRuns.delete(key);
      const queuedLast = pendingLastMessages.get(key);
      turnLastMessage.set(key, queuedLast?.length ? (queuedLast.shift()?.id ?? '') : '');
      turnTriggerRecorded.delete(key);
      // 只有橋接自己排進去的批次才等第一個 token；壓縮指令不會開回合。
      if (event.type === 'turn/start' && hadQueued) armTtftTimer(key, frame.sessionId, turn);
    }
    const ended = collector ? collector.push(event) : null;
    if (!ended) {
      // 佇列裡的下一回合開始：第一回合結束時輸入提示已停掉，這裡要重新亮起來。
      // 沒人叫 bot 的那批不亮：模型多半不會說話，亮了反而像打字打到一半消失。
      if (event.type === 'turn/start' && turnDirect.get(key)) {
        resolveChannel(key).then((channel) => startTyping(key, channel)).catch(() => {});
      }
      // 進度不分有沒有人叫：它自己去搜尋時，通常接著就會開口。沒用工具的回合不會貼任何東西。
      if (event.type === 'turn/start') startProgress(key);
      // 沒有對應 turn/start 的 turn/end（重連後補發）只需清掉殘留，不能當成新回覆。
      if (event.type === 'turn/end') {
        collectors.delete(frame.sessionId);
        ttftTimeouts.delete(key);
      }
      return;
    }
    collectors.delete(frame.sessionId);
    stopTyping(key);
    finishProgress(key);
    lastActive.set(key, Date.now());
    const direct = turnDirect.get(key) ?? defaultDirect(key);
    const loggedUsers = (turnUsers.get(key) ?? []).map((user) => user.userId);
    const meta = turnMeta.get(key) ?? null;
    turnMeta.delete(key);
    const sentTexts = turnSentTexts.get(key) ?? [];
    turnSentTexts.delete(key);
    // 出錯或被取消時拿不到 agentSender 的 sent 計數，用「有沒有文字送出」判斷要不要保底。
    const spoke = sentTexts.length > 0 ? 1 : 0;
    const tools = [...(turnTools.get(key) ?? [])];
    turnTools.delete(key);
    const measuredTtft = turnTtftMs.get(key) ?? null;
    turnTtftMs.delete(key);
    turnDirect.delete(key);
    turnUsers.delete(key);
    sandboxRuns.delete(key);
    turnDirectMessages.delete(key);
    turnStartedAt.delete(key);
    turnFollowupTaken.delete(key);
    turnFollowupHeld.delete(key);
    turnLastMessage.delete(key);
    turnTriggerRecorded.delete(key);

    const reason = ended.reason ?? {};
    const ttftMs = ttftTimeouts.get(key);
    ttftTimeouts.delete(key);
    if (reason.kind === 'completed') {
      const { sent, reacted, unreacted, removed, attempted } = agentSender.finishTurn(key);
      // 餅的回合：模型漏掉的原文連結由橋接補；完全沒送出才發保底訊息。
      const ceobeAdded = meta?.ceobe ? await finishCeobeTurn(key, meta.ceobe, sentTexts, sent) : 0;
      const totalSent = sent + ceobeAdded;
      if (meta) {
        const turnUsage = usage.ledger.turnUsage(frame.sessionId, ended.turn);
        writeTurn(key, meta, meta.internal && !meta.ceobe ? 'skipped' : (totalSent > 0 ? 'sent' : 'silent'), {
          reason: meta.ceobe ? 'ceobe' : (meta.internal ? 'system' : ''),
          turn: ended.turn,
          sent: totalSent,
          tools,
          tokens: turnUsage?.tokens ?? null,
          ttftMs: measuredTtft,
          model: turnUsage?.model ?? null,
          users: loggedUsers,
        });
      }
      // 只按／收回 reaction 或只收回訊息也算回應了，不是「忘了用工具」。
      if (totalSent > 0 || reacted > 0 || unreacted > 0 || removed > 0) return;
      // 沒有呼叫工具就真的不送。回合文字可能只是思考，不是要發出去的內容，
      // 所以這裡不代送；只留一行日誌方便追「模型忘了用工具」。
      const text = String(ended.text ?? '').trim();
      log(`回合完成但這一輪沒有實際送出訊息（${key}${attempted ? '，工具呼叫失敗或轉成背景工作' : ''}）${text ? `：${text.slice(0, 80)}${text.length > 80 ? '…' : ''}` : ''}`);
      // ★ 的回合只回了文字：提醒一次，免得群友以為被忽略。
      // 提醒自己的回合 direct=false，不會再觸發；有下一批在跑就交給那一批，不另外開回合。
      if (direct && !attempted && text && !quietUntil(key) && !turnGate.isBusy(key)
        && Date.now() - (noToolRemindedAt.get(key) ?? 0) > NO_TOOL_REMINDER_MS) {
        noToolRemindedAt.set(key, Date.now());
        enqueuePrompt(key, { entries: [], direct: false, epoch: epochOf(key), reminder: NO_TOOL_REMINDER });
        log(`已提醒模型呼叫工具回話（${key}）`);
      }
      return;
    }
    if (reason.kind === 'error') {
      const message = String(reason.error?.message ?? '未知錯誤').slice(0, 500);
      log(`agent 出錯 (${key})：${message}`);
      if (meta?.ceobe) await finishCeobeTurn(key, meta.ceobe, sentTexts, spoke);
      // 沒人叫 bot 的那批出錯只記日誌：頻道裡沒人在等回覆，貼錯誤只會吵到人。
      if (direct) await sendLong(key, `⚠️ agent 處理出錯：${message}`);
      return;
    }
    if (reason.kind === 'aborted') {
      if (meta?.ceobe) await finishCeobeTurn(key, meta.ceobe, sentTexts, spoke);
      if (direct) {
        await sendLong(key, ttftMs
          ? `⚠️ 模型這次想太久（超過 ${Math.round(ttftMs / 1000)} 秒），先取消這一輪；可以再問一次。`
          : '⏹️ 已停止');
      }
    }
  }

  async function handleFrame(frame) {
    switch (frame?.type) {
      case 'session/event':
        await handleSessionEvent(frame);
        break;
      case 'session/snapshot': {
        // 開場快照帶整條會話的 tokenUsage 累計與最近事件；只進帳本，不當成新回合。
        usage.ingestSnapshot(frame.sessionId, frame.snapshot);
        // 補上最大 turn、重建「有 start 沒有 end」的回合：重連後如果還有回合在跑，
        // /ask 才不會把它認成自己的；快照到之前也一律不讓 /ask 進來。
        const { open, ended } = turnsFromRecords(frame.snapshot?.records);
        for (const entry of frame.snapshot?.records ?? []) {
          const event = entry?.type === 'event' ? entry.event : entry;
          const turn = event?.data?.turn;
          if (typeof turn === 'number' && turn > (lastTurns.get(frame.sessionId) ?? 0)) {
            lastTurns.set(frame.sessionId, turn);
          }
        }
        if (open.size) openTurns.set(frame.sessionId, open);
        else openTurns.delete(frame.sessionId);
        snapshotReady.add(frame.sessionId);
        // 被放棄的回合只有在快照裡「真的看到 turn/end」才解除；不能只看不在 open
        // （records 只有最近 200 筆，start 可能被截掉但那一輪還在跑）。
        const abandoned = askAbandonedTurns.get(frame.sessionId);
        if (abandoned) {
          for (const abandonedTurn of [...abandoned.keys()]) {
            if (ended.has(abandonedTurn)) clearAbandonedTurn(frame.sessionId, abandonedTurn);
          }
        }
        break;
      }
      case 'question/requested':
        await handleQuestion(frame);
        break;
      case 'approval/requested':
        await handleApproval(frame);
        break;
      case 'stream/error':
        log(`事件流錯誤：${frame.error?.code ?? '未知'}`);
        break;
      default:
        // session/snapshot 帶的是歷史事件，絕不能當成新回合去回覆。
        break;
    }
  }

  async function pumpEvents() {
    let retryMs = 3_000;
    for (;;) {
      let frames = 0;
      try {
        log('連線 DSH 事件流…');
        // DSH 重啟後 llm-hedge 會回到預設；重連時把橋接的設定推回去。
        // 不能 await：DSH 慢的時候會拖到事件流連線。
        void syncHedgeSettings();
        for await (const envelope of api.events.mux({})) {
          frames += 1;
          lastFrameAt = Date.now();
          try {
            await handleFrame(envelope.payload);
          } catch (error) {
            log(`處理事件失敗：${error?.message ?? error}`);
          }
        }
        log(`DSH 事件流結束（本次 ${frames} 幀）`);
      } catch (error) {
        log(`DSH 事件流中斷：${error?.message ?? error}`);
      } finally {
        // 後台提問先收尾：斷線後分不出重連的回合是提問還是頻道批次，寧可取消也不要誤認。
        // 事件流收不到 turn/end，所以取消受理後直接收尾；取消失敗則繼續擋到寬限。
        for (const [sessionId, ask] of [...askTurns]) {
          void stopAskSession(sessionId, ask, { closeOnSuccess: true });
          ask.abort(new Error('DSH 事件流中斷'), ASK_CANCEL_FAILED_GRACE_MS);
        }
        // 學習會話也一樣：事件流斷了就不會再有回合結束，直接失敗（下次冷卻後再學）。
        for (const waiter of [...sessionWaiters.values()]) {
          waiter.fail(new Error('DSH 事件流中斷，學習回合取消'));
        }
        // 斷線後舊的 collector 不可信：重連快照會補歷史 turn/end，拿它當新回覆會重複發送。
        collectors.clear();
        // 重連要等新的開場快照才能再問；在那之前 /ask 會排隊等快照。
        snapshotReady.clear();
        openTurns.clear();
        agentSender.clearTurns();
        // 回合 ↔ 批次的對應也不可信了；之後的回合退回 defaultDirect。
        pendingDirect.clear();
        turnDirect.clear();
        turnTickets.clear();
        pendingUsers.clear();
        turnUsers.clear();
        pendingDirectMessages.clear();
        turnDirectMessages.clear();
        turnStartedAt.clear();
        turnFollowupTaken.clear();
        turnFollowupHeld.clear();
        pendingLastMessages.clear();
        turnLastMessage.clear();
        turnTriggerRecorded.clear();
        turnMeta.clear();
        turnTools.clear();
        turnTtftMs.clear();
        clearAllTtftTimers();
        // 斷線期間的 turn/end 收不到了：壓住的批次直接放行，不要等保險計時器。
        turnGate.releaseAll();
        for (const key of [...typingTimers.keys()]) stopTyping(key);
        for (const key of [...progress.keys()]) finishProgress(key);
        for (const key of [...compactNotices.keys()]) hideCompactNotice(key);
      }
      retryMs = frames > 0 ? 3_000 : Math.min(30_000, retryMs * 2);
      await sleep(retryMs);
    }
  }

  // 事件流最後一幀的時間：控制台要看得到「事件流是不是還活著」。
  let lastFrameAt = 0;

  // 這兩個只有訊息入口在用（一批帶幾個人的記憶、多久重帶一次）。

  // 離線重試：這兩個會被重新賦值，所以由模組自己持有，不從 deps 解構。
  let offlineTimer = null;
  let offlineFlushing = false;

  function scheduleOfflineFlush() {
    if (offlineTimer) return;
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      void flushOffline();
    }, cfg.discord.queue.retryMs);
    offlineTimer.unref?.();
  }

  function enqueueOffline(key, job) {
    const items = offlineQueue.get(key) ?? [];
    if (items.length >= cfg.discord.queue.max) {
      items.shift();
      log(`離線佇列已滿（${cfg.discord.queue.max}），丟棄最舊一則 (${key})`);
    }
    items.push(job);
    offlineQueue.set(key, items);
    log(`DSH 暫時不可用，訊息排隊 (${key})：${items.length} 條`);
    const now = Date.now();
    // 沒人叫 bot 的那批不提示：自由參與時，那等於對著整個頻道廣播系統狀態。
    if (job.direct && (offlineHintAt.get(key) ?? 0) + 60_000 < now) {
      offlineHintAt.set(key, now);
      void sendLong(key, '⏳ 系統服務暫時不可用，訊息已排隊，恢復後會自動送出。').catch(() => {});
    }
    scheduleOfflineFlush();
  }

  async function flushOffline() {
    if (offlineFlushing || offlineQueue.size === 0) return;
    offlineFlushing = true;
    try {
      // 先用一個便宜的一元 RPC 探活；通了才把整批丟回去。
      await api.callUnary('settings/describe', {});
    } catch {
      scheduleOfflineFlush();
      return;
    } finally {
      offlineFlushing = false;
    }
    const pending = [...offlineQueue.entries()];
    offlineQueue.clear();
    let count = 0;
    for (const [key, jobs] of pending) {
      for (const job of jobs) {
        count += 1;
        enqueuePrompt(key, job);
      }
    }
    log(`DSH 恢復，重新投遞 ${count} 條排隊訊息`);
  }

  function enqueuePrompt(key, job) {
    turnGate.submit(key, job);
  }

  // 沒開 Message Content 意圖時，Discord 只會把 @bot 的訊息內容送來，所以強制走 @ 模式。
  const requireMentionInGuild = () => cfg.discord.requireMentionInGuild || !cfg.discord.messageContentIntent;
  // 單頻道覆寫優先；私聊一律算 direct。
  const requireMentionFor = (key) => !key.startsWith('ch:') || requireMentionForChannel(cfg.discord, key.slice(3));

  /**
   * 一批訊息 → prompt 文字與圖片。附件、引用、上下文都在投遞時才抓：
   * 這樣排在同一條佇列裡，順序不會亂；任何一項失敗只略過那一項。
   */
  async function buildBatchPrompt(key, job) {
    const guild = Boolean(job.guildId);
    const quietAt = quietUntil(key);
    // 上一次送出的訊息收到的 reaction：只在這批 prompt 出現一次，不另外開回合。
    const feedbackEntries = reactionInbox.peek(key);
    const feedback = formatReactionInbox(
      feedbackEntries,
      (id) => messageRefs.register(key, id),
    );
    const entries = [];
    const images = [];
    const skipped = [];
    for (const entry of job.entries) {
      skipped.push(...(entry.media?.skipped ?? []));
      const entryRef = messageRefs.register(key, entry.id, { authorId: entry.userId, at: entry.at });
      // 連結預覽的圖（Tenor／Giphy 的 GIF）是 Discord 稍後用 messageUpdate 補上的，
      // 到這裡才讀 message.embeds：批次至少等過幾秒（有人 @ 時 8 秒），多半拿到了。沒有就只剩網址。
      // 轉發的預覽圖在快照裡，一起算。
      const attachments = entry.media?.accepted ?? [];
      const items = cfg.discord.media.enabled
        ? [...attachments, ...embedImages(messageParts(entry.message).embeds)]
        : [];
      for (const item of items.slice(cfg.discord.media.maxCount)) {
        skipped.push({ name: item.name, reason: `一則訊息最多 ${cfg.discord.media.maxCount} 張` });
      }
      const imageTags = [];
      for (const [index, item] of items.slice(0, cfg.discord.media.maxCount).entries()) {
        if (images.length >= cfg.discord.media.maxCount) {
          skipped.push({ name: item.name, reason: `一批最多 ${cfg.discord.media.maxCount} 張` });
          continue;
        }
        // 附件與貼圖可以拿 #編號/張數 當生圖參考；連結預覽的圖不是那則訊息的附件，只標 [圖]。
        // GIF 一律不標：參考圖拒收 GIF，標了只會讓模型白試一次。
        const refTag = index < attachments.length && item.mime !== 'image/gif' && !item.mime?.startsWith('video/')
          ? imageRefTag(entryRef, index + 1)
          : '';
        try {
          const buffer = await fetchDiscordMedia(item.url, cfg.discord.media);
          const prepared = await prepareMediaBlock(buffer, item.name, cfg.discord.media);
          if (prepared.block) {
            images.push(prepared.block);
            // 影片的 note 要讓模型看到：它得知道只抽了前幾十秒、這是一張格子圖。
            const note = item.mime?.startsWith('video/') ? flat(prepared.note, 80) : '';
            imageTags.push(refTag || (note ? `[圖：${note}]` : '[圖]'));
            if (prepared.note) log(`圖片 ${item.name}：${prepared.note}`);
          } else {
            skipped.push({ name: item.name, reason: prepared.error });
          }
        } catch (error) {
          skipped.push({ name: item.name, reason: error?.message ?? String(error) });
        }
      }
      // 編輯過的訊息，圖片張數或順序可能跟模型記得的不一樣；標一下，叫它不確定就再看一次。
      if (entry.message?.editedAt && imageTags.some((tag) => tag.startsWith('[圖 #'))) imageTags.push('[已編輯]');
      let quote = '';
      try {
        const referenced = await referencedMessage(entry.message);
        // 引用是 REST 抓的，重啟後一樣要補成員才拿得到伺服器暱稱。
        if (referenced) await warmMemberCache(job.channel?.guild, [referenced]);
        // 引用是群友貼進來的公開內容，原作者退出或被封鎖時照樣帶；少了它模型看不懂在回什麼。
        // 模型自己不理的人例外：他的話不進來，只留回覆對象的名字。
        if (referenced && !ignoredUser(referenced.author?.id)
          && (referenced.author?.bot || !isSkippedMessage(referenced.content, client.user.id))) {
          quote = formatQuote({
            ref: messageRefs.register(key, referenced.id, { authorId: referenced.author?.id, at: referenced.createdTimestamp }),
            author: authorName(referenced),
            content: labelEmojiTags(resolveMentions(withStickers(referenced), referenced), getEmojiCatalogs()),
            hasImage: messageParts(referenced).hasImage,
            silent: isSilentMessage(cfg.discord, referenced, client.user.id),
          });
        }
      } catch (error) {
        log(`讀取引用訊息失敗：${error?.message ?? error}`);
      }
      entries.push({
        author: entry.author,
        text: entry.text,
        rawText: entry.rawText ?? entry.text,
        direct: entry.direct,
        // 已退出的人 @ 你／回覆你時照常進批次，讓 formatBatch 標「可以回」。
        muted: cfg.discord.deny.self.includes(String(entry.userId)),
        isOwner: entry.isOwner,
        ref: entryRef,
        quote,
        preview: embedPreview(entry.message),
        // 引用內容看不到時（抓不到或被回覆的那則沒內容），至少寫出在回誰。
        replyName: quote ? '' : repliedName(entry.message),
        imageTags,
        hasImage: entry.hasImage,
      });
    }
    if (images.length > 0) log(`附加 ${images.length} 張圖 (${key})`);

    // 頻道上下文：預設模式每批都帶（模型看不到沒叫它的訊息）；自由參與只在會話的第一批帶，
    // 之後每一則都已經進過會話，再帶只是重複燒 token。例外是 /blacklist 退出的人說話後，
    // 下一批要再帶一次，才不會漏掉他們的訊息（silentPending）。
    let context = '';
    const wantContext = guild && cfg.discord.context.enabled && cfg.discord.context.messages > 0
      && (requireMentionFor(key) || quietAt || !primedKeys.has(key));
    if (wantContext) {
      try {
        // 從最後一則往前抓，再扣掉批次自己的訊息：@ 模式下兩則 @ 之間的閒聊也要看得到。
        const batchIds = new Set(job.entries.map((entry) => entry.id));
        const boundary = job.entries.at(-1).id;
        const fetched = await job.channel.messages.fetch({
          limit: Math.min(100, cfg.discord.context.messages + job.entries.length),
          before: boundary,
        });
        // 有 // 標記的訊息不進上下文，也不收黑話樣本。bot 自己的訊息不套這個規則。
        // 管理員封鎖與模型不理的人不進上下文；自己退出（deny.self）的人要進來，只是標成 ⊘、不回。
        const history = [...fetched.values()].filter((entry) => !batchIds.has(entry.id)
          && !cfg.discord.deny.users.includes(String(entry.author?.id ?? ''))
          && !ignoredUser(entry.author?.id)
          && (entry.author?.bot || !isSkippedMessage(entry.content, client.user.id)));
        // 歷史訊息是用 REST 抓的，不帶 member；重啟後成員快取是空的，
        // 名稱會掉回全域名稱。先補抓，之後 authorName 才拿得到伺服器暱稱。
        await warmMemberCache(job.channel?.guild, history);
        // 抓回來的歷史訊息也餵進黑話語料（去重靠 message.id）；退出的人不收。
        for (const entry of history) {
          if (!entry.author?.bot && entry.content && !cfg.discord.deny.self.includes(String(entry.author.id))) {
            collectSlangSample(entry, resolveMentions(entry.content, entry));
          }
        }
        // 退出的人那則已經落在這次抓的範圍（比批次最後一則舊），算帶到了；還在後面的留給下一批。
        const pending = silentPending.get(key);
        if (pending && BigInt(pending) <= BigInt(boundary)) silentPending.delete(key);
        context = formatRecentContext(
          history.reverse().map((entry) => ({
            ref: messageRefs.register(key, entry.id, { authorId: entry.author?.id, at: entry.createdTimestamp }),
            author: authorName(entry),
            content: labelEmojiTags(resolveMentions(withStickers(entry), entry), getEmojiCatalogs()),
            replyName: repliedName(entry),
            bot: entry.author?.id === client.user.id,
            hasImage: messageParts(entry).hasImage,
            silent: isSilentMessage(cfg.discord, entry, client.user.id),
          })),
          cfg.discord.context,
        );
      } catch (error) {
        log(`讀取頻道上下文失敗：${error?.message ?? error}`);
      }
    }

    // 群友記憶：這一批說話的人（有沒有 ★ 都算，★ 的排前面），最多 5 位；同一會話沒變就不重複帶。
    let memory = '';
    if (cfg.discord.memory.enabled && guild) {
      const speakers = new Map();
      for (const entry of [...job.entries].sort((a, b) => Number(b.direct) - Number(a.direct))) {
        if (speakers.size < MEMORY_USERS_PER_BATCH && !speakers.has(entry.userId)) {
          speakers.set(entry.userId, { userId: entry.userId, name: entry.author });
        }
      }
      if (!memoryShown.has(key)) memoryShown.set(key, new Map());
      if (pruneStaleGuesses(memoryStore) > 0) markMemoryDirty();
      memory = formatMemoryBlock(memoryStore, {
        users: [...speakers.values()],
        maxChars: cfg.discord.memory.maxChars,
        shown: memoryShown.get(key),
        refreshMs: MEMORY_REFRESH_MS,
        // 互動次數：回過他幾回合、最後一次多久前。沒有記憶的人也會多這一句。
        relationOf: (userId) => {
          const stats = triggerStore.users?.[userId];
          if (!stats || !stats.count) return null;
          const days = stats.lastAt > 0 ? Math.floor((Date.now() - stats.lastAt) / 86_400_000) : null;
          return {
            text: `你回過他 ${stats.count} 回合`
              + `${days === null ? '' : `，最後一次 ${days < 1 ? '今天' : `${days} 天前`}`}`,
            at: stats.lastAt || Date.now(),
          };
        },
      });
    }

    // 頻道筆記：最近幾條；同一會話帶過、沒變的不重複帶。
    let notesHint = '';
    if (cfg.discord.notes.enabled && guild) {
      if (pruneNotes(notesStore) > 0) markNotesDirty();
      if (!notesShown.has(key)) notesShown.set(key, new Map());
      notesHint = formatNotesBlock(notesStore, {
        channelId: job.channel.id,
        injectMax: cfg.discord.notes.injectMax,
        maxChars: cfg.discord.notes.maxChars,
        shown: notesShown.get(key),
        refreshMs: MEMORY_REFRESH_MS,
      });
    }

    // 已確認的黑話與頻道風格：只有管理員在控制台按過「確認」的才會進來；同一會話帶過的不重複帶。
    // 黑話全部伺服器共用，這批訊息講到的詞優先。
    let slangHint = '';
    let styleHint = '';
    if (cfg.discord.slang.enabled && guild) {
      if (!slangShown.has(key)) slangShown.set(key, new Map());
      slangHint = buildSlangHint(slangStore, {
        text: entries.map((entry) => `${entry.rawText ?? entry.text}\n${entry.quote}`).join('\n'),
        max: cfg.discord.slang.injectMax,
        maxChars: cfg.discord.slang.maxChars,
        shown: slangShown.get(key),
        refreshMs: MEMORY_REFRESH_MS,
      });
      styleHint = buildStyleHint(slangStore, {
        channelId: job.channel.id,
        shown: slangShown.get(key),
        refreshMs: MEMORY_REFRESH_MS,
      });
    }

    // 群知識：管理員確認過的長期資料。關鍵字命中或 always 才帶；工具用的在生圖那邊另外附。
    let knowledgeHint = '';
    if (cfg.discord.knowledge.enabled && guild) {
      if (!knowledgeShown.has(key)) knowledgeShown.set(key, new Map());
      knowledgeHint = formatKnowledgeBlock(knowledgeStore, {
        guildId: job.guildId,
        channelId: job.channel.id,
        text: entries.map((entry) => `${entry.rawText ?? entry.text}\n${entry.quote}`).join('\n'),
        shown: knowledgeShown.get(key),
        refreshMs: MEMORY_REFRESH_MS,
        maxChars: cfg.discord.knowledge.maxChars,
        guildNameOf: (guildId) => client.guilds.cache.get(guildId)?.name ?? '',
      });
    }

    // 表情：本伺服器前 8 個＋跨伺服器前 4 個，加上本伺服器其餘表情的情緒索引。
    // 兩段各自去重（同會話帶過、沒變就不重帶），索引才不會被常用表情的排序拖著每批重送。
    let emojiHint = '';
    if (cfg.discord.emoji.enabled && guild) {
      if (!emojiShown.has(key)) emojiShown.set(key, new Map());
      const shown = emojiShown.get(key);
      const hintText = buildEmojiHint(getEmojiCatalogs(), {
        guildId: job.guildId,
        usage: emojiUsage,
        maxChars: cfg.discord.emoji.maxChars,
      });
      const indexText = buildEmojiIndex(getEmojiCatalogs(), {
        guildId: job.guildId,
        // 從常用表情的文字反推名字，索引不重複列；格式改了這裡要跟著改。
        exclude: new Set([...hintText.matchAll(/^- (.+?)：/gm)].map((match) => match[1])),
      });
      emojiHint = [
        onceInSession(shown, 'emoji', hintText, Date.now(), MEMORY_REFRESH_MS),
        onceInSession(shown, 'emoji-index', indexText, Date.now(), MEMORY_REFRESH_MS),
      ].filter(Boolean).join('\n');
    }

    // 梗圖：依使用次數取前幾張（所有伺服器共用），只帶名稱與使用情境（模型不會自己想到去搜）。
    // 同一會話沒變就不重帶；清單變了（存了新的、用次數改了排序）才會再帶一次。
    let memeHintText = '';
    if (cfg.discord.memes.enabled && guild) {
      if (!emojiShown.has(key)) emojiShown.set(key, new Map());
      memeHintText = onceInSession(emojiShown.get(key), 'meme',
        memeHint(memeStore, { max: cfg.discord.memes.max }), Date.now(), MEMORY_REFRESH_MS);
    }

    // 回合太長、壓住的訊息超過上限時，最舊的閒聊被丟掉了；讓模型知道可以自己去翻。
    const dropped = job.dropped ? `\n（模型回合期間訊息太多，略過了較早的 ${job.dropped} 則；需要的話用 read_history 看）` : '';
    // 名單每批重算：模型會把舊 prompt 或壓縮摘要裡的 ⊘ 當成現在，這一行負責校正。
    // 只列這個伺服器的成員，名字取法跟【最近頻道訊息】一致，模型才對得上。
    // 這批標 ★ 的退出者要從 ⊘ 名單移出，不然模型會同時看到「只看不回」和「可以回」。
    // 用 id 比對：合批期間改暱稱時名字會對不上，兩份名單就又同時出現。
    const starredIds = new Set(job.entries
      .filter((entry) => entry.direct && cfg.discord.deny.self.includes(String(entry.userId)))
      .map((entry) => String(entry.userId)));
    const blacklistStatus = guild
      ? formatBlacklistStatus(
        guildBlacklistNames(cfg.discord.deny.self.filter((id) => !starredIds.has(String(id))), job.channel.guild),
        { stars: guildBlacklistNames([...starredIds], job.channel.guild) },
      )
      : '';
    const batch = formatBatch(entries, { guild }) + dropped + describeSkipped(skipped);
    // chatty 頻道不看發言比例：連數字都不給，模型才不會自己算「講太多了先不接」。
    const chatty = isChattyChannel(cfg.discord, job.channel.id);
    const time = [
      formatTimeContext({ messageAt: job.entries[0].at }),
      quietAt ? `（你設了安靜到 ${formatQuietUntil(quietAt)}；★ 只按 reaction，不送文字）` : '',
      chatty ? '' : formatActivityLine(activity.stats(key)),
    ].filter(Boolean).join('\n');
    return {
      text: [feedback, context, slangHint, styleHint, knowledgeHint, notesHint, memory, emojiHint, memeHintText, formatParticipationHint(chatty, { followup: cfg.discord.followup.enabled }), blacklistStatus, batch, time].filter(Boolean).join('\n'),
      images,
      feedbackEntries,
    };
  }

  /** bot 回給 T 之後，還有沒有回過別人。 */
  function botRepliedOthersAfter(key, userId, targetId) {
    const perUser = botLastByUser.get(key);
    if (!perUser || !targetId) return false;
    let target;
    try { target = BigInt(targetId); } catch { return false; }
    for (const [otherId, record] of perUser) {
      if (String(otherId) === String(userId)) continue;
      try {
        if (record.ids.some((id) => BigInt(id) > target)) return true;
      } catch { /* 非數字 id 略過 */ }
    }
    return false;
  }

  /** 讓位閘門：T 回覆 bot 回給他的那一則，中間有人插話，而且 bot 也回過插話的人。 */
  function yieldGateDecision(key, job) {
    const last = job.entries.at(-1);
    const userId = String(last?.userId ?? '');
    const batch = job.entries.map((entry) => ({
      id: String(entry.id ?? ''),
      userId: String(entry.userId ?? ''),
    }));
    // 只看原始文字：text 可能含表情目錄描述，描述裡剛好有「肥魚」不該算叫名字。
    const named = job.entries.some((entry) => isBotNamed(entry.rawText));
    // 同批還有別人 @bot：那一則不能被一起丟掉。
    const othersStar = job.entries.some((entry) => entry.direct && String(entry.userId) !== userId);
    const replyToId = replyTargetId(last?.message) ?? '';
    return shouldYield({
      botLast: botLastByUser.get(key)?.get(userId) ?? null,
      recent: recentHumans.get(key) ?? [],
      batch,
      // 只認「回覆 bot 那一則」；轉發、討論串起點與單純接話都不算。
      replyToId,
      named,
      othersStar,
      botAfter: botRepliedOthersAfter(key, userId, replyToId),
    });
  }

  /** 影子模式的 log 要能和 session log 對照：只記 id，不記內文。 */
  function yieldLogDetail(key, job) {
    const lastEntry = job.entries.at(-1);
    const userId = String(lastEntry?.userId ?? '');
    const target = botLastByUser.get(key)?.get(userId) ?? null;
    const replyToId = replyTargetId(lastEntry?.message) ?? '';
    const othersStar = job.entries.filter((entry) => entry.direct && String(entry.userId) !== userId).length;
    const recent = (recentHumans.get(key) ?? []).slice(-6).map((entry) => `${entry.id}:${entry.authorId}`).join(',');
    return ` bot=${target?.ids?.join('/') || '-'} reply=${replyToId || '-'} botAfter=${botRepliedOthersAfter(key, userId, replyToId) ? 1 : 0} others★=${othersStar} T=${userId || '-'} batch=${lastEntry?.id || '-'} recent=${recent || '-'}`;
  }

  /** 跳過一批但不讓它消失：下一批的【最近頻道訊息】會把它帶進來。 */
  function skipSilently(key, job, reason) {
    primedKeys.delete(key);
    const lastId = job.entries.at(-1)?.id;
    if (lastId) silentPending.set(key, lastId);
    log(`${reason} ${key}（${job.entries.length} 則）`);
  }

  /** @returns 有沒有排出一個模型回合（沒有就不會有 turn/end，閘門要自己放行） */
  async function deliverPrompt(key, job, ticket) {
    const { epoch } = job;
    const chatty = isChattyChannel(cfg.discord, job.channel?.id);
    const batchMeta = {
      direct: Boolean(job.direct),
      named: job.entries.some((entry) => isBotNamed(entry.rawText)),
      chatty,
      mediaOnly: isMediaOnlyBatch(job.entries),
      yielded: false,
      merged: job.merged ?? 0,
      internal: Boolean(job.system || job.reminder || job.followup),
      ceobe: job.ceobe ?? null,
    };
    if (epoch !== epochOf(key)) {
      log(`排隊期間會話已重置，丟棄 (${key})`);
      writeTurn(key, batchMeta, 'skipped', { reason: 'gate', job });
      return false;
    }
    // 批次排隊期間才設的安靜也要生效：沒叫 bot 的不進模型，省下這一輪。
    // 背景生圖完成是系統訊息，不能因為頻道剛好安靜就把圖丟掉。
    if (isQuietBatchSkipped({ direct: job.direct, quietUntil: quietUntil(key), system: Boolean(job.system) })) {
      // 回訪排隊期間才設的安靜：放回去，安靜結束後再送（額度已算過，不重扣）。
      if (job.followup) followups.restore(job.followup);
      log(job.followup
        ? `安靜期間延後回訪 ${key}`
        : `安靜期間丟棄 ${key}（${job.entries.length} 則，沒叫 bot）`);
      writeTurn(key, batchMeta, 'skipped', { reason: 'quiet', job });
      return false;
    }
    // 讓位閘門所有頻道都跑（收窄成「回覆 bot 那一則」）；純媒體閘門只給 chatty。
    // 兩個都先影子模式只記 log，觀察後再真的擋。
    const gateTurn = !job.followup && !job.reminder && !job.system;
    const chattyTurn = chatty && !job.direct && gateTurn;
    const yieldDecision = gateTurn && yieldGateDecision(key, job);
    batchMeta.yielded = Boolean(yieldDecision);
    if (yieldDecision) {
      if (YIELD_GATE_SHADOW) log(`讓位（影子，不擋）${key}（${job.entries.length} 則）${yieldLogDetail(key, job)}`);
      else {
        skipSilently(key, job, '讓位跳過');
        writeTurn(key, batchMeta, 'skipped', { reason: 'yield', job });
        return false;
      }
    }
    if (chattyTurn && batchMeta.mediaOnly) {
      if (YIELD_GATE_SHADOW) log(`純媒體（影子，不擋）${key}（${job.entries.length} 則） batch=${job.entries.at(-1)?.id || '-'}`);
      else {
        skipSilently(key, job, '純媒體跳過');
        writeTurn(key, batchMeta, 'skipped', { reason: 'media-only', job });
        return false;
      }
    }
    const sessionId = await getEnsureSession(key);
    if (epoch !== epochOf(key)) {
      log(`投遞前會話已重置，丟棄 (${key})`);
      writeTurn(key, batchMeta, 'skipped', { reason: 'gate', job });
      return false;
    }
    if (job.direct) startTyping(key, job.channel);

    const prompt = job.text
      ? { text: job.text, images: [], feedbackEntries: [] }
      : job.reminder
        ? { text: job.reminder, images: [], feedbackEntries: [] }
        : job.followup
          ? {
            // 回訪沒有【新訊息】，只有這幾行：先校正黑名單，再給回訪提示。
            // 少了黑名單，模型會拿舊 prompt 的名單去 @ 已經退出的人。
            // 回訪可能隔好幾天，沒有【現在】模型就判斷不出「比賽是不是今天」。
            text: [
              job.channel?.guild ? formatBlacklistStatus(guildBlacklistNames(cfg.discord.deny.self, job.channel.guild)) : '',
              formatFollowupPrompt(job.followup, { openTopic: isChattyChannel(cfg.discord, job.channel?.id) }),
              formatTimeContext(),
            ].filter(Boolean).join('\n'),
            images: [],
            feedbackEntries: [],
          }
          : await buildBatchPrompt(key, job);
    if (epoch !== epochOf(key)) {
      log(`整理批次期間會話已重置，丟棄 (${key})`);
      writeTurn(key, batchMeta, 'skipped', { reason: 'gate', job });
      return false;
    }

    // 令牌由 DSH 外掛自動帶入，不再寫進 prompt：模型看不到，被注入也抄不走。
    // 每輪還是要提醒一次「文字不會自動送出」，壓縮過上下文之後也不能忘。
    const sendHint = '【發送】要說話就呼叫 send_message，想回覆某則就加 reply_to=#編號。token 由系統自動帶入，不要自己填。不呼叫就是這次不說話；直接輸出文字不會送出。';
    // 換 system prompt 後的第一次發言：先把上一段對話的記憶放在最前面。
    const reload = peekReloadSummary(reloadStore, key);
    // 新會話的第一批，而且這批真的有人叫 bot（★）：給一句「先看話題接不接得上」。
    // 不要求它一定要說話；沒 ★ 的批次連提示都不帶，避免自由參與頻道被催著開口。
    // 只看「是不是新會話」：安靜結束也會清掉 primedKeys（為了重帶上下文），
    // 拿它判斷開場會在每次安靜後再叫模型主動說話一次。
    const opening = needsOpening.has(key) && job.direct ? `\n${OPENING_HINT}` : '';
    // 回訪清單只給「會說話的回合」：NO_TOOL 提醒與系統訊息不需要，多一行只是雜訊。
    const schedule = job.reminder || job.system ? '' : formatFollowupStatus(followups.list(key));
    const text = `${reload ? `${formatReloadSummary(reload)}\n` : ''}${prompt.text}${opening}\n${schedule ? `${schedule}\n` : ''}${sendHint}`;
    // 先排進去：這一批的 turn/start 可能比 prompt 的回應更早到。沒產生回合時再拿掉。
    const queued = pendingDirect.get(key) ?? [];
    const queuedBatch = { direct: job.direct, ticket, meta: batchMeta };
    queued.push(queuedBatch);
    pendingDirect.set(key, queued);
    const users = triggerUsers(job.entries);
    const queuedUsers = pendingUsers.get(key) ?? [];
    queuedUsers.push(users);
    pendingUsers.set(key, queuedUsers);
    const directMessages = job.entries
      .filter((entry) => entry.direct)
      .map((entry) => ({ userId: entry.userId, id: entry.id }));
    const queuedMessages = pendingDirectMessages.get(key) ?? [];
    queuedMessages.push(directMessages);
    pendingDirectMessages.set(key, queuedMessages);
    const lastMessageId = job.entries.at(-1)?.id ?? '';
    const queuedLast = pendingLastMessages.get(key) ?? [];
    const lastEntry = { id: lastMessageId };
    queuedLast.push(lastEntry);
    pendingLastMessages.set(key, queuedLast);
    const unqueue = () => {
      const index = queued.lastIndexOf(queuedBatch);
      if (index >= 0) queued.splice(index, 1);
      const userIndex = queuedUsers.lastIndexOf(users);
      if (userIndex >= 0) queuedUsers.splice(userIndex, 1);
      const messageIndex = queuedMessages.lastIndexOf(directMessages);
      if (messageIndex >= 0) queuedMessages.splice(messageIndex, 1);
      const lastIndex = queuedLast.lastIndexOf(lastEntry);
      if (lastIndex >= 0) queuedLast.splice(lastIndex, 1);
    };
    let accepted;
    try {
      accepted = await api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }, ...prompt.images],
      });
    } catch (error) {
      unqueue();
      throw error;
    }
    if (!accepted.result?.ok) {
      unqueue();
      stopTyping(key);
      const error = accepted.result?.error;
      throw new Error(`${error?.code ?? '未知錯誤'}${error?.message ? `：${error.message}` : ''}`);
    }
    if (accepted.result.value?.command) {
      // DSH 把它當斜線命令吃掉，不會開回合；放掉這一筆，免得閘門等到 5 分鐘保險絲。
      unqueue();
      stopTyping(key);
      log(`DSH 把批次當成斜線命令，沒有開回合 (${key})`);
      writeTurn(key, batchMeta, 'skipped', { reason: 'gate', job });
      return false;
    }
    // 還有「只當背景」的訊息沒被上下文涵蓋時不要標記，下一批會再重帶一次。
    // 純系統訊息（例如重啟後的【生圖完成】）沒有批次，也不能算這個會話已經帶過上下文。
    if (!silentPending.has(key) && (job.entries?.length ?? 0) > 0) primedKeys.add(key);
    // 第一批 prompt 真的進模型了才算用掉；送失敗不算。
    // 第一批沒 ★（沒帶開場）也一樣用掉：開場只給新會話的第一批，不留到後面的 ★ 批次。
    needsOpening.delete(key);
    // prompt 真的進 DSH 了才用掉交接摘要；送失敗時下一則還會再帶一次。
    if (reload && takeReloadSummary(reloadStore, key)) {
      saveReloadStore();
      log(`帶入交接摘要 ${key}（${reload.text.length} 字）`);
    }
    // prompt 真的進 DSH 了，反應區塊才算送達；失敗重試時還會再帶一次。
    reactionInbox.clear(key, prompt.feedbackEntries);
    log(job.reminder
      ? `已投遞提醒 ${key}`
      : job.followup
        ? `已投遞回訪 ${key}（${formatFollowupDelay(job.followup.minutes)}）`
        : `已投遞 ${key}（${job.entries.length} 則${job.direct ? '，有人叫 bot' : ''}${job.dropped ? `，略過 ${job.dropped} 則` : ''}）`);
    if (job.direct && cfg.discord.ackMessage) await sendLong(key, cfg.discord.ackMessage).catch(() => {});
    return true;
  }

  async function maybeReact(message, key, text) {
    const conf = cfg.discord.reactions;
    if (!conf.enabled || !message.guildId) return false;
    if (/^[!/]/.test(text)) return false;
    // 有圖片（附件、轉發快照、連結預覽或 component media）的訊息不自動按：
    // 戰績圖、截圖、梗圖先交給模型判斷，避免只憑文字亂按。
    const parts = messageParts(message);
    if (parts.hasImage || embedImages(parts.embeds).length > 0
      || parts.embeds.some(embedIsSensitive)) return false;

    const now = Date.now();
    if ((reactionLastAt.get(key) ?? 0) + conf.cooldownMs > now) return false;
    while (reactionTimes.length > 0 && now - reactionTimes[0] > 3_600_000) reactionTimes.shift();
    if (reactionTimes.length >= conf.maxPerHour) return false;

    refreshEmojiCatalogs();
    const candidates = retrieveEmojis(getEmojiCatalogs(), { guildId: message.guildId, text, k: 5, maxChars: 600 });
    const best = candidates
      .filter((entry) => (entry.keywordScore ?? 0) >= conf.minKeywordScore)
      .sort((a, b) => (b.keywordScore ?? 0) - (a.keywordScore ?? 0))[0];
    if (!best) return false;
    if (Math.random() > conf.probability) return false;

    try {
      await message.react(`<${best.animated ? 'a' : ''}:${best.name}:${best.id}>`);
      reactionTimes.push(now);
      reactionLastAt.set(key, now);
      log(`加了 reaction ${best.name}（${key}，score ${best.keywordScore}）`);
      return true;
    } catch (error) {
      // 最常見：bot 沒有 Add Reactions 權限（或頻道權限覆蓋）。
      log(`reaction 失敗（${key}）：${error?.message ?? error}`);
      return false;
    }
  }

  return {
    lastFrameAt: () => lastFrameAt,
    cancelPendingEntry,
    registerPending,
    answerPending,
    handleQuestion,
    handleApproval,
    autoCompact,
    clearTtftTimer,
    clearAllTtftTimers,
    armTtftTimer,
    handleSessionEvent,
    handleFrame,
    pumpEvents,
    enqueueOffline,
    flushOffline,
    enqueuePrompt,
    requireMentionInGuild,
    requireMentionFor,
    deliverPrompt,
    maybeReact,
  };
}
