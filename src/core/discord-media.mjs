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
import fs from 'node:fs';
import path from 'node:path';
import { normalizeImageForModel, normalizeVideoForModel, normalizeVideoUrlForModel, sniffImage, sniffVideo } from '../media-normalize.js';
import { componentParts, embedIsSensitive, messageParts, visibleAttachments } from './discord-context.mjs';

/** 允許抓圖的 host（精確比對，子網域不算）。 */
// images-ext-*：Discord 替連結預覽代抓的外部圖片。原站由 Discord 去抓，橋接只連 Discord 的主機。
export const DISCORD_IMAGE_HOSTS = Object.freeze(['cdn.discordapp.com', 'media.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net']);

// 同時最多跑幾個縮圖／抽格。多個頻道同時丟影片時，不讓 ffmpeg 把 CPU 打滿，
// 免得 Discord heartbeat 和回合回應跟著變慢。下載是 I/O，照舊並行。
const MEDIA_CONCURRENCY = 2;
// 排到隊但剩餘預算不到這個數字就不跑了：跑也一定逾時，還會把呼叫端的其他結果一起拖掉。
const MEDIA_QUEUE_MIN_MS = 10_000;

/**
 * 同時最多 limit 個任務在跑，其餘照排隊順序等。排隊中的任務不會被丟掉；
 * 每個任務內部本來就有 ffmpeg 逾時，所以佇列不會永久卡住。
 * @returns {(task: () => Promise) => Promise}
 */
export function createMediaQueue(limit = MEDIA_CONCURRENCY) {
  const cap = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (!next) {
      active -= 1;
      return;
    }
    // 直接把名額交給下一個：active 不變，避免別的任務插隊。
    Promise.resolve().then(next.task).then(next.resolve, next.reject).finally(release);
  };
  return function run(task) {
    if (active < cap) {
      active += 1;
      return Promise.resolve().then(task).finally(release);
    }
    return new Promise((resolve, reject) => waiting.push({ task, resolve, reject }));
  };
}

const mediaQueue = createMediaQueue();

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
// 影片只抽幾格拼圖，不下載原片給模型。
const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
// 語音訊息（Discord 是 audio/ogg）與上傳的音檔橋接聽不到：分類出來給一句人話，
// 不要讓群友看到「不是支援的圖片或影片格式」這種技術句子。
const AUDIO_EXT = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'weba']);
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
    if (declared.startsWith('audio/') || (!declared && AUDIO_EXT.has(/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()))) {
      skipped.push({ name, reason: '語音或音訊（聽不到）', kind: 'audio' });
      continue;
    }
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
 * 生圖參考圖的編號：`#k7f3ab/1`（第 1 張）或 `k7f3ab`（預設第 1 張）。
 * 張數從 1 起算；格式不對回 null，由呼叫端回一句看得懂的錯。
 */
export function parseDrawRef(value) {
  const match = /^#?([0-9a-z]{4,12})(?:\/([1-9]\d?))?$/i.exec(String(value ?? '').trim());
  return match ? { ref: match[1].toLowerCase(), index: match[2] ? Number(match[2]) : 1 } : null;
}

const drawRefError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/**
 * view_message 用：把每則訊息的附件／貼圖對應到 `ref:#編號/張數`，模型才知道哪張圖能當
 * 生圖參考。名單跟 `loadReferenceImage` 完全一樣（附件＋貼圖、同一套上限），編號才對得上。
 * 連結預覽的圖不在名單裡：它們不是訊息附件，`/imageRef` 也拿不到。
 * @param labelOf (message) => '#編號'；別的頻道沒有編號，呼叫端自己過濾
 * @returns {Map<string, string>} 附件網址 → `ref:#編號/張數`
 */
export function referenceRefsByUrl(messages, limits, labelOf) {
  const refs = new Map();
  for (const message of messages) {
    if (!message) continue;
    const parts = messageParts(message);
    const { accepted } = collectMediaAttachments([...parts.attachments, ...stickerImages(parts.stickers)], limits);
    accepted.forEach((item, index) => refs.set(item.url, `ref:${labelOf(message)}/${index + 1}`));
  }
  return refs;
}

