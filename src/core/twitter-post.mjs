// X／Twitter 貼文 → 作者、正文與媒體。
//
// 原站與 fixvx／fixupx 這些轉址頁都拿不到正文（影片頁只回一句 Redirecting），
// 所以改用 FxEmbed 的公開 API（api.fxtwitter.com）：不用金鑰，貼文 ID 會送給第三方。
// 這裡只做網址判斷、JSON 整理與固定白名單的抓取；測試注入假的 fetch，不打外網。
import { safeFetch, safeFetchBuffer } from '../safe-fetch.js';

const API_HOST = 'api.fxtwitter.com';
// 只收貼文網域。www／mobile／m 前綴先去掉再比對，其他子網域一律不算。
// shortcut: t.co 短連結不解析（要再抓一次轉址），等真的有人直接貼再處理。
const POST_HOSTS = new Set(['x.com', 'twitter.com', 'fixvx.com', 'fixupx.com', 'fxtwitter.com', 'vxtwitter.com']);
const STATUS_PATH = /\/status(?:es)?\/(\d{2,20})(?:\/|$)/i;
// 貼文圖片與影片縮圖都在 pbs.twimg.com；API 回傳的網址也要再過一次白名單。
const IMAGE_HOSTS = ['pbs.twimg.com'];
// FxTwitter 後面的 Cloudflare 會擋 Chrome UA，換成自己的；pbs.twimg.com 不受影響。
const API_OPTS = {
  allowProtocols: ['https:'],
  allowHosts: [API_HOST],
  allowPorts: [443],
  userAgent: 'dc-bridge/0.2 (+https://github.com/konnokai/dc-bridge)',
};
const IMAGE_OPTS = { allowProtocols: ['https:'], allowHosts: IMAGE_HOSTS, allowPorts: [443] };

const LINK = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;

const statusIdFromUrl = (raw) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  const host = url.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, '');
  if (!POST_HOSTS.has(host)) return '';
  return STATUS_PATH.exec(url.pathname)?.[1] ?? '';
};

/** 從單一網址或一整段訊息文字裡挑第一條 X／Twitter 貼文，回貼文 ID；不是就回空字串。 */
export function twitterStatusId(input) {
  for (const match of String(input ?? '').matchAll(LINK)) {
    // 句尾標點不算網址（群友常寫「看這個 https://x.com/…，很好笑」）。
    const raw = match[0].replace(/[.,;:!?，。；：！？」』）)】]+$/u, '');
    const id = statusIdFromUrl(raw);
    if (id) return id;
  }
  return '';
}

/** 從多段文字挑第一段含 X 貼文的；view_message 用（訊息本文 → 被回覆 → 修復 bot）。 */
export function firstTwitterPost(inputs) {
  return (Array.isArray(inputs) ? inputs : []).find((value) => twitterStatusId(value)) ?? '';
}

const textOf = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** 秒 → mm:ss。 */
const clock = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/** FxTwitter API 的 JSON → 固定形狀。純函式，可單測。 */
export function parseTwitterPost(json) {
  const status = json?.status;
  if (!status) return { ok: false, reason: 'X 沒有回傳貼文內容' };
  if (status.type === 'tombstone') {
    return { ok: false, reason: status.reason ? `貼文已刪除或保護中（${status.reason}）` : '貼文已刪除或保護中' };
  }

  const author = status.author ?? {};
  const listed = Array.isArray(status.media?.all) && status.media.all.length
    ? status.media.all
    : [
      ...(status.media?.photos ?? []),
      ...(status.media?.videos ?? []),
      ...(status.media?.external ? [status.media.external] : []),
    ];
  const media = listed
    .filter((item) => item && typeof item.url === 'string' && item.url)
    .map((item) => ({
      type: item.type === 'video' || item.type === 'gif' ? item.type : 'photo',
      url: item.url,
      thumbnailUrl: typeof item.thumbnail_url === 'string' ? item.thumbnail_url : '',
      altText: textOf(item.altText ?? item.alt_text, 200),
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      duration: Number(item.duration) || 0,
    }));

  return {
    ok: true,
    id: String(status.id ?? ''),
    url: typeof status.url === 'string' ? status.url : '',
    text: textOf(status.text, 4000),
    author: {
      name: textOf(author.name, 80),
      screenName: textOf(author.screen_name, 40),
    },
    createdAt: textOf(status.created_at, 40),
    quoteText: textOf(status.quote?.text, 1000),
    sensitive: Boolean(status.possibly_sensitive),
    media,
  };
}

