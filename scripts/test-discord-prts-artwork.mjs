// PRTS 立繪解析的離線測試：檔名驗證、variant 寬度、MediaWiki 回應與網域限制。
// 不連網：fetchJson／fetchImage 都是注入的假函式。
import assert from 'node:assert/strict'
import { normalizeArtworkId, pickImageInfo, prtsApiUrl, resolvePrtsArtwork, variantWidth } from '../src/core/prts-artwork.mjs'

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
const art = await resolvePrtsArtwork({
  artworkId: '立绘_阿米娅_1.png',
  variant: 'preview',
  fetchJson: async (url) => {
    assert.ok(url.includes('iiurlwidth=256'), 'preview 查 256px')
    return { query: { pages: { 1: { imageinfo: [info] } } } }
  },
  fetchImage: async (url, max) => {
    assert.equal(url, info.thumburl, '抓 thumburl')
    assert.equal(max, 8 * 1024 * 1024, '圖片上限 8MB')
    return png
  },
})
assert.equal(art.buffer, png, '回傳圖片位元組')
assert.equal(art.mimeType, 'image/png', '保留 MIME')
assert.equal(art.width, 256, '寬度用縮圖')
assert.equal(art.height, 256, '高度用縮圖')
assert.equal(art.url, info.thumburl, '回傳實際抓取網址')
assert.equal(art.variant, 'preview', '回傳 variant')

const relative = await resolvePrtsArtwork({
  artworkId: 'x.png',
  fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: '//media.prts.wiki/x.png', mime: 'image/png' }] } } } }),
  fetchImage: async () => png,
})
assert.equal(relative.url, 'https://media.prts.wiki/x.png', 'protocol-relative 補成 https')

await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: 'https://evil.example/x.png' }] } } } }),
    fetchImage: async () => png,
  }),
  /允許的網域/,
  '不在 media.prts.wiki／prts.wiki 的圖片要拒絕',
)
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: 'https://media.prts.wiki/x.png', mime: 'image/png' }] } } } }),
    fetchImage: async () => ({ buffer: png, url: 'https://evil.example/x.png' }),
  }),
  /允許的網域/,
  '轉址後的最終網址也要檢查',
)
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: 'http://media.prts.wiki/x.png', mime: 'image/png' }] } } } }),
    fetchImage: async () => png,
  }),
  /允許的網域/,
  'http 不允許',
)
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: 'https://media.prts.wiki:8443/x.png', mime: 'image/png' }] } } } }),
    fetchImage: async () => png,
  }),
  /允許的網域/,
  '非 443 埠不允許',
)
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    fetchJson: async () => ({ query: { pages: { 1: { imageinfo: [{ url: 'https://media.prts.wiki/x.gif', mime: 'image/gif' }] } } } }),
    fetchImage: async () => png,
  }),
  /不支援的立繪格式/,
  '只收 PNG/JPEG/WebP',
)
await assert.rejects(
  () => resolvePrtsArtwork({
    artworkId: 'x.png',
    fetchJson: async () => ({ query: { pages: { '-1': {} } } }),
    fetchImage: async () => png,
  }),
  /找不到立繪/,
  '找不到檔案要說清楚',
)

console.log('PRTS artwork resolver: OK')
