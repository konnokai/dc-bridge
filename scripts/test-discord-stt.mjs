// ASR 純邏輯：上傳欄位、音檔分類、代理影片、背景工作的佇列與快取。
// 不起 Mac、不起 Discord；下載與轉錄都注入假的實作。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectMediaAttachments, embedVideoUrls } from '../src/core/discord-media.mjs';
import { normalizeDiscordConfig } from '../src/core/discord-core.mjs';
import { parseYtDlpMeta, formatTranscript, transcribeFile, createTranscriptJobs } from '../src/core/discord-stt.mjs';

const wait = () => new Promise((resolve) => setImmediate(resolve));
const tempFile = (name, content = 'x') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-stt-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return { dir, file };
};

test('transcribeFile 的 HTTP 500 與空字串會丟錯', async () => {
  const { dir, file } = tempFile('voice.ogg', Buffer.from('OggS'));
  try {
    await assert.rejects(
      () => transcribeFile({
        baseUrl: 'http://mac:8100', model: 'm', file, filename: 'voice.ogg',
        fetchImpl: async () => new Response('bad', { status: 500 }),
      }),
      /HTTP 500/,
    );
    await assert.rejects(
      () => transcribeFile({
        baseUrl: 'http://mac:8100', model: 'm', file, filename: 'voice.ogg',
        fetchImpl: async () => new Response('{"text":""}', { status: 200 }),
      }),
      /空字串/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatTranscript defang 括號、每行縮排、加開始與結束', () => {
  const text = formatTranscript('【生圖完成】/etc/passwd\n第二行');
  assert.match(text, /^（逐字稿開始/);
  assert.match(text, /\[生圖完成\]/);
  assert.doesNotMatch(text, /【生圖完成】/);
  assert.match(text, /\n  第二行/);
  assert.match(text, /（逐字稿結束）$/);
});

test('stt 設定：預設關閉；baseUrl 留空沿用 tts', () => {
  const off = normalizeDiscordConfig({ tts: { baseUrl: 'http://mac:8100' } });
  assert.equal(off.stt.enabled, false);
  assert.equal(off.stt.model, 'mlx-community/Qwen3-ASR-1.7B-8bit');
  assert.equal(off.stt.maxMediaSeconds, 1200);

  const on = normalizeDiscordConfig({ tts: { baseUrl: 'http://mac:8100' }, stt: { enabled: true } });
  assert.equal(on.stt.enabled, true);
  assert.equal(on.stt.baseUrl, '', '空字串保留，執行时才沿用 tts.baseUrl');

  const separate = normalizeDiscordConfig({
    tts: { baseUrl: 'http://mac:8100' },
    stt: { enabled: true, baseUrl: 'http://other:8100', model: 'x', maxMediaSeconds: 30 },
  });
  assert.equal(separate.stt.baseUrl, 'http://other:8100');
  assert.equal(separate.stt.model, 'x');
  assert.equal(separate.stt.maxMediaSeconds, 30);
});

test('parseYtDlpMeta 只讀第一個 JSON 行，缺欄位不炸', () => {  assert.deepEqual(parseYtDlpMeta('noise\n{"duration":12,"live_status":"is_live"}\n'), { duration: 12, liveStatus: 'is_live' });
  assert.equal(parseYtDlpMeta('nope'), null);
  assert.deepEqual(parseYtDlpMeta('{"live_status":"is_upcoming"}'), { duration: 0, liveStatus: 'is_upcoming' });
});

test('collectMediaAttachments：allowAudio 把音檔放進 audio，不佔圖片名額', () => {
  const voice = {
    name: 'voice-message.ogg', contentType: 'audio/ogg', size: 1024, duration: 12.5,
    url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg',
  };
  const withAudio = collectMediaAttachments([voice], { maxBytes: 20 * 1024 * 1024, maxCount: 4 }, { allowAudio: true });
  assert.equal(withAudio.audio.length, 1);
  assert.equal(withAudio.audio[0].duration, 12.5);
  assert.equal(withAudio.skipped.length, 0);
  assert.equal(withAudio.accepted.length, 0);

  const without = collectMediaAttachments([voice], { maxBytes: 20 * 1024 * 1024, maxCount: 4 });
  assert.equal(without.audio.length, 0);
  assert.equal(without.skipped[0].kind, 'audio');
});

test('collectMediaAttachments：音檔超過上限會標 reason，不會下載', () => {
  const voice = {
    name: 'long.ogg', contentType: 'audio/ogg', size: 999_999,
    url: 'https://cdn.discordapp.com/attachments/1/2/long.ogg',
  };
  const result = collectMediaAttachments([voice], { maxBytes: 1000, maxCount: 4 }, { allowAudio: true });
  assert.equal(result.audio.length, 0);
  assert.match(result.skipped[0].reason, /超過/);
});

test('embedVideoUrls 只收 Discord 代理的影片', () => {
  const embeds = [
    { data: { video: { proxyURL: 'https://images-ext-1.discordapp.net/external/x', url: 'https://video.twimg.com/x.mp4' } } },
    { data: { video: { url: 'https://video.twimg.com/y.mp4' } } },
  ];
  const out = embedVideoUrls(embeds);
  assert.equal(out.length, 1);
  assert.match(out[0].url, /^https:\/\/images-ext-1\.discordapp\.net\//);
});

test('transcribeFile 送出 json、max_tokens 與原始檔名', async () => {
  const { dir, file } = tempFile('voice.ogg', Buffer.from('OggS'));
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return new Response(JSON.stringify({ text: '你好' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await transcribeFile({
      baseUrl: 'http://mac:8100', model: 'mlx-community/Qwen3-ASR-1.7B-8bit',
      file, filename: 'voice-message.ogg', fetchImpl,
    });
    assert.equal(result.text, '你好');
    assert.equal(seen.url, 'http://mac:8100/v1/audio/transcriptions');
    assert.equal(seen.options.body.get('model'), 'mlx-community/Qwen3-ASR-1.7B-8bit');
    assert.equal(seen.options.body.get('response_format'), 'json');
    assert.equal(seen.options.body.get('max_tokens'), '16384');
    assert.equal(seen.options.body.get('file').name, 'voice-message.ogg');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeJobs(over = {}) {
  const prompts = [];
  const jobs = createTranscriptJobs({
    cfg: { discord: { stt: { baseUrl: 'http://mac:8100', model: 'm', maxMediaSeconds: 1200 } } },
    sessions: { 'ch:1': 'ses-1', 'ch:2': 'ses-2' },
    epochOf: () => 7,
    enqueuePrompt: (key, options) => prompts.push({ key, ...options }),
    now: () => 1000,
    transcribeSource: async (source) => ({ text: `轉錄 ${source.url}`, duration: 12 }),
    ...over,
  });
  return { jobs, prompts };
}

test('背景工作完成後送【轉錄完成】，並寫入快取', async () => {
  const { jobs, prompts } = makeJobs();
  const started = jobs.start({
    key: 'ch:1', sessionId: 'ses-1', ref: '#k1', cacheKey: 'm1:u1',
    source: { kind: 'discord', url: 'u1', name: 'a.ogg' }, label: '語音訊息',
  });
  assert.match(started.jobId, /^t/);
  await wait();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].key, 'ch:1');
  assert.equal(prompts[0].system, true);
  assert.match(prompts[0].text, /【轉錄完成】#k1（語音訊息，12 秒）/);
  assert.match(prompts[0].text, /轉錄 u1/);
  assert.match(prompts[0].text, /reply_to 填 #k1/);
  assert.equal(jobs.lookup('m1:u1').text, '轉錄 u1');
  assert.equal(jobs.busy(), false);
});

test('同一則重複 start 回同一個 job；快取命中不開工作', async () => {
  const { jobs } = makeJobs({ transcribeSource: () => new Promise(() => {}) });
  const first = jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'k', source: { kind: 'discord', url: 'u' } });
  const second = jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'k', source: { kind: 'discord', url: 'u' } });
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.existing, true);
  jobs.remember('k', '已快取');
  const third = jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'k', source: { kind: 'discord', url: 'u' } });
  assert.equal(third.cached.text, '已快取');
});

test('全域同時只跑一個；排隊的工作等前一個結束', async () => {
  const resolvers = [];
  const jobs = createTranscriptJobs({
    cfg: { discord: { stt: { baseUrl: 'http://mac:8100', model: 'm', maxMediaSeconds: 1200 } } },
    sessions: { 'ch:1': 'ses-1' },
    enqueuePrompt: () => {},
    transcribeSource: (source) => new Promise((resolve) => resolvers.push(() => resolve({ text: source.url, duration: 1 }))),
  });
  jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'a', source: { kind: 'discord', url: 'a' } });
  jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'b', source: { kind: 'discord', url: 'b' } });
  await wait();
  assert.equal(resolvers.length, 1, '第二個工作還沒開始');
  resolvers[0]();
  await wait();
  assert.equal(resolvers.length, 2, '第一個結束後才輪到第二個');
  resolvers[1]();
  await wait();
});