/** 模型看得懂的一段摘要；view_message 與 web_fetch 共用。 */
export function twitterPostLines(post) {
  if (!post?.ok) return [`X 貼文看不了：${post?.reason ?? '未知原因'}`];
  const handle = post.author.screenName ? `（@${post.author.screenName}）` : '';
  const when = post.createdAt ? `，${post.createdAt}` : '';
  const lines = [`X／Twitter 貼文：${post.author.name || '（沒有作者）'}${handle}${when}`];
  if (post.text) lines.push(`推文內容：${post.text}`);
  if (post.quoteText) lines.push(`引用推文：${post.quoteText}`);
  if (post.sensitive) {
    lines.push('（這則貼文標成敏感，媒體不附圖）');
    return lines;
  }
  post.media.forEach((item, index) => {
    const number = index + 1;
    if (item.type === 'photo') {
      lines.push(`圖片 ${number}：${item.url}${item.altText ? `（${item.altText}）` : ''}`);
      return;
    }
    const kind = item.type === 'gif' ? '動圖' : '影片';
    const length = item.duration ? ` ${clock(item.duration)}` : '';
    const thumbnail = item.thumbnailUrl ? `，縮圖 ${item.thumbnailUrl}` : '';
    lines.push(`${kind} ${number}${length}：${item.url}${thumbnail}`);
  });
  if (!post.text && !post.media.length) lines.push('（這則貼文沒有文字或媒體）');
  return lines;
}

/**
 * 可以附給模型的圖片：照片用原圖，影片用縮圖；只留 pbs.twimg.com 的 https 網址。
 * 照片的 name=orig 改成 name=medium，下載快一點，也夠模型看清楚。
 */
export function twitterImageUrls(post, max = 4) {
  const limit = Math.max(0, max);
  const picked = [];
  if (!limit || post?.sensitive) return picked;
  for (const item of post?.media ?? []) {
    const raw = item.type === 'photo' ? item.url : item.thumbnailUrl;
    if (!raw) continue;
    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !IMAGE_HOSTS.includes(url.hostname)) continue;
    if (url.searchParams.get('name') === 'orig') url.searchParams.set('name', 'medium');
    const candidate = url.toString();
    if (picked.some((entry) => entry.url === candidate)) continue;
    picked.push({ url: candidate, name: `x-${picked.length + 1}.jpg` });
    if (picked.length >= limit) break;
  }
  return picked;
}

/** 貼文網址 → 摘要。fetch 參數只給測試注入，正常呼叫用 safeFetch。 */
export async function fetchTwitterPost(input, { fetch = safeFetch } = {}) {
  const id = twitterStatusId(input);
  if (!id) return { ok: false, reason: '不是 X／Twitter 的貼文網址' };

  let response;
  try {
    response = await fetch(`https://${API_HOST}/2/status/${id}`, 200_000, API_OPTS);
  } catch (error) {
    return { ok: false, reason: `連不上 X 貼文服務：${error?.message ?? error}` };
  }

  let json;
  try {
    json = JSON.parse(response.body);
  } catch {
    return { ok: false, reason: `X 貼文服務沒有回傳 JSON（HTTP ${response.statusCode}）` };
  }
  const code = Number(json?.code ?? response.statusCode);
  if (code === 401 || code === 403 || code === 404) {
    return { ok: false, reason: `X 貼文不存在、已刪除或保護中（HTTP ${code}）` };
  }
  if (code === 429) return { ok: false, reason: 'X 貼文服務限流，稍後再試（HTTP 429）' };
  if (code !== 200) return { ok: false, reason: `X 貼文服務錯誤（HTTP ${code}）` };
  return parseTwitterPost(json);
}

/** 抓 pbs.twimg.com 的圖片位元組；固定白名單交給 safeFetchBuffer 逐跳檢查。 */
export async function fetchTwitterImage(url, maxBytes) {
  const result = await safeFetchBuffer(url, maxBytes, IMAGE_OPTS);
  return result.buffer;
}
