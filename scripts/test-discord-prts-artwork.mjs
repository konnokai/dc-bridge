// PRTS 立繪解析的離線測試：檔名驗證、variant 寬度、MediaWiki 回應與網域限制。
// 不連網：fetchJson／fetchImage 都是注入的假函式。
import assert from 'node:assert/strict'
import { fetchProxyImage, normalizeArtworkId, pickImageInfo, prtsApiUrl, prtsDirectUrl, prtsOriginalUrl, resolvePrtsArtwork, variantWidth } from '../src/core/prts-artwork.mjs'

assert.equal(normalizeArtworkId(' 立绘_阿米娅_1.png '), '立绘_阿米娅_1.png', '前後空白會去掉')
for (const bad of ['../secret.png', '/etc/passwd', 'x.exe', 'x.png/../y', '', `${'a'.repeat(200)}.png`]) {
  assert.throws(() => normalizeArtworkId(bad), /格式/, `要拒絕 ${JSON.stringify(bad)}`)
}
assert.equal(variantWidth().key, 'preview', '預設 preview')
assert.equal(variantWidth('preview').width, 256, 'preview = 256px')
assert.equal(variantWidth('large').width, 1024, 'large = 1024px')
assert.throws(() => variantWidth('original'), /preview 或 large/, '不支援 original')
assert.throws(() => normalizeArtworkId('../x.png'), (error) => error.statusCode === 400, '格式錯誤回 400')
assert.throws(() => variantWidth('original'), (error) => error.statusCode === 400, 'variant 錯誤回 400')

const api = prtsApiUrl('立绘_阿米娅_1.png', 256)
assert.ok(api.startsWith('https://prts.wiki/api.php?'), '走 prts.wiki API')
assert.ok(api.includes('iiurlwidth=256'), '帶縮圖寬度')
assert.ok(api.includes('titles=File%3A'), '檔名放在 File: 標題')

// MediaWiki 路徑 = MD5 前 1 碼 + 前 2 碼；空白會正規化成底線，雜湊用正規化後的檔名。
const pepeName = encodeURIComponent('立绘_佩佩_skin1.png')
assert.equal(
  prtsDirectUrl('立绘_佩佩_skin1.png', 1024),
  `https://media.prts.wiki/thumb/7/71/${pepeName}/1024px-${pepeName}`,
  'large 組 1024px 縮圖',
)
assert.equal(
  prtsDirectUrl('立绘 佩佩 skin1.png', 256),
  `https://media.prts.wiki/thumb/7/71/${pepeName}/256px-${pepeName}`,
  '空白正規化成底線後再雜湊',
)
assert.equal(
  prtsDirectUrl('abc.png', 1024),
  'https://media.prts.wiki/thumb/b/bf/Abc.png/1024px-Abc.png',
  'MediaWiki 第一個字母轉大寫後再雜湊',
)
assert.equal(
  prtsOriginalUrl('立绘_阿米娅_1.png'),
  'https://media.prts.wiki/d/dd/%E7%AB%8B%E7%BB%98_%E9%98%BF%E7%B1%B3%E5%A8%85_1.png',
  'large 縮圖不存在時改抓原圖',
)

const info = {
  url: 'https://media.prts.wiki/x.png',
  thumburl: 'https://media.prts.wiki/thumb/x.png',
  mime: 'image/png',
  width: 1024,
  height: 1024,
  thumbwidth: 256,
  thumbheight: 256,
}
assert.equal(pickImageInfo({ query: { pages: { '-1': { title: 'File:no' }, 1: { imageinfo: [info] } } } }), info, '跳過不存在的頁面')
assert.equal(pickImageInfo({ query: { pages: { '-1': {} } } }), null, '沒有 imageinfo 回 null')

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

// 直接組網址成功時不該碰 API。
const direct = await resolvePrtsArtwork({
  artworkId: '立绘_佩佩_skin1.png',
  variant: 'large',
  fetchJson: async () => { throw new Error('直接抓圖成功時不該查 API') },
  fetchImage: async (url, max) => {
    assert.equal(url, prtsDirectUrl('立绘_佩佩_skin1.png', 1024), '先抓 1024px 縮圖')
    assert.equal(max, 8 * 1024 * 1024, '圖片上限 8MB')
    return { buffer: png, url }
  },
})
assert.equal(direct.buffer, png, '回傳圖片位元組')
assert.equal(direct.mimeType, 'image/png', '從 magic 判斷 MIME')
assert.equal(direct.width, null, '直接抓圖沒有 API 的實測尺寸')
assert.equal(direct.height, null, '直接抓圖沒有 API 的實測尺寸')
assert.equal(direct.url, prtsDirectUrl('立绘_佩佩_skin1.png', 1024), '回傳實際抓取網址')
assert.equal(direct.variant, 'large', '回傳 variant')

