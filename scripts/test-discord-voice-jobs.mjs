// 背景語音工作的生命週期：只給同一個頻道取用、逾時會清掉。不需要網路或 Discord。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addVoiceJob, hasWorkingVoiceJob, listVoiceJobs, pruneVoiceJobs, takeVoiceJob, voiceJobFor, VOICE_JOB_TTL_MS } from '../src/core/discord-voice-jobs.mjs';

const job = (over = {}) => ({
  id: 'job-1',
  key: 'ch:1',
  sessionId: 'ses-1',
  status: 'working',
  startedAt: 1000,
  ...over,
});

test('addVoiceJob 記下 at，不改呼叫端物件', () => {
  const jobs = new Map();
  const input = job();
  const added = addVoiceJob({ jobs, job: input, now: () => 5000 });
  assert.equal(added.at, 5000);
  assert.equal(input.at, undefined);
  assert.equal(jobs.get('job-1'), added);
});

test('voiceJobFor 只認同一個頻道，逾時的不回傳', () => {
  const jobs = new Map([['job-1', job({ at: 1000 })]]);
  assert.equal(voiceJobFor({ jobs, key: 'ch:1', jobId: 'job-1', now: () => 2000 })?.id, 'job-1');
  assert.equal(voiceJobFor({ jobs, key: 'ch:2', jobId: 'job-1', now: () => 2000 }), null);
  assert.equal(voiceJobFor({ jobs, key: 'ch:1', jobId: 'nope', now: () => 2000 }), null);
  assert.equal(voiceJobFor({ jobs, key: 'ch:1', jobId: 'job-1', now: () => 1000 + VOICE_JOB_TTL_MS + 1 }), null);
  assert.equal(jobs.size, 1, '逾時的工作留給 pruneVoiceJobs 統一清，才不會漏掉預告');
});

test('takeVoiceJob 只給 ready，取出後就移除', () => {
  const jobs = new Map([['job-1', job({ at: 1000, status: 'working' })]]);
  assert.equal(takeVoiceJob({ jobs, key: 'ch:1', jobId: 'job-1', now: () => 2000 }), null);
  jobs.get('job-1').status = 'ready';
  const taken = takeVoiceJob({ jobs, key: 'ch:1', jobId: 'job-1', now: () => 2000 });
  assert.equal(taken.id, 'job-1');
  assert.equal(jobs.size, 0);
  jobs.set('job-1', job({ at: 1000, status: 'failed' }));
  assert.equal(takeVoiceJob({ jobs, key: 'ch:1', jobId: 'job-1', now: () => 2000 }), null);
});

test('listVoiceJobs 只列這個頻道，依開始時間排序，逾時的不列', () => {
  const jobs = new Map([
    ['a', job({ id: 'a', at: 1000, startedAt: 2000, status: 'ready' })],
    ['b', job({ id: 'b', at: 3000, startedAt: 1500 })],
    ['c', job({ id: 'c', key: 'ch:2', at: 3000 })],
    ['d', job({ id: 'd', at: 0 })],
  ]);
  const list = listVoiceJobs({ jobs, key: 'ch:1', now: () => 4000, ttlMs: 3500 });
  assert.deepEqual(list.map((item) => item.id), ['b', 'a']);
  assert.equal(jobs.has('d'), true, '逾時的不列出來，但留給 prune 清');
});

test('hasWorkingVoiceJob 只看同頻道、未逾時的合成中工作', () => {
  const jobs = new Map([
    ['a', job({ id: 'a', at: 1000, status: 'working' })],
    ['b', job({ id: 'b', key: 'ch:2', at: 1000, status: 'working' })],
    ['c', job({ id: 'c', at: 1000, status: 'ready' })],
  ]);
  assert.equal(hasWorkingVoiceJob({ jobs, key: 'ch:1', now: () => 2000 }), true);
  assert.equal(hasWorkingVoiceJob({ jobs, key: 'ch:2', now: () => 2000 }), true);
  jobs.get('a').status = 'ready';
  assert.equal(hasWorkingVoiceJob({ jobs, key: 'ch:1', now: () => 2000 }), false);
  jobs.set('d', job({ id: 'd', at: 1000, status: 'working' }));
  assert.equal(hasWorkingVoiceJob({ jobs, key: 'ch:1', now: () => 1000 + VOICE_JOB_TTL_MS + 1 }), false);
});

test('pruneVoiceJobs 回傳被清掉的工作', () => {
  const jobs = new Map([
    ['a', job({ id: 'a', at: 1000 })],
    ['b', job({ id: 'b', at: 9000 })],
  ]);
  const removed = pruneVoiceJobs({ jobs, now: () => 1000 + VOICE_JOB_TTL_MS + 1 });
  assert.deepEqual(removed.map((item) => item.id), ['a']);
  assert.deepEqual([...jobs.keys()], ['b']);
});
