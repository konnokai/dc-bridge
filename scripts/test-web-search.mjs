// 共用 Web Search / safe-fetch 的離線回歸（Discord 的 mcp-web-search-safe 也用同一份）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bingSearch,
  clearSearchCache,
  deepseekSearch,
  loadSearchConfig,
  mapDeepSeekResponse,
  parseBingHtml,
  parseBingRss,
  readDshCredential,
  resolveSearchApiKey,
  searxngSearch,
  webSearch
} from '../src/web-search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 搜索：配置 / 凭据 / 结果映射 / 解析 ─────────────────────────────────────
await test('loadSearchConfig 默认值与越界收敛', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-search-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      webSearch: { provider: 'bing', maxResults: 99, maxUses: 9, timeoutMs: 1, apiKeyEnv: ' MY_KEY ' }
    }));
    const cfg = loadSearchConfig(dir);
    assert.equal(cfg.provider, 'bing');
    assert.equal(cfg.maxResults, 20, 'maxResults 上限 20');
    assert.equal(cfg.maxUses, 5, 'maxUses 上限 5');
    assert.equal(cfg.timeoutMs, 5000, 'timeoutMs 下限 5s');
    assert.equal(cfg.apiKeyEnv, 'MY_KEY');
    assert.equal(cfg.model, 'deepseek-v4-flash');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webSearch: { provider: 'nonsense' } }));
    assert.equal(loadSearchConfig(dir).provider, 'auto', '未知 provider 回退 auto');
    fs.writeFileSync(path.join(dir, 'config.json'), '{broken json');
    assert.equal(loadSearchConfig(dir).provider, 'auto', '坏配置不得让搜索崩溃');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('loadSearchConfig 支援 searxng（含私有端點開關）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-searx-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      webSearch: { provider: 'searxng', searxngURL: ' http://192.168.98.21:58918/search ', allowPrivate: true }
    }));
    const cfg = loadSearchConfig(dir);
    assert.equal(cfg.provider, 'searxng');
    assert.equal(cfg.searxngURL, 'http://192.168.98.21:58918/search');
    assert.equal(cfg.allowPrivate, true);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webSearch: { provider: 'searxng' } }));
    assert.equal(loadSearchConfig(dir).allowPrivate, false, 'allowPrivate 預設 false');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('searxngSearch：解析 JSON、去重、丟掉非 http(s) 結果', async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('format') !== 'json' || url.searchParams.get('q') !== '測試') {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { title: 'A', url: 'https://a.example/', content: 'aa' },
      { title: 'A dup', url: 'https://a.example/', content: 'dup' },
      { title: 'FTP', url: 'ftp://b.example/', content: 'bad' },
      { title: 'C', url: 'https://c.example/', content: 'cc' },
    ] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const results = await searxngSearch('測試', {
      searxngURL: `http://127.0.0.1:${server.address().port}/search`,
      allowPrivate: true,
      maxResults: 5,
      timeoutMs: 5000,
    });
    assert.deepEqual(results.map((r) => r.url), ['https://a.example/', 'https://c.example/']);
    assert.equal(results[0].snippet, 'aa');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