// Worker + R2 快取：成功時不直連，失敗時 fallback 回直連。
const proxyTarget = prtsDirectUrl('立绘_佩佩_skin1.png', 1024)
const proxy = await resolvePrtsArtwork({
  artworkId: '立绘_佩佩_skin1.png',
  variant: 'large',
  proxyUrl: 'https://proxy.example/',
  proxyToken: 'secret',
  proxyFetch: async (url, init) => {
    assert.equal(new URL(url).searchParams.get('u'), proxyTarget, 'Worker 收到原始圖片網址')
    assert.equal(init.headers['x-prts-token'], 'secret', 'Worker 收到 token')
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
  },
  fetchImage: async () => { throw new Error('Worker 成功時不該直連') },
})
assert.deepEqual(proxy.buffer, png, 'Worker 回傳的圖片')
assert.equal(proxy.url, proxyTarget, '回傳原始圖片網址，不是 Worker 網址')

const fallbackDirect = await resolvePrtsArtwork({
  artworkId: '立绘_佩佩_skin1.png',
  variant: 'large',
  proxyUrl: 'https://proxy.example/',
  proxyToken: 'secret',
  proxyFetch: async () => { throw new Error('Worker 掛了') },
  fetchImage: async (url) => ({ buffer: png, url }),
})
assert.equal(fallbackDirect.buffer, png, 'Worker 失敗時 fallback 直連')
assert.equal(fallbackDirect.url, proxyTarget, 'fallback 回傳直連網址')

await assert.rejects(
  () => fetchProxyImage('http://proxy.example/', 'secret', proxyTarget, 1024),
  /只允許 https/,
  '非本機 proxy 不允許 http',
)
await assert.rejects(
  () => fetchProxyImage('https://proxy.example/', 'secret', proxyTarget, 1024, {
    fetchImpl: async () => new Response('not an image', { status: 200, headers: { 'content-type': 'text/plain' } }),
  }),
  /不是有效圖片/,
  'Worker 回傳非圖片要拒絕',
)
await assert.rejects(
  () => fetchProxyImage('https://proxy.example/', 'secret', proxyTarget, 1024, {
    fetchImpl: async () => new Response('missing', { status: 404 }),
  }),
  (error) => error.statusCode === 404,
  'Worker 404 要保留狀態碼',
)

// Worker 回 404 時直接換原圖候選，不再多花一次直連。
const thumb404 = await resolvePrtsArtwork({
  artworkId: '立绘_阿米娅_1.png',
  variant: 'large',
  proxyUrl: 'https://proxy.example/',
  proxyToken: 'secret',
  proxyFetch: async (url) => {
    const target = new URL(url).searchParams.get('u')
    if (target === prtsDirectUrl('立绘_阿米娅_1.png', 1024)) {
      return new Response('missing', { status: 404 })
    }
    assert.equal(target, prtsOriginalUrl('立绘_阿米娅_1.png'), '404 後換原圖')
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
  },
  fetchImage: async () => { throw new Error('Worker 404 時不該直連') },
})
assert.deepEqual(thumb404.buffer, png, 'Worker 404 後改抓原圖')
assert.equal(thumb404.url, prtsOriginalUrl('立绘_阿米娅_1.png'), '回傳原圖網址')

// 原圖只有 1024px 時 MediaWiki 不生成縮圖；縮圖 404 後改抓原圖，不用查 API。
const originalUrl = prtsOriginalUrl('立绘_阿米娅_1.png')
const original = await resolvePrtsArtwork({
  artworkId: '立绘_阿米娅_1.png',
  variant: 'large',
  fetchJson: async () => { throw new Error('原圖 fallback 成功時不該查 API') },
  fetchImage: async (url) => {
    if (url === prtsDirectUrl('立绘_阿米娅_1.png', 1024)) throw new Error('圖片抓取失敗：HTTP 404')
    assert.equal(url, originalUrl, '縮圖 404 後抓原圖')
    return { buffer: png, url }
  },
})
assert.equal(original.url, originalUrl, '回傳原圖網址')

// 縮圖與原圖都 404 時才回頭查 API。
const apiFallback = await resolvePrtsArtwork({
  artworkId: '立绘_阿米娅_1.png',
  variant: 'large',
  fetchJson: async (url) => {
    assert.ok(url.includes('iiurlwidth=1024'), 'large 查 1024px')
    return { query: { pages: { 1: { imageinfo: [info] } } } }
  },
  fetchImage: async (url) => {
    if (url === prtsDirectUrl('立绘_阿米娅_1.png', 1024) || url === originalUrl) {
      throw new Error('圖片抓取失敗：HTTP 404')
    }
    assert.equal(url, info.thumburl, 'API 回縮圖網址')
    return { buffer: png, url }
  },
})
assert.equal(apiFallback.url, info.thumburl, 'API fallback 回傳縮圖網址')

