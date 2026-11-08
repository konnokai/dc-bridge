// X／Twitter 貼文：網址判斷、API JSON 整理，以及 view_message／web_fetch 的接入點。
// 全部離線；真正的 safeFetch 由測試注入假的回應。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fetchTwitterImage, fetchTwitterPost, firstTwitterPost, parseTwitterPost, twitterImageUrls, twitterPostLines, twitterStatusId } from '../src/core/twitter-post.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ID = '2119048213701558698';

test('twitterStatusId：認得 X／Twitter 與 fixup 家族，其他網域不算', () => {
  assert.equal(twitterStatusId(`https://x.com/yumiacn/status/${ID}`), ID);
  assert.equal(twitterStatusId(`https://twitter.com/i/status/${ID}`), ID);
  assert.equal(twitterStatusId(`https://fixvx.com/Diptipper/status/${ID}/photo/1`), ID);
  assert.equal(twitterStatusId(`https://fixupx.com/user/statuses/${ID}`), ID);
  assert.equal(twitterStatusId(`https://www.fxtwitter.com/user/status/${ID}`), ID);
  assert.equal(twitterStatusId(`https://vxtwitter.com/user/status/${ID}?s=46`), ID);
  assert.equal(twitterStatusId(`https://mobile.twitter.com/user/status/${ID}`), ID, 'mobile 前綴也認');
  assert.equal(twitterStatusId(`https://m.twitter.com/user/status/${ID}`), ID, 'm 前綴也認');
  assert.equal(twitterStatusId(`http://X.COM/user/status/${ID}`), ID, 'http 與大寫網域也認');
  assert.equal(twitterStatusId(`https://x.com/i/web/status/${ID}`), ID, '/i/web/status/ 也認');
  assert.equal(twitterStatusId(`<https://x.com/user/status/${ID}>`), ID, 'Discord 的 <...> 連結也認');
  assert.equal(twitterStatusId(`||https://x.com/user/status/${ID}||`), ID, '||...|| 也認');
  assert.equal(twitterStatusId(`看這個 https://fixvx.com/user/status/${ID}，很好笑`), ID, '訊息文字裡夾著連結也找得到');
  assert.equal(twitterStatusId('https://x.com.evil.com/user/status/123456789'), '', '子網域詐騙不算');
  assert.equal(twitterStatusId('https://x.com@evil.com/user/status/123456789'), '', 'userinfo 偽裝不算');
  assert.equal(twitterStatusId('https://example.com/user/status/123456789'), '', '別的網站不算');
  assert.equal(twitterStatusId('https://x.com/user/status/abc'), '', 'ID 不是數字不算');
  assert.equal(twitterStatusId('not a url'), '', '不是網址不算');
});

test('firstTwitterPost：照訊息本文、被回覆、修復 bot 的順序挑第一條', () => {
  const link = `https://fixvx.com/user/status/${ID}`;
  assert.equal(firstTwitterPost(['沒有連結', link, 'https://x.com/other/status/123456789']), link);
  assert.equal(firstTwitterPost(['沒有連結', '', null]), '');
  assert.equal(firstTwitterPost([]), '');
});

test('parseTwitterPost：照片、作者、正文與 alt 都留著', () => {
  const post = parseTwitterPost({
    code: 200,
    status: {
      id: ID,
      url: `https://x.com/yumiacn/status/${ID}`,
      text: '群友给前女友当舔狗\n这谁绷得住',
      created_at: 'Sat Nov 07 12:43:58 +0000 2026',
      author: { name: '海螺', screen_name: 'yumiacn' },
      media: {
        all: [
          { type: 'photo', url: `https://pbs.twimg.com/media/a.jpg?name=orig`, altText: '截圖' },
        ],
      },
    },
  });
  assert.equal(post.ok, true);
  assert.equal(post.text, '群友给前女友当舔狗 这谁绷得住', '換行收成空白');
  assert.equal(post.author.name, '海螺');
  assert.equal(post.author.screenName, 'yumiacn');
  assert.equal(post.media.length, 1);
  assert.equal(post.media[0].altText, '截圖');

  const lines = twitterPostLines(post);
  assert.match(lines[0], /海螺（@yumiacn）/);
  assert.match(lines[1], /推文內容：群友给前女友当舔狗/);
  assert.match(lines[2], /圖片 1：https:\/\/pbs\.twimg\.com\/media\/a\.jpg/);
  assert.match(lines[2], /截圖/);
});

