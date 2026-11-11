---
name: discord-trade
description: 模擬股票交易 MVP（台股）：資料來源、漲跌停、市場狀態、結算、Bot 交易員、權限與控制台
---

台股模擬股票交易 MVP（第一版只有 TW），與 Discord 橋接整合。

## 架構

- 新增核心：`src/core/trade-symbols.mjs`、`quote-provider.mjs`、`discord-trade-db.mjs`、`discord-trade.mjs`、`bot-trader.mjs`、`src/mcp-trade.js`。
- dc-trader preset：`dsh/agent-presets/dc-trader/`，重新產生 `plugins/dc-agent-presets/presets/dc-trader.patch.yml`。
- 橋接接入：`src/discord-bridge.js` 的 trade MCP 端點、玩家／Bot 身分、收盤結算排程、Bot 排程、`/portfolio`、`/forget`、控制台 API、交易設定即時重建。
- 權限：`dc-tool-restrict` 的 `trade: player|bot|none`、`dc-session-token` 的 `trade`、`setup-dsh` 的 `mcp-trade`。
- 控制台：「股盤」唯讀分頁與「設定」分頁的交易表單；`/api/trade/*`。帳號顯示用橋接端 `tradeNameCache`（TTL 10 分鐘）補 Discord 顯示名稱，查不到退回 `玩家 …末六碼`；完整 uid 在儲存格 `title` 與訂單放大彈窗看得到（詳見 [[discord-console-detail-modal]]）。- Node ≥26（`node:sqlite`）；伺服器 26.12.1、本機 26.13。
- `mcp-trade` 暴露 6 個工具：`get_quote`、`place_order`、`get_portfolio`、`get_leaderboard`、`get_bot_portfolio`、`bot_place_order`。
- `dc-tool-restrict` 的 `trade: player|bot|none`；Bot 額外有 web search/fetch 上限（橋接寫 `state/discord-trade-limits.json`，preset 讀取並取 min）。
- Bot 一次性會話只活在記憶體，不寫入 sessions 檔；`resolve(token, { allowBot: true })` 只給 Bot 交易端點使用。

## 資料來源

- TWSE OpenAPI（`STOCK_DAY_ALL`）與 TPEx OpenAPI（`tpex_mainboard_quotes`）；假日行事曆 `holidaySchedule`。
- TWSE 資料會晚一天：18:28 仍為前一日資料，TPEx 已是當日資料。
- provider 跳過無成交列（TPEx 回 `Close:"----"`、`Change:"---"`）；`getForDate` 只認資料日期等於 trade_date；`dataDate` 回整份來源日期。
- 無成交／停牌股票：整份資料日期 > trade_date 才判定逾期拒絕。
- 三大法人日報：`src/core/institutional-provider.mjs`，TWSE `T86`（`/rwd/zh/fund/T86`）與 TPEx OpenAPI `tpex_3insti_daily_trading`；欄位用「先精確比對再 contains」避免 `自營商買賣超股數` 被 `自營商買賣超股數(避險)` 誤抓。
- 重大訊息：`src/core/material-provider.mjs`，TWSE `t187ap04_L`、TPEx `mopsfin_t187ap04_O`。MOPS 公告日通常比復盤日早一天，parser 收 `[prevTradingDate, date]` 範圍並標每筆實際日期；空結果不快取，下一輪重抓。`getForSymbols` 以 `time + subject` 去重、依日期+時間由新到舊排序、每檔取前 3。
- 休市日 provider：`src/core/quote-provider.mjs` 的 `getHolidays()`，失敗只快取 5 分鐘（不再 12 小時），空回應算失敗；同時合併重複請求（inflight）；`extraHolidays`（`config.discord.trade.extraHolidays`，YYYY-MM-DD）與 API 結果聯集，供颱風／臨時停市。
- 商品主檔是人工白名單（`src/core/trade-symbols.mjs`），一定漏收。主檔 miss 時 `quote()`／`placeOrder()` 用 provider 的 `lookup()` 反查官方行情（兩個來源並行抓，只認完整代號或完整名稱）：查得到就回「在官方行情查得到，但不在可交易商品主檔…不是代號打錯」（錯誤碼 `SYMBOL_NOT_COLLECTED`），兩邊都查不到才回「查不到這個股票」。行情清單也含 ETF／特別股／TDR，所以文案只說「可能漏收」，不斷言。6196 帆宣在 TWSE 上市，不是上櫃（回饋 df_mwbhnyoscc6e90，2026-11-11）。
- 不用 Yahoo Finance／yfinance 做台股即時報價：TWSE／TPEx 在 Yahoo 是 20 分鐘延遲，且條款禁止轉散布給第三人（personal use only）。要往盤中即時走，必須找有轉散布授權的行情源；沒有就維持 A 模式收盤結算。

