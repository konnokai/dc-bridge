// TTS：把一句話送給本機 mlx_audio 合成，轉成 Discord 語音訊息要的 OGG/Opus。
//
// 後端只負責合成。長度、安靜期間、補句、敏感資訊與每輪上限都在橋接的 sendVoice 那條路；
// 這裡是純的 HTTP 與 ffmpeg，測試不需要 Discord。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Converter } from 'opencc-js';
import { probeAudio, resolveFfmpeg } from '../voice-core.js';

/** Discord 免費帳號的單檔上限。 */
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;

const WAVEFORM_BUCKETS = 256;

/** mlx_audio 的 lang_code 認全名，不是 zh／ja 這種短碼。 */
const LANGUAGE_NAMES = {
  zh: 'Chinese',
  'zh-tw': 'Chinese',
  'zh-cn': 'Chinese',
  chinese: 'Chinese',
  en: 'English',
  english: 'English',
  ja: 'Japanese',
  jp: 'Japanese',
  japanese: 'Japanese',
  ko: 'Korean',
  kr: 'Korean',
  korean: 'Korean',
  auto: 'auto',
};

/** 模型給的語言代碼 → mlx_audio 的全名；不認得就走自動。 */
export function ttsLanguage(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return LANGUAGE_NAMES[key] ?? 'auto';
}

// Qwen3-TTS 看到繁體中文會用粵語唸（實測：同一句話簡體是普通話、繁體是粵語）。
// 只在送進模型前轉簡體，不影響頻道上的文字。
const toSimplified = Converter({ from: 'tw', to: 'cn' });

/** 日文假名、韓文字母不在 OpenCC 的處理範圍，硬轉只會改壞漢字。 */
function shouldSimplify(text, language) {
  const lang = ttsLanguage(language);
  if (lang !== 'auto' && lang !== 'Chinese') return false;
  return !/[\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

/** 送去合成的文字：中文轉簡體，其他語言原樣。 */
export function spokenText(text, language = 'auto') {
  const value = String(text ?? '');
  return shouldSimplify(value, language) ? toSimplified(value) : value;
}

function trimBaseUrl(baseUrl) {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '');
}

async function readErrorDetail(res) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body);
      detail = String(parsed?.detail?.message ?? parsed?.detail ?? parsed?.message ?? body);
    } catch { detail = body; }
  } catch { /* 沒有 body 就只報狀態碼 */ }
  return detail;
}