/**
 * 一則訊息的第 index 張附件（1 起算）→ 給 Codex 的靜態參考圖。
 * 來源跟批次 prompt 的 `[圖 #編號/張數]` 一樣是「附件 + 貼圖」，編號才對得上。
 * 影片與動圖不收：模型看到的版本是多格拼圖，拿去當參考只會畫出格子。
 * @param options.fetchMedia 測試注入用，預設抓 Discord CDN
 * @returns {Promise<{name:string, mimeType:string, data:string}>}
 */
export async function loadReferenceImage(message, index, limits, { fetchMedia = fetchDiscordMedia } = {}) {
  const parts = messageParts(message);
  const { accepted, skipped } = collectMediaAttachments([...parts.attachments, ...stickerImages(parts.stickers)], limits);
  if (!accepted.length) {
    throw drawRefError(`這則訊息沒有能當參考圖的附件${skipped[0]?.reason ? `（${skipped[0].reason}）` : ''}`, 400);
  }
  if (!Number.isInteger(index) || index < 1 || index > accepted.length) {
    throw drawRefError(`這則訊息只有 ${accepted.length} 張附件，張數要填 1~${accepted.length}`, 400);
  }
  const item = accepted[index - 1];
  const buffer = await fetchMedia(item.url, limits);
  if (sniffVideo(buffer)) throw drawRefError('影片不能當參考圖，請用靜態圖片', 400);
  const info = sniffImage(buffer);
  if (!info) throw drawRefError('附件不是 PNG/JPEG/WebP 圖片', 400);
  if (info.format === 'gif' || info.animated) throw drawRefError('GIF 或動圖不能當參考圖，請用 PNG/JPEG/WebP', 400);
  const prepared = await prepareMediaBlock(buffer, item.name, limits);
  if (!prepared.block) throw drawRefError(prepared.error, 400);
  return { name: safeName(item.name), mimeType: prepared.block.mediaType, data: prepared.block.data };
}

/**
 * 生圖參考圖的入口：外掛用 sessionId + `#編號/張數` 來拿圖。
 * `messageRefs` 綁會話 key，所以只拿得到這個頻道登記過的訊息；別的伺服器、私聊、
 * 已刪除的訊息一律拿不到。依賴從外面給，測試不用起橋接。
 */
export async function resolveReferenceImage({ sessionId, ref, reverse, sessions, refs, resolveChannel, limits, enabled = true, fetchMedia }) {
  if (enabled === false) throw drawRefError('這個伺服器沒開圖片功能，不能拿參考圖', 403);
  const key = reverse.get(String(sessionId ?? ''));
  if (!key || sessions[key] !== sessionId) throw drawRefError('這個會話已經結束，拿不到參考圖', 403);
  const parsed = parseDrawRef(ref);
  if (!parsed) throw drawRefError('參考圖編號格式不對：要填 ref:#編號/張數', 400);
  const id = refs.lookup(key, parsed.ref);
  if (!id) throw drawRefError(`找不到訊息 #${parsed.ref}：只能用 prompt 裡出現過的 #編號`, 404);
  const channel = await resolveChannel(key);
  const message = await channel.messages.fetch(id).catch(() => null);
  if (!message) throw drawRefError(`訊息 #${parsed.ref} 已經不存在（可能被刪了），這張圖不能當參考`, 404);
  return loadReferenceImage(message, parsed.index, limits, { fetchMedia });
}

/**
 * 把【生圖完成】提示裡的 path 收斂成可直接上傳的本機檔案。
 *
 * 只認 dir 底下的檔名：模型給完整路徑或只給檔名都行，但 `..`、絕對路徑、
 * 其他目錄一律不接受。這樣 send_image 不會變成「送主機上任一張圖」的通道。
 *
 * @param dir      允許的目錄（state/discord-images）
 * @param file     【生圖完成】提示裡的 path 或檔名
 * @param options  { maxBytes }
 * @returns {{path:string, name:string, buffer:Buffer}} 已讀進記憶體的圖片
 */
