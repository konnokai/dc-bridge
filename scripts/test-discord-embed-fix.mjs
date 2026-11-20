// Threads／Instagram／Facebook 貼文改走 ebfix：網址判斷、頁面解析，以及 view_message／web_fetch 的接入點。
// 全部離線；真正的 safeFetch 由測試注入假的回應。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { embedFixLines, embedFixTarget, fetchEmbedFixPost, firstEmbedFixPost, parseEmbedFixPage } from '../src/core/embed-fix.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const THREADS = 'https://www.threads.com/@forayst0910_fs/post/Df68kycgRhz';
const IG = 'https://www.instagram.com/reel/CuE2WNQs6vH/';

/** 照 ebfix 的 renderPostPage 產生的形狀；正文裡的 <br> 要留著。 */
const postPage = ({
  title = '@forayst0910_fs',
  author = '@forayst0910_fs',
  meta = 'Threads · 2026-11-19',
  body = '<p>616絕滅你有幾個媽敢剪這首剪成答辯</p>',
} = {}) => `<!DOCTYPE html>
<html><head>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${title} · Threads">
<meta property="og:site_name" content="Threads">
<meta name="author" content="${author}">
<meta http-equiv="refresh" content="0; url=${THREADS}">
<script id="discord:component-embed" type="application/json">{"component":{"components":[]}}</script>
<style>body{margin:0} .x{color:#222}</style>
</head><body>
<h1>${title}</h1>
<p class="meta">${meta}</p>
${body}
<p><a href="${THREADS}">前往 Threads 原文</a></p>
</body></html>`;

const statusPage = `<!DOCTYPE html>
<html><head>
<meta property="og:title" content="需登入的貼文">
<meta property="og:description" content="這篇貼文需要登入 Threads 才能查看，也可能是私人帳號或已刪除。">
<meta property="og:site_name" content="ebfix">
<style>.x{color:red}</style>
</head><body><h1>需登入的貼文</h1><p>這篇貼文需要登入 Threads 才能查看，也可能是私人帳號或已刪除。</p></body></html>`;

test('embedFixTarget：認得 Threads／Instagram／Facebook 貼文，其他網址不算', () => {
  assert.equal(embedFixTarget(THREADS).fetchUrl, 'https://ebfix.konnokai.me/@forayst0910_fs/post/Df68kycgRhz');
  assert.equal(embedFixTarget('https://www.threads.com/share/_fBt76jhK').fetchUrl, 'https://ebfix.konnokai.me/share/_fBt76jhK');
  assert.equal(embedFixTarget('https://threads.net/t/C-srcchPpp7').fetchUrl, 'https://ebfix.konnokai.me/t/C-srcchPpp7');
  assert.equal(embedFixTarget(IG).fetchUrl, 'https://ig.ebfix.konnokai.me/reel/CuE2WNQs6vH/');
  assert.equal(
    embedFixTarget('https://www.instagram.com/someone/p/CuE2WNQs6vH/?igsh=abc').fetchUrl,
    'https://ig.ebfix.konnokai.me/someone/p/CuE2WNQs6vH/',
    'query string 丟掉',
  );
  assert.equal(
    embedFixTarget('https://www.facebook.com/share/p/1AbCdEf/').fetchUrl,
    'https://fb.ebfix.konnokai.me/share/p/1AbCdEf/',
  );
  assert.match(
    embedFixTarget('https://www.facebook.com/groups/123/?multi_permalinks=456').fetchUrl,
    /^https:\/\/fb\.ebfix\.konnokai\.me\/groups\/123\/\?multi_permalinks=456$/,
    'story.php／groups 的貼文 id 在 query，要保留',
  );
  assert.equal(embedFixTarget('https://www.facebook.com/permalink.php?story_fbid=1&id=2').fetchUrl,
    'https://fb.ebfix.konnokai.me/permalink.php?story_fbid=1&id=2');
  assert.equal(embedFixTarget('https://www.facebook.com/'), null, '首頁不算貼文');
  assert.equal(embedFixTarget('https://www.facebook.com/reel/abc'), null, 'reel 不是數字就不是 Facebook');

  assert.equal(embedFixTarget('https://ebfix.konnokai.me/@a/post/B'), null, '已經換過網域的服務頁不用再轉');
  assert.equal(embedFixTarget('https://example.com/@a/post/B'), null, '別的網站不算');
  assert.equal(embedFixTarget('https://x.com/a/status/123456789'), null, 'X 走 FxEmbed');
  assert.equal(embedFixTarget('https://www.threads.com/@someone'), null, '個人頁不算貼文');
  assert.equal(embedFixTarget('not a url'), null);
  assert.equal(
    firstEmbedFixPost(['沒有連結', `看這個 ${THREADS}，很好笑`, 'https://www.threads.com/share/XXX']),
    `看這個 ${THREADS}，很好笑`,
    '訊息文字裡夾著連結也找得到',
  );
  assert.equal(firstEmbedFixPost([]), '');
});

