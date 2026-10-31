// 背景生圖的回報與畫圖次數歸屬。
//
// 為什麼不讓 DSH 外掛直接 agent.followup：那會在橋接已經排好一批訊息時插一個
// 沒有人認領的回合，/ask 的靜音與 pendingDirect 的配對都會認錯。外掛改成呼叫
// 橋接的 /imageJob，由這裡把完成提示排進同一個會話閘門。
import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_JOB_TTL_MS = 15 * 60_000;
// poll 每 15 秒一次；超過 2 分鐘沒消息就當外掛失聯（DSH 重啟、當掉、連不上）。
export const IMAGE_JOB_STALE_MS = 2 * 60_000;
export const IMAGE_JOB_STALE_TEXT = '【生圖失敗】生圖工作中斷（外掛沒有回報進度），跟頻道說這次沒畫成，不要假裝畫了；同一個要求最多再試一次。';
const IMAGE_JOB_MAX_TEXT = 2000;
const IMAGE_JOBS_VERSION = 1;
const MAX_FILE_BYTES = 1_000_000;
const MAX_JOB_ID = 100; // jobId 是 UUID（36 字），留一點空間；太長的一律當壞資料
const MAX_KEY = 200;
const MAX_USERS = 50;
const MAX_NAME = 100;
const MAX_FILE_NAME = 255;

/**
 * @param options.jobs         jobId -> { key, users, at }
 * @param options.pendingDraws 檔名 -> { key, users, at }
 * @param options.turnUsers    key -> 目前回合的觸發者
 * @param options.reverse      sessionId -> key
 * @param options.sessions     key -> sessionId
 * @param options.enqueuePrompt (key, job) => void，走回合閘門
 * @param options.epochOf      (key) => number
 */
export function createImageJobHandler({
  jobs,
  pendingDraws,
  turnUsers,
  reverse,
  sessions,
  enqueuePrompt,
  epochOf,
  ttlMs = IMAGE_JOB_TTL_MS,
  now = Date.now,
  error = (message, statusCode) => Object.assign(new Error(message), { statusCode }),
}) {
  function prune(at = now()) {
    for (const [jobId, job] of jobs) if (at - job.at > ttlMs) jobs.delete(jobId);
    for (const [name, entry] of pendingDraws) if (at - entry.at > ttlMs) pendingDraws.delete(name);
  }

  return async function imageJob(body) {
    const phase = String(body?.phase ?? '');
    const sessionId = String(body?.sessionId ?? '');
    const jobId = String(body?.jobId ?? '');
    if (!['start', 'done', 'failed', 'poll'].includes(phase)) throw error('phase 不對', 400);
    if (!sessionId || !jobId) throw error('sessionId 和 jobId 都要有值', 400);
    const at = now();
    prune(at);
    const key = reverse.get(sessionId);
    if (phase === 'poll') {
      const job = jobs.get(jobId);
      // 工作還在就續命；只有 /reset 或會話被移除才回 cancel。
      if (!job || !key || sessions[key] !== sessionId) return { cancel: true };
      job.at = at;
      return { cancel: false };
    }
    if (!key || sessions[key] !== sessionId) throw error('這個會話已經結束，丟棄生圖通知', 403);
    if (phase === 'start') {
      jobs.set(jobId, { key, users: turnUsers.get(key) ?? [], at });
      return { key };
    }
    const job = jobs.get(jobId);
    if (!job || job.key !== key) throw error('找不到這個生圖工作（橋接重啟過？）', 404);
    // 先驗文字再刪工作：400 時工作還在，外掛重試才不會只拿到 404。
    const text = String(body?.text ?? '').trim().slice(0, IMAGE_JOB_MAX_TEXT);
    if (!text) throw error('text 是空的', 400);
    jobs.delete(jobId);
    if (phase === 'done' && typeof body?.file === 'string' && body.file.trim()) {
      pendingDraws.set(path.basename(body.file.trim()), { key, users: job.users, at });
    }
    enqueuePrompt(key, {
      entries: [],
      direct: false,
      system: true,
      epoch: epochOf(key),
      text,
    });
    return { key };
  };
}

/** send_image 時用檔名找回生圖開始時的觸發者；逾時、別的會話或查不到就回空。 */
export function drawUsersForFile({ pendingDraws, key, file, ttlMs = IMAGE_JOB_TTL_MS, now = Date.now }) {
  const at = now();
  for (const [name, entry] of pendingDraws) if (at - entry.at > ttlMs) pendingDraws.delete(name);
  const name = path.basename(String(file ?? '').trim());
  if (!name) return [];
  const entry = pendingDraws.get(name);
  if (!entry) return [];
  return entry.key === key ? entry.users : [];
}

