// Firecrawl 接入：設定判斷、請求形狀、回應整理。全部離線，fetch 由測試注入。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firecrawlEndpoint, firecrawlScrape } from '../src/core/firecrawl.mjs';

const config = (overrides = {}) => ({
  firecrawlURL: 'http://127.0.0.1:3002',
  firecrawlApiKey: '',
  firecrawlApiKeyEnv: 'TEST_FIRECRAWL_KEY',
  ...overrides,
});

test('firecrawlEndpoint：沒設定就停用，尾端斜線收掉', () => {
  assert.equal(firecrawlEndpoint({}), '');
  assert.equal(firecrawlEndpoint({ firecrawlURL: '   ' }), '');
  assert.equal(firecrawlEndpoint({ firecrawlURL: 'not a url' }), '');
  assert.equal(firecrawlEndpoint({ firecrawlURL: 'http://127.0.0.1:3002/' }), 'http://127.0.0.1:3002/v2/scrape');
});

test('firecrawlScrape：POST /v2/scrape，回 markdown 與 metadata', async () => {
  const calls = [];
  const fakeFetch = async (endpoint, options) => {
    calls.push({ endpoint, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          markdown: '# 標題\n\n正文',
          metadata: { title: '頁面標題', description: '說明', url: 'https://example.com/final' },
        },
      }),
    };
  };
  const result = await firecrawlScrape('https://example.com/a', config(), { fetch: fakeFetch });
  assert.equal(result.ok, true);
  assert.equal(result.text, '# 標題\n\n正文');
  assert.equal(result.title, '頁面標題');
  assert.equal(result.url, 'https://example.com/final');
  assert.equal(result.truncated, false);
  assert.equal(calls[0].endpoint, 'http://127.0.0.1:3002/v2/scrape');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(JSON.parse(calls[0].options.body).formats[0], 'markdown');
  assert.equal(calls[0].options.headers.authorization, undefined, '沒設金鑰就不帶 Authorization');
});

test('firecrawlScrape：金鑰可用 config 或環境變數', async () => {
  const readAuth = async (options) => ({ ok: true, status: 200, json: async () => ({ success: true, data: { markdown: 'x' } }) });
  let seen = '';
  await firecrawlScrape('https://example.com/', config({ firecrawlApiKey: 'fc-literal' }), {
    fetch: async (_endpoint, options) => { seen = options.headers.authorization; return readAuth(options); },
  });
  assert.equal(seen, 'Bearer fc-literal');

  process.env.TEST_FIRECRAWL_KEY = 'fc-env';
  try {
    await firecrawlScrape('https://example.com/', config(), {
      fetch: async (_endpoint, options) => { seen = options.headers.authorization; return readAuth(options); },
    });
    assert.equal(seen, 'Bearer fc-env');
  } finally {
    delete process.env.TEST_FIRECRAWL_KEY;
  }
});

test('firecrawlScrape：沒設定、HTTP 錯誤、success=false、空正文都回原因', async () => {
  const disabled = await firecrawlScrape('https://example.com/', {});
  assert.equal(disabled.ok, false);
  assert.match(disabled.reason, /沒有設定 Firecrawl/);

  const denied = await firecrawlScrape('https://example.com/', config(), {
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
  });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /HTTP 500：boom/);

  const failed = await firecrawlScrape('https://example.com/', config(), {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: false, error: 'no page' }) }),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /沒有抓到內容：no page/);

  const empty = await firecrawlScrape('https://example.com/', config(), {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { markdown: '  ' } }) }),
  });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /沒有回傳正文/);

  const down = await firecrawlScrape('https://example.com/', config(), {
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(down.ok, false);
  assert.match(down.reason, /連不上 Firecrawl/);
});

test('firecrawlScrape：被擋或非 2xx 的頁面不當成正文', async () => {
  const forbidden = await firecrawlScrape('https://example.com/', config(), {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { markdown: 'Access denied', metadata: { statusCode: 403, error: 'Blocked insecure target URL' } },
      }),
    }),
  });
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.reason, /HTTP 403/);
  assert.match(forbidden.reason, /Blocked insecure target URL/);

  const challenge = await firecrawlScrape('https://example.com/', config(), {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { markdown: 'Checking your browser...', metadata: { title: 'Just a moment...' } } }),
    }),
  });
  assert.equal(challenge.ok, false);
  assert.match(challenge.reason, /機器人驗證/);
});

test('firecrawlScrape：長正文截到 20000 字並標記', async () => {
  const result = await firecrawlScrape('https://example.com/', config(), {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { markdown: 'x'.repeat(25_000), metadata: {} } }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.text.length, 20_000);
  assert.equal(result.truncated, true);
});
