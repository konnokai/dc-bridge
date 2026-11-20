// 回合層：提問與審批、事件流、自動壓縮、TTFT。
//
// 這一段是「DSH 問問題／要審批 → 貼到頻道 → 等人回答 → 回覆 DSH」，加上事件流本身。
// 只有它會碰 pending 這個 Map，所以搬出來仍然只有一個寫入者。
import { canAnswerPending, describeToolCall, parseApprovalAnswer, questionAnswersFor, questionAudience, shouldAutoCompact } from './discord-core.mjs';

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
    enqueuePrompt,
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
  };
}