## 漲跌停與參考價

- `limitPrices(referenceCents, entry)`：參考價 ×(1±`limitPct`) 後對齊升降單位（漲停向下取、跌停向上取），級距用漲跌停價本身而非參考價。`limitPct` 逐檔不同（一般 10、槓桿 ETF 20），沒給 entry 當 10%。
- ETF：`tickCents(price, 'etf')` 未滿 50 元 0.01、50 元以上 0.05；賣出證交稅 `fees.twEtfTaxRate`（預設 0.1%），建單時寫進 `orders.tax_rate_ppm`。ETF 走白名單（10 檔國內成分），債券／國外成分／ETN 不收（無漲跌幅限制或外幣計價）。
- 參考價用 `referenceForTradeDate(latest, tradeDate)`：`latest.date < trade_date` 時用 `latest.closeCents`（前一日收盤），不是 `close − change`；同日資料才用 `referenceCents`（`close − change`）回推。
- 來源未更新時參考價可能落後 1–2 個交易日，保留額低估只會讓結算時現金不足而拒單，不會讓餘額變負。

## 市場狀態

- 台北時間 09:00–13:30 盤中；週末與行事曆休市；`nextOpen` 給下一次開盤時間。
- 預約單：交易日 14:50 至次一交易日 09:00；休市日整天都在上一交易日起的預約窗裡；13:30–14:50 不收單。
  `marketState()` 回 `canOrder`、`orderDate`（這筆單的 `trade_date`）、`orderRefFloor`（報價可接受的最舊日期）、`nextOrderAt`。
- 不模擬 09:10 第一次撮合與之後每 5 秒的集合競價；A 模式統一用當日收盤價結算。
- 結算只在收盤後進行（`market.phase` 為 after）。
- 結算開始時間由 `trade.settlement.twSettleAfter` 控制，預設 `19:00`（HH:MM）；19:00 前即使有收盤資料也不結算，等收盤價、法人、晚報資料較齊。

## 帳戶與下單

- `ensureAccount` 惰性：下單成功才建立帳戶；起始資金 1,000,000 NT$（`startingCash`）；`maxOrderPct` 30%。
- 買單保留額用漲停價估算；結算時釋放差額。
- 結算買單：`otherReserved = account.reserved_cents - current.reserved_cents`，可用現金 = 現金 − 別筆保留。
- `/forget` 刪除玩家交易資料；Bot 帳戶不受影響。
- `placeOrder` 先查 `findOrderByRequest`／`findOrderByMessage`（重送回 duplicate），再檢查市場狀態；避免時間窗換段時把已存在的單說成不能下單。

## 結算

- `settleDue`：收盤後成交；`market.minutes >= twSettleAfter`（預設 19:00）才開始；資料日期等於 trade_date 才成交；逾期拒絕並釋放保留。
- 預約單的 `trade_date` 是下一個交易日，當天晚上不結算；到該交易日 19:00 後才成交。
- `orderRefFloor` 空時 fail-closed（拒絕舊資料過關）；預約單用 `orderDate` 往前推兩個交易日，春節後第一個交易日仍可算出。
- 漲停買單、跌停賣單不成交。
- 結算與 Bot 排程有執行旗標防重疊；`rejectOrder` 遇非 pending 回 null。

## Bot 交易員

