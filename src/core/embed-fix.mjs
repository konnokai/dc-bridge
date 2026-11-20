// Threads／Instagram／Facebook 貼文 → ebfix 靜態頁（自架 embed fix 服務）。
//
// 原站是 SPA：HTML 只有框架和一大段樣式，正文要 JS 才長出來，直接抓只會拿到 CSS。
// ebfix 用同樣的路徑、只換網域，回一篇含 og 標籤和可見正文的靜態頁；貼文轉成
// 需登入／已刪除時，回一張寫明原因的提示卡片，不會假裝有內容。
import { safeFetch } from '../safe-fetch.js';
import { decodeEntities } from './web-content.mjs';

const SERVICE = 'ebfix.konnokai.me';
const INSTAGRAM_SERVICE = `ig.${SERVICE}`;
const FACEBOOK_SERVICE = `fb.${SERVICE}`;
// 服務在 Cloudflare 上，用自己的 UA；模板照 twitter-post.mjs。
// 網域白名單要在轉址前就生效：ebfix 哪天回 301，不能讓 safeFetch 跟著去抓原站。
const FETCH_OPTS = {
  allowProtocols: ['https:'],
  allowHosts: [SERVICE, INSTAGRAM_SERVICE, FACEBOOK_SERVICE],
  allowPorts: [443],
  userAgent: 'dc-bridge/0.2 (+https://github.com/konnokai/dc-bridge)',
};

const THREADS_HOSTS = new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const FACEBOOK_HOSTS = new Set([
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'mbasic.facebook.com', 'web.facebook.com', 'fb.com', 'www.fb.com',
]);

// 路徑規則照 ebfix 的 router；共用網域有碰撞，所以 Instagram／Facebook 走各自的子網域。
const THREADS_PATH = /^\/(?:(?:@|%40)[A-Za-z0-9._]*\/post\/[A-Za-z0-9_-]+(?:\/.*)?|t\/[A-Za-z0-9_-]+\/?|share\/[A-Za-z0-9_-]+\/?)$/;
const INSTAGRAM_PATH = /^\/(?:[A-Za-z0-9._]+\/(?:p|reel)\/[A-Za-z0-9_-]+|(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+|share\/(?:(?:p|reel)\/)?[A-Za-z0-9_-]+)\/?$/;
const FACEBOOK_PATHS = [
  /^\/[A-Za-z0-9._-]+\/posts\/(?:pfbid[A-Za-z0-9]+|\d+)\/?$/,
  /^\/reel\/\d+\/?$/,
  /^\/[A-Za-z0-9._-]+\/videos\/(?:[^/]+\/)?\d+\/?$/,
  /^\/watch\/?$/,
  /^\/(?:story|permalink)\.php$/,
  /^\/(?:photo\/?|photo\.php)$/,
  /^\/groups\/[A-Za-z0-9._-]+\/(?:posts|permalink)\/\d+\/?$/,
  /^\/groups\/[A-Za-z0-9._-]+\/?$/,
  /^\/profile\.php$/,
  /^\/people\/[^/]+\/(?:pfbid[A-Za-z0-9]+|\d+)\/?$/,
  /^\/p\/[^/]+-\d{9,}\/?$/,
  /^\/share\/(?:(?:p|r|v)\/)?[A-Za-z0-9_-]+\/?$/,
];

const LINK = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
const TRAILING = /[.,;:!?，。；：！？」』）)】]+$/u;

const targetFromUrl = (raw) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  // 原站都支援 https；統一改成 https，Firecrawl 那條路才不會拿到明文網址。
  const original = new URL(url);
  original.protocol = 'https:';
  const originalUrl = original.toString();
  if (THREADS_HOSTS.has(host) && THREADS_PATH.test(url.pathname)) {
    return { platform: 'Threads', fetchUrl: `https://${SERVICE}${url.pathname}`, originalUrl };
  }
  if (INSTAGRAM_HOSTS.has(host) && INSTAGRAM_PATH.test(url.pathname)) {
    return { platform: 'Instagram', fetchUrl: `https://${INSTAGRAM_SERVICE}${url.pathname}`, originalUrl };
  }
  if (FACEBOOK_HOSTS.has(host) && FACEBOOK_PATHS.some((pattern) => pattern.test(url.pathname))) {
    return {
      platform: 'Facebook',
      // story.php／permalink.php／watch 的貼文 id 在 query；ebfix 自己會丟掉其他追蹤參數。
      fetchUrl: `https://${FACEBOOK_SERVICE}${url.pathname}${url.search}`,
      originalUrl,
    };
  }
  return null;
};

/** 從單一網址或一整段訊息文字裡挑第一條貼文網址；不是就回 null。 */
export function embedFixTarget(input) {
  for (const match of String(input ?? '').matchAll(LINK)) {
    const target = targetFromUrl(match[0].replace(TRAILING, ''));
    if (target) return target;
  }
  return null;
}

/** 從多段文字挑第一段含貼文網址的；view_message 用（訊息本文 → 被回覆 → 修復 bot）。 */
export function firstEmbedFixPost(inputs) {
  return (Array.isArray(inputs) ? inputs : []).find((value) => embedFixTarget(value)) ?? '';
}

const metaContent = (html, key) => {
  const pattern = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i');
  return decodeEntities(pattern.exec(html)?.[1] ?? '').trim();
};

const tagText = (html, name) => {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(html);
  return match ? decodeEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
};

const plainText = (html) => decodeEntities(
  String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div)>/gi, '\n')
    .replace(/<[^>]*>/g, ''),
)
  .replace(/\uFFFC/g, '')
  .split('\n')
  .map((line) => line.replace(/[ \t]+$/g, ''))
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLATFORM_NAMES = ['Threads', 'Instagram', 'Facebook', 'Naver Cafe'];

