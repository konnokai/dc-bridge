---
name: discord-console-detail-modal
description: 控制台通用放大彈窗（detail-modal）：CSS [hidden] 陷阱、梗圖延遲載入的 token 守衛、訂單整列點擊、帳號顯示名稱與快取
---

控制台 `public/discord-console.html` 原本只有群知識有放大彈窗；2026-11-10 把它抽成通用 `openDetail({ title, meta, body, imageUrl, mono, wide })` / `closeDetail()`，HTML id 改為 `detail-*`。知識、梗圖、股盤訂單、日誌共用同一個 modal。

## CSS：author display 會蓋掉 `[hidden]`

- `.detail-image { display:block }`、`.modal-meta { display:grid }` 是作者樣式，會蓋掉瀏覽器內建 `[hidden]{display:none}`。整份檔案只有 `.modal[hidden]` 補了 `!important`。
- 所以額外加了全域 `[hidden] { display: none !important; }`（與 `.hidden` 同行）。沒有這行，`image.hidden = true`、`meta.hidden = true` 都不生效，空 `<img>` 會多出 12px margin、日誌彈窗多一個空 grid。
- 延遲載入的梗圖能顯示是靠這個 bug 才成立；修 CSS 時必須同時改載入邏輯（見下），否則延遲載入的圖永遠看不到。

## 梗圖放大（openMemeDetail）

- 縮圖包成 `button[data-meme-view]`，`openMemeDetail` 用 `fetchMemeThumb(id)`（async，回傳 blob URL 或 null）。
- 快取命中就直接 `imageUrl`；未命中時先開 modal（圖 hidden），fetch 回來再設 `src` 並取消 hidden。
- 必須用 token 守衛：`detailToken` 在每次 `openDetail`/`closeDetail` 遞增；fetch 的 `.then` 先比對 `detailToken !== token`，對不上就不設 `src`。否則快速切換 A→B 時 A 的慢 fetch 會把圖蓋到 B 上，關掉再開日誌也會把圖塞進去。
- fetch 失敗時在 meta 後面 append「圖片載入失敗」，不要靜默。
- `memeThumbs`（id → blob URL）是模組層級 Map，刪除／換頁時 revoke；modal 開著時 refresh 不會清圖，因為 blob URL 還有效。

## 訂單放大（openOrderDetail）

- `tradeOrders` 保存目前清單，`<tr data-order="index">` 整列可點（`className: 'clickable'`、`tabIndex: 0`）；Enter/Space 鍵盤可開。拖選文字時（`getSelection()` 非空）不開。
- `tradeOrders` 與 DOM 在 `renderTrade` 裡同步替換，refresh 後 index 不會錯位；唯一的副作用是 mousedown 之後剛好 refresh，那一次 click 會掉。
- `tradeAccountName(id, name)`：有 `accountName` 就顯示名字，否則 bot 回 `🤖 Bot`、user 回 `玩家 …末六碼`。完整 uid 在儲存格 `title` 與彈窗 meta 看得到。

## 日誌放大

- 標題加「放大」按鈕，`openDetail({ mono: true, wide: true })`；彈窗開後把 `#detail-card` 滾到底。

## 帳號顯示名稱（橋接端）

- `src/discord-bridge.js` 的 `trade` handler 用 `client` 快取補 `accountName`：bot → `Bot`... 實際回 `client.user.displayName || username`（前端會加 🤖？不，前端 `tradeAccountName` 有 name 就直接用，所以橋接回 bot 名稱時前端原本的 🤖 永遠用不到；兩者擇一）。
- `tradeNameCache`（uid → { name, at }）TTL 10 分鐘，避免每 5 秒都打 REST；查不到時快取 60 秒再重試。
- 查名順序：`order.guild_id` 對應的 guild member 快取 → 其他 guild 的 member 快取 → `users.cache` → `client.users.fetch`（REST）。
- 跨伺服器暱稱不同時顯示的是第一個查到的 guild 的暱稱；bridge 重啟後快取空，會大量退回末六碼直到成員開口或 fetch 完成。

## 背景點擊關閉

- `mousedown` 記錄 target，只有 mousedown 與 click 都在背景（`#detail-modal`）時才關。避免卡片內拖選文字到背景放開誤關（日誌複製常碰到）。

## 測試

- `scripts/test-console-ui.mjs`：知識測試改用 `#detail-*`；梗圖測試加放大斷言（mock `/api/memes/image` 回 1×1 PNG，斷言 `naturalWidth > 0` 與關閉後 `src` 為 null）；新增「訂單與日誌可放大」測試。
- 兩個本來就掛的檢查（baseline deep-equal、7 天桶寬）與本改動無關，見 AGENTS.md Lessons。

相關：[[discord-trade]]、[[discord-meme-plan]]、[[discord-console-table-layout]]。