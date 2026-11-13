// 背景語音工作的生命週期。合成在 send_voice 的背景跑，完成後喚醒模型再送出。
//
// 跟生圖工作不同：音檔只在記憶體裡（幾百 KB），橋接重啟就重來；不落地就沒有清理與權限問題。
// 工作只給同一個頻道、同一個會話取用，別的頻道拿不到 job id 也送不出去。
export const VOICE_JOB_TTL_MS = 10 * 60_000;

/** 新建工作。呼叫端先填好 id／key／sessionId／status／startedAt。 */
export function addVoiceJob({ jobs, job, now = Date.now }) {
  const entry = { ...job, at: now() };
  jobs.set(entry.id, entry);
  return entry;
}

/** 查工作：只回同一個頻道、還沒逾時的；別的頻道一律當找不到。逾時的不在這裡刪，交給 prune 統一清。 */
export function voiceJobFor({ jobs, key, jobId, now = Date.now, ttlMs = VOICE_JOB_TTL_MS }) {
  const id = String(jobId ?? '').trim();
  if (!id) return null;
  const job = jobs.get(id);
  if (!job) return null;
  if (now() - job.at > ttlMs) return null;
  return job.key === key ? job : null;
}

/** 同一個頻道有沒有還在合成的工作；避免冷卻過了又疊一個。 */
export function hasWorkingVoiceJob({ jobs, key, now = Date.now, ttlMs = VOICE_JOB_TTL_MS }) {
  const at = now();
  for (const job of jobs.values()) {
    if (job.key === key && job.status === 'working' && at - job.at <= ttlMs) return true;
  }
  return false;
}

/** 取出可送出的工作；working／failed 不給。成功取出後就從地圖移除。 */
export function takeVoiceJob({ jobs, key, jobId, now = Date.now, ttlMs = VOICE_JOB_TTL_MS }) {
  const job = voiceJobFor({ jobs, key, jobId, now, ttlMs });
  if (!job || job.status !== 'ready') return null;
  jobs.delete(job.id);
  return job;
}

/** 這個頻道的工作摘要（給 job_status）。 */
export function listVoiceJobs({ jobs, key, now = Date.now, ttlMs = VOICE_JOB_TTL_MS }) {
  const at = now();
  const out = [];
  for (const [id, job] of jobs) {
    if (at - job.at > ttlMs) continue;
    if (job.key !== key) continue;
    out.push({ id, status: job.status, startedAt: job.startedAt, at: job.at });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** 清掉逾時工作；回傳被清掉的工作。 */
export function pruneVoiceJobs({ jobs, now = Date.now, ttlMs = VOICE_JOB_TTL_MS }) {
  const at = now();
  const removed = [];
  for (const [id, job] of jobs) {
    if (at - job.at > ttlMs) {
      jobs.delete(id);
      removed.push(job);
    }
  }
  return removed;
}
