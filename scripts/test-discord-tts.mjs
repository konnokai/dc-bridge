// TTS 離線回歸：設定、波形、後端請求、降級決策；不需要網路、Discord 或 ffmpeg。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { normalizeDiscordConfig } from '../src/core/discord-core.mjs';
import { deliverVoiceFile, makeWaveform, probeDuration, spokenText, synthesizeSpeech, toVoiceOgg, ttsLanguage, voiceGate } from '../src/core/discord-tts.mjs';

const hasFfmpeg = (() => {
  try { return spawnSync('ffmpeg', ['-v', 'error', '-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
})();

const ttsCfg = (over = {}) => normalizeDiscordConfig({ tts: { enabled: true, ...over } }).tts;

test('tts 設定：預設關閉，數值有範圍', () => {
  const cfg = normalizeDiscordConfig({});
  assert.equal(cfg.tts.enabled, false);
  assert.equal(cfg.tts.baseUrl, '');
  assert.equal(cfg.tts.model, 'mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16');
  assert.equal(cfg.tts.maxChars, 150);
  assert.equal(cfg.tts.cooldownSec, 30);
  assert.equal(cfg.tts.maxPerTurn, 1);
  assert.match(cfg.tts.accent, /台灣華語/);
  assert.equal(cfg.tts.refAudio, '');
  assert.equal(cfg.tts.refText, '');
  assert.deepEqual(cfg.tts.channels, []);

  const tight = normalizeDiscordConfig({
    tts: { maxChars: 99999, cooldownSec: -5, maxPerTurn: 99, timeoutMs: 1 },
  });
  assert.equal(tight.tts.maxChars, 1000);
  assert.equal(tight.tts.cooldownSec, 0);
  assert.equal(tight.tts.maxPerTurn, 5);
  assert.equal(tight.tts.timeoutMs, 5000);
  assert.equal(normalizeDiscordConfig({ tts: { enabled: 'true' } }).tts.enabled, false);
});

test('tts.baseUrl 只收 http(s)，尾端斜線拿掉', () => {
  const cfg = normalizeDiscordConfig({ tts: { baseUrl: 'http://192.168.98.105:8000/' } });
  assert.equal(cfg.tts.baseUrl, 'http://192.168.98.105:8000');
  assert.throws(() => normalizeDiscordConfig({ tts: { baseUrl: 'ftp://example.com' } }), /http\(s\)/);
  assert.throws(() => normalizeDiscordConfig({ tts: { baseUrl: 'not a url' } }), /不是合法網址/);
});

test('tts 參考音：Base 沒 refAudio、只填一邊、相對路徑都在載入時擋下', () => {
  const base = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16';
  assert.throws(() => normalizeDiscordConfig({ tts: { model: base } }), /refAudio/);
  assert.throws(() => normalizeDiscordConfig({ tts: { model: base, refAudio: '/a.wav' } }), /refText/);
  assert.throws(() => normalizeDiscordConfig({ tts: { model: 'm', refText: 'x' } }), /refAudio/);
  assert.throws(
    () => normalizeDiscordConfig({ tts: { model: 'm', refAudio: 'a.wav', refText: 'x' } }),
    /絕對路徑/,
  );

  const cfg = normalizeDiscordConfig({ tts: { model: base, refAudio: ' /a.wav ', refText: ' x ' } }).tts;
  assert.equal(cfg.refAudio, '/a.wav');
  assert.equal(cfg.refText, 'x');
});

test('語言代碼轉成 mlx_audio 認得的全名', () => {
  assert.equal(ttsLanguage('zh'), 'Chinese');
  assert.equal(ttsLanguage('en'), 'English');
  assert.equal(ttsLanguage('ja'), 'Japanese');
  assert.equal(ttsLanguage('ko'), 'Korean');
  assert.equal(ttsLanguage('Japanese'), 'Japanese');
  assert.equal(ttsLanguage('auto'), 'auto');
  assert.equal(ttsLanguage(''), 'auto');
  assert.equal(ttsLanguage('klingon'), 'auto');
});

test('spokenText：繁體轉簡體，日韓原樣', () => {
  // Qwen3-TTS 實測：繁體用粵語唸，簡體才是普通話。
  assert.equal(spokenText('測試語音訊息，代表橋接已經接通'), '测试语音讯息，代表桥接已经接通');
  assert.equal(spokenText('漢字', 'ja'), '漢字');
  assert.equal(spokenText('漢字', 'ko'), '漢字');
  assert.equal(spokenText('안녕하세요'), '안녕하세요');
  assert.equal(spokenText('hello'), 'hello');
});

test('makeWaveform：固定 256 格、靜音 0、滿幅 255', () => {
  assert.equal(makeWaveform(Buffer.alloc(0)).length, 256);
  assert.deepEqual([...makeWaveform(Buffer.alloc(2000))], new Array(256).fill(0));

  const loud = Buffer.alloc(512 * 2);
  for (let i = 0; i < 512; i += 1) loud.writeInt16LE(i % 2 ? -32768 : 32767, i * 2);
  const peaks = makeWaveform(loud);
  assert.equal(peaks.length, 256);
  assert.equal(Math.min(...peaks), 255);
  assert.equal(Math.max(...peaks), 255);
});

test('synthesizeSpeech：帶全名語言、wav、語氣與口音，錯誤會回後端訊息', async () => {
  let seen = null;
  const fakeFetch = async (url, options) => {
    seen = { url, body: JSON.parse(options.body) };
    return { ok: true, arrayBuffer: async () => Buffer.from('RIFF-fake') };
  };
  const wav = await synthesizeSpeech({
    baseUrl: 'http://tts.local:8000/',
    model: 'model-x',
    text: 'こんにちは',
    instruct: '溫柔',
    accent: '標準台灣華語',
    language: 'ja',
    voice: 'Vivian',
    fetchImpl: fakeFetch,
  });
  assert.equal(wav.toString(), 'RIFF-fake');
  assert.equal(seen.url, 'http://tts.local:8000/v1/audio/speech');
  assert.equal(seen.body.model, 'model-x');
  assert.equal(seen.body.input, 'こんにちは');
  assert.equal(seen.body.instruct, '溫柔，標準台灣華語');
  assert.equal(seen.body.lang_code, 'Japanese');
  assert.equal(seen.body.response_format, 'wav');
  assert.equal(seen.body.voice, 'Vivian');
  assert.equal(seen.body.ref_audio, undefined);
  assert.equal(seen.body.ref_text, undefined);

  const failing = async () => ({ ok: false, status: 500, text: async () => '{"detail":"CUDA not found"}' });
  await assert.rejects(
    synthesizeSpeech({ baseUrl: 'http://tts.local:8000', model: 'm', text: 'x', fetchImpl: failing }),
    /HTTP 500.*CUDA not found/,
  );
});

test('synthesizeSpeech：refAudio／refText 走 Base 複製，不送 instruct 與 voice', async () => {
  let seen = null;
  const fakeFetch = async (url, options) => {
    seen = JSON.parse(options.body);
    return { ok: true, arrayBuffer: async () => Buffer.from('RIFF-clone') };
  };
  const out = await synthesizeSpeech({
    baseUrl: 'http://tts.local:8100',
    model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16',
    text: '測試複製聲音',
    instruct: '溫柔',
    accent: '標準台灣華語',
    voice: 'Vivian',
    refAudio: '/Users/me/refs/voice.wav',
    refText: '這是參考音的文字',
    fetchImpl: fakeFetch,
  });
  assert.equal(out.toString(), 'RIFF-clone');
  assert.equal(seen.ref_audio, '/Users/me/refs/voice.wav');
  assert.equal(seen.ref_text, '这是参考音的文字');
  assert.equal(seen.instruct, undefined);
  assert.equal(seen.voice, undefined);

  await assert.rejects(
    synthesizeSpeech({ baseUrl: 'http://tts.local:8100', model: 'm', text: 'x', refAudio: '/tmp/a.wav', fetchImpl: fakeFetch }),
    /refText/,
  );
  await assert.rejects(
    synthesizeSpeech({ baseUrl: 'http://tts.local:8100', model: 'm', text: 'x', refText: 'x', fetchImpl: fakeFetch }),
    /refAudio/,
  );
});

test('voiceGate：開關、頻道、長度、每輪上限與冷卻', () => {
  const CH = '123456789012345678';
  const OTHER = '999999999999999999';
  const base = { tts: ttsCfg(), channelId: CH, text: '你好' };
  assert.equal(voiceGate(base).speak, '你好');
  assert.equal(voiceGate({ ...base, tts: ttsCfg({ enabled: false }) }).status, 403);
  assert.equal(voiceGate({ ...base, tts: ttsCfg({ channels: [OTHER] }) }).status, 403);
  assert.equal(voiceGate({ ...base, tts: ttsCfg({ channels: [CH] }) }).error, undefined);
  assert.equal(voiceGate({ ...base, text: '   ' }).status, 400);
  assert.equal(voiceGate({ ...base, instruct: '長'.repeat(201) }).status, 400);
  assert.equal(voiceGate({ ...base, used: 1 }).status, 429);
  assert.equal(voiceGate({ ...base, lastAt: Date.now(), now: Date.now() }).status, 429);
  assert.equal(voiceGate({ ...base, lastAt: Date.now() - 31_000, now: Date.now() }).error, undefined);

  // emoji 不能被切成半個 surrogate pair；回報的字數用碼點算。
  const cut = voiceGate({ ...base, tts: ttsCfg({ maxChars: 2 }), text: '😀😀😀' });
  assert.equal(cut.speak, '😀😀');
  assert.match(cut.note, /只說前面 2 字/);
});

test('probeDuration：檔案不存在回 0，不丟例外', async () => {
  const missing = path.join(os.tmpdir(), `dc-tts-missing-${process.pid}.ogg`);
  fs.rmSync(missing, { force: true });
  assert.equal(await probeDuration(missing, { ffprobePath: 'definitely-not-ffprobe' }), 0);
});

test('deliverVoiceFile：語音被拒只重送一次附件，沒權限不重送', async () => {
  let plain = 0;
  const ok = await deliverVoiceFile({
    sendVoice: async () => ['voice-id'],
    sendPlain: async () => { plain += 1; return ['plain-id']; },
  });
  assert.deepEqual(ok, { sent: ['voice-id'] });
  assert.equal(plain, 0);

  const degraded = await deliverVoiceFile({
    sendVoice: async () => { throw Object.assign(new Error('invalid form body'), { status: 400 }); },
    sendPlain: async () => { plain += 1; return ['plain-id']; },
  });
  assert.deepEqual(degraded.sent, ['plain-id']);
  assert.match(degraded.detail, /一般音檔/);
  assert.equal(plain, 1);

  // 網路錯誤、5xx、權限錯誤都可能已經送出或重送也沒用：不降級，直接往上丟。
  for (const failure of [
    Object.assign(new Error('missing permissions'), { code: 50013 }),
    Object.assign(new Error('gateway timeout'), { status: 502 }),
    new Error('socket hang up'),
  ]) {
    await assert.rejects(
      deliverVoiceFile({
        sendVoice: async () => { throw failure; },
        sendPlain: async () => { plain += 1; return ['plain-id']; },
      }),
      new RegExp(failure.message),
    );
  }
  assert.equal(plain, 1);
});

test('toVoiceOgg：真的轉出 OGG 與波形', (t) => {
  if (!hasFfmpeg) return t.skip('本機沒有 ffmpeg');
  const sampleRate = 24000;
  const seconds = 0.5;
  const samples = Math.round(sampleRate * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return toVoiceOgg(Buffer.concat([header, pcm])).then((voice) => {
    assert.equal(voice.buffer.subarray(0, 4).toString(), 'OggS');
    assert.ok(voice.duration >= 0.4 && voice.duration <= 0.7, `duration=${voice.duration}`);
    assert.equal(Buffer.from(voice.waveform, 'base64').length, 256);
  });
});
