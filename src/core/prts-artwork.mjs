// PRTS 立繪解析：把 operator_artwork 的檔名換成 MediaWiki 圖片網址，再抓成 buffer。
//
// 為什麼不直接走 MediaWiki API：prts.wiki 的 GeoDNS 會輪換 CDN 池，Node 的
// safeFetch 一次只試 4 個位址；遇到連不上的池就整個逾時。檔名到圖片路徑是
// MediaWiki 的固定規則（MD5 前兩碼 + 檔名），直接組 media.prts.wiki 的網址
// 少一個 host，也避開 API 的 DNS 池。真的組不出來才回頭查 API。
//
// 為什麼不給模型自己填網址：模型會被群友帶偏，任意網址等於多一個 SSRF／讀圖通道。
// 這裡只認 prts.wiki 的 API 與 media.prts.wiki 的圖片，檔名也只收圖片副檔名。
import crypto from 'node:crypto';
import { looksLikeImageBuffer, safeFetch, safeFetchBuffer } from '../safe-fetch.js';

const API = 'https://prts.wiki/api.php';
const API_HOST = 'prts.wiki';
const MEDIA_HOST = 'media.prts.wiki';
const IMAGE_HOSTS = ['prts.wiki', 'media.prts.wiki'];
const SAFE_OPTS = { allowProtocols: ['https:'], allowPorts: [443] };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 20_000;
// 控制字元、bidi 控制與零寬字元都不該出現在檔名裡；只收四種圖片副檔名。
const ARTWORK_ID = /^[^\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]{1,160}\.(?:png|jpe?g|webp)$/i;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
// 貼圖用 preview 就夠；生圖參考固定用 large（1024px），256px 會掉太多細節。
const VARIANTS = { preview: 256, large: 1024 };

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const notFound = (message) => Object.assign(new Error(message), { statusCode: 404 });

/** 只收 operator_artwork 回傳的檔名；路徑、萬用字元與非圖片一律拒絕。 */
export function normalizeArtworkId(value) {
  const id = String(value ?? '').trim();
  if (!ARTWORK_ID.test(id) || id.includes('..')) {
    throw badRequest('立繪檔名格式不對：要填 operator_artwork 的 action=list 回傳的檔名（.png/.jpg/.webp）');
  }
  return id;
}

/** preview = 256px、large = 1024px；不支援 original（原圖可能超過附件上限）。 */
export function variantWidth(variant = 'preview') {
  const key = String(variant ?? 'preview').toLowerCase();
  if (!Object.hasOwn(VARIANTS, key)) throw badRequest('variant 只能是 preview 或 large');
  return { key, width: VARIANTS[key] };
}

/** MediaWiki API 的查詢網址；titles 用檔名，iiurlwidth 讓它回縮圖網址。 */
export function prtsApiUrl(artworkId, width) {
  const params = new URLSearchParams({
    action: 'query',
    titles: `File:${artworkId}`,
    prop: 'imageinfo',
    iiprop: 'url|mime|size',
    format: 'json',
  });
  if (width) params.set('iiurlwidth', String(width));
  return `${API}?${params}`;
}

/**
 * 直接組 media.prts.wiki 的縮圖網址，不查 API。
 *
 * MediaWiki 的路徑是 MD5(檔名) 的前 1 碼與前 2 碼。縮圖在 /thumb/ 下；
 * 原圖本來就只有 1024px 時 MediaWiki 不會生縮圖，large 會再用 prtsOriginalUrl()
 * 試一次原圖。原圖 fallback 可能大於 1024px，超過 8MB 就交給 API fallback。
 * @returns {string}
 */
export function prtsDirectUrl(artworkId, width) {
  const name = String(artworkId).replaceAll(' ', '_');
  // MediaWiki 的 $wgCapitalLinks 預設把檔名第一個字母轉大寫再算 MD5；中文不受影響。
  const normalized = name.charAt(0).toUpperCase() + name.slice(1);
  const hash = crypto.createHash('md5').update(normalized).digest('hex');
  const encoded = encodeURIComponent(normalized);
  return `https://${MEDIA_HOST}/thumb/${hash[0]}/${hash.slice(0, 2)}/${encoded}/${width}px-${encoded}`;
}

