// 影片連結（YouTube 等）→ yt-dlp 取直連網址，交給 media-normalize 抽格。
//
// 只認白名單網域：yt-dlp 會自己連原站，不能讓群友丟什麼網址就讓伺服器抓什麼。
// stdout/stderr 一律寫檔案：受限沙箱裡 pipe 會 EPERM（跟 voice-core 的 ffprobe 同一個理由）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 可以交給 yt-dlp 的網域（精確比對）。 */
export const VIDEO_LINK_HOSTS = Object.freeze([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** 從訊息文字挑出白名單網域的連結（去重，保持出現順序）。 */
export function videoLinks(text) {
  const found = new Map();
  for (const match of String(text ?? '').matchAll(/https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g)) {
    // 句尾標點不算網址（群友常寫「看這個 https://youtu.be/xxx，很好笑」）。
    const raw = match[0].replace(/[.,;:!?，。；：！？」』）】]+$/u, '');
    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (!VIDEO_LINK_HOSTS.includes(url.hostname.toLowerCase())) continue;
    if (!found.has(url.toString())) found.set(url.toString(), true);
  }
  return [...found.keys()];
}

/** yt-dlp 的位置：設定的路徑 → 環境變數 → PATH 裡的裸命令名。 */
export function resolveYtDlp({ ytDlpPath = null } = {}) {
  for (const candidate of [ytDlpPath, process.env.YTDLP_PATH].filter(Boolean)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 不存在就換下一個 */ }
  }
  return 'yt-dlp';
}

/** yt-dlp 的輸出 → 第一條 https 網址（-g 有時會給多行）。純函式，可單測。 */
export function parseStreamUrl(raw) {
  return String(raw ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => /^https:\/\//.test(line)) ?? '';
}

/**
 * 跑一次 yt-dlp -g，拿單一影片的直連網址（video-only、高度 ≤480，夠抽格就好）。
 * @returns {Promise<{ok:true,url:string}|{ok:false,reason:string}>}
 */
export async function fetchStreamUrl(url, { ytDlpPath = null, timeoutMs = 30_000 } = {}) {
  const bin = resolveYtDlp({ ytDlpPath });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ytdlp-'));
  const outFile = path.join(dir, 'urls.txt');
  const errFile = path.join(dir, 'error.txt');
  let outFd = null;
  let errFd = null;
  try {
    outFd = fs.openSync(outFile, 'w');
    errFd = fs.openSync(errFile, 'w');
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, [
          '--no-playlist', '--no-warnings', '--no-progress',
          // 拼圖一格才 240px 寬，360p 就夠；高位元率只是多下載時間。
          '-f', 'bv*[height<=360]/b[height<=360]/b',
          '-g', url,
        ], { windowsHide: true, stdio: ['ignore', outFd, errFd] });
      } catch (error) {
        resolve({ code: -1, error: `yt-dlp 啟動失敗：${error?.message ?? error}` });
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve({ code: -2, error: `yt-dlp 逾時（${Math.round(timeoutMs / 1000)}s）` });
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: -1, error: error?.code === 'ENOENT' ? '找不到 yt-dlp（設 YTDLP_PATH 或 config.json 的 discord.videoLinks.ytDlpPath）' : `yt-dlp 不可用：${error?.message ?? error}` });
      });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
    });
    if (result.error) return { ok: false, reason: result.error };

    const stream = parseStreamUrl(fs.readFileSync(outFile, 'utf8'));
    if (stream) return { ok: true, url: stream };

    const detail = fs.readFileSync(errFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
    return { ok: false, reason: `yt-dlp 沒有給出直連網址（退出碼 ${result.code | 0}${detail ? `：${detail.slice(0, 120)}` : ''}）` };
  } finally {
    try { if (outFd != null) fs.closeSync(outFd); } catch {}
    try { if (errFd != null) fs.closeSync(errFd); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
