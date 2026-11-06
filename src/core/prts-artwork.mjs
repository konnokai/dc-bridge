// PRTS 立繪解析：把 operator_artwork 的檔名換成 MediaWiki 圖片網址，再抓成 buffer。
//
// 為什麼不讓模型自己填網址：模型會被群友帶偏，任意網址等於多一個 SSRF／讀圖通道。
// 這裡只認 prts.wiki 的 API 與 media.prts.wiki 的圖片，檔名也只收圖片副檔名。
import { safeFetch, safeFetchBuffer } from '../safe-fetch.js';

const API = 'https://prts.wiki/api.php';
const API_HOST = 'prts.wiki';
const IMAGE_HOSTS = ['prts.wiki', 'media.prts.wiki'];
const SAFE_OPTS = { allowProtocols: ['https:'], allowPorts: [443] };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
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
 * 解析並下載一張 PRTS 立繪。
 * fetchJson／fetchImage 可以注入，測試不用連網。
 * @returns {{buffer: Buffer, mimeType: string, name: string, width: number|null, height: number|null, url: string, variant: string}}
 */
export async function resolvePrtsArtwork({ artworkId, variant = 'preview', fetchJson = defaultJson, fetchImage = defaultImage } = {}) {
  const id = normalizeArtworkId(artworkId);
  const { key, width } = variantWidth(variant);
  const apiUrl = prtsApiUrl(id, width);
  if (new URL(apiUrl).hostname !== API_HOST) throw new Error('PRTS API 位址不對');

  const doc = await fetchJson(apiUrl);
  const info = pickImageInfo(doc);
  if (!info) throw notFound(`找不到立繪「${id}」：先用 operator_artwork 的 action=list 確認檔名`);

  // MediaWiki 偶爾回 protocol-relative 網址；用 API 當基底補成絕對網址。
  const url = assertAllowedUrl(String(info.thumburl || info.url), IMAGE_HOSTS);
  const mimeType = String(info.mime ?? '').toLowerCase();
  if (!MIME_TYPES.has(mimeType)) throw new Error(`不支援的立繪格式（${info.mime ?? '未知'}）`);

  const fetched = await fetchImage(url.toString(), MAX_IMAGE_BYTES);
  // 預設 fetcher 回 { buffer, url }（轉址後的最終網址）；測試可以只回 Buffer。
  const buffer = Buffer.isBuffer(fetched) ? fetched : fetched?.buffer;
  if (!Buffer.isBuffer(buffer)) throw new Error('PRTS 沒有回傳圖片位元組');
  if (!Buffer.isBuffer(fetched) && fetched?.url) assertAllowedUrl(fetched.url, IMAGE_HOSTS);

  return {
    buffer,
    mimeType,
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
