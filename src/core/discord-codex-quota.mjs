// Codex（ChatGPT 方案）額度與 5 小時窗口重置觸發。
//
// 額度用 `codex app-server` 的 account/rateLimits/read 查：app-server 會自己刷新
// ~/.codex/auth.json 的 token，橋接不用碰 access token，也不會跟 Codex CLI 搶刷新。
// 生圖的開關在 preset 的 dc-tool-restrict.config.allowImageGen；沒有開生圖就不查額度，
// 也不排重置 ping。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { untilText } from './discord-usage.mjs';

export const CODEX_PING_MODEL = 'gpt-6-luna';
export const CODEX_QUOTA_TTL_MS = 5 * 60_000;
// 額度太低時先停生圖，免得畫到一半被擋或把最後一點額度用完。
export const CODEX_DRAW_MIN_FIVE_HOUR_PERCENT = 15;
export const CODEX_DRAW_MIN_WEEKLY_PERCENT = 5;
const CODEX_QUOTA_FAILURE_TTL_MS = 60_000;
const CODEX_USAGE_TIMEOUT_MS = 15_000;
const CODEX_PING_TIMEOUT_MS = 90_000;
export const CODEX_RESET_GRACE_MS = 30_000;
export const CODEX_RESET_RETRY_MS = 15 * 60_000;

/** app-server 的 rateLimits 回應 → 橋接用的形狀；時間轉成毫秒。 */
export function normalizeCodexRateLimits(result) {
  const limits = result?.rateLimits ?? result?.rateLimitsByLimitId?.codex;
  if (!limits) throw new Error('Codex 沒回額度資料');
  const toWindow = (window) => {
    if (!window) return null;
    const used = Number(window.usedPercent);
    if (!Number.isFinite(used)) return null;
    return {
      usedPercent: Math.max(0, Math.min(100, used)),
      remainingPercent: Math.max(0, Math.min(100, 100 - used)),
      resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : null,
      windowMinutes: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null,
    };
  };
  return {
    planType: limits.planType ?? null,
    fiveHour: toWindow(limits.primary),
    weekly: toWindow(limits.secondary),
    credits: limits.credits ?? null,
    resetCredits: result?.rateLimitResetCredits ?? null,
  };
}

/**
 * 用 Codex app-server 的 account/rateLimits/read 查額度。
 * 每次開一個短命的 app-server，拿到回應就殺掉；它不跑模型。
 */