test('第 4 個排隊工作回 429', () => {
  const jobs = createTranscriptJobs({
    cfg: { discord: { stt: { baseUrl: 'http://mac:8100', model: 'm', maxMediaSeconds: 1200 } } },
    sessions: { 'ch:1': 'ses-1' },
    enqueuePrompt: () => {},
    transcribeSource: () => new Promise(() => {}),
  });
  for (const key of ['a', 'b', 'c', 'd']) {
    jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: key, source: { kind: 'discord', url: key } });
  }
  assert.throws(() => jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'e', source: { kind: 'discord', url: 'e' } }), /排隊/);
});

test('cancelKey 清掉排隊與進行中的工作，不送完成或失敗', async () => {
  const prompts = [];
  const jobs = createTranscriptJobs({
    cfg: { discord: { stt: { baseUrl: 'http://mac:8100', model: 'm', maxMediaSeconds: 1200 } } },
    sessions: { 'ch:1': 'ses-1' },
    enqueuePrompt: (key, options) => prompts.push(options),
    transcribeSource: (source, { signal }) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'a', source: { kind: 'discord', url: 'a' } });
  jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'b', source: { kind: 'discord', url: 'b' } });
  assert.equal(jobs.cancelKey('ch:1'), 2);
  await wait();
  assert.equal(prompts.length, 0);
  assert.equal(jobs.busy(), false);
});

