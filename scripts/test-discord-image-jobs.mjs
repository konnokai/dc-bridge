// 背景生圖回報：start 記觸發者、done/failed 排進會話閘門、send_image 用檔名找回人。
//   node scripts/test-discord-image-jobs.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IMAGE_JOB_STALE_MS,
  IMAGE_JOB_STALE_TEXT,
  IMAGE_JOB_TTL_MS,
  cancelImageJobs,
  createImageJobHandler,
  drawUsersForFile,
  listImageJobs,
  loadImageJobs,
  saveImageJobs,
  sweepStaleImageJobs,
} from '../src/core/discord-image-jobs.mjs';

const ok = (cond, label) => {
  if (!cond) throw new Error(label);
  console.log(`ok ${label}`);
};

const rejects = async (promise, statusCode, label) => {
  try {
    await promise;
    ok(false, `${label}（應該要拒絕）`);
  } catch (error) {
    ok(error.statusCode === statusCode, label);
  }
};

const jobs = new Map();
const pendingDraws = new Map();
const turnUsers = new Map([['ch:1', [{ userId: 'u1', name: 'A' }]]]);
const reverse = new Map([['s1', 'ch:1']]);
const sessions = { 'ch:1': 's1' };
const enqueued = [];
let clock = 1000;
const handler = createImageJobHandler({
  jobs,
  pendingDraws,
  turnUsers,
  reverse,
  sessions,
  enqueuePrompt: (key, job) => enqueued.push({ key, job }),
  epochOf: () => 7,
  ttlMs: IMAGE_JOB_TTL_MS,
  now: () => clock,
  error: (message, statusCode) => Object.assign(new Error(message), { statusCode }),
});

const started = await handler({ phase: 'start', sessionId: 's1', jobId: 'j1' });
ok(started.key === 'ch:1' && jobs.get('j1')?.users[0]?.userId === 'u1', 'start 記下會話與觸發者');
ok(jobs.get('j1')?.startedAt === 1000 && jobs.get('j1')?.at === 1000, 'start 記下開始時間');

{
  let knowledgeCalls = 0;
  const withKnowledge = createImageJobHandler({
    jobs: new Map(),
    pendingDraws: new Map(),
    turnUsers,
    reverse,
    sessions,
    enqueuePrompt: () => {},
    epochOf: () => 7,
    knowledgeFor: async () => (knowledgeCalls++ === 0 ? ['設定：鯨魚尾'] : []),
    now: () => clock,
    error: (message, statusCode) => Object.assign(new Error(message), { statusCode }),
  });
  const hit = await withKnowledge({ phase: 'start', sessionId: 's1', jobId: 'k1' });
  ok(hit.knowledge?.[0] === '設定：鯨魚尾', 'start 會回傳工具觸發的群知識');
  const miss = await withKnowledge({ phase: 'start', sessionId: 's1', jobId: 'k2' });
  ok(!('knowledge' in miss), '沒有知識就不帶欄位');
}

await handler({ phase: 'done', sessionId: 's1', jobId: 'j1', file: '/tmp/state/discord-images/a.png', text: '【生圖完成】' });
ok(!jobs.has('j1'), 'done 後工作清掉');
ok(enqueued.length === 1 && enqueued[0].key === 'ch:1'
  && enqueued[0].job.system === true && enqueued[0].job.epoch === 7
  && enqueued[0].job.text === '【生圖完成】', '完成提示用系統訊息排進閘門');
ok(pendingDraws.get('a.png')?.users[0]?.userId === 'u1', '完成後把觸發者掛到檔名');

const credited = drawUsersForFile({ pendingDraws, key: 'ch:1', file: '/tmp/state/discord-images/a.png', now: () => 1000 });
ok(credited[0]?.userId === 'u1', 'send_image 用檔名找回原本的人');
const otherKey = drawUsersForFile({ pendingDraws, key: 'ch:2', file: 'a.png', now: () => 1000 });
ok(otherKey.length === 0, '別的會話拿不到這張圖的觸發者');
const expired = drawUsersForFile({ pendingDraws, key: 'ch:1', file: 'a.png', now: () => 1000 + IMAGE_JOB_TTL_MS + 1 });
ok(expired.length === 0 && !pendingDraws.has('a.png'), '過期的畫圖歸屬會清掉');

