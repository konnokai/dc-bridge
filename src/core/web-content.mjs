// 網頁抓取後的內容整理：Google 文件的 export 改寫，以及 HTML 的 og／title／正文抽取。
// 只做純字串處理，方便離線測試；真正的網路與 SSRF 防護仍在 safe-fetch.js。

const GOOGLE_EXPORT = [
  { pattern: /^\/document\/d\/([^/]+)/, path: 'document', format: 'txt' },
  { pattern: /^\/presentation\/d\/([^/]+)/, path: 'presentation', format: 'txt' },
  { pattern: /^\/spreadsheets\/d\/([^/]+)/, path: 'spreadsheets', format: 'csv' },
];

/**
 * Google Docs／Slides／Sheets 的編輯頁改成公開 export 端點。
 * 回傳 expectText 讓呼叫端知道這是「要求純文字」的抓取；不能拿字串比較判斷，
 * 因為 URL.toString() 會把 https://example.com 補成 https://example.com/。
 */
export function normalizeWebFetchUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? ''));
  } catch {
    return { url: String(input ?? ''), expectText: false };
  }
  if (url.hostname !== 'docs.google.com') return { url: url.toString(), expectText: false };
  for (const entry of GOOGLE_EXPORT) {
    const match = entry.pattern.exec(url.pathname);
    // /d/e/<pubId>/pub 是已發佈文件；e 不是文件 id，不能改寫。
    if (!match || match[1] === 'e') continue;
    let target = `https://docs.google.com/${entry.path}/d/${match[1]}/export?format=${entry.format}`;
    if (entry.path === 'spreadsheets') {
      const gid = new URLSearchParams(url.hash.replace(/^#/, '')).get('gid') || url.searchParams.get('gid');
      if (gid) target += `&gid=${encodeURIComponent(gid)}`;
    }
    return { url: target, expectText: true };
  }
  return { url: url.toString(), expectText: false };
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

const decodeEntities = (value) => String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
  const key = String(code).toLowerCase();
  if (key.startsWith('#x')) {
    const n = Number.parseInt(key.slice(2), 16);
    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
  }
  if (key.startsWith('#')) {
    const n = Number.parseInt(key.slice(1), 10);
    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
  }
  return ENTITIES[key] ?? match;
});

const META_ATTR = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

const metaTags = (html) => {
  const tags = [];
  const pattern = /<meta\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const attrs = {};
    META_ATTR.lastIndex = 0;
    let attr;
    while ((attr = META_ATTR.exec(match[0]))) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    }
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content) tags.push({ key, content: decodeEntities(attrs.content) });
  }
  return tags;
};

const tagContent = (html, name) => {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(html);
  return match ? decodeEntities(match[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
};

// 只看開頭，避免純文字正文剛好提到 <title> 就被當成 HTML。
export const isHtml = (body) => /<(?:!doctype|html|head|body)\b/i.test(String(body ?? '').slice(0, 500));

/** 把 HTML 收成模型看得懂的標題、說明、網站名、圖片與可見文字。 */
export function extractHtmlPreview(body) {
  const html = String(body ?? '');
  const meta = metaTags(html);
  const first = (...keys) => {
    for (const key of keys) {
      const found = meta.find((tag) => tag.key === key);
      if (found) return found.content;
    }
    return '';
  };
  // 有 main／article 就先讀它，避免前 2000 字都是導覽列。
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2];
  const source = main?.trim() ? main : html;
  const text = source
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title: first('og:title') || tagContent(html, 'title'),
    description: first('og:description', 'description'),
    siteName: first('og:site_name'),
    image: first('og:image'),
    text: decodeEntities(text).slice(0, 2000),
  };
}