test('parseEmbedFixPage：作者、日期、正文與原貼文網址都讀得到，CSS 不會混進正文', () => {
  const post = parseEmbedFixPage(postPage());
  assert.equal(post.ok, true);
  assert.equal(post.author, '@forayst0910_fs');
  assert.equal(post.date, '2026-11-19');
  assert.equal(post.text, '616絕滅你有幾個媽敢剪這首剪成答辯');
  assert.equal(post.url, THREADS, '原貼文網址來自 meta refresh');
  assert.doesNotMatch(post.text, /color:#|margin:0/, 'style 內容不會進正文');
});

test('parseEmbedFixPage：主題標籤、多段正文、回覆與引用', () => {
  const post = parseEmbedFixPage(postPage({
    author: '@alice',
    meta: 'Threads › 明日方舟 · 2026-11-20',
    body: '<blockquote><p class="meta">回覆 @bob</p><p>被回覆的內容</p></blockquote>'
      + '<p>第一段<br>換行</p><p>第二段</p>'
      + '<p class="meta"><a href="https://example.com/">個人連結</a></p>'
      + '<blockquote><p class="meta">引用 @carol 的貼文</p><p>被引用的內容</p></blockquote>',
  }));
  assert.equal(post.author, '@alice');
  assert.equal(post.topic, '明日方舟');
  assert.equal(post.text, '第一段\n換行\n\n第二段');
  assert.deepEqual(post.replyTo, { handle: 'bob', text: '被回覆的內容' });
  assert.deepEqual(post.quoted, { handle: 'carol', text: '被引用的內容' });

  const mediaOnlyQuote = parseEmbedFixPage(postPage({
    body: '<blockquote><p class="meta">引用 @carol 的貼文</p><img src="https://scontent.cdninstagram.com/a.jpg"></blockquote>',
  }));
  assert.deepEqual(mediaOnlyQuote.quoted, { handle: 'carol', text: '' }, '只有圖片的引用不能整個丟掉');

  const displayName = parseEmbedFixPage(postPage({
    title: '@alice',
    author: 'Alice (@alice)',
    meta: 'Alice (@alice) · Threads · 2026-11-20',
  }));
  assert.equal(displayName.author, 'Alice (@alice)', '優先用 meta author，保留顯示名稱');
});

test('parseEmbedFixPage：不是 ebfix 的貼文頁就回失敗，不做假成功', () => {
  const post = parseEmbedFixPage('<html><body><h1>Threads</h1><p>登入</p></body></html>');
  assert.equal(post.ok, false);
  assert.match(post.reason, /不是貼文頁/);
});

test('parseEmbedFixPage：提示卡片明說沒有正文，不假裝抓到了', () => {
  const post = parseEmbedFixPage(statusPage);
  assert.equal(post.ok, false);
  assert.equal(post.status, true);
  assert.match(post.reason, /需登入的貼文/);
  assert.match(post.reason, /沒有正文/);
  assert.doesNotMatch(post.reason, /color:red/);
  const lines = embedFixLines({ ...post, platform: 'Threads' });
  assert.match(lines[0], /Threads 看不了：需登入的貼文/);
});

test('parseEmbedFixPage：沒有作者時用標題；真的沒有文字時講清楚', () => {
  const post = parseEmbedFixPage(postPage({
    title: '@google',
    author: '',
    meta: 'Instagram · 2023-06-29',
    body: '<p>說明文字</p><video src="https://scontent.cdninstagram.com/a.mp4" controls></video>',
  }));
  assert.equal(post.ok, true);
  assert.equal(post.author, '@google', 'meta 沒有作者時用標題（帳號）');
  assert.equal(post.text, '說明文字');

  const empty = parseEmbedFixPage(postPage({
    title: '@google',
    author: '',
    meta: 'Instagram · 2023-06-29',
    body: '<video src="https://scontent.cdninstagram.com/a.mp4" controls></video>',
  }));
  assert.equal(empty.text, '', '只有影片時正文是空的');
  assert.ok(embedFixLines({ ...empty, platform: 'Instagram' }).some((line) => line.includes('沒有文字，只有圖片或影片')));
});

test('fetchEmbedFixPost：固定打 ebfix 子網域，錯誤與壞掉都回原因', async () => {
  const calls = [];
  const fakeFetch = async (url, limit, opts) => {
    calls.push({ url, limit, opts });
    return { statusCode: 200, body: postPage() };
  };
  const post = await fetchEmbedFixPost(THREADS, { fetch: fakeFetch });
  assert.equal(post.ok, true);
  assert.equal(post.platform, 'Threads');
  assert.equal(post.text, '616絕滅你有幾個媽敢剪這首剪成答辯');
  assert.equal(calls[0].url, 'https://ebfix.konnokai.me/@forayst0910_fs/post/Df68kycgRhz');
  assert.deepEqual([...calls[0].opts.allowProtocols], ['https:']);
  assert.deepEqual([...calls[0].opts.allowPorts], [443]);
  assert.deepEqual([...calls[0].opts.allowHosts], ['ebfix.konnokai.me', 'ig.ebfix.konnokai.me', 'fb.ebfix.konnokai.me'], '轉址也不能離開 ebfix');
  assert.match(calls[0].opts.userAgent, /^dc-bridge\//, '用自己的 UA');

  const down = await fetchEmbedFixPost(THREADS, { fetch: async () => ({ statusCode: 503, body: '' }) });
  assert.equal(down.ok, false);
  assert.match(down.reason, /HTTP 503/);

  // ebfix 對上游暫時失敗時也會回 503 提示卡片；卡片文字比狀態碼有用。
  const transient = await fetchEmbedFixPost(THREADS, {
    fetch: async () => ({
      statusCode: 503,
      body: '<html><head><meta property="og:site_name" content="ebfix"><meta property="og:description" content="上游暫時無法回應，請稍後再試。"></head>'
        + '<body><h1>暫時無法取得預覽</h1></body></html>',
    }),
  });
  assert.equal(transient.ok, false);
  assert.equal(transient.status, true);
  assert.match(transient.reason, /暫時無法取得預覽/);

  const broken = await fetchEmbedFixPost(THREADS, { fetch: async () => { throw new Error('timeout'); } });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /連不上 embed fix 服務/);

  let untouched = false;
  const notSocial = await fetchEmbedFixPost('https://example.com/a', {
    fetch: async () => { untouched = true; return { statusCode: 200, body: '' }; },
  });
  assert.equal(notSocial.ok, false);
  assert.equal(untouched, false, '不是社群貼文就不打 ebfix');
});

test('view_message 與 web_fetch 都有接上 embed fix', () => {
  const core = path.join(REPO_ROOT, 'src', 'core');
  const bridge = [path.join(REPO_ROOT, 'src', 'discord-bridge.js'), ...fs.readdirSync(core)
    .filter((name) => /^discord-bridge-.+\.mjs$/.test(name))
    .map((name) => path.join(core, name))]
    .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const start = bridge.indexOf('async view(body)');
  const end = bridge.indexOf('async user(body)');
  assert.notEqual(start, -1, 'view_message 錨點還在');
  assert.notEqual(end, -1, 'user 錨點還在');
  const viewBody = bridge.slice(start, end);
  assert.match(viewBody, /firstEmbedFixPost\(/, 'view_message 照本文、被回覆、修復 bot 的順序找連結');
  assert.match(viewBody, /fetchEmbedFixPost\(/, 'view_message 會向 ebfix 要正文');
  assert.match(viewBody, /embedFixLines\(socialPost\)/, 'view_message 會印作者與正文');
  assert.match(viewBody, /withTimeout\(socialPromise/, '社群貼文受 60 秒預算限制');

  const mcp = fs.readFileSync(path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');
  assert.match(mcp, /embedFixTarget\(url\)/, 'web_fetch 先認 Threads／Instagram／Facebook');
  assert.match(mcp, /fetchEmbedFixPost\(url\)/, 'web_fetch 走同一條解析');
  assert.match(mcp, /firecrawlFallback\(url\)/, '只有框架的頁面交給 Firecrawl');
});
