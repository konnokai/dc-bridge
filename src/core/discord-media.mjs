// Discord 附件（圖片、影片）→ DSH 的 base64 圖像區塊。
//
// 兩件事都在這裡把關：
//   1. 只抓 Discord 自己的主機（DISCORD_IMAGE_HOSTS），
//      不因為訊息裡有 URL 就替模型去抓任意網址（那是 SSRF）。
//   2. 太大／解析度太高的圖先在本地縮小再送出；縮不動就明確回報，
//      不送注定被 DSH 丟掉的位元組。
//
// 縮圖重用 QQ 版的 normalizeImageForModel（ffmpeg）：它已經處理過 DSH 的
// base64 上限、長邊、動圖抽帧拼圖，是這個 repo 唯一的圖片正規化實作。
import { normalizeImageForModel, normalizeVideoForModel, normalizeVideoUrlForModel, sniffImage, sniffVideo } from '../media-normalize.js';

/** 允許抓圖的 host（精確比對，子網域不算）。 */
// images-ext-*：Discord 替連結預覽代抓的外部圖片。原站由 Discord 去抓，橋接只連 Discord 的主機。
export const DISCORD_IMAGE_HOSTS = Object.freeze(['cdn.discordapp.com', 'media.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net']);

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
// 影片只抽幾格拼圖，不下載原片給模型。
const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const EXT_MIME = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
]);

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

function safeName(value) {
  const cleaned = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'image').slice(0, 80);
}

function inferMime(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext ? (EXT_MIME.get(ext) ?? null) : null;
}

/**
 * 從一則訊息的附件挑出可用的圖片與影片。
 * @param attachments discord.js 的 Collection（或同形狀的陣列）
 * @param limits { maxBytes, maxCount }
 * @returns {{accepted: {url:string,name:string,mime:string}[], skipped: {name:string,reason:string}[]}}
 */
export function collectMediaAttachments(attachments, limits) {
  const list = Array.isArray(attachments)
    ? attachments
    : [...(attachments?.values?.() ?? [])];
  const accepted = [];
  const skipped = [];

  for (const item of list) {
    const name = safeName(item?.name);
    const declared = String(item?.contentType ?? '').toLowerCase();
    const mime = declared
      ? (IMAGE_MIME.has(declared) || VIDEO_MIME.has(declared) ? declared : null)
      : inferMime(name);
    if (!mime) {
      skipped.push({ name, reason: '不是支援的圖片或影片格式（png/jpeg/webp/gif/mp4/webm/mov）' });
      continue;
    }
    if (Number.isFinite(item?.size) && item.size > limits.maxBytes) {
      skipped.push({ name, reason: `超過 ${mb(limits.maxBytes)} 下載上限` });
      continue;
    }
    if (accepted.length >= limits.maxCount) {
      skipped.push({ name, reason: `一次最多 ${limits.maxCount} 張` });
      continue;
    }
    let url;
    try {
      url = new URL(String(item?.url ?? ''));
    } catch {
      skipped.push({ name, reason: '附件網址無效' });
      continue;
    }
    if (url.protocol !== 'https:' || !DISCORD_IMAGE_HOSTS.includes(url.hostname)) {
      skipped.push({ name, reason: `不是 Discord CDN 的網址（${url.hostname || '未知'}）` });
      continue;
    }
    accepted.push({ url: url.toString(), name, mime });
  }
  return { accepted, skipped };
}

/**
 * 下載一份 Discord CDN 的附件（圖片或影片）。
 * 只用 https、只認白名單 host、不跟隨轉址；大小在讀取前後各檢查一次。
 */
export async function fetchDiscordMedia(url, { maxBytes, timeoutMs = 20_000 } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error('附件網址無效');
  }
  if (parsed.protocol !== 'https:' || !DISCORD_IMAGE_HOSTS.includes(parsed.hostname)) {
    throw new Error(`拒絕抓取非 Discord CDN 的網址（${parsed.hostname || '未知'}）`);
  }

  const response = await fetch(parsed, {
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'dc-bridge (+discord)' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`下載失敗（HTTP ${response.status}）`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`檔案 ${mb(declared)} 超過 ${mb(maxBytes)} 上限`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`檔案 ${mb(buffer.length)} 超過 ${mb(maxBytes)} 上限`);
  return buffer;
}

/**
 * 把下載到的位元組整理成 DSH 的 `{type:'image', mediaType, data}`。
 * 影片先抽格拼圖，再走跟圖片一樣的出口；解析度／體積超標時交給 ffmpeg 縮小。
 * 縮不動回傳 error，由呼叫端變成一句可讀訊息。
 */
