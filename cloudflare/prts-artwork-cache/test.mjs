// Worker 的純函式測試：不連 Cloudflare，只驗 URL 白名單與圖片 magic。
import assert from 'node:assert/strict'
import { allowedImageUrl, imageMime } from './src/index.js'

const thumb = 'https://media.prts.wiki/thumb/7/71/%E7%AB%8B%E7%BB%98_%E4%BD%A9%E4%BD%A9_skin1.png/1024px-%E7%AB%8B%E7%BB%98_%E4%BD%A9%E4%BD%A9_skin1.png'
const original = 'https://media.prts.wiki/7/71/%E7%AB%8B%E7%BB%98_%E4%BD%A9%E4%BD%A9_skin1.png'
assert.equal(allowedImageUrl(thumb)?.hostname, 'media.prts.wiki', '允許縮圖')
assert.equal(allowedImageUrl(original)?.hostname, 'media.prts.wiki', '允許原圖')
assert.equal(allowedImageUrl('https://prts.wiki/thumb/7/71/x/1024px-x.png')?.hostname, 'prts.wiki', '允許 prts.wiki 的轉址目標')
for (const bad of [
  'http://media.prts.wiki/thumb/7/71/x/1024px-x.png',
  'https://evil.example/thumb/7/71/x/1024px-x.png',
  'https://media.prts.wiki/api.php',
  'https://media.prts.wiki/thumb/7/71/x/1024px-x.png?x=1',
  'https://media.prts.wiki/thumb/7/71/x/1024px-x.png#frag',
  'not a url',
]) {
  assert.equal(allowedImageUrl(bad), null, `拒絕 ${bad}`)
}

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
assert.equal(imageMime(png), 'image/png', 'PNG')
assert.equal(imageMime(jpeg), 'image/jpeg', 'JPEG')
assert.equal(imageMime(webp), 'image/webp', 'WebP')
assert.equal(imageMime(Uint8Array.from([1, 2, 3])), null, '非圖片')

console.log('PRTS cache worker: OK')
