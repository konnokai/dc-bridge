// 背景生圖的回報與畫圖次數歸屬。
//
// 為什麼不讓 DSH 外掛直接 agent.followup：那會在橋接已經排好一批訊息時插一個
// 沒有人認領的回合，/ask 的靜音與 pendingDirect 的配對都會認錯。外掛改成呼叫
// 橋接的 /imageJob，由這裡把完成提示排進同一個會話閘門。
import path from 'node:path';

export const IMAGE_JOB_TTL_MS = 15 * 60_000;
const IMAGE_JOB_MAX_TEXT = 2000;

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
      // 工作還在就續命；/reset、橋接重啟或外掛消失都回 cancel。
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
    jobs.delete(jobId);
    const text = String(body?.text ?? '').trim().slice(0, IMAGE_JOB_MAX_TEXT);
    if (!text) throw error('text 是空的', 400);
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