await test('searxngSearch：回 HTML 時明確要求開 json 格式', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not json</html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const error = await searxngSearch('q', {
      searxngURL: `http://127.0.0.1:${server.address().port}/search`,
      allowPrivate: true,
      timeoutMs: 5000,
    }).catch((e) => e);
    assert.match(String(error.message), /formats/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

await test('searxngSearch：公開端點必須 https（私有要明開 allowPrivate）', async () => {
  const error = await searxngSearch('q', {
    searxngURL: 'http://192.0.2.1:1/search',
    allowPrivate: false,
    timeoutMs: 1000,
  }).catch((e) => e);
  assert.match(String(error.message), /https/);
});

await test('webSearch：provider=searxng 走 SearXNG', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'S', url: 'https://s.example/', content: 'ss' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const value = await webSearch('測試', {
      provider: 'searxng',
      config: {
        provider: 'searxng',
        searxngURL: `http://127.0.0.1:${server.address().port}/search`,
        allowPrivate: true,
        maxResults: 5,
        timeoutMs: 5000,
      },
    });
    assert.equal(value.provider, 'searxng');
    assert.equal(value.results[0].url, 'https://s.example/');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

await test('resolveSearchApiKey 的优先级：config > env > DSH 凭据', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-home-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.QQ_TEST_SEARCH_KEY;
  try {
    fs.writeFileSync(path.join(home, '.credentials.yaml'), [
      'version: 1',
      'refs:',
      '  QQ_TEST_SEARCH_KEY: sk-from-dsh-credentials',
      'records: {}',
      ''
    ].join('\n'));
    process.env.DSH_HOME = home;
    delete process.env.QQ_TEST_SEARCH_KEY;

    assert.equal(resolveSearchApiKey({ apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }).source, 'dsh-credentials');
    assert.equal(readDshCredential('QQ_TEST_SEARCH_KEY'), 'sk-from-dsh-credentials');

    process.env.QQ_TEST_SEARCH_KEY = 'sk-from-env';
    assert.deepEqual(resolveSearchApiKey({ apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }), { key: 'sk-from-env', source: 'env' });

    assert.deepEqual(
      resolveSearchApiKey({ apiKey: 'sk-from-config', apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }),
      { key: 'sk-from-config', source: 'config' }
    );

    delete process.env.QQ_TEST_SEARCH_KEY;
    fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs: {}\nrecords: {}\n');
    assert.equal(resolveSearchApiKey({ apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }).source, 'none');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.QQ_TEST_SEARCH_KEY; else process.env.QQ_TEST_SEARCH_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('mapDeepSeekResponse：去重、去 #N 锚点、引用摘要', async () => {
  const apiKey = 'sk-secret-fixture-key';
  const response = {
    content: [
      { type: 'thinking', thinking: '...' },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: '鲸鱼娘', url: 'https://example.com/a#1', page_age: '2026-10-01' },
          { type: 'web_search_result', title: '重复', url: 'https://example.com/a#2' },
          { type: 'web_search_result', title: `鲸鱼娘（二）${apiKey}`, url: 'https://example.com/b' }
        ]
      },
      { type: 'text', text: '答案', citations: [{ url: 'https://example.com/b', cited_text: `这是引用片段 ${apiKey}` }] }
    ]
  };
  const results = mapDeepSeekResponse(response, 8, apiKey);
  assert.equal(results.length, 2, '同一 URL 必须去重');
  assert.equal(results[0].url, 'https://example.com/a', '必须去掉 #1 锚点');
  assert.equal(results[0].publishedAt, '2026-10-01');
  assert.equal(results[1].snippet, '这是引用片段 [REDACTED]', '引用摘要里的 key 必须遮掉');
  assert.ok(!JSON.stringify(results).includes(apiKey), '结果里不能出现完整 key');
  assert.throws(() => mapDeepSeekResponse({ content: [{ type: 'text', text: '没有结果块' }] }), /web_search_tool_result/);
});

await test('Bing RSS / HTML 解析：CDATA、实体、去重、上限', async () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[第一条 & 摘要]]></title><link>https://example.com/1</link><description><![CDATA[<b>加粗</b> 内容 &#x4e2d;]]></description></item>
    <item><title>第二条</title><link>https://example.com/2</link><description>&amp; 转义</description></item>
    <item><title>重复</title><link>https://example.com/1</link></item>
  </channel></rss>`;
  const fromRss = parseBingRss(rss, 8);
  assert.equal(fromRss.length, 2);
  assert.equal(fromRss[0].title, '第一条 & 摘要');
  assert.equal(fromRss[0].snippet, '加粗 内容 中');
  assert.equal(fromRss[1].snippet, '& 转义');

  const html = `<li class="b_algo"><h2><a href="https://example.com/x">X 标题</a></h2><p>X 摘要</p></li>
    <li class="b_algo"><h2><a href="https://example.com/x">重复</a></h2><p>dup</p></li>
    <li class="b_algo"><h2><a href="https://example.com/y">Y</a></h2><p>Y 摘要</p></li>`;
  const fromHtml = parseBingHtml(html, 8);
  assert.equal(fromHtml.length, 2);
  assert.equal(fromHtml[0].url, 'https://example.com/x');
  assert.equal(parseBingRss(rss, 1).length, 1, 'maxResults 必须生效');
});

await test('deepseekSearch：没有 key 时报 NO_KEY；非 https 端点直接拒绝', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-home2-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;
    const noKey = await deepseekSearch('测试', { provider: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' }).catch((e) => e);
    assert.equal(noKey?.code, 'NO_KEY');

    const insecure = await deepseekSearch('测试', {
      provider: 'deepseek',
      apiKey: 'sk-test-only-for-unit-test',
      baseURL: 'http://api.deepseek.com/anthropic/v1'
    }).catch((e) => e);
    assert.match(String(insecure?.message), /https/, 'API key 不允许发往 http 端点');

    const privateHost = await deepseekSearch('测试', {
      provider: 'deepseek',
      apiKey: 'sk-test-only-for-unit-test',
      baseURL: 'https://127.0.0.1/anthropic/v1'
    }).catch((e) => e);
    assert.match(String(privateHost?.message), /内网|本机|禁止/, 'API key 不允许发往内网/本机端点');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('webSearch：provider=deepseek 且无 key 时不静默回退（明确报错）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-home3-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;
    clearSearchCache();
    const error = await webSearch('测试', {
      root: ROOT,
      provider: 'deepseek',
      config: { provider: 'deepseek', apiKey: '', apiKeyEnv: 'DEEPSEEK_API_KEY' }
    }).catch((e) => e);
    assert.equal(error?.code, 'NO_KEY', '显式指定 deepseek 时不能悄悄回退 Bing');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('MCP 服务器复用 web-search 模块（不再自己抓 Bing HTML）', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');
  assert.match(source, /from '\.\/web-search\.js'/, 'MCP 必须复用统一搜索模块');
  assert.match(source, /webSearch\(/, 'MCP 必须调用 webSearch()');
  assert.ok(!/b_algo/.test(source), 'MCP 里不得再有一份 Bing HTML 解析（会与模块实现漂移）');
  assert.ok(!/bingSearch/.test(source), 'MCP 里不得再有一份 bingSearch 实现');
});

await test('safe-fetch：多地址时按 IPv4 优先并在失败后切换', async () => {
  // 直接验证纯函数（不联网）：一个 IPv6 在前、IPv4 在后的应答，必须排出 IPv4 优先的顺序。
  const { default: dns } = await import('node:dns');
  const original = dns.promises.lookup;
  dns.promises.lookup = async () => ([
    { address: '2408:8756:f50:4::17', family: 6 },
    { address: '116.162.45.14', family: 4 }
  ]);
  try {
    // 用动态 import 拿到"用这份 DNS 桩解析"的实例：模块在导入时捕获 lookup 引用，
    // 所以先替换再导入（与 test-audit-security 的做法一致）。
    const mod = await import(`../src/safe-fetch.js?failover=${Date.now()}`);
    assert.deepEqual(await mod.resolveSafeAddresses('example.com'), ['116.162.45.14', '2408:8756:f50:4::17']);
  } finally {
    dns.promises.lookup = original;
  }
});

// ── 搜索：空结果 note 必须进入缓存（否则 5 分钟内重复查询拿不到提示） ────────────
// 不能真联网，所以这里是**结构断言**：note 走的是 `value = {...value, note}`（新建对象），
// 而缓存存的是引用；先 cache.set 再加 note ⇒ 命中缓存时拿到的正是那个没有 note 的旧对象，
// 而「同一句 query 连着问几次」恰恰是模型最容易开始重试的场景（issue #17 的修复点）。
await test('webSearch：空结果提示在写缓存之前生成（缓存命中也要带 note）', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'web-search.js'), 'utf8');
  const noteAt = source.indexOf('没有搜到结果');
  const cacheAt = source.indexOf('cache.set(cacheKey');
  assert.ok(noteAt > 0, 'webSearch 必须给空结果附 note');
  assert.ok(cacheAt > 0, 'webSearch 必须有 5 分钟查询缓存');
  assert.ok(noteAt < cacheAt, 'note 必须在 cache.set 之前生成：缓存存的是 value 的引用，反过来写会让缓存命中丢掉提示');
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
