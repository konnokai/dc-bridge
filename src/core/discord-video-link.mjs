// 影片連結（YouTube 等）→ 一次 yt-dlp 取直連網址、影片資訊與字幕文字，再交給 media-normalize 抽格。
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
    const raw = match[0].replace(/[.,;:!?，。；：！？」』）)】]+$/u, '');
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

/** 字幕語言偏好：先繁中、再簡中、最後英文。逗號分隔時 yt-dlp 照這個順序抓，被 429 擋也先保住最想要的。 */
export const SUBTITLE_LANGS = Object.freeze(['zh-TW', 'zh-Hant', 'zh-CN', 'zh-Hans', 'en']);
// yt-dlp 自己會在每個語言後面補 $ 並用 re.match，不用寫錨點；用逗號而不是 | 才會照偏好排序。
const SUB_LANGS_ARG = SUBTITLE_LANGS.join(',');

/** 逐字稿送進模型的字數上限：長片整份字幕會把回合的 context 吃掉。 */
export const MAX_TRANSCRIPT_CHARS = 12_000;

// 欄位子集語法：缺的欄位直接省略，輸出一定是合法 JSON。
// 寫成 {"chapters":%(chapters)j,...} 時，沒有章節的影片會印成 "chapters":NA，整份 JSON 就壞了。
// 也不落地整份 info.json（所有 format 網址加起來有幾十 MB）。
const PRINT_TEMPLATE = '%(.{title,duration,chapters,description,url})j';

/** yt-dlp 的 --print 輸出 → 需要的欄位。純函式，可單測。 */
export function parseVideoMeta(raw) {
  const line = String(raw ?? '').split(/\r?\n/).find((row) => row.trim().startsWith('{')) ?? '';
  if (!line) return null;
  try {
    const doc = JSON.parse(line);
    return {
      url: typeof doc.url === 'string' && /^https?:\/\//i.test(doc.url) ? doc.url : '',
      title: typeof doc.title === 'string' ? doc.title : '',
      duration: Number.isFinite(doc.duration) ? doc.duration : 0,
      chapters: Array.isArray(doc.chapters) ? doc.chapters : [],
      description: typeof doc.description === 'string' ? doc.description : '',
    };
  } catch {
    return null;
  }
}

/** 從 yt-dlp 寫出的檔名挑一條字幕。純函式，可單測。 */
export function pickSubtitleFile(names) {
  const files = (Array.isArray(names) ? names : []).filter((name) => /\.vtt$/i.test(String(name)));
  for (const lang of SUBTITLE_LANGS) {
    const hit = files.find((name) => String(name).endsWith(`.${lang}.vtt`));
    if (hit) return hit;
  }
  return files.sort()[0] ?? '';
}

/**
 * VTT → 可讀逐字稿。YouTube 自動字幕每個 cue 會把上一句再印一次，連續重複只留一次；
 * 時間軸、cue 標號、<c>／<00:00:00.000> 標籤與 HTML entity 都要去掉。
 */
export function parseVtt(raw) {
  const rows = String(raw ?? '').split(/\r?\n/).map((row) => row.trim());
  const lines = [];
  let skipBlock = false;
  let atBlockStart = true;
  let seenCue = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) { skipBlock = false; atBlockStart = true; continue; }
    if (skipBlock) { atBlockStart = false; continue; }
    // NOTE／STYLE／REGION 是 VTT 的區塊標頭，只在空行後、自己獨立一行時才算；
    // 不分大小寫會把「Note that…」這種字幕整段刪掉。
    if (atBlockStart && /^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(row)) { skipBlock = true; atBlockStart = false; continue; }
    // 檔案標頭只在第一個 cue 之前略過，免得把字幕裡的「Language: …」也刪掉。
    if (!seenCue && /^(?:WEBVTT|Kind:|Language:|X-TIMESTAMP-MAP:)/i.test(row)) { atBlockStart = false; continue; }
    // 時間軸一定從時間開始；字幕內文裡的「A --> B」不該被當成時間軸。
    if (/^[\d:.,]+\s*-->/.test(row)) { seenCue = true; atBlockStart = false; continue; }
    // cue 標號只有下一行是時間軸時才成立，否則「2024」這種字幕要留下來。
    if (/^\d+$/.test(row) && rows[i + 1]?.includes('-->')) { atBlockStart = false; continue; }
    atBlockStart = false;
    const text = row
      .replace(/<[^>]*>/g, '')
      .replace(/&(?:nbsp|#160);/gi, ' ')
      .replace(/&(?:amp|lt|gt|quot|apos|#39);/gi, (entity) => ({
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
      }[entity.toLowerCase()] ?? ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || lines[lines.length - 1] === text) continue;
    lines.push(text);
  }
  return lines.join('\n');
}