async function postAudio(url, { headers, payload, label, timeoutMs, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`TTS 後端逾時（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw new Error(`連不上 TTS 後端（${label}）：${error?.message ?? error}`);
  }
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`TTS 後端回應 HTTP ${res.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('TTS 後端回了空檔案');
  return bytes;
}

/**
 * 合成一句話：POST 到 mlx_audio 的 OpenAI 相容 /v1/audio/speech。
 * @returns {Promise<Buffer>} WAV bytes
 */
export async function synthesizeSpeech({
  baseUrl,
  model,
  text,
  instruct = '',
  accent = '',
  language = 'auto',
  voice = '',
  refAudio = '',
  refText = '',
  timeoutMs = 60_000,
  fetchImpl = fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('這個 Node 版本沒有 fetch');
  if (!text || !String(text).trim()) throw new Error('要說的話是空的');

  const base = trimBaseUrl(baseUrl);
  if (!base) throw new Error('沒有設定 tts.baseUrl');
  // Base 模型用參考音複製聲音：ref_audio 是 TTS 主機上的檔案路徑，ref_text 是那段話的逐字稿。
  // 兩者都要有才會走 ICL；只有一個是設定錯誤，不要默默退回每次亂抽的聲音。
  const ref = String(refAudio ?? '').trim();
  if (ref && !String(refText ?? '').trim()) throw new Error('設定了 tts.refAudio 但沒有 tts.refText');
  if (!ref && String(refText ?? '').trim()) throw new Error('設定了 tts.refText 但沒有 tts.refAudio');
  // VoiceDesign 只靠 instruct 決定聲音；補上口音才不會隨機挑到粵語腔。
  const style = [String(instruct ?? '').trim(), String(accent ?? '').trim()].filter(Boolean).join('，');
  const input = spokenText(text, language);
  return postAudio(`${base}/v1/audio/speech`, {
    headers: { 'content-type': 'application/json' },
    payload: {
      model,
      input,
      lang_code: ttsLanguage(language),
      response_format: 'wav',
      speed: 1.0,
      ...(ref
        ? { ref_audio: ref, ref_text: spokenText(String(refText).trim()) }
        : {
            ...(style ? { instruct: style } : {}),
            ...(voice ? { voice: String(voice) } : {}),
          }),
    },
    label: base,
    timeoutMs,
    fetchImpl,
  });
}

/**
 * 16-bit 單聲道 PCM → Discord 的 256 格波形，每格 0~255。
 * 靜音要真的是 0；滿幅（±32768）才接近 255。
 */
export function makeWaveform(pcm, buckets = WAVEFORM_BUCKETS) {
  const out = Buffer.alloc(buckets);
  if (!Buffer.isBuffer(pcm) || pcm.length < 2) return out;
  const samples = Math.floor(pcm.length / 2);
  const perBucket = Math.max(1, Math.ceil(samples / buckets));
  for (let i = 0; i < buckets; i += 1) {
    const start = i * perBucket;
    const end = Math.min(samples, start + perBucket);
    let peak = 0;
    for (let s = start; s < end; s += 1) {
      const value = Math.abs(pcm.readInt16LE(s * 2));
      if (value > peak) peak = value;
    }
    out[i] = Math.min(255, Math.round((peak / 32768) * 255));
  }
  return out;
}

function runFfmpeg(ffmpegPath, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegPath, ['-nostdin', ...args], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg 啟動失敗：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已經結束 */ }
      settle({ ok: false, error: `ffmpeg 逾時（${Math.round(timeoutMs / 1000)} 秒）` });
    }, timeoutMs);
    child.on('error', (error) => settle({
      ok: false,
      error: error?.code === 'ENOENT' ? '找不到 ffmpeg（設定 FFMPEG_PATH）' : `ffmpeg 不可用：${error?.message ?? error}`,
    }));
    child.on('close', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg 退出碼 ${code == null ? '不明' : code | 0}` }));
  });
}

/**
 * WAV → OGG/Opus 與波形。一次 ffmpeg 同時產出 OGG 與 8kHz 單聲道 PCM：
 * 多一次 spawn 只是多花時間，波形不需要另外解碼。
 */
export async function toVoiceOgg(audioBuffer, { ffmpegPath = null, timeoutMs = 30_000, tmpDir = null } = {}) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) throw new Error('音訊是空的');
  const base = tmpDir ? path.resolve(tmpDir) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'dc-tts-'));
  const inFile = path.join(dir, 'in.audio');
  const oggFile = path.join(dir, 'voice.ogg');
  const pcmFile = path.join(dir, 'voice.pcm');
  try {
    fs.writeFileSync(inFile, audioBuffer);
    const run = await runFfmpeg(resolveFfmpeg({ ffmpegPath }), [
      '-v', 'error', '-y', '-i', inFile,
      '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', oggFile,
      '-f', 's16le', '-ac', '1', '-ar', '8000', pcmFile,
    ], timeoutMs);
    if (!run.ok) throw new Error(run.error);
    const buffer = fs.readFileSync(oggFile);
    if (buffer.length === 0) throw new Error('ffmpeg 沒有產出 OGG');
    if (buffer.length > VOICE_MAX_BYTES) {
      throw new Error(`語音檔 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 超過 Discord 的 10MB 上限`);
    }
    const pcm = fs.readFileSync(pcmFile);
    // PCM 長度就是真實音長，比 ffprobe 少一次 spawn；ffprobe 問得到時以它為準。
    const probed = await probeDuration(oggFile);
    const duration = probed > 0 ? probed : pcm.length / 2 / 8000;
    return {
      buffer,
      waveform: makeWaveform(pcm).toString('base64'),
      duration: Math.round(duration * 100) / 100,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** OGG 秒數；ffprobe 沒裝或讀不到回 0，呼叫端再用 PCM 長度兜底。 */
export async function probeDuration(file, { ffprobePath = process.env.FFPROBE_PATH || 'ffprobe' } = {}) {
  const probed = await probeAudio(file, { ffprobePath, timeoutMs: 10_000 });
  return probed.ok ? Number(probed.duration) || 0 : 0;
}

/** instruct 太長會讓 VoiceDesign 吃掉提示詞，直接擋。 */
export const VOICE_INSTRUCT_MAX = 200;

/**
 * 送出前的規則檢查（純函式）：開關、頻道、長度、instruct、每輪上限、冷卻。
 * 回傳 { speak, instruct, note } 或 { error, status }。
 */
export function voiceGate({ tts, channelId, text, instruct = '', used = 0, lastAt = 0, now = Date.now() }) {
  if (!tts?.enabled) return { error: '語音回覆沒有開啟（discord.tts.enabled）', status: 403 };
  if ((tts.channels?.length ?? 0) > 0 && !tts.channels.includes(String(channelId))) {
    return { error: '這個頻道沒有開放語音回覆（discord.tts.channels）', status: 403 };
  }
  // 用碼點算長度：emoji 的 surrogate pair 不能被 slice 切成一半。
  const chars = Array.from(String(text ?? '').trim());
  if (chars.length === 0) return { error: 'text 是空的：要說的話放 text', status: 400 };
  const limit = Number(tts.maxChars) || 150;
  const speak = (chars.length > limit ? chars.slice(0, limit) : chars).join('').trimEnd();
  const note = chars.length > limit ? `文字超過 ${limit} 字，只說前面 ${Array.from(speak).length} 字` : '';
  const desc = String(instruct ?? '').trim();
  if (Array.from(desc).length > VOICE_INSTRUCT_MAX) {
    return { error: `instruct 最多 ${VOICE_INSTRUCT_MAX} 字`, status: 400 };
  }
  if (used >= (Number(tts.maxPerTurn) || 1)) {
    return { error: `這一輪已經送過 ${tts.maxPerTurn} 則語音`, status: 429 };
  }
  const cooldownMs = (Number(tts.cooldownSec) || 0) * 1000;
  const waitMs = cooldownMs - (now - Number(lastAt || 0));
  if (cooldownMs > 0 && waitMs > 0) return { error: `語音剛送過，再等 ${Math.ceil(waitMs / 1000)} 秒`, status: 429 };
  return { speak, instruct: desc, note };
}

/**
 * 語音訊息被 Discord 拒絕時，只重送一次普通附件。
 * 只認 HTTP 400（表單格式／旗標不被接受）：網路逾時或 5xx 可能已經送出，重送會變兩則。
 * 沒有權限（50013）也不是格式問題，同樣直接讓呼叫端處理。
 */
export async function deliverVoiceFile({ sendVoice, sendPlain }) {
  try {
    return { sent: await sendVoice() };
  } catch (error) {
    if (error?.status !== 400) throw error;
    const sent = await sendPlain();
    return { sent, detail: 'Discord 不接受語音訊息，已改送一般音檔' };
  }
}
