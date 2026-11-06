# PRTS artwork cache Worker

把 bridge 抓到的 PRTS 立繪快取在 R2，避開 `media.prts.wiki` 對海外線路的抖動。

目前部署：`https://prts-artwork-cache.konnokai.workers.dev`（需要 `x-prts-token`）。

## 部署

```bash
cd cloudflare/prts-artwork-cache
npx wrangler r2 bucket create prts-artwork-cache
npx wrangler deploy
npx wrangler secret put PRTS_PROXY_TOKEN --name prts-artwork-cache
```

`PRTS_PROXY_TOKEN` 要跟 bridge 的 `discord.prts.proxyToken` 一樣。`/health` 不需要 token。

## 呼叫方式

```bash
curl -H "x-prts-token: $PRTS_PROXY_TOKEN" \
  "https://prts-artwork-cache.<account>.workers.dev/?u=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("https://media.prts.wiki/thumb/...", safe=""))')"
```

第一次會回 `x-prts-cache: miss`，第二次 `hit`。Worker 只接受
`media.prts.wiki`／`prts.wiki` 的 `/thumb/<h1>/<h1h2>/...` 與
`/<h1>/<h1h2>/...` 圖片路徑；其他 URL 一律 400。

## 邊界

- R2 bucket 不公開；只有 Worker binding 讀寫。
- 單張上限 8MB；只收 PNG/JPEG/WebP，並用 magic bytes 再驗一次。
- 上游失敗回 502，bridge 會 fallback 回直連。
- 第一次抓取仍走 Cloudflare → PRTS CDN；R2 只快取成功的那一次。