/** 原圖網址；large 的縮圖不存在時（原圖本來就只有 1024px）改抓這一個。 */
export function prtsOriginalUrl(artworkId) {
  const name = String(artworkId).replaceAll(' ', '_');
  const normalized = name.charAt(0).toUpperCase() + name.slice(1);
  const hash = crypto.createHash('md5').update(normalized).digest('hex');
  const encoded = encodeURIComponent(normalized);
  return `https://${MEDIA_HOST}/${hash[0]}/${hash.slice(0, 2)}/${encoded}`;
}

/** 從圖片位元組判斷 MIME；safeFetchBuffer 已驗過 magic，這裡只負責回傳正確的值。 */
function imageMime(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** 從 API 回應挑第一張有圖的頁面；檔案不存在時 pages 會是 -1。 */
export function pickImageInfo(doc) {
  for (const page of Object.values(doc?.query?.pages ?? {})) {
    const info = page?.imageinfo?.[0];
    if (info?.url) return info;
  }
  return null;
}

/** 轉址後的最終網址也要是 https/443 且在允許網域內；protocol-relative 用 API 當基底。 */
function assertAllowedUrl(raw, hosts, base = API) {
  const url = new URL(raw, base);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !hosts.includes(url.hostname)) {
    throw new Error(`立繪網址不在允許的網域（${url.hostname}）`);
  }
  return url;
}

/**
 * safeFetch 的網路層錯誤（逾時、連不上）。
 * API fallback 最後還是抓同一個 media.prts.wiki；這裡再查一次只是多等 20 秒，
 * 而且會讓 dc-draw-image 的 60 秒參考圖預算被吃光。HTTP 4xx／5xx 才值得回頭查 API。
 */
function isNetworkError(error) {
  return /请求超时|已尝试|ENETUNREACH|ECONN|EAI_AGAIN|socket hang up/i.test(String(error?.message ?? ''));
}

/**
 * 從 Cloudflare Worker + R2 快取拿圖；Worker 只接受 media.prts.wiki／prts.wiki 的圖片路徑。
 * 失敗時由呼叫端 fallback 回 defaultImage()，不讓 Worker 變成新的單點故障。
 * proxyFetch 是測試注入點；正式用全域 fetch。
 * @returns {{buffer: Buffer, url: string}}
 */
export async function fetchProxyImage(proxyUrl, token, targetUrl, maxBytes, { fetchImpl = fetch } = {}) {
  const base = new URL(String(proxyUrl ?? ''));
  // 正式一定要 https；只有本機 wrangler dev 才允許 http。
  const localHttp = base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname);
  if (base.protocol !== 'https:' && !localHttp) throw new Error('PRTS proxy URL 只允許 https');
  if (!token) throw new Error('PRTS proxy token 沒有設定');

  const target = new URL(base);
  target.searchParams.set('u', targetUrl);
  const res = await fetchImpl(target.toString(), {
    headers: { 'x-prts-token': String(token) },
    redirect: 'error',
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });
  if (!res.ok) {
    const error = new Error(`PRTS proxy 回應 HTTP ${res.status}`);
    error.statusCode = res.status;
    throw error;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('PRTS proxy 回傳圖片超過大小限制');
  if (!looksLikeImageBuffer(buffer)) throw new Error('PRTS proxy 回傳的不是有效圖片');
  return { buffer, url: targetUrl };
}

/**
 * 解析並下載一張 PRTS 立繪。
 * fetchJson／fetchImage 可以注入，測試不用連網；direct=false 只走 API（測 API 邊界）。
 * @returns {{buffer: Buffer, mimeType: string, name: string, width: number|null, height: number|null, url: string, variant: string}}
 */