// 排隊超過 TTL 的工作仍活著：每次 poll 都會續命。
await handler({ phase: 'start', sessionId: 's1', jobId: 'long' });
clock += IMAGE_JOB_TTL_MS - 1;
const alive = await handler({ phase: 'poll', sessionId: 's1', jobId: 'long' });
ok(alive.cancel === false && jobs.get('long')?.at === clock, 'poll 會把工作續命');
clock += 2;
await handler({ phase: 'done', sessionId: 's1', jobId: 'long', file: 'long.png', text: '【生圖完成】' });
ok(pendingDraws.has('long.png'), '排隊很久的工作完成後仍能交付');
const unknownPoll = await handler({ phase: 'poll', sessionId: 's1', jobId: 'nope' });
ok(unknownPoll.cancel === true, '工作不存在時 poll 回 cancel');
await handler({ phase: 'start', sessionId: 's1', jobId: 'orphan' });
reverse.delete('s1');
const orphanPoll = await handler({ phase: 'poll', sessionId: 's1', jobId: 'orphan' });
ok(orphanPoll.cancel === true, '會話被移除後 poll 回 cancel');
reverse.set('s1', 'ch:1');

await handler({ phase: 'start', sessionId: 's1', jobId: 'j2' });
await handler({ phase: 'failed', sessionId: 's1', jobId: 'j2', text: '【生圖失敗】' });
ok(!pendingDraws.has('b.png') && enqueued.at(-1)?.job.text === '【生圖失敗】', '失敗只排通知，不記畫圖');

await rejects(handler({ phase: 'done', sessionId: 's1', jobId: 'nope', text: 'x' }), 404, '沒有 start 過的 job 回 404');
await rejects(handler({ phase: 'start', sessionId: 's1', jobId: 'j3' }).then(() => handler({ phase: 'done', sessionId: 's1', jobId: 'j3', text: '   ' })), 400, '沒有通知文字回 400');
const emptyTextAlive = await handler({ phase: 'poll', sessionId: 's1', jobId: 'j3' });
ok(emptyTextAlive.cancel === false, '沒有通知文字被拒絕後工作還在，外掛可以重試');
await rejects(handler({ phase: 'start', sessionId: 'gone', jobId: 'j4' }), 403, '會話已經結束就拒絕');
await rejects(handler({ phase: 'bogus', sessionId: 's1', jobId: 'j5' }), 400, 'phase 不認得就拒絕');

// 取消生圖：只刪這個會話的工作；外掛下一次 poll 拿到 cancel，逾時掃描不會再送失敗通知。
{
  const cancelJobs = new Map([
    ['c1', { key: 'ch:1', users: [], at: 1000 }],
    ['c2', { key: 'ch:2', users: [], at: 1000 }],
  ]);
  const canceled = cancelImageJobs({ jobs: cancelJobs, key: 'ch:1' });
  ok(canceled.join() === 'c1' && !cancelJobs.has('c1') && cancelJobs.has('c2'),
    '取消只刪這個會話的生圖工作');
  ok(cancelImageJobs({ jobs: cancelJobs, key: 'ch:1' }).length === 0, '沒有工作時取消回空');
}
await handler({ phase: 'start', sessionId: 's1', jobId: 'cancel-me' });
const canceledIds = cancelImageJobs({ jobs, key: 'ch:1' });
const canceledPoll = await handler({ phase: 'poll', sessionId: 's1', jobId: 'cancel-me' });
ok(canceledIds.includes('cancel-me') && canceledPoll.cancel === true, '取消後 poll 回 cancel');
{
  const beforeDone = enqueued.length;
  await rejects(handler({ phase: 'done', sessionId: 's1', jobId: 'cancel-me', file: 'cancel.png', text: '【生圖完成】' }),
    404, '取消後才完成的 done 回 404');
  ok(enqueued.length === beforeDone && !pendingDraws.has('cancel.png'), '取消後完成的通知不排進會話，也不記畫圖歸屬');
  ok(sweepStaleImageJobs({ jobs, now: () => clock + IMAGE_JOB_STALE_MS + 1 }).length === 0,
    '取消後逾時掃描不會送假的失敗通知');
}

// done 重送第二次拿到 404，不會重複排進會話；重試才不會送兩張圖。
await handler({ phase: 'start', sessionId: 's1', jobId: 'dup' });
await handler({ phase: 'done', sessionId: 's1', jobId: 'dup', file: 'dup.png', text: '【生圖完成】' });
const beforeDup = enqueued.length;
await rejects(handler({ phase: 'done', sessionId: 's1', jobId: 'dup', file: 'dup.png', text: '【生圖完成】' }), 404, '重送的 done 回 404');
ok(enqueued.length === beforeDup, '重送的 done 不會重複排進會話');