const parseMetaLine = (line) => {
  const parts = String(line ?? '').split(' · ').map((part) => part.trim()).filter(Boolean);
  const date = parts.find((part) => DATE.test(part)) ?? '';
  const site = parts.find((part) => PLATFORM_NAMES.some((name) => part === name || part.startsWith(`${name} › `))) ?? '';
  const topic = site.includes(' › ') ? site.slice(site.indexOf(' › ') + 3) : '';
  const author = parts.find((part) => part !== date && part !== site) ?? '';
  return { author, date, topic };
};

/**
 * ebfix 頁面 → 貼文欄位。純字串處理，可離線測試。
 * 提示卡片（需登入／已刪除）的 og:site_name 是 ebfix，跟正常貼文分得開。
 */
export function parseEmbedFixPage(html) {
  const source = String(html ?? '');
  const title = tagText(source, 'h1') || metaContent(source, 'og:title');
  const description = metaContent(source, 'og:description');
  const siteName = metaContent(source, 'og:site_name');
  if (siteName === 'ebfix') {
    return {
      ok: false,
      status: true,
      reason: `${title || '只有提示卡片'}${description ? `（${description}）` : ''}，沒有正文`,
    };
  }
  // 只認 ebfix 產生的貼文頁。少了這個檢查，轉址拿到原站 SPA 時會回一個「沒有文字」的假成功。
  if (!PLATFORM_NAMES.includes(siteName) && !source.includes('id="discord:component-embed"')) {
    return { ok: false, reason: 'embed fix 服務回的不是貼文頁，沒有作者與正文' };
  }

  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(source)?.[1] ?? '';
  const blocks = [];
  for (const match of body.matchAll(/<(h1|p|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const text = plainText(match[3]);
    if (!text) continue;
    blocks.push({
      tag: match[1].toLowerCase(),
      meta: /\bclass\s*=\s*["'][^"']*\bmeta\b/i.test(match[2]),
      link: /<a\b/i.test(match[3]),
      text,
    });
  }

  let pageTitle = '';
  let metaLine = '';
  const quotes = [];
  const paragraphs = [];
  for (const block of blocks) {
    if (block.tag === 'h1') {
      pageTitle ||= block.text;
    } else if (block.tag === 'blockquote') {
      quotes.push(block.text);
    } else if (block.meta) {
      if (!metaLine && !block.link) metaLine = block.text;
    } else if (!block.link) {
      paragraphs.push(block.text);
    }
  }

  const meta = parseMetaLine(metaLine);
  let replyTo = null;
  let quoted = null;
  for (const text of quotes) {
    // 只有圖片／影片的引用貼文沒有正文，不能因此把整個引用丟掉。
    const match = /^(回覆|引用) @([^\s：]+)(?: 的貼文)?(?:\n([\s\S]+))?$/.exec(text);
    if (!match) continue;
    const entry = { handle: match[2], text: match[3]?.trim() ?? '' };
    if (match[1] === '回覆') replyTo ||= entry;
    else quoted ||= entry;
  }
  const original = /<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i.exec(source)?.[1];

  return {
    ok: true,
    title: pageTitle || title,
    author: metaContent(source, 'author') || meta.author || pageTitle,
    date: meta.date,
    topic: meta.topic,
    text: paragraphs.join('\n\n'),
    replyTo,
    quoted,
    url: decodeEntities(original ?? '').trim(),
  };
}

/** 貼文網址 → 內容。fetch 參數只給測試注入，正常呼叫用 safeFetch。 */
export async function fetchEmbedFixPost(input, { fetch = safeFetch } = {}) {
  const target = embedFixTarget(input);
  if (!target) return { ok: false, reason: '不是 Threads／Instagram／Facebook 的貼文網址' };

  let response;
  try {
    response = await fetch(target.fetchUrl, 1_000_000, FETCH_OPTS);
  } catch (error) {
    return { ok: false, platform: target.platform, reason: `連不上 embed fix 服務：${error?.message ?? error}` };
  }
  const page = parseEmbedFixPage(response?.body);
  // 503 也會回一張「暫時無法取得預覽」的提示卡片；卡片比狀態碼有用，先採用。
  if (Number(response?.statusCode) !== 200 && !page.status) {
    return {
      ok: false,
      platform: target.platform,
      reason: `embed fix 服務沒有正常回應（HTTP ${response?.statusCode ?? '未知'}）`,
    };
  }
  return { platform: target.platform, url: target.originalUrl, ...page };
}

/** 模型看得懂的一段摘要；view_message 與 web_fetch 共用。 */
export function embedFixLines(post) {
  const platform = post?.platform ?? '社群貼文';
  if (!post?.ok) return [`${platform} 看不了：${post?.reason ?? '未知原因'}`];
  const heading = [post.author, post.date ? `（${post.date}）` : ''].filter(Boolean).join('');
  const lines = [`${platform} 貼文${heading ? `：${heading}` : ''}`];
  if (post.topic) lines.push(`主題標籤：${post.topic}`);
  if (post.text) lines.push(`貼文內容：${post.text}`);
  else if (!post.quoted) lines.push('貼文內容：（沒有文字，只有圖片或影片）');
  const quotedText = (entry) => (entry.text ? `：${entry.text}` : '：（沒有文字，只有圖片或影片）');
  if (post.replyTo) lines.push(`回覆 @${post.replyTo.handle}${quotedText(post.replyTo)}`);
  if (post.quoted) lines.push(`引用 @${post.quoted.handle}${quotedText(post.quoted)}`);
  if (post.url) lines.push(`原貼文：${post.url}`);
  return lines;
}
