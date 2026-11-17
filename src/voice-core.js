// ffmpeg / ffprobe 共用工具：Discord 媒體縮圖、影片抽格與 TTS 都走這一份。
// stdout/stderr 一律 ignore、結果寫暫存檔再讀：受限沙箱下 pipe 會 EPERM。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * ffprobe 探測（時長／編碼／sampleRate／channels）。
 * 結果寫臨時檔回傳，stdout/stderr 一律 ignore（受限沙箱下 pipe 會 EPERM）。
 */
export async function probeAudio(file, { ffprobePath = 'ffprobe', timeoutMs = 10000, tmpDir = null } = {}) {
  const dirs = [tmpDir, path.join(os.tmpdir(), 'voice-probe')].filter(Boolean);
  let dir = null;
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); dir = d; break; } catch {}
  }
  if (!dir) return { ok: false, reason: '沒有可寫的臨時目錄用於 ffprobe 輸出' };

  const outFile = path.join(dir, `p-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const run = () => new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name',
        '-show_entries', 'stream=codec_name,codec_type,sample_rate,channels',
        '-of', 'json', '-o', outFile, file
      ], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ code: -1, error: `ffprobe 啟動失敗：${error?.message ?? error}` });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -2, error: 'ffprobe 逾時' }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, error: `ffprobe 不可用：${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });

  try {
    const res = await run();
    if (res.error) return { ok: false, reason: res.error };
    let raw = '';
    try { raw = fs.readFileSync(outFile, 'utf8'); }
    catch (error) { return { ok: false, reason: `ffprobe 未產出結果（退出碼 ${res.code}，${error?.message ?? error}）` }; }
    if (!raw.trim()) return { ok: false, reason: `ffprobe 結果為空（退出碼 ${res.code}）` };
    const j = JSON.parse(raw);
    const streams = Array.isArray(j.streams) ? j.streams : [];
    const audio = streams.find((s) => s.codec_type === 'audio');
    return {
      ok: true,
      duration: Number(j.format?.duration) || 0,
      formatName: j.format?.format_name ?? '',
      codec: audio?.codec_name ?? '',
      sampleRate: Number(audio?.sample_rate) || 0,
      channels: Number(audio?.channels) || 0
    };
  } catch (error) {
    return { ok: false, reason: `ffprobe 輸出解析失敗：${error?.message ?? error}` };
  } finally {
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/**
 * 找 ffmpeg：顯式參數優先於環境變數，只回傳**確實存在**的檔案。
 * 兩個候選都不存在時回裸命令名，交給 spawn 按 PATH 解析。
 */
export function resolveFfmpeg({ ffmpegPath = null, envVar = 'FFMPEG_PATH' } = {}) {
  const candidates = [ffmpegPath, process.env[envVar]].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return 'ffmpeg';
}