function backupCorrupt(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch { /* 備份失敗不影響從空的重建 */ }
}

/** 只留形狀正確的觸發者；壞資料不能帶進統計。 */
function readUsers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((user) => user && typeof user === 'object' && /^\d{5,25}$/.test(String(user.userId ?? '')))
    .slice(0, MAX_USERS)
    .map((user) => ({ userId: String(user.userId), name: String(user.name ?? '').slice(0, MAX_NAME) }));
}

/**
 * 讀生圖工作。壞檔／過大／格式不認得時改名備份再從空的重建；
 * 只留會話還在、而且還沒逾時的工作。
 * 載入時把 `at` 設成當下：重啟後失聯掃描有完整的 2 分鐘可以等外掛回來 poll。
 * @returns {{jobs: Map, pendingDraws: Map, warning: string|null}}
 */
export function loadImageJobs(file, { ttlMs = IMAGE_JOB_TTL_MS, keys = null, now = Date.now } = {}) {
  const empty = () => ({ jobs: new Map(), pendingDraws: new Map(), warning: null });
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return empty();
    throw error;
  }
  const size = Buffer.byteLength(raw, 'utf8');
  if (size > MAX_FILE_BYTES) {
    backupCorrupt(file);
    return { ...empty(), warning: `生圖工作檔過大（${(size / 1024).toFixed(1)} KB），已備份並重建` };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    backupCorrupt(file);
    return { ...empty(), warning: `生圖工作檔不是合法 JSON（${error?.message ?? error}），已備份並重建` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== IMAGE_JOBS_VERSION
    || !doc.jobs || typeof doc.jobs !== 'object' || Array.isArray(doc.jobs)
    || !doc.pendingDraws || typeof doc.pendingDraws !== 'object' || Array.isArray(doc.pendingDraws)) {
    backupCorrupt(file);
    return { ...empty(), warning: '生圖工作檔格式錯誤，已備份並重建' };
  }
  const at = now();
  const knownKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY
    && (!keys || keys.has(key));
  const jobs = new Map();
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    if (!jobId || jobId.length > MAX_JOB_ID || !job || typeof job !== 'object') continue;
    if (!knownKey(job.key)) continue;
    const time = Number(job.at);
    if (!Number.isFinite(time) || at - time > ttlMs) continue;
    jobs.set(jobId, { key: job.key, users: readUsers(job.users), at });
  }
  const pendingDraws = new Map();
  for (const [rawName, entry] of Object.entries(doc.pendingDraws)) {
    const name = path.basename(String(rawName ?? ''));
    if (!name || name.length > MAX_FILE_NAME || !entry || typeof entry !== 'object') continue;
    if (!knownKey(entry.key)) continue;
    const time = Number(entry.at);
    if (!Number.isFinite(time) || at - time > ttlMs) continue;
    // 畫圖歸屬保留原本的時間：重啟不能讓同一張圖的歸屬再多活 15 分鐘。
    pendingDraws.set(name, { key: entry.key, users: readUsers(entry.users), at: time });
  }
  return { jobs, pendingDraws, warning: null };
}

/** 原子寫：先寫 .tmp 再 rename，避免半截檔案。 */
export function saveImageJobs(file, { jobs, pendingDraws } = {}) {
  const doc = { version: IMAGE_JOBS_VERSION, jobs: {}, pendingDraws: {} };
  for (const [jobId, job] of jobs ?? []) doc.jobs[jobId] = { key: job.key, users: job.users ?? [], at: job.at };
  for (const [name, entry] of pendingDraws ?? []) {
    doc.pendingDraws[name] = { key: entry.key, users: entry.users ?? [], at: entry.at };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 已不在 */ }
    throw error;
  }
}

/**
 * 外掛失聯（DSH 重啟、當掉、連不上）時，清掉久沒 poll 的工作。
 * @returns {Array<{jobId: string, key: string, users: object[], at: number}>} 被清掉的工作
 */
export function sweepStaleImageJobs({ jobs, staleMs = IMAGE_JOB_STALE_MS, now = Date.now }) {
  const at = now();
  const stale = [];
  for (const [jobId, job] of jobs) {
    if (at - job.at > staleMs) {
      jobs.delete(jobId);
      stale.push({ jobId, ...job });
    }
  }
  return stale;
}
