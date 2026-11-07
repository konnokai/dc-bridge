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
- 控制台：「股盤」唯讀分頁與「設定」分頁的交易表單；`/api/trade/*`。
- Node ≥26（`node:sqlite`）；伺服器 26.12.1、本機 26.13。

## 資料來源

- TWSE OpenAPI（`STOCK_DAY_ALL`）與 TPEx OpenAPI（`tpex_mainboard_quotes`）；假日行事曆 `holidaySchedule`。
- TWSE 資料會晚一天：18:28 仍為前一日資料，TPEx 已是當日資料。
- provider 跳過無成交列（TPEx 回 `Close:"----"`、`Change:"---"`）；`getForDate` 只認資料日期等於 trade_date；`dataDate` 回整份來源日期。
- 無成交／停牌股票：整份資料日期 > trade_date 才判定逾期拒絕。

## 漲跌停與參考價

- `limitPrices(referenceCents)`：參考價 ×1.1／×0.9 後對齊升降單位（漲停向下取、跌停向上取），級距用漲跌停價本身而非參考價。
- 盤中參考價：`latest.date < market.date` 時用 `latest.closeCents`（前一日收盤），不是 `close − change`。
- 同日資料才用 `referenceCents`（`close − change`）回推。

## 市場狀態

- 台北時間 09:00–13:30 盤中；週末與行事曆休市；`nextOpen` 給下一次開盤時間。
- 結算只在收盤後進行（`market.phase` 為 after）。

## 帳戶與下單

- `ensureAccount` 惰性：下單成功才建立帳戶；起始資金 1,000,000 NT$（`startingCash`）；`maxOrderPct` 30%。
- 買單保留額用漲停價估算；結算時釋放差額。
- 結算買單：`otherReserved = account.reserved_cents - current.reserved_cents`，可用現金 = 現金 − 別筆保留。
- `/forget` 刪除玩家交易資料；Bot 帳戶不受影響。

## 結算

- `settleDue`：收盤後成交；資料日期等於 trade_date 才成交；逾期拒絕並釋放保留。
- 漲停買單、跌停賣單不成交。
- 結算與 Bot 排程有執行旗標防重疊；`rejectOrder` 遇非 pending 回 null。

## Bot 交易員

- `dc-trader` preset；`mcp-trade` 工具；web search/fetch 上限；每日 token 上限。
- `bot:trader` 一次性會話只活在記憶體，不寫入 sessions 檔。
- `resolve(token, { allowBot: true })` 只給 Bot 交易端點使用。
- 復盤公告排版：`formatReviewBody`（`src/core/bot-trader.mjs`）把模型一整段拆成一句一行，並把點數／百分比／金額等重點數字加粗（`KEY_NUMBER`）；已分好的短行、清單、粗體原樣保留。`formatReviewNotice` 走 `formatReviewBody`；`sendTradeNotice` 也走 `splitDiscordMessage` 分段送。dc-trader persona 改要求 4~8 行、一行一個重點、數字用粗體；dc-chat persona 加「復盤、摘要、報告這類長訊息：一句一行或分成幾段，重點數字用粗體」。docs/guides/DISCORD.md 與 PLAN_STOCK.md 同步。

## 備份

- `state/backups/discord-trade-*.sqlite`，每日備份、保留 7 份。

## 已知限制

- Console UI 測試缺 Playwright，只做 HTML 語法與標籤平衡檢查。
- `node scripts/test-setup-dsh-idempotent.mjs` 需 `DSH_INSTALL_MODULES`，本機無法跑。

相關：[[discord-usage-pricing]]、[[discord-console-table-layout]]。