export async function prepareMediaBlock(buffer, name, limits) {
  if (sniffVideo(buffer)) {
    const result = await normalizeVideoForModel(buffer, {
      maxModelBytes: limits.maxModelBytes,
      maxVideoSeconds: limits.maxVideoSeconds,
      gifTile: 240,
      videoFrames: 6,
      timeoutMs: limits.timeoutMs,
      ffmpegPath: limits.ffmpegPath ?? null,
    });
    if (!result.ok) return { error: result.error };
    return {
      block: {
        type: 'image',
        mediaType: result.mimeType || 'image/jpeg',
        data: result.buffer.toString('base64'),
        name: safeName(name),
      },
      note: result.note || '',
    };
  }
  const info = sniffImage(buffer);
  if (!info) return { error: '認不出圖片格式（png/jpeg/webp/gif）或影片格式（mp4/webm/mov）' };
  const mediaType = `image/${info.format}`;
  const result = await normalizeImageForModel(buffer, mediaType, {
    maxModelBytes: limits.maxModelBytes,
    maxLongEdge: limits.maxLongEdge,
    gifFrames: 6,
    gifTile: 240,
    timeoutMs: limits.timeoutMs,
    label: safeName(name),
  });
  if (!result.ok) return { error: result.error };
  return {
    block: {
      type: 'image',
      mediaType: result.mimeType || mediaType,
      data: result.buffer.toString('base64'),
      name: safeName(name),
    },
    note: result.note || '',
  };
}

/** yt-dlp 的直連網址 → 跟附件一樣的圖像區塊（影片抽格拼圖）。 */
export async function prepareVideoUrlBlock(url, limits, { timeoutMs } = {}) {
  const result = await normalizeVideoUrlForModel(url, {
    maxModelBytes: limits.maxModelBytes,
    maxVideoSeconds: limits.maxVideoSeconds,
    gifTile: 240,
    videoFrames: 6,
    // 呼叫端算好剩餘預算（MCP 整通只有 60 秒）；沒給就用 45 秒。
    timeoutMs: timeoutMs ?? 45_000,
    ffmpegPath: limits.ffmpegPath ?? null,
  });
  if (!result.ok) return { error: result.error };
  return {
    block: {
      type: 'image',
      mediaType: result.mimeType || 'image/jpeg',
      data: result.buffer.toString('base64'),
      name: 'video-link',
    },
    note: result.note || '',
  };
}

// discord.js 的 StickerFormatType：1 PNG、2 APNG、3 Lottie、4 GIF。APNG 的網址也是 .png。
const STICKER_MIME = { 1: 'image/png', 2: 'image/png', 4: 'image/gif' };

/** 訊息貼圖 → `[貼圖：名稱]`，接在文字後面，模型才知道對方送了哪一張。 */
export function stickerLabel(stickers) {
  return [...(stickers?.values?.() ?? [])]
    .map((s) => `[貼圖：${String(s?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)}]`)
    .join('');
}

/**
 * 訊息貼圖 → 跟附件同形狀的清單，交給 collectMediaAttachments 把關網址與張數。
 * Lottie 是向量動畫 JSON，模型看不了，只靠 stickerLabel 給名稱。
 */
export function stickerImages(stickers) {
  return [...(stickers?.values?.() ?? [])]
    .filter((s) => STICKER_MIME[s?.format])
    .map((s) => ({ name: `${safeName(s.name)}.${s.format === 4 ? 'gif' : 'png'}`, contentType: STICKER_MIME[s.format], url: s.url }));
}

/**
 * embed 裡 Discord 代理過的圖，形狀同附件，交給 collectMediaAttachments 把關網址與張數。
 * Tenor／Giphy 的 GIF 就是這種 embed；代理網址常常沒有副檔名，先標成圖，下載後再認格式。
 * 同一個 embed 的 thumbnail 常常是 image 的縮小版，只取一張，不重複下載同一張圖。
 */
export function embedImages(embeds) {
  return (embeds ?? []).flatMap((embed) => {
    const image = [embed?.image, embed?.thumbnail].find((candidate) => candidate?.proxyURL);
    if (!image) return [];
    let name = 'embed';
    try {
      name = new URL(image.proxyURL).pathname.split('/').filter(Boolean).pop() ?? name;
    } catch { /* 壞網址留給 collectMediaAttachments 說明 */ }
    return [{ name: safeName(name), contentType: 'image/png', url: image.proxyURL }];
  });
}

/** 被跳過的附件寫成一行給模型看的說明（模型才知道要跟使用者說看不到什麼）。 */
export function describeSkipped(skipped) {
  if (!skipped?.length) return '';
  const items = skipped.map((s) => `${safeName(s.name)}（${s.reason}）`).join('；');
  return `\n[附件未送給模型：${items}]`;
}