- `dc-trader` preset；`mcp-trade` 工具；web search/fetch 上限；每日 token 上限。
- `bot:trader` 一次性會話只活在記憶體，不寫入 sessions 檔。
- `resolve(token, { allowBot: true })` 只給 Bot 交易端點使用。
- 復盤公告排版：`formatReviewBody`（`src/core/bot-trader.mjs`）把模型一整段拆成一句一行，並把點數／百分比／金額等重點數字加粗（`KEY_NUMBER`）；已分好的短行、清單、粗體原樣保留。`formatReviewNotice` 走 `formatReviewBody`；`sendTradeNotice` 也走 `splitDiscordMessage` 分段送。dc-trader persona 改要求 4~8 行、一行一個重點、數字用粗體；dc-chat persona 加「復盤、摘要、報告這類長訊息：一句一行或分成幾段，重點數字用粗體」。docs/guides/DISCORD.md 與 PLAN_STOCK.md 同步。
- Bot 復盤（review）：`trade.bot.review.enabled` 預設 true、`review.after` 預設 `19:10`。Bridge 先抓收盤價與法人資料（TWSE T86、TPEx OpenAPI），模型只補新聞；19:40 法人還缺就照跑並標「查不到」。重大訊息 API 常隔天才更新，復盤只等法人，重大訊息缺就照跑並標「最近交易日的重大訊息：查不到」。復盤輸出發到 `announceChannelId`，這一輪不能下單。Bot runs 以 `kind` 區分 `decision`／`review`；復盤每交易日一次，重啟不補做。
- 復盤公開前安全處理：`stripPublicLinks` 去 URL／邀請連結；`findSensitive` 命中就不發布、只記 log；發送加 `SuppressEmbeds`。`botReviewRunning` 在等待資料前就設 true，避免重複排程。
- 隔天決策只帶入 `lastReview.date >= market.prevPrevTradingDate` 的復盤，避免過期摘要；復盤摘要存 `daily_reviews`（date PK）。

## 營運狀態（2026-11-05）

- `trade.enabled` 與 `trade.bot.enabled` 皆開啟；Bot 帳戶 `bot:1564252581340127294`，起始資金 1,000,000 NT$；公告頻道 `739040035571236905`（#雜談交流大廳）。
- 復盤排程在 19:10（`review.after`），`daily_reviews` 表記錄摘要與 token；Bot 盤中決策在 09:00 後。
- TWSE OpenAPI 常只到前一交易日，19:10 當天重大訊息更新尚未實測驗證。
- 預約單時段功能已合併並部署：commit `48f7f6f`（2026-11-10），測試伺服器 28/28 通過，dsh 與 dc-bridge 已重啟。
- 使用者所述：重大訊息規定下午兩點之後發布，所以盤前新聞彙整參考性有限；目前 Bot 在 09:00 後第一次決策時自己查新聞，沒有盤前摘要功能。
- 交易 DB `state/discord-trade.sqlite` 權限 600，每日備份保留 7 份。

## 備份

- `state/backups/discord-trade-*.sqlite`，每日備份、保留 7 份。

## 美股擴充（規劃中，2026-11-10）

使用者需求：私人使用、無收入，想補齊美股實作。尚未決定範圍。

### 行情源授權（關鍵不是有沒有賺錢，是報價給誰看）

- Yahoo Finance：條款禁止轉散布；美股 real-time（頁面標 `NasdaqGS - BOATS Real Time`），台股 20 分鐘延遲。
- Finnhub 免費層：60 calls/min、real-time US quotes、WebSocket 50 symbols；定位 personal/non-commercial，ToS 明確禁止 share access；商業使用需書面核准。
- 只有自己看 → 實務上 personal use，爭議小；伺服器還有其他玩家看 → 仍算把資料給第三人，Yahoo 與 Finnhub 都禁止轉散布，要乾淨必須找有轉散布授權的行情源。
- 技術：Node repo 用 `yahoo-finance2` 比 yfinance 少一個 Python 服務。

### 範圍評估

「補齊美股」不是只換行情源。目前這些都寫死台灣：`market: 'TW'`、`currency: 'TWD'`、`marketState()`、`limitPrices()`、法人／重大訊息、Bot prompt、console。行情大概只占兩成，其餘是美股時段／早收／假日、USD 計價與匯率、結算規則、DB 與測試。

### 待決定

- 報價誰看得到：只有我看 / 伺服器其他人也看得到。
- 第一次做到哪裡：先做查價（只加美股報價與市場狀態，不動下單）/ 查價＋下單（A 模式收盤結算、USD 帳戶、美股行事曆，整條交易線都要改）。
- 建議：只有自己看先做查價，確認 Yahoo 資料穩定再接交易；有其他人看先別用 Yahoo／Finnhub，行情源另外找。

## 已知限制

- Console UI 測試缺 Playwright，只做 HTML 語法與標籤平衡檢查。
- `nextOrderAt` 找不到下一交易日時顯示「未定」（31 天內都沒有交易日的極端情況）。
- `node scripts/test-setup-dsh-idempotent.mjs` 需 `DSH_INSTALL_MODULES`，本機無法跑。
- 測試套件：`npm run test:discord` 為 29 支腳本（含 `test-discord-trade`、`test-discord-trade-db`、`test-discord-bot-trader`、`test-discord-institutional`）；`test-mcp-servers-stdio` 驗證 mcp-trade 6 工具。

相關：[[discord-usage-pricing]]、[[discord-console-table-layout]]。