// 網路逾時不要再多查一次 API：fallback 最後還是抓同一個 media host。
let apiCalled = false
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    variant: 'large',
    fetchJson: async () => { apiCalled = true; return { query: { pages: {} } } },
    fetchImage: async () => { throw new Error('请求超时：media.prts.wiki（已尝试 4 个地址）') },
  }),
  /请求超时/,
  '網路逾時直接回錯誤',
)
assert.equal(apiCalled, false, '網路逾時不該呼叫 API')

// 兩邊都失敗時要列出兩個原因，不能只看起來像檔案不存在。
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    fetchJson: async () => { throw new Error('请求超时：prts.wiki') },
    fetchImage: async () => { throw new Error('圖片抓取失敗：HTTP 404') },
  }),
  /直接抓圖：.*HTTP 404.*PRTS API：.*请求超时/,
  '直接抓圖與 API 的錯誤都要列出',
)

// 直接抓圖失敗時回頭查 API；preview 的縮圖網址由 API 給。
const fallback = await resolvePrtsArtwork({
  artworkId: '立绘_阿米娅_1.png',
  variant: 'preview',
  fetchJson: async (url) => {
    assert.ok(url.includes('iiurlwidth=256'), 'preview 查 256px')
    return { query: { pages: { 1: { imageinfo: [info] } } } }
  },
  fetchImage: async (url, max) => {
    if (url === prtsDirectUrl('立绘_阿米娅_1.png', 256)) throw new Error('圖片抓取失敗：HTTP 404')
    assert.equal(url, info.thumburl, '抓 API 給的 thumburl')
    assert.equal(max, 8 * 1024 * 1024, '圖片上限 8MB')
    return png
  },
})
assert.equal(fallback.buffer, png, '回傳圖片位元組')
assert.equal(fallback.mimeType, 'image/png', '保留 MIME')
assert.equal(fallback.width, 256, '寬度用縮圖')
assert.equal(fallback.height, 256, '高度用縮圖')
assert.equal(fallback.url, info.thumburl, '回傳實際抓取網址')
assert.equal(fallback.variant, 'preview', '回傳 variant')

// 直接抓圖拿到不在允許網域的最終網址時要拒絕，並改用 API。
const redirected = await resolvePrtsArtwork({
  artworkId: 'x.png',
  fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [info] } } } }),
  fetchImage: async (url) => (url === prtsDirectUrl('x.png', 256)
    ? { buffer: png, url: 'https://evil.example/x.png' }
    : { buffer: png, url }),
})
assert.equal(redirected.url, info.thumburl, '直接抓圖的 evil 最終網址被拒絕，改用 API')

const relative = await resolvePrtsArtwork({
  artworkId: 'x.png',
  direct: false,
  fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: '//media.prts.wiki/x.png', mime: 'image/png' }] } } } }),
  fetchImage: async () => png,
})
assert.equal(relative.url, 'https://media.prts.wiki/x.png', 'protocol-relative 補成 https')

await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    direct: false,
    fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: 'https://evil.example/x.png' }] } } } }),
    fetchImage: async () => png,
  }),
  /允許的網域/,
  '不在 media.prts.wiki／prts.wiki 的圖片要拒絕',
)
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    direct: false,
    fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: 'https://media.prts.wiki/x.png', mime: 'image/png' }] } } } }),
    fetchImage: async () => ({ buffer: png, url: 'https://evil.example/x.png' }),
  }),
  /允許的網域/,
  '轉址後的最終網址也要檢查',
)
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    direct: false,
    fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: 'http://media.prts.wiki/x.png', mime: 'image/png' }] } } } }),
    fetchImage: async () => png,
  }),
  /允許的網域/,
  'http 不允許',
)
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    direct: false,
    fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: 'https://media.prts.wiki:8443/x.png', mime: 'image/png' }] } } } }),
    fetchImage: async () => png,
  }),
  /允許的網域/,
  '非 443 埠不允許',
)
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    direct: false,
    fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: 'https://media.prts.wiki/x.gif', mime: 'image/gif' }] } } } }),
    fetchImage: async () => png,
  }),
  /不支援的立繪格式/,
  '只收 PNG/JPEG/WebP',
)
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    direct: false,
    fetchJson: async () => ({ query: { pages: { '-1': {} } } }),
    fetchImage: async () => png,
  }),
  /找不到立繪/,
  '找不到檔案要說清楚',
)

console.log('PRTS artwork resolver: OK')
