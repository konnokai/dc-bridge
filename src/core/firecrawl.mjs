// 需要 JavaScript 才長出內容的頁面：交給自架的 Firecrawl 用瀏覽器渲染，取 markdown 正文。
//
// 端點和金鑰都只放在 config.json 的 webSearch（操作者設定，不是模型給的），所以這裡用一般
// fetch，不套 safeFetch 的內網限制：服務通常就架在同一台伺服器的 127.0.0.1。
// 要抓的網址仍是模型給的；SSRF 的邊界由 Firecrawl 自己負責，不要把它開放給外網。
const DEFAULT_API_KEY_ENV = 'FIRECRAWL_API_KEY';
const MAX_MARKDOWN_CHARS = 20_000;
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser/i;

const apiKeyOf = (config) => {
  const literal = String(config?.firecrawlApiKey ?? '').trim();
  if (literal) return literal;
  const envName = String(config?.firecrawlApiKeyEnv || DEFAULT_API_KEY_ENV).trim();
  return envName ? String(process.env[envName] ?? '').trim() : '';
};

/** 設定完整時回端點；沒設定就回空字串（呼叫端不啟用）。 */
export function firecrawlEndpoint(config) {
  const base = String(config?.firecrawlURL ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/]+/i.test(base) ? `${base}/v2/scrape` : '';
}

/**
 * @param url 要渲染的網址
 * @param config webSearch 段（firecrawlURL／firecrawlApiKey／firecrawlApiKeyEnv）
 * @returns { ok, reason? , url?, title?, description?, text?, truncated? }
 */
export async function firecrawlScrape(url, config, { fetch = globalThis.fetch } = {}) {
  const endpoint = firecrawlEndpoint(config);
  if (!endpoint) return { ok: false, reason: '沒有設定 Firecrawl（config.json 的 webSearch.firecrawlURL）' };

  const key = apiKeyOf(config);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      // 端點是操作者設定的，不跟轉址；避免設定被改壞時把請求帶到別台機器。
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: 30_000 }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    return { ok: false, reason: `連不上 Firecrawl：${error?.message ?? error}` };
  }

  let json = null;
  try {
    json = await response.json();
  } catch { /* 非 JSON 錯誤頁只看狀態碼 */ }
  if (!response.ok) {
    const detail = typeof json?.error === 'string' ? `：${json.error.slice(0, 200)}` : '';
    return { ok: false, reason: `Firecrawl 回應 HTTP ${response.status}${detail}` };
  }
  if (json?.success === false) {
    return { ok: false, reason: `Firecrawl 沒有抓到內容：${String(json?.error ?? '未知原因').slice(0, 200)}` };
  }

  const markdown = String(json?.data?.markdown ?? '').trim();
  if (!markdown) return { ok: false, reason: 'Firecrawl 沒有回傳正文' };
  const metadata = json?.data?.metadata && typeof json.data.metadata === 'object' ? json.data.metadata : {};
  const field = (value) => (typeof value === 'string' ? value : '');
  const title = field(metadata.title);
  // Firecrawl 自己會處理轉址與 DNS；被網站擋下時要當失敗，不能把驗證頁或 404 頁當正文。
  const status = Number(metadata.statusCode);
  if (Number.isFinite(status) && (status < 200 || status >= 300)) {
    const detail = field(metadata.error) ? `：${field(metadata.error).slice(0, 200)}` : '';
    return { ok: false, reason: `Firecrawl 拿到的頁面是 HTTP ${status}${detail}` };
  }
  if (CHALLENGE_TITLE.test(title) || /just a moment|attention required|checking your browser/i.test(markdown.slice(0, 600))) {
    return { ok: false, reason: 'Firecrawl 被網站的機器人驗證擋住' };
  }
  return {
    ok: true,
    url: field(metadata.url) || field(metadata.sourceURL) || String(url ?? ''),
    title,
    description: field(metadata.description),
    text: markdown.slice(0, MAX_MARKDOWN_CHARS),
    truncated: markdown.length > MAX_MARKDOWN_CHARS,
  };
}
