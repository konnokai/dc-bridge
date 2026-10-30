// Codex 額度查詢與 5 小時窗口重置 ping 的離線回歸。
//   node scripts/test-discord-codex-quota.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  CODEX_DRAW_MIN_FIVE_HOUR_PERCENT,
  CODEX_DRAW_MIN_WEEKLY_PERCENT,
  CODEX_PING_MODEL,
  CODEX_RESET_GRACE_MS,
  CODEX_RESET_RETRY_MS,
  codexDrawGate,
  createCodexQuota,
  createCodexResetPinger,
  formatCodexQuota,
  normalizeCodexRateLimits,
  presetAllowsImageGen,
  readCodexRateLimits,
  runCodexResetPing,
} from '../src/core/discord-codex-quota.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = {
  rateLimits: {
    limitId: 'codex',
    planType: 'plus',
    primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1793362572 },
    secondary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1793931236 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
  },
  rateLimitResetCredits: { availableCount: 1 },
};

console.log('## 1. 額度資料');
{
  const normalized = normalizeCodexRateLimits(FIXTURE);
  ok(normalized.planType === 'plus', '方案代號保留');
  ok(normalized.fiveHour.remainingPercent === 94, '5 小時剩餘百分比 = 100 - 已用');
  ok(normalized.fiveHour.resetsAt === 1793362572000, '重置時間轉成毫秒');
  ok(normalized.weekly.remainingPercent === 85, '每週剩餘百分比');
  ok(normalized.credits.balance === '0', 'credits 原樣保留');
  ok(normalized.resetCredits.availableCount === 1, '重置券張數保留');

  const now = 1793362572000 - 2 * 60 * 60 * 1000;
  const line = formatCodexQuota({ ok: true, ...normalized, fetchedAt: now }, now);
  ok(line.startsWith('Codex 額度：') && line.includes('5 小時剩 94%'), '/status 顯示 5 小時剩餘');
  ok(line.includes('2 小時 0 分後重置'), '/status 顯示 5 小時重置倒數');
  ok(line.includes('每週剩 85%（'), '/status 顯示每週重置倒數');
  ok(line.includes('重置券 1 張'), '/status 顯示重置券');
  ok(formatCodexQuota({ skipped: true }) === '', '沒開生圖時不顯示');
  ok(formatCodexQuota({ ok: false, error: 'boom' }).includes('查不到（boom）'), '查不到時顯示原因');
  ok(CODEX_RESET_GRACE_MS === 30_000 && CODEX_RESET_RETRY_MS === 15 * 60_000,
    '預設重置緩衝 30 秒、失敗重試 15 分鐘');
}

console.log('## 1b. 生圖額度門檻');
{
  const gate = (five, weekly) => codexDrawGate({ ok: true, fiveHour: { remainingPercent: five }, weekly: { remainingPercent: weekly } });
  ok(CODEX_DRAW_MIN_FIVE_HOUR_PERCENT === 15 && CODEX_DRAW_MIN_WEEKLY_PERCENT === 5, '門檻是 5 小時 15%、每週 5%');
  ok(gate(15, 5).allowed === true, '剛好 15% 與 5% 仍可畫');
  ok(gate(14, 50).allowed === false && /5 小時額度剩 14%/.test(gate(14, 50).reason), '5 小時低於 15% 暫停');
  ok(gate(50, 4).allowed === false && /每週額度剩 4%/.test(gate(50, 4).reason), '每週低於 5% 暫停');
  ok(gate(50, 50).allowed === true && gate(50, 50).reason === null, '額度足夠時放行');
  ok(codexDrawGate({ ok: true }).allowed === true && codexDrawGate({ ok: false }).allowed === true, '沒有額度資料時不擋');
}

console.log('## 2. preset 的生圖開關');
{
  ok(presetAllowsImageGen({ root: ROOT, presetId: 'dc-chat' }) === true, 'dc-chat 有開 allowImageGen');
  ok(presetAllowsImageGen({ root: ROOT, presetId: 'dc-learner' }) === false, 'dc-learner 沒開 allowImageGen');
  ok(presetAllowsImageGen({ root: ROOT, presetId: 'missing' }) === false, '讀不到 preset 時當沒開');
}

