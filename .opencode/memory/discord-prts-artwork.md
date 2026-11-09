---
name: discord-prts-artwork
description: PRTS 立繪改走 Cloudflare Worker + R2 快取：MediaWiki 路徑、large 404 fallback 原圖、bridge /prtsImage、config.discord.prts
---

PRTS 幹員立繪不再先打 prts.wiki API，改成直接組 MediaWiki 路徑；`large` 縮圖 404 時抓原圖。新增 Cloudflare Worker + R2 快取層，抓不到時 fallback 直連。

## 架構

- Worker 原始碼：`cloudflare/prts-artwork-cache/`（`src/index.js`、`wrangler.jsonc`、`test.mjs`）。
- 橋接端點：`/prtsImage`，回傳 `large` PNG；`src/core/prts-artwork.mjs`、`src/mcp-discord.js`、`src/discord-bridge.js`。
- 設定鍵：`config.discord.prts = { proxyUrl, proxyToken }`（Worker 網址與 token）；`config.example.json` 同步。
- `operator_artwork` 的 `large` 在 3.2.4 起可到 8 MiB，但原圖不經縮圖直接進模型；模型看圖改走橋接的 `get_prts_artwork`（會先縮到 `media.maxModelBytes`），生圖參考仍拿 `large` 原檔。

## 橋接端工具（2026-11-07）

- prts-mcp 改跑 `IMAGES_ENABLED=true`；`operator_artwork` 加進 `PRTS_TOOLS`（dc-chat 24 個），dc-learner／dc-trader 的 deny 清單也同步加進去。
- `send_prts_artwork`（`/prtsArtwork`）：橋接抓圖、存進圖片目錄，走一般送出流程；`variant` 預設 preview（256px），要清楚一點用 large（1024px）。送出後刪暫存檔；失敗時錯誤帶可直接貼的連結。
- `get_prts_artwork`（`/prtsImage`）：只把圖回給模型看，預設 large（1024px），不貼頻道。
- `generate_image` 的 `inputImage` 可填 `prts:<幹員>/<檔名>`，橋接走 `/prtsImage` 拿 large 作參考圖。
- Variant 政策：preview（256）給送圖／描述；large（1024）給看圖與生圖參考。

## 部署

- commit 8ba09a5 / merge 8de7d9d（2026-11-07），push 到 origin/main 並部署到測試伺服器。
- 伺服器 `config.json` 由 SSH 寫入 `discord.prts`（備份 `config.json.bak-20261107-020621`）。
- Worker URL：`https://prts-artwork-cache.konnokai.workers.dev`；橋接 `/prtsImage` 實測 3.21 秒、3,049,040 bytes PNG。

## 已知限制

- Worker token 與 R2 bucket 為外部資源，部署 Worker 需 wrangler 憑證。
- `large` 雖然 3.2.4 起可到 8 MiB，但原圖不經縮圖直接進模型；模型看圖要用橋接路徑（`/prtsImage` 或 `prts:`）。
- 橋接 `resolvePrtsArtwork` 受 `prts.wiki` DNS 8 個 A record 影響：safe-fetch 最多嘗試前 4 個，部分不可達時會 20s 超時。

## 修正（2026-11-07，code review 後）

- Blocker 修正：`dc-draw-image.mjs` 的 `fetchPrtsReference` 回傳 `{ path, operator, artworkId }`（原 `{ file, ... }` 導致 PRTS 參考圖被無聲丟掉、Codex 收到空 `inputImage`）。測試新增 `prts:` 路徑並 assert exec.arguments.inputImage 段數與檔案存在。
- `/prtsArtwork` 改走 `agentHandlers.send(..., { prts: true })`（原直接 `sendMessage`），安靜／補句／重複拒絕都生效；PRTS 視為新發言（安靜時被擋、不計繪圖次數）。
- 安全：`safe-fetch` 的 `validateFetchUrl` 新增 `allowHosts` 選項（每跳都檢查）；prts-artwork 用 `allowProtocols: ['https:']`、`allowPorts: [443]`、`allowHosts`；redirect 後重新檢查網域。
- 失敗回應：只有上傳失敗才附直連網址；403／409／429 這類規則性拒絕不附，避免教模型繞路。
- `send` handler 簽章改為 `send(body, options = {})`；`recordSent` 的 `{ draw }` 選項由 handler 傳入。
- `quietSendBlocked`：PRTS 立繪視為無附檔（安靜時被擋）。
- 參數相容：`/prtsImage` 同時接受 `artworkId`（外掛 camelCase）與 `artwork_id`（MCP snake_case）；`get_prts_artwork` 工具 schema 欄位是 `artwork_id`。
- MediaWiki 首字母大寫：`prtsDirectUrl` 算 MD5 前將檔名第一個字元轉大寫（`$wgCapitalLinks`），中文不受影響；測試 `abc.png` → `Abc.png`。
- 網路錯誤不 fallback：direct 抓圖若為逾時／連不上（`isNetworkError`），不再查 API，直接回錯；只有 HTTP 4xx/5xx 才 fallback；兩邊都失敗時錯誤訊息列出「直接抓圖：…；PRTS API：…」。
- persona 措辭：`operator_artwork action=get` 必填 `variant=preview`（256px），避免 guard 擋一次。
- 成本：`/prtsImage` 為 sessionless 路由，無每輪次數上限；重複呼叫每次抓 2–3MB 圖塞進 context。

相關：[[discord-prts-mcp]]。