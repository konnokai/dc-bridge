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

export const decodeEntities = (value) => String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
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
  // 正文只看 <body>。<title> 在 <head>，算進去會讓「只有標題」的 SPA 頁看起來有內容。
  // 被字數上限截斷的頁面可能連 <body> 都還沒出現，這時就當沒有正文。
  let visible = html;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const headEnd = /<\/head\s*>/i.exec(html);
    if (headEnd) {
      visible = html.slice(headEnd.index);
    } else {
      // HTML5 可以省略 </head> 和 <body>：遇到 body 才有的元素就當正文開始。
      // 被字數上限截斷的頁面通常停在 <style> 裡，找不到這些元素，就當沒有正文。
      const bodyStart = /<(?:body|main|article|div|p|h[1-6]|section|table|ul|ol|form|header|footer|nav)\b/i.exec(html);
      visible = bodyStart ? html.slice(bodyStart.index) : '';
    }
  }
  // 有 main／article 就先讀它，避免前 2000 字都是導覽列。
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(visible)?.[2];
  const source = main?.trim() ? main : visible;
  const text = source
    // 註解要先拿掉：註解裡一個沒關的 <svg 會讓下面的未閉合規則吃到後面。
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)(?=[\s/>])[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // 正文被字數上限截斷時，<style>／<script> 可能沒有結尾；lazy 比對抓不到，CSS 就會
    // 整段留下來（Threads 的 670 KB SPA 頁就是這樣）。沒有結尾就當它一路吃到檔尾。
    .replace(/<(script|style|noscript|template|svg)(?=[\s/>])[^>]*>[\s\S]*$/gi, ' ')
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