export function resolveGeneratedImage(dir, file, { maxBytes = 10 * 1024 * 1024 } = {}) {
  const raw = String(file ?? '').trim();
  if (!raw) throw new Error('file 是空的：填【生圖完成】提示裡的 path');
  const name = path.basename(raw);
  if (!name || name === '.' || name === '..' || name.startsWith('.')) {
    throw new Error('檔名無效：填【生圖完成】提示裡的 path');
  }
  const full = path.join(dir, name);
  let link;
  try {
    link = fs.lstatSync(full);
  } catch {
    throw new Error(`找不到這張圖（${name}）：先用 generate_image 畫，檔名要跟【生圖完成】提示裡的 path 一樣`);
  }
  if (link.isSymbolicLink()) throw new Error(`${name} 是符號連結，不送`);
  if (!link.isFile()) throw new Error(`${name} 不是檔案`);
  if (link.size > maxBytes) throw new Error(`圖片 ${mb(link.size)} 超過 ${mb(maxBytes)} 上傳上限`);

  // 開檔後用 fstat 再確認一次，並把位元組留在記憶體；不讓 upload 再依路徑開一次
  // （驗證與使用之間被換成 symlink 的 TOCTOU）。Linux 上 O_NOFOLLOW 直接擋連結，
  // Windows 沒有這個 flag 時靠上面的 lstat。
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(full, flags);
  let buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${name} 不是檔案`);
    if (stat.size > maxBytes) throw new Error(`圖片 ${mb(stat.size)} 超過 ${mb(maxBytes)} 上傳上限`);
    buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== buffer.length) throw new Error(`讀取 ${name} 不完整`);
  } finally {
    fs.closeSync(fd);
  }
  if (!sniffImage(buffer)) throw new Error(`${name} 不是 PNG/JPEG/WebP/GIF 圖片`);
  return { path: full, name, buffer };
}

/** 跟看圖、抽格共用同一個 ffmpeg 名額，梗圖縮圖才不會跟它們搶 CPU。 */
export const runInMediaQueue = (task) => mediaQueue(task);

/**
 * save_meme 用：一則訊息第 index 張「附件」的原始位元組。
 * 不收 Discord 貼圖與連結預覽的圖：貼圖可能是別的伺服器的，預覽圖不是這則訊息的內容。
 * 動圖照收，原始位元組交給縮圖那一步判斷。
 * @returns {Promise<{buffer: Buffer, name: string}>}
 */
export async function loadMemeSourceBytes(message, index, limits, { fetchMedia = fetchDiscordMedia } = {}) {
  const { accepted, skipped } = collectMediaAttachments(messageParts(message).attachments, limits);
  const images = accepted.filter((item) => item.mime.startsWith('image/'));
  if (!images.length) {
    throw drawRefError(`這則訊息沒有能存的圖片附件${skipped[0]?.reason ? `（${skipped[0].reason}）` : ''}`, 400);
  }
  if (!Number.isInteger(index) || index < 1 || index > images.length) {
    throw drawRefError(`這則訊息只有 ${images.length} 張圖片附件，張數要填 1~${images.length}`, 400);
  }
  const item = images[index - 1];
  return { buffer: await fetchMedia(item.url, limits), name: safeName(item.name) };
}

/**
 * 把下載到的位元組整理成 DSH 的 `{type:'image', mediaType, data}`。
 * 影片先抽格拼圖，再走跟圖片一樣的出口；解析度／體積超標時交給 ffmpeg 縮小。
 * 縮不動回傳 error，由呼叫端變成一句可讀訊息。
 */
export async function prepareMediaBlock(buffer, name, limits, { deadline } = {}) {
  return mediaQueue(() => {
    // deadline 是呼叫端整通工具的預算；排隊等掉的時間也要算進去。
    if (deadline && deadline - Date.now() < MEDIA_QUEUE_MIN_MS) {
      return { error: '媒體排隊太久，這張先跳過' };
    }
    return prepareMediaBlockNow(buffer, name, limits);
  });
}

async function prepareMediaBlockNow(buffer, name, limits) {
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
export async function prepareVideoUrlBlock(url, limits, { timeoutMs, deadline } = {}) {
  return mediaQueue(() => {
    const left = deadline ? deadline - Date.now() : Infinity;
    if (left < MEDIA_QUEUE_MIN_MS) return { error: '媒體排隊太久，影片連結這次先跳過' };
    // 預算在拿到名額之後才算：排隊的時間不能白花。
    return prepareVideoUrlBlockNow(url, limits, {
      timeoutMs: Math.max(5_000, Math.min(timeoutMs ?? 45_000, left)),
    });
  });
}

async function prepareVideoUrlBlockNow(url, limits, { timeoutMs } = {}) {
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
    const data = embed?.data ?? embed;
    if (embedIsSensitive(data)) return [];

    // component embed 的文字與圖片都在 components；有 media gallery 就優先用它，
    // 只有 thumbnail 時才退而求其次（FB 的 40×40 頭像不該排在貼文照片前面）。
    const componentMedia = componentParts(data?.components).media
      .filter((item) => item.url && (item.kind !== 'file' || /^(image|video)\//.test(item.contentType)));
    const gallery = componentMedia.filter((item) => item.kind === 'gallery');
    const chosen = gallery.length ? gallery : componentMedia.filter((item) => item.kind !== 'gallery');
    if (chosen.length) {
      return chosen.map((item) => ({
        name: safeName(item.name),
        // 圖片一律交給下載後 sniff；只有影片保留 Discord 宣告的類型。
        contentType: item.contentType?.startsWith('video/') ? item.contentType : 'image/png',
        url: item.url,
        description: item.description,
        spoiler: item.spoiler,
      }));
    }

    const image = [data?.image, data?.thumbnail]
      .find((candidate) => candidate?.proxy_url || candidate?.proxyURL);
    const url = image?.proxy_url ?? image?.proxyURL;
    if (!url) return [];
    let name = 'embed';
    try {
      name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? name;
    } catch { /* 壞網址留給 collectMediaAttachments 說明 */ }
    return [{ name: safeName(name), contentType: 'image/png', url }];
  });
}

/** 被跳過的附件寫成一行給模型看的說明（模型才知道要跟使用者說看不到什麼）。 */
export function describeSkipped(skipped) {
  if (!skipped?.length) return '';
  const items = skipped.map((s) => `${safeName(s.name)}（${s.reason}）`).join('；');
  return `\n[附件未送給模型：${items}]`;
}

/**
 * view_message 的圖片來源：本則與轉發快照的附件、貼圖，
 * 以及本則、被回覆那則、修復 bot 補上的連結預覽。
 * 被回覆那則的附件也要帶：引文只留 300 字，原圖只有這裡看得到。
 */
export function viewMediaItems({ target, replied = null, fixMessages = [] } = {}) {
  const parts = messageParts(target);
  const repliedParts = messageParts(replied);
  const componentImages = (entry) => {
    const media = componentParts(entry?.components).media
      .filter((item) => item.url && (item.kind !== 'file' || /^(image|video)\//.test(item.contentType)));
    const gallery = media.filter((item) => item.kind === 'gallery');
    return (gallery.length ? gallery : media.filter((item) => item.kind !== 'gallery'))
      .map((item) => ({
        name: safeName(item.name),
        // 圖片一律交給下載後 sniff；Discord 宣告 avif 這類格式時才不會被 MIME 白名單擋掉。
        contentType: item.contentType?.startsWith('video/') ? item.contentType : 'image/png',
        url: item.url,
        description: item.description,
        spoiler: item.spoiler,
      }));
  };
  const items = [
    ...visibleAttachments(target, parts),
    ...componentImages(parts),
    ...embedImages(parts.embeds),
    ...stickerImages(parts.stickers),
    ...visibleAttachments(replied, repliedParts),
    ...componentImages(repliedParts),
    ...embedImages(repliedParts.embeds),
    ...fixMessages.flatMap((message) => {
      const fixParts = messageParts(message);
      return [
        ...visibleAttachments(message, fixParts),
        ...componentImages(fixParts),
        ...embedImages(fixParts.embeds),
      ];
    }),
  ];
  // 同一個 pathname 可能同時是附件（cdn）與 component media（proxy host）；只送一次，保留第一個。
  const seen = new Set();
  const kept = [];
  for (const item of items) {
    let key = item.url;
    try { key = new URL(item.url).pathname; } catch { /* 壞網址留給 collectMediaAttachments 說明 */ }
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept;
}