export function readCodexRateLimits({
  codexBin = process.env.CODEX_BIN || 'codex',
  timeoutMs = CODEX_USAGE_TIMEOUT_MS,
  spawnImpl = spawn,
  cwd = os.tmpdir(),
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(codexBin, ['app-server'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      reject(new Error(`無法啟動 Codex：${error?.message ?? error}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let asked = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* 已經結束 */ }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`查 Codex 額度逾時（${timeoutMs}ms）`)), timeoutMs);
    const send = (message) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch (error) { finish(new Error(`寫入 Codex app-server 失敗：${error?.message ?? error}`)); }
    };

    child.on('error', (error) => finish(new Error(`無法啟動 Codex：${error?.message ?? error}`)));
    child.stdin.on?.('error', (error) => finish(new Error(`寫入 Codex app-server 失敗：${error?.message ?? error}`)));
    child.on('close', (code) => finish(new Error(`Codex app-server 提前結束（${code}）：${stderr.trim().slice(-300)}`)));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let index;
      while ((index = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error(`Codex app-server 初始化失敗：${message.error.message ?? JSON.stringify(message.error)}`));
            return;
          }
          if (!asked) {
            asked = true;
            send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: null });
          }
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error(`查 Codex 額度失敗：${message.error.message ?? JSON.stringify(message.error)}`));
            return;
          }
          try { finish(null, normalizeCodexRateLimits(message.result)); }
          catch (error) { finish(error); }
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'dc-bridge', version: '0.0.0' }, capabilities: { experimentalApi: true } },
    });
  });
}

/** 生圖的低額度守門：5 小時剩不到 15% 或每週剩不到 5% 就暫停。 */
export function codexDrawGate(result) {
  if (!result?.ok) return { allowed: true, reason: null };
  const five = result.fiveHour?.remainingPercent;
  const weekly = result.weekly?.remainingPercent;
  if (Number.isFinite(five) && five < CODEX_DRAW_MIN_FIVE_HOUR_PERCENT) {
    return {
      allowed: false,
      reason: `Codex 5 小時額度剩 ${Math.round(five)}%（低於 ${CODEX_DRAW_MIN_FIVE_HOUR_PERCENT}%），先不畫圖；額度恢復後會自動再開`,
    };
  }
  if (Number.isFinite(weekly) && weekly < CODEX_DRAW_MIN_WEEKLY_PERCENT) {
    return {
      allowed: false,
      reason: `Codex 每週額度剩 ${Math.round(weekly)}%（低於 ${CODEX_DRAW_MIN_WEEKLY_PERCENT}%），先不畫圖；額度恢復後會自動再開`,
    };
  }
  return { allowed: true, reason: null };
}

/** 給畫圖外掛讀的額度快照；生圖端只認 fetchedAt 還新鮮的檔案。 */
function writeQuotaSnapshot(file, value) {
  if (!file) return;
  try {
    const gate = codexDrawGate(value);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({
      fetchedAt: value.fetchedAt,
      drawAllowed: gate.allowed,
      drawBlockedReason: gate.reason,
      fiveHour: value.fiveHour,
      weekly: value.weekly,
    }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 快照寫不進去時，畫圖端會當成沒有資料而放行 */ }
}

/** 快取額度查詢；成功 5 分鐘、失敗 60 秒，控制台每 5 秒刷新也不會一直開 app-server。 */
export function createCodexQuota({
  read = readCodexRateLimits,
  ttlMs = CODEX_QUOTA_TTL_MS,
  failureTtlMs = CODEX_QUOTA_FAILURE_TTL_MS,
  now = Date.now,
  snapshotFile = null,
} = {}) {
  let cached = null;
  let inflight = null;

  async function load() {
    try {
      const value = { ok: true, ...(await read()), fetchedAt: now() };
      if (value.ok) writeQuotaSnapshot(snapshotFile, value);
      return value;
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), fetchedAt: now() };
    }
  }

  return {
    async get({ force = false } = {}) {
      const ttl = cached?.value?.ok ? ttlMs : failureTtlMs;
      if (!force && cached && now() - cached.at < ttl) return cached.value;
      inflight ??= load().then((value) => {
        cached = { value, at: now() };
        return value;
      }).finally(() => { inflight = null; });
      return inflight;
    },
  };
}

/** `/status` 用的一行；沒有開生圖（skipped）時回空字串。 */
export function formatCodexQuota(result, now = Date.now()) {
  if (!result || result.skipped) return '';
  if (!result.ok) return `Codex 額度：查不到（${result.error ?? '未知原因'}）`;
  const parts = [];
  if (result.fiveHour) {
    const remaining = result.fiveHour.resetsAt ? result.fiveHour.resetsAt - now : null;
    const reset = remaining === null ? ''
      : remaining > 0 ? `（${untilText(remaining)}後重置）` : '（已重置，等下一則訊息）';
    parts.push(`5 小時剩 ${Math.round(result.fiveHour.remainingPercent)}%${reset}`);
  }
  if (result.weekly) {
    const remaining = result.weekly.resetsAt ? result.weekly.resetsAt - now : null;
    const reset = remaining === null ? ''
      : remaining > 0 ? `（${untilText(remaining)}後重置）` : '（已重置）';
    parts.push(`每週剩 ${Math.round(result.weekly.remainingPercent)}%${reset}`);
  }
  if (result.resetCredits?.availableCount > 0) parts.push(`重置券 ${result.resetCredits.availableCount} 張`);
  if (result.credits?.hasCredits && Number(result.credits.balance) > 0) parts.push(`credits ${result.credits.balance}`);
  return `Codex 額度：${parts.join('｜')}`;
}

/** preset 來源裡的 dc-tool-restrict.config.allowImageGen；讀不到就當沒開。 */
export function presetAllowsImageGen({ root, presetId }) {
  if (!root || !presetId) return false;
  const file = path.join(root, 'dsh', 'agent-presets', presetId, 'agent.cordis.yml');
  try {
    const rows = yaml.load(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows)
      && rows.some((row) => row?.id === 'dc-tool-restrict' && row?.config?.allowImageGen === true);
  } catch {
    return false;
  }
}

/**
 * 送一則短訊息把新的 5 小時窗口打開。
 * 用 luna、low reasoning、ephemeral，關掉 shell/檔案工具，只留模型回應。
 */
export function runCodexResetPing({
  codexBin = process.env.CODEX_BIN || 'codex',
  model = CODEX_PING_MODEL,
  timeoutMs = CODEX_PING_TIMEOUT_MS,
  spawnImpl = spawn,
  cwd = path.join(os.tmpdir(), 'dc-codex-reset'),
  signal,
} = {}) {
  fs.mkdirSync(cwd, { recursive: true });
  const args = [
    'exec', '--skip-git-repo-check', '-C', cwd, '--ephemeral',
    '--ignore-user-config', '--ignore-rules',
    '-s', 'read-only',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'view_image',
    '-m', model,
    '-c', 'model_reasoning_effort="low"',
    '--json', '--', 'test',
  ];
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'));
      return;
    }
    let child;
    try {
      child = spawnImpl(codexBin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
    } catch (error) {
      reject(new Error(`無法啟動 Codex：${error?.message ?? error}`));
      return;
    }

    let stderr = '';
    let settled = false;
    let onAbort;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      try { child.kill('SIGKILL'); } catch { /* 已經結束 */ }
      if (error) reject(error);
      else if (code === 0) resolve();
      else reject(new Error(`Codex 重置 ping 失敗（exit ${code}）：${stderr.trim().slice(-300)}`));
    };
    const timer = setTimeout(() => finish(new Error(`Codex 重置 ping 逾時（${timeoutMs}ms）`)), timeoutMs);
    onAbort = () => finish(new Error('已取消'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (error) => finish(new Error(`無法啟動 Codex：${error?.message ?? error}`)));
    child.on('close', (code) => finish(null, code));
  });
}

function emptyResetState() {
  return { lastPingedResetAt: null, lastAttemptAt: null, lastPingError: null };
}

function loadResetState(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('狀態格式不對');
    return {
      ok: true,
      state: {
        lastPingedResetAt: Number.isFinite(doc.lastPingedResetAt) ? doc.lastPingedResetAt : null,
        lastAttemptAt: Number.isFinite(doc.lastAttemptAt) ? doc.lastAttemptAt : null,
        lastPingError: typeof doc.lastPingError === 'string' ? doc.lastPingError : null,
      },
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, state: emptyResetState() };
    return { ok: false, error: `狀態檔讀取失敗：${error?.message ?? error}` };
  }
}

function saveResetState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 5 小時窗口的守門員：到 resetsAt 後送一則 test 把新窗口打開。
 * 狀態存檔，橋接重啟不會對同一個 resetsAt 重送；失敗 15 分鐘後再試。
 */
export function createCodexResetPinger({
  quota,
  runPing = runCodexResetPing,
  stateFile,
  log = () => {},
  now = Date.now,
  pollMs = CODEX_QUOTA_TTL_MS,
  retryMs = CODEX_RESET_RETRY_MS,
  graceMs = CODEX_RESET_GRACE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let stopped = false;
  let running = false;
  let currentPing = null;
  const loaded = loadResetState(stateFile);
  const state = loaded.state;
  let stateUsable = loaded.ok;
  if (!loaded.ok) log(`Codex 重置狀態讀取失敗，停止付費 ping：${loaded.error}`);

  const save = () => {
    if (!stateUsable) return false;
    try {
      saveResetState(stateFile, state);
      return true;
    } catch (error) {
      stateUsable = false;
      log(`Codex 重置狀態寫入失敗，停止付費 ping：${error?.message ?? error}`);
      return false;
    }
  };

  async function tick() {
    if (stopped || running) return;
    if (timer) { clearTimer(timer); timer = null; }
    running = true;
    try {
      let usage = await quota.get();
      if (stopped) return;
      const cachedResetAt = usage?.ok ? usage.fiveHour?.resetsAt : null;
      // 快取可能還是舊窗口；重置時間到了就先重查，避免使用者已經自己開新窗口還多送一次 ping。
      if (cachedResetAt && now() >= cachedResetAt + graceMs && state.lastPingedResetAt !== cachedResetAt) {
        usage = await quota.get({ force: true });
        if (stopped) return;
      }
      const resetAt = usage?.ok ? usage.fiveHour?.resetsAt : null;
      if (resetAt) {
        const due = resetAt + graceMs;
        const pinged = state.lastPingedResetAt === resetAt;
        const retryAt = state.lastAttemptAt ? state.lastAttemptAt + retryMs : 0;
        const weeklyFull = usage.weekly && usage.weekly.usedPercent >= 100;
        if (stateUsable && !pinged && !weeklyFull && now() >= due && now() >= retryAt) {
          state.lastAttemptAt = now();
          if (!save()) {
            log('Codex 重置狀態無法寫入，這次不送 ping');
          } else {
            log(`Codex 5 小時窗口已重置，送出 ${CODEX_PING_MODEL} 的 test`);
            const controller = new AbortController();
            currentPing = controller;
            try {
              await runPing({ signal: controller.signal });
              state.lastPingedResetAt = resetAt;
              state.lastPingError = null;
              log('Codex 5 小時窗口已重新開始');
              await quota.get({ force: true }).catch(() => {});
            } catch (error) {
              state.lastPingError = String(error?.message ?? error);
              log(`Codex 重置觸發失敗：${state.lastPingError}`);
            } finally {
              currentPing = null;
              save();
            }
          }
        }
      }
      if (stopped) return;
      const nextPoll = now() + pollMs;
      const nextReset = resetAt ? resetAt + graceMs + 1000 : 0;
      const wake = nextReset > now() ? Math.min(nextPoll, nextReset) : nextPoll;
      timer = setTimer(tick, Math.max(1000, wake - now()));
      timer.unref?.();
    } catch (error) {
      log(`Codex 額度檢查失敗：${error?.message ?? error}`);
      if (stopped) return;
      timer = setTimer(tick, Math.max(1000, pollMs));
      timer.unref?.();
    } finally {
      running = false;
    }
  }

  return {
    start() { if (!timer && !stopped) void tick(); },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      currentPing?.abort();
      currentPing = null;
    },
    tick,
  };
}