export async function resolvePrtsArtwork({
  artworkId,
  variant = 'preview',
  fetchJson = defaultJson,
  fetchImage = defaultImage,
  direct = true,
  proxyUrl = '',
  proxyToken = '',
  proxyFetch = fetch,
} = {}) {
  const id = normalizeArtworkId(artworkId);
  const { key, width } = variantWidth(variant);
  let directError = null;
  // Worker 快取優先；Worker 掛掉或回錯就 fallback 回直連。
  const imageFetcher = proxyUrl && proxyToken
    ? async (url, maxBytes) => {
        try {
          return await fetchProxyImage(proxyUrl, proxyToken, url, maxBytes, { fetchImpl: proxyFetch });
        } catch (error) {
          // Worker 說上游 404 就換下一個候選（例如縮圖不存在、改抓原圖），不要再多花一次直連。
          if (error?.statusCode === 404) throw error;
          console.warn(`[prts-artwork] proxy 失敗，改走直連：${error?.message ?? error}`);
          return fetchImage(url, maxBytes);
        }
      }
    : fetchImage;

  if (direct) {
    // large 的縮圖 404 有兩種可能：原圖本來就只有 1024px（抓原圖），或檔案不存在（查 API）。
    // shortcut: 原圖 fallback 可能大於 1024px；超過 8MB 會失敗，要嚴格 1024px 得等上游支援壓縮。
    const candidates = key === 'large' ? [prtsDirectUrl(id, width), prtsOriginalUrl(id)] : [prtsDirectUrl(id, width)];
    for (const candidate of candidates) {
      try {
        const fetched = await imageFetcher(candidate, MAX_IMAGE_BYTES);
        // 預設 fetcher 回 { buffer, url }（轉址後的最終網址）；測試可以只回 Buffer。
        const buffer = Buffer.isBuffer(fetched) ? fetched : fetched?.buffer;
        if (!Buffer.isBuffer(buffer)) throw new Error('PRTS 沒有回傳圖片位元組');
        const finalUrl = Buffer.isBuffer(fetched) ? candidate : fetched?.url;
        if (finalUrl) assertAllowedUrl(finalUrl, IMAGE_HOSTS);
        const mimeType = imageMime(buffer);
        if (!mimeType) throw new Error('PRTS 回傳的不是支援的圖片（PNG/JPEG/WebP）');
        return {
          buffer,
          mimeType,
          name: id,
          width: null,
          height: null,
          url: finalUrl ?? candidate,
          variant: key,
        };
      } catch (error) {
        directError = error;
        // 網路層失敗就別再試下一個候選，否則 Worker + 直連會把 60 秒預算吃光。
        if (isNetworkError(error)) break;
      }
    }
    if (directError && isNetworkError(directError)) {
      throw new Error(`抓不到 PRTS 立繪「${id}」：${directError.message}`);
    }
  }

  const apiUrl = prtsApiUrl(id, width);
  if (new URL(apiUrl).hostname !== API_HOST) throw new Error('PRTS API 位址不對');

  let doc;
  try {
    doc = await fetchJson(apiUrl);
  } catch (error) {
    if (error?.statusCode === 404 || /找不到立繪/.test(String(error?.message))) throw error;
    const directMessage = directError ? `直接抓圖：${directError.message}；` : '';
    throw new Error(`抓不到 PRTS 立繪「${id}」：${directMessage}PRTS API：${error?.message ?? error}`);
  }
  const info = pickImageInfo(doc);
  if (!info) throw notFound(`找不到立繪「${id}」：先用 operator_artwork 的 action=list 確認檔名`);

  // MediaWiki 偶爾回 protocol-relative 網址；用 API 當基底補成絕對網址。
  const url = assertAllowedUrl(String(info.thumburl || info.url), IMAGE_HOSTS);
  const declaredMime = String(info.mime ?? '').toLowerCase();
  if (!MIME_TYPES.has(declaredMime)) throw new Error(`不支援的立繪格式（${info.mime ?? '未知'}）`);

  const fetched = await imageFetcher(url.toString(), MAX_IMAGE_BYTES);
  // 預設 fetcher 回 { buffer, url }（轉址後的最終網址）；測試可以只回 Buffer。
  const buffer = Buffer.isBuffer(fetched) ? fetched : fetched?.buffer;
  if (!Buffer.isBuffer(buffer)) throw new Error('PRTS 沒有回傳圖片位元組');
  if (!Buffer.isBuffer(fetched) && fetched?.url) assertAllowedUrl(fetched.url, IMAGE_HOSTS);

  return {
    buffer,
    mimeType: imageMime(buffer) ?? declaredMime,
    name: id,
    width: Number(info.thumbwidth || info.width) || null,
    height: Number(info.thumbheight || info.height) || null,
    url: url.toString(),
    variant: key,
  };
}

async function defaultJson(url) {
  const res = await safeFetch(url, 200_000, { ...SAFE_OPTS, allowHosts: [API_HOST] });
  if (res.statusCode !== 200) throw new Error(`PRTS API 回應 HTTP ${res.statusCode}`);
  assertAllowedUrl(res.url, [API_HOST]);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error('PRTS API 回應不是合法 JSON');
  }
}

async function defaultImage(url, maxBytes) {
  const res = await safeFetchBuffer(url, maxBytes, { ...SAFE_OPTS, allowHosts: IMAGE_HOSTS });
  assertAllowedUrl(res.url, IMAGE_HOSTS);
  return { buffer: res.buffer, url: res.url };
}