test('parseTwitterPost：影片標出長度與縮圖，刪文回原因', () => {
  const video = parseTwitterPost({
    code: 200,
    status: {
      text: 'another speed drawing',
      author: { name: 'Diptip', screen_name: 'Diptipper' },
      media: {
        all: [{
          type: 'video',
          url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1024x576/a.mp4',
          thumbnail_url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg',
          duration: 130.4,
        }],
      },
    },
  });
  const lines = twitterPostLines(video);
  assert.ok(lines.some((line) => line.includes('影片 1 02:10')), '影片有長度');
  assert.ok(lines.some((line) => line.includes('縮圖 https://pbs.twimg.com/')), '影片有縮圖');
  assert.deepEqual(twitterImageUrls(video), [{ url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg', name: 'x-1.jpg' }]);

  const tombstone = parseTwitterPost({ status: { type: 'tombstone', reason: 'deleted' } });
  assert.equal(tombstone.ok, false);
  assert.match(tombstone.reason, /deleted/);
  assert.match(twitterPostLines(tombstone)[0], /已刪除或保護中/);
});

test('parseTwitterPost：敏感貼文只回文字，不附圖', () => {
  const post = parseTwitterPost({
    status: {
      possibly_sensitive: true,
      text: '敏感內容',
      author: { name: 'A', screen_name: 'a' },
      media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg?name=orig' }] },
    },
  });
  assert.equal(post.sensitive, true);
  assert.deepEqual(twitterImageUrls(post), []);
  assert.ok(twitterPostLines(post).some((line) => line.includes('標成敏感，媒體不附圖')));
});

test('twitterImageUrls：只留 pbs.twimg.com，照片改成 medium', () => {
  const post = parseTwitterPost({
    status: {
      media: {
        all: [
          { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg?name=orig' },
          { type: 'photo', url: 'https://evil.example.com/b.jpg' },
          { type: 'photo', url: 'https://pbs.twimg.com/media/c.jpg' },
          { type: 'photo', url: 'https://pbs.twimg.com/media/d.jpg' },
        ],
      },
    },
  });
  const images = twitterImageUrls(post, 2);
  assert.equal(images.length, 2, '上限生效');
  assert.equal(images[0].url, 'https://pbs.twimg.com/media/a.jpg?name=medium');
  assert.equal(images[1].url, 'https://pbs.twimg.com/media/c.jpg');
  assert.deepEqual(twitterImageUrls(post, 0), [], '沒有圖片名額就不挑');
});

test('fetchTwitterPost：固定打 api.fxtwitter.com，錯誤與壞掉都回原因', async () => {
  const calls = [];
  const fakeFetch = async (url, limit, opts) => {
    calls.push({ url, limit, opts });
    return {
      statusCode: 200,
      body: JSON.stringify({ code: 200, status: { text: 'hello', author: { name: 'A', screen_name: 'a' } } }),
    };
  };
  const post = await fetchTwitterPost(`https://fixvx.com/a/status/${ID}`, { fetch: fakeFetch });
  assert.equal(post.ok, true);
  assert.equal(post.text, 'hello');
  assert.equal(calls[0].url, `https://api.fxtwitter.com/2/status/${ID}`);
  assert.deepEqual(calls[0].opts.allowHosts, ['api.fxtwitter.com']);
  assert.match(calls[0].opts.userAgent, /^dc-bridge\//, '用自己的 UA，Cloudflare 才不擋');

  const missing = await fetchTwitterPost(`https://x.com/a/status/${ID}`, {
    fetch: async () => ({ statusCode: 404, body: '{"code":404,"status":null}' }),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /HTTP 404/);

  const limited = await fetchTwitterPost(`https://x.com/a/status/${ID}`, {
    fetch: async () => ({ statusCode: 429, body: '{"code":429,"status":null}' }),
  });
  assert.equal(limited.ok, false);
  assert.match(limited.reason, /限流/);

  const broken = await fetchTwitterPost(`https://x.com/a/status/${ID}`, {
    fetch: async () => ({ statusCode: 502, body: '<html>bad gateway</html>' }),
  });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /沒有回傳 JSON/);

  const down = await fetchTwitterPost(`https://x.com/a/status/${ID}`, {
    fetch: async () => { throw new Error('timeout'); },
  });
  assert.equal(down.ok, false);
  assert.match(down.reason, /連不上/);

  let untouched = false;
  const notX = await fetchTwitterPost('https://example.com/a/status/123456789', {
    fetch: async () => { untouched = true; return { statusCode: 200, body: '{}' }; },
  });
  assert.equal(notX.ok, false);
  assert.equal(untouched, false, '不是 X 網址就不打 API');
});

test('fetchTwitterImage：白名單在 DNS 之前就擋掉別的網域', async () => {
  await assert.rejects(fetchTwitterImage('https://evil.example.com/a.jpg', 1024), /仅允许 pbs\.twimg\.com/);
});

test('view_message 與 web_fetch 都有接上 X 貼文解析', () => {
  const bridge = fs.readFileSync(path.join(REPO_ROOT, 'src', 'discord-bridge.js'), 'utf8');
  const viewBody = bridge.slice(bridge.indexOf('async view(body)'), bridge.indexOf('async user(body)'));
  assert.match(viewBody, /firstTwitterPost\(/, 'view_message 照本文、被回覆、修復 bot 的順序找連結');
  assert.match(viewBody, /fetchTwitterPost\(/, 'view_message 會抓貼文');
  assert.match(viewBody, /withTimeout\(tweetPromise/, 'X 貼文受 60 秒預算限制');
  assert.match(viewBody, /twitterPostLines\(post\)/, 'view_message 會印作者、正文與媒體');
  assert.match(viewBody, /twitterImageUrls\(post/, 'view_message 會附貼文圖片或影片縮圖');
  assert.match(viewBody, /const buffer = await fetchTwitterImage\(/, '抓回來的是圖片位元組');

  const mcp = fs.readFileSync(path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');
  assert.match(mcp, /twitterStatusId\(url\)/, 'web_fetch 先認 X／Twitter 貼文');
  assert.match(mcp, /fetchTwitterPost\(url\)/, 'web_fetch 走同一條解析');
});
