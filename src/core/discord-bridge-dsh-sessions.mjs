// DSH 會話層：preset 檢查、建會話、退役與交接摘要。
// 拆自 discord-bridge.js 的 main()；會話建立走 api（DSH RPC），退役要通知回合層與各 store。
import fs from 'node:fs';
import path from 'node:path';
import { presetForChannelKey, saveSessions } from './discord-core.mjs';
import {
  buildReloadSummaryPrompt,
  clearReloadSummaryOrThrow,
  forgetReloadSummaryIfCurrent,
  persistReloadSummary,
  saveReloadFile,
} from './discord-reload.mjs';
import { findSensitive } from './discord-security.mjs';

export function createDshSessions({
  api,
  cfg,
  log,
  unwrap,
  withTimeout,
  PRIVATE_RELOAD_HEADER,
  SESSIONS_FILE,
  RELOAD_FILE,
  STATE_DIR,
  usage,
  sessions,
  sessionPresets,
  reverse,
  modelApplied,
  needsOpening,
  sessionPromises,
  epochs,
  epochOf,
  sessionWaiters,
  askTurns,
  forgetAbandonedTurns,
  pending,
  cancelPendingEntry,
  turnGate,
  followups,
  batcher,
  urgentTyping,
  refusals,
  agentSender,
  quietState,
  reactionInbox,
  imageJobs,
  pendingDraws,
  voiceJobs,
  persistImageJobs,
  runtime,
  stopTyping,
  finishProgress,
  hideCompactNotice,
  clearTtftTimer,
  client,
  agentSecrets,
  reloadStore,
  saveReloadStore,
  renameSession,
  persistedSessions,
  saveSessionPresetMap,
}) {
  // ── DSH ──────────────────────────────────────────────────────────────────

  /**
   * preset 必須存在才准建會話。
   * DSH 對未知 preset 可能套用預設值（帶完整本地工具），對 Discord 頻道等於把機器交出去。
   * 所以清單拿不到、或名字不在清單裡，都直接拒絕 —— 寧可回一句安裝提示，也不建一個高權限會話。
   */
  let presetList = null;
  async function loadPresets() {
    const { presets } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
    presetList = (presets ?? []).map((preset) => ({
      id: String(preset.id),
      broken: preset.broken ? String(preset.broken).trim() : '',
    }));
  }
  async function requirePreset(name, { refresh = false } = {}) {
    if (refresh || presetList === null) await loadPresets();
    const wanted = String(name ?? '').trim();
    const found = presetList.find((preset) => preset.id === wanted);
    if (!found) {
      // 照文件跑完 setup＋重啟 DSH 之後，橋接手上的清單可能還是舊的：重抓一次再決定。
      if (!refresh) return requirePreset(name, { refresh: true });
      const error = new Error(`preset "${wanted}" 不在 DSH 可用清單（${presetList.map((preset) => preset.id).join(', ') || '空'}）。請執行 node scripts/setup-dsh.mjs，然後重啟 DSH`);
      error.code = 'preset-missing';
      throw error;
    }
    if (found.broken) {
      // id 還在清單裡但掛載失敗時，DSH 不一定會拒絕建會話；這裡先 fail-closed。
      // 剛修好 preset、重啟 DSH 後，橋接手上的舊清單可能還標 broken：重抓一次再決定。
      if (!refresh) return requirePreset(name, { refresh: true });
      const error = new Error(`preset "${wanted}" 掛載失敗：${found.broken}。請看 DSH log 與 preset patch`);
      error.code = 'preset-broken';
      throw error;
    }
  }
  // 政治開放版是另一個 preset：只在建立會話時選，既有會話不會自己換（要 /reset）。

  async function applyModel(sessionId) {
    if (modelApplied.has(sessionId)) return;
    try {
      const selection = { sessionId, provider: cfg.dsh.provider, model: cfg.dsh.model };
      // 空的 reasoningEffort 代表「不指定」，不能傳空字串：DSH 會當成不支援的檔位。
      if (cfg.dsh.reasoningEffort) selection.reasoningEffort = cfg.dsh.reasoningEffort;
      const value = unwrap(await api.sessions.selectModel(selection), 'session.selectModel');
      modelApplied.add(sessionId);
      usage.rememberModel(sessionId, value.selected);
      log(`會話 ${sessionId} 模型 → ${value.selected?.provider}/${value.selected?.model}`);
    } catch (error) {
      // 選模型失敗不該讓訊息送不出去；下一則訊息會再試一次。
      log(`設定模型失敗 ${sessionId}：${error?.message ?? error}`);
    }
  }

  async function ensureSession(key) {
    const epoch = epochOf(key);
    const existing = sessions[key];
    if (existing) {
      await applyModel(existing);
      return existing;
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);

    const promise = (async () => {
      const agentPreset = presetForChannelKey(cfg.discord, key);
      await requirePreset(agentPreset);
      const dir = cfg.discord.sessionDir || path.join(STATE_DIR, 'discord-agents');
      fs.mkdirSync(dir, { recursive: true });
      const workspace = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
      if (workspace.created && cfg.discord.workspaceTitle) {
        await api.workspace.rename({ workspaceId: workspace.workspace.workspaceId, title: cfg.discord.workspaceTitle });
      }
      const created = unwrap(await api.sessions.create({
        workspaceId: workspace.workspace.workspaceId,
        agentPreset,
      }), 'session.create');
      const sessionId = created.sessionId;
      // 建會話期間有人按了 /reset：丟掉這個新會話，不要讓它復活。
      if (epoch !== epochOf(key)) {
        try { await withTimeout(api.workspace.archiveSession({ sessionId }), 15_000, 'archiveSession'); } catch { /* 已經沒了 */ }
        throw new Error('會話建立期間已重置，本次投遞取消');
      }
      await renameSession(sessionId, key);
      // rename 也是 await：期間有人按 /reset 的話，retireSession 看不到這個會話，
      // 會回「沒有可重置的會話」；這裡再確認一次，避免重置被吃掉。
      if (epoch !== epochOf(key)) {
        try { await withTimeout(api.workspace.archiveSession({ sessionId }), 15_000, 'archiveSession'); } catch { /* 已經沒了 */ }
        throw new Error('會話建立期間已重置，本次投遞取消');
      }
      // 新版事件流要顯式 follow，否則收不到 turn 事件（也就永遠不會有回覆）。
      api.events.follow(sessionId);
      sessions[key] = sessionId;
      sessionPresets[sessionId] = agentPreset;
      reverse.set(sessionId, key);
      // 只有真的新建會話才標記開場。sessions 會從磁碟載入，重啟後 existing 分支
      // 不會走到這裡，所以部署重啟後的第一批不會再被叫去主動說話。
      needsOpening.add(key);
      saveSessions(SESSIONS_FILE, persistedSessions());
      saveSessionPresetMap();
      await applyModel(sessionId);
      log(`新會話 ${key} → ${sessionId}（preset ${agentPreset}）`);
      return sessionId;
    })();

    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  async function retireSession(key, { preservePending = false, onRetired = null } = {}) {
    stopTyping(key);
    finishProgress(key);
    hideCompactNotice(key);
    const activeSession = sessions[key];
    if (activeSession) clearTtftTimer(activeSession);
    // 純 per-key 的執行期狀態一次清掉；清單只有 runtime-state 那份，新增狀態不會漏。
    runtime.forgetKey(key);
    epochs.set(key, epochOf(key) + 1);
    // 重載提示：後續訊息要跟著新會話走。換代次後立刻改排隊批次的 epoch，
    // deliverPrompt 才不會把它們當成舊對話丟掉。
    if (preservePending) turnGate.rebase(key, epochOf(key));
    // 回訪屬於舊對話，/reset 之後不要再送。重載人格不算重置，排程跟著同一個 key 留著。
    if (!preservePending) followups.forget(key);
    // 還沒送出的那批（含 DSH 斷線時排著的）屬於舊對話，不能進新會話；新會話要重新帶一次頻道上下文。
    // 重載提示是例外：排隊中的訊息要留著，等新會話開好再送。
    if (!preservePending) {
      batcher.drop(key);
      turnGate.drop(key);
      urgentTyping.drop(key);
    }
    refusals.forget(key);
    agentSender.forgetKey(key);
    quietState.forget(key);
    reactionInbox.clear(key);
    for (const [jobId, job] of imageJobs) if (job.key === key) imageJobs.delete(jobId);
    for (const [name, entry] of pendingDraws) if (entry.key === key) pendingDraws.delete(name);
    persistImageJobs();
    for (const [jobId, job] of voiceJobs) {
      if (job.key !== key) continue;
      voiceJobs.delete(jobId);
      void job.notice?.delete().catch(() => {});
    }
    const entry = pending.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(key);
      void cancelPendingEntry(entry);
    }
    const sessionId = sessions[key];
    if (!sessionId) return false;

    // 掛在這個會話上的 /ask 等不到回答了，先讓它失敗，不要讓使用者乾等逾時。
    askTurns.get(sessionId)?.abort(new Error('會話已重置'), 0);
    sessionWaiters.get(sessionId)?.fail(new Error('會話已重置'));
    forgetAbandonedTurns(sessionId);
    runtime.forgetSession(sessionId);
    api.events.forget(sessionId);
    delete sessions[key];
    reverse.delete(sessionId);
    // 映射已經移除：之後就算存檔或歸檔失敗，也算「退役已發生」，交接摘要不能跟著刪。
    onRetired?.();
    agentSender.forget(sessionId);
    delete sessionPresets[sessionId];
    saveSessions(SESSIONS_FILE, persistedSessions());
    saveSessionPresetMap();

    // 佇列要清、回合要取消，最後才歸檔（歸檔只是隱藏，不會停掉還在跑的工作）。
    try {
      await withTimeout(api.stopSessionWork(sessionId), 15_000, 'stopSessionWork');
    } catch (error) {
      log(`⚠️ 停止舊會話失敗 ${key}：${error?.message ?? error}`);
    }
    try {
      await withTimeout(api.workspace.archiveSession({ sessionId }), 15_000, 'archiveSession');
    } catch (error) {
      log(`⚠️ 歸檔舊會話失敗 ${key}：${error?.message ?? error}`);
    }
    log(`已重置會話 ${key}（舊 ${sessionId}）`);
    return true;
  }

  /** /reset：連同還沒用掉的交接摘要一起清掉；下一則訊息完全重來。 */
  async function resetConversation(key) {
    try {
      // 摘要清不掉就不要重置；否則重啟後磁碟上的舊摘要會復活。
      clearReloadSummaryOrThrow(reloadStore, key, () => saveReloadFile(RELOAD_FILE, reloadStore));
    } catch (error) {
      log(`清除交接摘要失敗 ${key}：${error?.message ?? error}`);
      throw error;
    }
    return retireSession(key);
  }

  /**
   * /reload-system-prompt：排進同一條會話佇列，等目前回合結束後在舊會話產生交接摘要，再清掉會話。
   * 摘要失敗就不清，避免把還接得上的對話弄丟；排隊期間的新訊息留在 bridge，重載後進新會話。
   */
  async function reloadSystemPrompt(key) {
    // 先把還沒送出的頻道訊息排進佇列，摘要才會包含它們。
    batcher.flush(key);
    if (!sessions[key] && !turnGate.hasPending(key)) {
      return {
        summarized: false,
        cleared: false,
        chars: 0,
        message: '目前沒有會話可總結；下一則訊息會用 DSH 目前載入的 system prompt 開新會話。',
      };
    }
    const channelName = key.startsWith('ch:')
      ? client.channels.cache.get(key.slice(3))?.name
      : '';
    const prompt = buildReloadSummaryPrompt({
      channelName,
      isDm: key.startsWith('dm:'),
    });
    const ask = {
      question: prompt,
      header: PRIVATE_RELOAD_HEADER,
      holdAfterAnswer: true,
    };
    let summary;
    try {
      summary = await new Promise((resolve, reject) => {
        ask.resolve = resolve;
        ask.reject = reject;
        turnGate.submit(key, { ask }, { noStuckRelease: true });
      });
    } catch (error) {
      throw new Error(`產生交接摘要失敗（${error?.message ?? error}）`);
    }
    if (cfg.discord.security.blockSensitive && findSensitive(summary, agentSecrets())) {
      log(`重載摘要 ${key}：命中敏感資訊閘門，不保存`);
      summary = '';
    }
    let cleared = false;
    let retired = false;
    let superseded = false;
    let entry = null;
    const dropOwnSummary = () => {
      // 只刪自己那一筆；中間被新的 reload 覆蓋就不能動別人的摘要。
      if (entry && forgetReloadSummaryIfCurrent(reloadStore, key, entry)) saveReloadStore();
      entry = null;
    };
    try {
      // 先落盤再退役：寫檔失敗就保留舊會話，不能回報成功卻在重啟後找不到摘要。
      entry = persistReloadSummary(reloadStore, { key, text: summary, file: RELOAD_FILE });
      const epochBeforeRetire = epochOf(key);
      cleared = await retireSession(key, {
        preservePending: true,
        onRetired: () => { retired = true; },
      });
      if (!cleared || epochOf(key) !== epochBeforeRetire + 1) {
        // 會話沒退成，或退役期間被另一個 /reset／重載插隊：不要把自己的摘要留給下一段對話。
        superseded = epochOf(key) !== epochBeforeRetire + 1;
        dropOwnSummary();
      } else if (entry && reloadStore.summaries[key] !== entry) {
        // 另一個 reload 已經接走這個頻道；它的摘要留著，這次不要回報成功。
        superseded = true;
        entry = null;
      } else {
        log(`重載 system prompt ${key}：摘要 ${entry?.text.length ?? 0} 字`);
      }
    } catch (error) {
      // 映射已移除（retired）就保留摘要；只刪「根本沒退成」的那一份。
      if (!retired) dropOwnSummary();
      throw error;
    } finally {
      // 舊會話已經退役（或不需要退役）：放行排隊的訊息，它們會用新的代次進新會話。
      // ticket 確保舊 reload 不會放到新 reload 的閘門。
      turnGate.resume(key, { force: cleared || retired, ticket: ask.ticket });
    }
    return {
      summarized: Boolean(entry),
      cleared,
      chars: entry?.text.length ?? 0,
      message: superseded
        ? '期間有另一個重置／重載接手，這次的摘要沒有套用。'
        : entry
          ? `已記下 ${entry.text.length} 字的對話摘要，會話已重置；排隊中的訊息會在新會話接續。`
          : cleared
            ? '這一輪沒有可交接的重點，會話已重置；排隊中的訊息會在新會話接續。'
            : '找不到可以重置的會話；排隊中的訊息會照常處理。',
    };
  }
return {
    loadPresets,
    requirePreset,
    applyModel,
    ensureSession,
    retireSession,
    resetConversation,
    reloadSystemPrompt,
  };
}