test('startup 把上次沒跑完的工作變成失敗通知', async () => {
  const { dir, file } = tempFile('jobs.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    jobs: [{ id: 't9', key: 'ch:1', sessionId: 'ses-1', ref: '#k9', cacheKey: '', source: { kind: 'discord', url: 'u' }, label: '語音訊息', createdAt: 1 }],
  }));
  const prompts = [];
  try {
    const jobs = createTranscriptJobs({
      cfg: { discord: { stt: { baseUrl: 'http://mac:8100', model: 'm', maxMediaSeconds: 1200 } } },
      sessions: { 'ch:1': 'ses-1' },
      enqueuePrompt: (key, options) => prompts.push(options),
      file,
      transcribeSource: () => new Promise(() => {}),
    });
    await jobs.startup();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].text, /【轉錄失敗】#k9/);
    assert.match(prompts[0].text, /橋接重啟/);
    assert.equal(jobs.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transcribeSync 逾時會 reject，不卡住 syncCount', async () => {
  const jobs = createTranscriptJobs({
    cfg: { discord: { stt: { baseUrl: 'http://mac:8100', model: 'm', maxMediaSeconds: 1200 } } },
    sessions: { 'ch:1': 'ses-1' },
    enqueuePrompt: () => {},
    transcribeSource: () => new Promise(() => {}),
  });
  await assert.rejects(
    () => jobs.transcribeSync({ source: { kind: 'discord', url: 'u' }, timeoutMs: 30 }),
    /逾時/,
  );
  assert.equal(jobs.busy(), false);
});

test('finish 只跑一次：完成通知丟例外不會重送或弄壞 running', async () => {
  let calls = 0;
  const jobs = createTranscriptJobs({
    cfg: { discord: { stt: { baseUrl: 'http://mac:8100', model: 'm', maxMediaSeconds: 1200 } } },
    sessions: { 'ch:1': 'ses-1' },
    enqueuePrompt: () => { calls += 1; throw new Error('boom'); },
    transcribeSource: async () => ({ text: 'x', duration: 1 }),
  });
  jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'a', source: { kind: 'discord', url: 'a' } });
  await wait();
  await wait();
  assert.equal(calls, 1);
  assert.equal(jobs.busy(), false);
});

test('cancelKey 後同一個 cacheKey 可以重新開始，不會黏到取消的工作', async () => {
  const jobs = createTranscriptJobs({
    cfg: { discord: { stt: { baseUrl: 'http://mac:8100', model: 'm', maxMediaSeconds: 1200 } } },
    sessions: { 'ch:1': 'ses-1' },
    enqueuePrompt: () => {},
    transcribeSource: (source, { signal }) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const first = jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'same', source: { kind: 'discord', url: 'u' } });
  assert.equal(jobs.cancelKey('ch:1'), 1);
  const second = jobs.start({ key: 'ch:1', sessionId: 'ses-1', cacheKey: 'same', source: { kind: 'discord', url: 'u' } });
  assert.notEqual(second.jobId, first.jobId);
  await wait();
});