/** 長逐字稿截到上限，盡量停在換行處。純函式，可單測。 */
export function clipTranscript(text) {
  const full = String(text ?? '');
  if (full.length <= MAX_TRANSCRIPT_CHARS) return { text: full, truncated: false };
  const cut = full.slice(0, MAX_TRANSCRIPT_CHARS);
  const lastBreak = cut.lastIndexOf('\n');
  return { text: (lastBreak > MAX_TRANSCRIPT_CHARS * 0.8 ? cut.slice(0, lastBreak) : cut).trimEnd(), truncated: true };
}

/** 秒 → mm:ss；超過一小時讓分鐘繼續加，模型比較好對上章節時間。 */
export function formatVideoTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** yt-dlp 的 chapters → 「00:00 標題；02:05 標題」這種可讀大綱。 */
export function formatChapters(chapters, max = 20) {
  return (Array.isArray(chapters) ? chapters : [])
    .slice(0, max)
    .map((chapter) => {
      const title = String(chapter?.title ?? '').replace(/\s+/g, ' ').trim();
      return title ? `${formatVideoTime(chapter?.start_time)} ${title}` : '';
    })
    .filter(Boolean)
    .join('；');
}

/**
 * 一次 yt-dlp 拿到：抽格用的直連網址、標題／長度／章節／簡介，以及字幕文字。
 *
 * --print 自帶 --simulate（不寫任何檔），所以要加 --no-simulate 讓字幕真的落地，
 * 再用 --skip-download 擋掉影片本身。字幕被 YouTube 429 擋時退出碼不是 0，
 * 但已經寫出的字幕與 --print 輸出照用，不當成整次失敗。
 * --ignore-config 擋掉使用者設定檔的 -P（否則字幕會寫到暫存目錄外面）；
 * -I 1 讓純清單網址只處理第一支；--ignore-no-formats-error 讓抽格選不到格式時字幕仍拿得到。
 */
export async function fetchVideoLink(url, { ytDlpPath = null, timeoutMs = 30_000 } = {}) {
  const bin = resolveYtDlp({ ytDlpPath });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ytdlp-'));
  const outFile = path.join(dir, 'meta.json');
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
          '--no-playlist', '--no-warnings', '--no-progress', '--skip-download',
          '--ignore-config', '--ignore-no-formats-error', '-I', '1',
          '--write-subs', '--write-auto-subs', '--sub-format', 'vtt', '--sub-langs', SUB_LANGS_ARG,
          // 拼圖一格才 240px 寬，360p 就夠；高位元率只是多下載時間。
          '-f', 'bv*[height<=360]/b[height<=360]/b',
          '--print', PRINT_TEMPLATE, '--no-simulate',
          '-o', path.join(dir, 'sub.%(ext)s'),
          url,
        ], { windowsHide: true, stdio: ['ignore', outFd, errFd] });
      } catch (error) {
        resolve({ error: `yt-dlp 啟動失敗：${error?.message ?? error}` });
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve({ error: `yt-dlp 逾時（${Math.round(timeoutMs / 1000)}s）` });
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ error: error?.code === 'ENOENT' ? '找不到 yt-dlp（設 YTDLP_PATH 或 config.json 的 discord.videoLinks.ytDlpPath）' : `yt-dlp 不可用：${error?.message ?? error}` });
      });
      child.on('close', () => { clearTimeout(timer); resolve({}); });
    });
    // --print 在字幕下載前就印出來了，逾時也可能已經有直連網址與部分字幕，先讀再判斷成敗。
    const meta = parseVideoMeta(fs.readFileSync(outFile, 'utf8'));
    const subFile = pickSubtitleFile(fs.readdirSync(dir));
    const transcript = subFile ? parseVtt(fs.readFileSync(path.join(dir, subFile), 'utf8')) : '';
    if (!meta && !transcript) {
      const detail = fs.readFileSync(errFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
      return { ok: false, reason: result.error ?? `yt-dlp 沒給出影片資訊或字幕${detail ? `：${detail.slice(0, 120)}` : ''}` };
    }
    const clipped = clipTranscript(transcript);
    return {
      ok: true,
      url: meta?.url ?? '',
      title: meta?.title ?? '',
      duration: meta?.duration ?? 0,
      chapters: meta?.chapters ?? [],
      description: meta?.description ?? '',
      transcript: clipped.text,
      transcriptTruncated: clipped.truncated,
      transcriptLang: subFile ? String(subFile).replace(/^.*\.([^.]+)\.vtt$/i, '$1') : '',
    };
  } finally {
    try { if (outFd != null) fs.closeSync(outFd); } catch {}
    try { if (errFd != null) fs.closeSync(errFd); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