console.log('## 3. 額度快取');
{
  let reads = 0;
  let clock = 1_000;
  const normalized = normalizeCodexRateLimits(FIXTURE);
  const quota = createCodexQuota({
    read: async () => { reads += 1; return normalized; },
    ttlMs: 1_000,
    failureTtlMs: 100,
    now: () => clock,
  });
  const first = await quota.get();
  await quota.get();
  ok(first.ok && reads === 1, '快取內只查一次');
  clock += 1_001;
  await quota.get();
  ok(reads === 2, '快取過期後重查');
  await quota.get({ force: true });
  ok(reads === 3, 'force 會重查');

  let fails = 0;
  const failing = createCodexQuota({
    read: async () => { fails += 1; throw new Error('nope'); },
    failureTtlMs: 100,
    now: () => clock,
  });
  const bad = await failing.get();
  ok(!bad.ok && bad.error.includes('nope') && fails === 1, '失敗回原因');
  await failing.get();
  ok(fails === 1, '失敗也快取');
  clock += 101;
  await failing.get();
  ok(fails === 2, '失敗快取過期後重試');
}

console.log('## 3b. 生圖額度快照');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-codex-snapshot-'));
  const low = normalizeCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 90, resetsAt: 100 },
      secondary: { usedPercent: 50, resetsAt: 200 },
    },
  });
  const file = path.join(dir, 'quota.json');
  const quota = createCodexQuota({ read: async () => low, now: () => 5_000, snapshotFile: file });
  await quota.get();
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(snapshot.fetchedAt === 5_000 && snapshot.drawAllowed === false
    && /低於 15%/.test(snapshot.drawBlockedReason), '低額度寫入暫停生圖的快照');
  ok(snapshot.fiveHour.remainingPercent === 10 && snapshot.weekly.remainingPercent === 50,
    '快照帶兩個窗口的剩餘百分比');

  const okFile = path.join(dir, 'ok.json');
  const good = createCodexQuota({ read: async () => normalizeCodexRateLimits(FIXTURE), now: () => 6_000, snapshotFile: okFile });
  await good.get();
  ok(JSON.parse(fs.readFileSync(okFile, 'utf8')).drawAllowed === true, '額度足夠時快照放行');

  const failFile = path.join(dir, 'fail.json');
  const failing = createCodexQuota({ read: async () => { throw new Error('nope'); }, snapshotFile: failFile });
  await failing.get();
  ok(!fs.existsSync(failFile), '查詢失敗不寫快照');

  const blocked = path.join(dir, 'blocked');
  fs.mkdirSync(blocked);
  const unwritable = createCodexQuota({ read: async () => low, now: () => 7_000, snapshotFile: blocked });
  ok((await unwritable.get()).ok, '快照寫不進去不影響額度查詢');
  fs.rmSync(dir, { recursive: true, force: true });
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {} };
  child.kill = () => {};
  return child;
}

console.log('## 4. app-server 查額度');
{
  const child = fakeChild();
  let spawned = null;
  child.stdin.write = (line) => {
    const message = JSON.parse(line);
    if (message.id === 2) {
      setImmediate(() => child.stdout.emit('data', `${JSON.stringify({ id: 2, result: FIXTURE })}\n`));
    }
  };
  const spawnImpl = (bin, args, options) => {
    spawned = { bin, args, options };
    setImmediate(() => child.stdout.emit('data', `${JSON.stringify({ id: 1, result: {} })}\n`));
    return child;
  };
  const result = await readCodexRateLimits({ spawnImpl, cwd: os.tmpdir() });
  ok(spawned?.args?.[0] === 'app-server', '用 codex app-server 查');
  ok(result.fiveHour.remainingPercent === 94, '解析 app-server 的 rateLimits');
}

console.log('## 4b. app-server stdin 錯誤');
{
  const child = fakeChild();
  child.stdin = new EventEmitter();
  child.stdin.write = () => { setImmediate(() => child.stdin.emit('error', new Error('EPIPE'))); };
  let error = null;
  try { await readCodexRateLimits({ spawnImpl: () => child, cwd: os.tmpdir() }); }
  catch (err) { error = err; }
  ok(error && /寫入 Codex app-server 失敗/.test(error.message), 'stdin EPIPE 會回錯誤，不會讓程序崩潰');
}

