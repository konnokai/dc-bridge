// 網頁抓取後的純字串處理：Google export 改寫、HTML 預覽、fetchVerdict。
// 離線測試，不打真網站。
import assert from 'node:assert/strict';
import { fetchVerdict } from '../src/core/fetch-verdict.mjs';
import { extractHtmlPreview, isHtml, normalizeWebFetchUrl } from '../src/core/web-content.mjs';

const ok = (condition, label) => {
  assert.ok(condition, label);
  console.log(`✅ ${label}`);
};

const docs = normalizeWebFetchUrl('https://docs.google.com/document/d/abc123/edit?usp=sharing');
ok(docs.url === 'https://docs.google.com/document/d/abc123/export?format=txt' && docs.expectText,
  'Google Docs 改成 txt export');
const slides = normalizeWebFetchUrl('https://docs.google.com/presentation/d/abc123/edit#slide=id.p1');
ok(slides.url === 'https://docs.google.com/presentation/d/abc123/export?format=txt' && slides.expectText,
  'Google Slides 改成 txt export');
const sheets = normalizeWebFetchUrl('https://docs.google.com/spreadsheets/d/abc123/edit#gid=456');
ok(sheets.url === 'https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=456' && sheets.expectText,
  'Google Sheets 改成 csv export，保留 gid');
const published = normalizeWebFetchUrl('https://docs.google.com/document/d/e/2PACX-abc/pub');
ok(published.url === 'https://docs.google.com/document/d/e/2PACX-abc/pub' && !published.expectText,
  '已發佈文件 /d/e/ 不改寫');
const plainUrl = normalizeWebFetchUrl('https://example.com');
ok(plainUrl.url === 'https://example.com/' && !plainUrl.expectText, '一般網址不會被當成要純文字的 export');
ok(normalizeWebFetchUrl('not a url').url === 'not a url', '壞網址原樣回傳，交給 safeFetch 報錯');

const html = `<!doctype html><html><head>
<title>頁面標題</title>
<meta property="og:title" content="OG 標題 &amp; 測試">
<meta name="description" content="一般說明">
<meta property="og:description" content="OG 說明">
<meta property="og:site_name" content="範例站">
<meta property="og:image" content="https://example.com/a.png">
<script>不該出現的腳本</script><style>.x{color:red}</style>
</head><body><article>正文第一段</article><p>正文第二段</p></body></html>`;
const preview = extractHtmlPreview(html);
ok(preview.title === 'OG 標題 & 測試', 'og:title 優先，entity 解碼');
ok(preview.description === 'OG 說明', 'og:description 優先');
ok(preview.siteName === '範例站' && preview.image === 'https://example.com/a.png', 'site_name 與 image 讀得到');
ok(preview.text.includes('正文第一段'), '可見正文讀得到');
ok(!preview.text.includes('不該出現的腳本') && !preview.text.includes('color:red'), 'script/style 不會進正文');
const articlePreview = extractHtmlPreview('<html><body><nav>導覽列</nav><article>正文內容</article><footer>頁尾</footer></body></html>');
ok(articlePreview.text === '正文內容', '有 article 時只取 article，不拿導覽列');
ok(isHtml(html) && !isHtml('純文字'), 'HTML 判斷正確');
ok(!isHtml('這段文字提到 <title> 標籤，但不是 HTML'), '純文字提到 <title> 不會被誤判成 HTML');

const plain = fetchVerdict({ url: 'https://example.com/a', statusCode: 200, truncated: false, body: '純文字正文' });
ok(!plain.isError && JSON.parse(plain.text).text === '純文字正文', '純文字回 text 欄位');
const page = fetchVerdict({ url: 'https://example.com/a', statusCode: 200, truncated: false, body: html });
ok(!page.isError && JSON.parse(page.text).title === 'OG 標題 & 測試', 'HTML 回標題與正文，不是原始 HTML');
const login = fetchVerdict({
  url: 'https://docs.google.com/presentation/d/x/export?format=txt',
  statusCode: 200,
  truncated: false,
  body: '<!doctype html><html><head><title>登入</title></head></html>',
}, { expectText: true });
ok(login.isError && /登录页或 HTML/.test(login.text), 'expectText 卻拿到 HTML 時說只有登入頁');
const empty = fetchVerdict({ url: 'https://example.com/a', statusCode: 200, truncated: false, body: '' });
ok(!empty.isError && JSON.parse(empty.text).note === '没有正文', '空正文有明確說明');

console.log('\n✅ 網頁內容離線測試通過');