// 橋接重啟：工作與畫圖歸屬要從磁碟撿回來，poll 不能把還在跑的圖取消。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-image-jobs-'));
  const file = path.join(dir, 'discord-image-jobs.json');
  saveImageJobs(file, {
    jobs: new Map([['r1', { key: 'ch:1', users: [{ userId: '123456789012345678', name: 'A' }], startedAt: 500, at: 1000 }]]),
    pendingDraws: new Map([['r.png', { key: 'ch:1', users: [{ userId: '123456789012345678', name: 'A' }], at: 1000 }]]),
  });
  const loaded = loadImageJobs(file, { keys: new Set(['ch:1']), now: () => 2000 });
  ok(loaded.warning === null, '生圖工作檔正常載入');
  ok(loaded.jobs.get('r1')?.key === 'ch:1' && loaded.jobs.get('r1')?.at === 2000,
    '重啟後工作還在，並從載入時間重新計時');
  ok(loaded.jobs.get('r1')?.startedAt === 500, '重啟後保留原本的開始時間');
  ok(loaded.pendingDraws.get('r.png')?.users[0]?.userId === '123456789012345678', '重啟後畫圖歸屬還在');
  ok(loaded.pendingDraws.get('r.png')?.at === 1000, '重啟不會延長畫圖歸屬的 15 分鐘');

  const replayed = [];
  const restarted = createImageJobHandler({
    jobs: loaded.jobs,
    pendingDraws: loaded.pendingDraws,
    turnUsers,
    reverse,
    sessions,
    enqueuePrompt: (key, job) => replayed.push({ key, job }),
    epochOf: () => 0,
    now: () => 3000,
  });
  const aliveAfterRestart = await restarted({ phase: 'poll', sessionId: 's1', jobId: 'r1' });
  ok(aliveAfterRestart.cancel === false, '重啟後 poll 不會取消還在跑的工作');
  await restarted({ phase: 'done', sessionId: 's1', jobId: 'r1', file: '/tmp/state/discord-images/r.png', text: '【生圖完成】' });
  ok(replayed.length === 1 && replayed[0].key === 'ch:1' && replayed[0].job.system === true,
    '重啟後完成提示照樣排進會話閘門');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 載入時清掉逾時與會話已經不存在的工作。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-image-jobs-prune-'));
  const file = path.join(dir, 'discord-image-jobs.json');
  saveImageJobs(file, {
    jobs: new Map([
      ['live', { key: 'ch:1', users: [], at: 1000 }],
      ['stale', { key: 'ch:1', users: [], at: 1000 - IMAGE_JOB_TTL_MS - 1 }],
      ['gone', { key: 'ch:2', users: [], at: 1000 }],
    ]),
    pendingDraws: new Map(),
  });
  const loaded = loadImageJobs(file, { keys: new Set(['ch:1']), now: () => 1000 });
  ok(loaded.jobs.has('live') && !loaded.jobs.has('stale') && !loaded.jobs.has('gone'),
    '只留下沒逾時而且會話還在的工作');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 壞檔備份後從空的重建，不能擋住橋接啟動。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-image-jobs-bad-'));
  const file = path.join(dir, 'discord-image-jobs.json');
  fs.writeFileSync(file, '{oops');
  const loaded = loadImageJobs(file, { now: () => 1000 });
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  ok(loaded.warning?.includes('備份') && loaded.jobs.size === 0 && loaded.pendingDraws.size === 0 && backups.length === 1,
    '壞檔備份後從空的重建');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 外掛失聯：久沒 poll 的工作要收掉，其他工作不動。
{
  const jobs = new Map([
    ['alive', { key: 'ch:1', users: [], at: 1000 }],
    ['dead', { key: 'ch:1', users: [], at: 1000 - IMAGE_JOB_STALE_MS - 1 }],
  ]);
  const swept = sweepStaleImageJobs({ jobs, now: () => 1000 });
  ok(swept.length === 1 && swept[0].jobId === 'dead' && jobs.has('alive') && !jobs.has('dead'),
    '失聯超過 2 分鐘的工作會被清掉');
  ok(IMAGE_JOB_STALE_TEXT.startsWith('【生圖失敗】') && IMAGE_JOB_STALE_TEXT.includes('不要假裝'),
    '失聯通知用生圖失敗的格式，模型知道要跟頻道說');
}

// job_status：只列這個頻道、依開始時間排序，逾時順手清掉。
{
  const jobs = new Map([
    ['a', { key: 'ch:1', users: [], startedAt: 2000, at: 3000 }],
    ['b', { key: 'ch:1', users: [], startedAt: 1500, at: 3000 }],
    ['c', { key: 'ch:2', users: [], startedAt: 1000, at: 3000 }],
    ['d', { key: 'ch:1', users: [], startedAt: 0, at: 0 }],
  ]);
  const list = listImageJobs({ jobs, key: 'ch:1', now: () => 4000, ttlMs: 3500 });
  ok(list.map((item) => item.id).join() === 'b,a', '只列這個頻道，依開始時間排序');
  ok(!jobs.has('d'), '逾時的工作不在狀態裡');
  ok(listImageJobs({ jobs, key: 'nope', now: () => 4000 }).length === 0, '別的頻道看不到');
}

console.log('\n✅ 背景生圖回報測試通過');