console.log('## 5. 重置 ping 的參數');
{
  const child = fakeChild();
  let captured = null;
  const spawnImpl = (bin, args, options) => {
    captured = { bin, args, options };
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-codex-ping-'));
  await runCodexResetPing({ spawnImpl, cwd });
  ok(captured.args.includes('-m') && captured.args[captured.args.indexOf('-m') + 1] === CODEX_PING_MODEL,
    '重置 ping 用 luna 模型');
  ok(captured.args.includes('--ephemeral') && captured.args.includes('--') && captured.args.at(-1) === 'test',
    '重置 ping 是 ephemeral 的 test');
  ok(captured.args[captured.args.indexOf('-s') + 1] === 'read-only', '重置 ping 用 read-only');
  ok(captured.args.includes('shell_tool') && captured.args.includes('unified_exec') && captured.args.includes('view_image'),
    '重置 ping 關掉 shell／unified_exec／view_image');
  ok(captured.args.includes('model_reasoning_effort="low"'), '重置 ping 用 low reasoning');
  ok(captured.args.includes('--ignore-user-config') && captured.args.includes('--ignore-rules'),
    '重置 ping 忽略使用者設定與 rules');
  fs.rmSync(cwd, { recursive: true, force: true });
}

function makePinger({ resetsAt, weekly = 10, stateFile, runPing, now, retryMs = 10_000, graceMs = 0 }) {
  const quota = { get: async () => ({ ok: true, fiveHour: { resetsAt }, weekly: { usedPercent: weekly } }) };
  return createCodexResetPinger({ quota, runPing, stateFile, now, pollMs: 1e9, retryMs, graceMs });
}

console.log('## 6. 5 小時重置排程');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-codex-reset-'));
  const stateFile = path.join(dir, 'reset.json');
  let clock = 1_000_000;
  let pings = 0;
  const pinger = makePinger({
    resetsAt: clock + 60_000,
    stateFile,
    runPing: async () => { pings += 1; },
    now: () => clock,
  });
  await pinger.tick();
  ok(pings === 0, '還沒到重置時間不 ping');
  clock += 60_001;
  await pinger.tick();
  ok(pings === 1, '重置後 ping 一次');
  await pinger.tick();
  ok(pings === 1, '同一個重置時間不重複 ping');
  pinger.stop();

  const restarted = makePinger({
    resetsAt: 1_060_000,
    stateFile,
    runPing: async () => { pings += 1; },
    now: () => clock,
  });
  await restarted.tick();
  ok(pings === 1, '重啟後看 state 不重複 ping');
  restarted.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('## 7. 失敗重試與每週額度');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-codex-retry-'));
  const stateFile = path.join(dir, 'reset.json');
  let clock = 2_000_000;
  let attempts = 0;
  const pinger = makePinger({
    resetsAt: 2_000_000,
    stateFile,
    runPing: async () => { attempts += 1; throw new Error('boom'); },
    now: () => clock,
  });
  await pinger.tick();
  ok(attempts === 1, '失敗一次');
  clock += 9_999;
  await pinger.tick();
  ok(attempts === 1, '15 分鐘內不重試');
  clock += 1;
  await pinger.tick();
  ok(attempts === 2, '重試時間到再試');
  pinger.stop();

  const weeklyState = path.join(dir, 'weekly.json');
  let weeklyPings = 0;
  const weeklyFull = makePinger({
    resetsAt: 3_000_000,
    weekly: 100,
    stateFile: weeklyState,
    runPing: async () => { weeklyPings += 1; },
    now: () => 3_060_000,
    graceMs: 30_000,
  });
  await weeklyFull.tick();
  ok(weeklyPings === 0, '每週額度已滿時不 ping');
  weeklyFull.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('## 8. 快取、停止與狀態檔的邊界');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-codex-edge-'));
  const stateFile = path.join(dir, 'reset.json');

  // 快取還是舊窗口時，重置時間到了要先重查，避免使用者已自己開新窗口還多送 ping。
  let forced = 0;
  let cachedPings = 0;
  const cachedQuota = {
    get: async ({ force } = {}) => {
      if (force) {
        forced += 1;
        return { ok: true, fiveHour: { resetsAt: 1_000_000 + 3_600_000 }, weekly: { usedPercent: 10 } };
      }
      return { ok: true, fiveHour: { resetsAt: 1_000_000 }, weekly: { usedPercent: 10 } };
    },
  };
  const cachedPinger = createCodexResetPinger({
    quota: cachedQuota,
    runPing: async () => { cachedPings += 1; },
    stateFile,
    now: () => 1_000_001,
    pollMs: 1e9,
    graceMs: 0,
  });
  await cachedPinger.tick();
  ok(forced === 1 && cachedPings === 0, '快取到期時先重查，不直接 ping');
  cachedPinger.stop();

  // stop() 發生在等額度查詢時，查詢回來也不能接著 ping。
  let resolveQuery;
  let stoppedPings = 0;
  const slowQuota = { get: () => new Promise((resolve) => { resolveQuery = resolve; }) };
  const stoppedPinger = createCodexResetPinger({
    quota: slowQuota,
    runPing: async () => { stoppedPings += 1; },
    stateFile,
    now: () => 2_000_001,
    pollMs: 1e9,
    graceMs: 0,
  });
  const pendingQuery = stoppedPinger.tick();
  stoppedPinger.stop();
  resolveQuery({ ok: true, fiveHour: { resetsAt: 2_000_000 }, weekly: { usedPercent: 10 } });
  await pendingQuery;
  ok(stoppedPings === 0, 'stop 後等待中的查詢不會接著 ping');

  // stop() 要取消已經在跑的 ping。
  let pingSignal = null;
  let abortedPings = 0;
  const fastQuota = { get: async () => ({ ok: true, fiveHour: { resetsAt: 2_000_000 }, weekly: { usedPercent: 10 } }) };
  const abortPinger = createCodexResetPinger({
    quota: fastQuota,
    runPing: async ({ signal }) => {
      pingSignal = signal;
      abortedPings += 1;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true }));
    },
    stateFile,
    now: () => 2_000_001,
    pollMs: 1e9,
    graceMs: 0,
  });
  const pendingPing = abortPinger.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  abortPinger.stop();
  await pendingPing;
  ok(abortedPings === 1 && pingSignal?.aborted === true, 'stop 會取消進行中的 ping');

  // 狀態檔損壞：不花額度 ping。
  const corruptFile = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptFile, 'not json');
  let corruptPings = 0;
  const corruptLogs = [];
  const corruptPinger = createCodexResetPinger({
    quota: fastQuota,
    runPing: async () => { corruptPings += 1; },
    stateFile: corruptFile,
    log: (line) => corruptLogs.push(line),
    now: () => 2_000_001,
    pollMs: 1e9,
    graceMs: 0,
  });
  await corruptPinger.tick();
  ok(corruptPings === 0 && corruptLogs.some((line) => line.includes('停止付費 ping')),
    '狀態檔損壞時不 ping');
  corruptPinger.stop();

  // 狀態檔寫不進去：也不花額度 ping。
  const blockedFile = path.join(dir, 'blocked.json');
  fs.writeFileSync(blockedFile, '{}');
  let blockedPings = 0;
  const blockedLogs = [];
  const blockedPinger = createCodexResetPinger({
    quota: fastQuota,
    runPing: async () => { blockedPings += 1; },
    stateFile: blockedFile,
    log: (line) => blockedLogs.push(line),
    now: () => 2_000_001,
    pollMs: 1e9,
    graceMs: 0,
  });
  fs.rmSync(blockedFile);
  fs.mkdirSync(blockedFile);
  await blockedPinger.tick();
  ok(blockedPings === 0 && blockedLogs.some((line) => line.includes('停止付費 ping')),
    '狀態寫入失敗時不 ping');
  blockedPinger.stop();

  // 下一個 timer 要抓在重置 + 30 秒，不是每 5 分鐘。
  const delays = [];
  const timerPinger = createCodexResetPinger({
    quota: { get: async () => ({ ok: true, fiveHour: { resetsAt: 1_060_000 }, weekly: { usedPercent: 10 } }) },
    runPing: async () => {},
    stateFile: path.join(dir, 'timer.json'),
    now: () => 1_000_000,
    pollMs: 300_000,
    graceMs: 30_000,
    setTimer: (fn, ms) => { delays.push(ms); return { unref() {} }; },
    clearTimer: () => {},
  });
  await timerPinger.tick();
  ok(delays[0] === 91_000, '下一個醒來時間是重置 + 30 秒');
  timerPinger.stop();

  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} 個測試失敗`);
  process.exitCode = 1;
} else {
  console.log('\nCodex 額度與重置 ping 測試全部通過');
}
