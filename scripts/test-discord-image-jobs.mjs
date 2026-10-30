// 背景生圖回報：start 記觸發者、done/failed 排進會話閘門、send_image 用檔名找回人。
//   node scripts/test-discord-image-jobs.mjs
import assert from 'node:assert/strict';
import { IMAGE_JOB_TTL_MS, createImageJobHandler, drawUsersForFile } from '../src/core/discord-image-jobs.mjs';

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
await rejects(handler({ phase: 'start', sessionId: 'gone', jobId: 'j4' }), 403, '會話已經結束就拒絕');
await rejects(handler({ phase: 'bogus', sessionId: 's1', jobId: 'j5' }), 400, 'phase 不認得就拒絕');

console.log('\n✅ 背景生圖回報測試通過');
