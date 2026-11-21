---
name: discord-ceobecanteen
description: 小刻食堂（餅）的上游 API、已實作的投遞流程與安全限制
---

- 截至 2026-11-20，功能已實作於 `src/core/discord-ceobe.mjs`、`src/discord-bridge.js`、`src/core/discord-console.mjs` 與控制台；設定使用 `discord.ceobe.channels: { "<channelId>": ["<unique_id>"] }`，只透過 `/api/config` 寫入。`/api/ceobe` 提供資料源與狀態。使用指南在 `docs/guides/DISCORD.md`，上游快照與實作對照在 `docs/design/REF_CEOBECANTEEN.md`。2026-11-20 已部署測試伺服器（當時 HEAD `dd4d90c`），預設關閉；在控制台「設定 → 小刻食堂（餅）」載入資料源、加入頻道、選來源並儲存後，下一次 60 秒輪詢生效。
- 上游 API 依序為：GET `https://server.ceobecanteen.top/api/v1/canteen/config/datasource/list`；POST `https://server.ceobecanteen.top/api/v1/canteen/user/getDatasourceComb`，body `{ "datasource_push": ["<unique_id>"] }`；GET `https://cdn.ceobecanteen.top/datasource-comb/{comb_id}`（回應沒有 `code`）；GET `https://server-cdn.ceobecanteen.top/api/v1/cdn/cookie/mainList/cookieList?datasource_comb_id=...&cookie_id=...`。一般成功回應的 `code` 是字串 `"00000"`。
- 資料源設定值是 `unique_id`，不是原平台帳號 ID。餅乾用 `item.id` 去重；透過 `(cookie.source.data, cookie.source.type) === (target.db_unique_key, target.datasource)` 對回資料源。原文網址在 `item.url`；時間戳是毫秒，資料可含長文、轉發和多張圖片。
- state 存在 `state/discord-ceobe.json`。每個（頻道, 來源）有 `since` 水位；新 pair 與功能停用後再啟用從當下開始，正常重啟保留水位與 seen。seen key 是 `${source.type}:${source.data}:${item.id}`。使用 `timestamp.fetcher` 判斷新舊，缺值時退回 `platform`；超過 24 小時的餅不投遞。每次最多送 3 則、每則文字最多 800 字，多的留到下一輪。
- 餅排進回合閘門時就持久化標 seen（at-most-once），避免頻道忙或 DSH 離線時每分鐘重排。代價是 `/reset` 丟掉排隊工作、送出失敗或安靜時可能漏餅，不會重試那筆。投遞前用 `client.channels.fetch` 重新取頻道，檢查文字頻道、白名單、`ViewChannel`，以及一般頻道的 `SendMessages` 或討論串的 `SendMessagesInThreads`；不合格就略過，未標 seen。
- 回合由既有 DSH session 處理。回合結束時若模型沒送任何訊息，橋接以來源、第一行和原文 URL 保底發送；若模型有發言但漏 URL，橋接補 `-# 原文：…`。完成、錯誤與取消（含 TTFT 超時）都會走收尾；安靜期間略過收尾。保底文字會跳脫 Markdown。
- 餅文是外部不可信資料：用隨機 nonce 包住、改寫 `【】`，移除零寬與 bidi 字元，只保留 http(s) URL。餅回合只允許 `send`、`react`、`unreact`；`imageJob` 的 `start` 也要用 `sessionId` 反查回合後阻擋，`poll`／`done` 放行以便既有工作收尾。唯讀 web search 不經 bridge，仍可能可用。
- 輪詢用 10 秒請求逾時，回應上限 2 MiB；`code: null` 不能視為成功。上游分頁 `next_page_id` 尚未處理；不抓圖片，也不支援公告頁截圖。上游文件快照取自 `nonebot-bison/docs/dev/ceobecanteen.md`，commit `c891b92`（2026-11-20），原文與實作對照在 `docs/design/REF_CEOBECANTEEN.md`，含 MIT 授權。
- 小刻食堂控制台卡片用 `.fsec` 左標題／右欄位版面，避免設定靠卡片左緣；頻道列的 label 延展填滿剩餘寬度，刪除鈕與輸入框同高。桌機來源清單固定四欄，窄螢幕用自動欄數。
- 核心行為測試：`node scripts/test-discord-ceobe.mjs`。相關回合接線可對照 [[discord-bridge-turns]]。
- 控制台排版沿用 [[discord-console-settings]]。
