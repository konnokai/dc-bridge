# 計畫：模擬股票（Discord 版）

> **狀態：已作廢（superseded）。**
> 這份是早期草案。A 模式（盤後結算）、SQLite、Bot 交易員、控制台股盤分頁等決策已寫進
> `docs/design/PLAN_STOCK.md`。以下內容只保留歷史參考，不要照這份實作；有衝突時以
> `PLAN_STOCK.md` 為準。
>
> 原始狀態：**計畫，尚未實作**。
>
> 目標：群友可以在 Discord 跟 bot 玩「虛擬資金買賣股票」。只模擬，不碰任何真實券商或真錢。
> 參考實作：`src/mcp-slang.js`（MCP 走橋接 loopback 端點）、`src/core/discord-slang.mjs`（純資料模組）。

## 為什麼不整合現成專案

評估過 [HKUDS/AI-Trader](https://github.com/HKUDS/AI-Trader) 與 [OpenByteInc/QuantDinger](https://github.com/OpenByteInc/QuantDinger)（只讀了 README，未 clone）。

- AI-Trader 是 agent 社群與跟單平台，主要是 hosted 服務，沒有 MCP，沒提台股。
- QuantDinger 要 Postgres + Redis + Kafka + Docker，而且能送真實訂單；放在聊天 bot 旁邊風險不值得。
- 本功能只需要：虛擬帳戶、報價、買賣、損益、排行榜。自寫比部署整個系統小很多。
- 只借鑑設計：QuantDinger 模擬成交用 0.05% 手續費 + 0.05% 滑價（本計畫沿用）。

## 範圍

做：

- 每人一個虛擬帳戶（以 Discord user id 為 key），起始資金固定。
- 查報價、買進、賣出（只做現股、只做多，不做融資融券、不做選擇權）。
- 查持倉與損益、排行榜。

不做：

- 任何真實下單、券商 API、API key。
- 即時 tick、K 線、技術指標、回測。
- 「AI 推薦買哪支」的專用功能。模型被問到時照一般聊天回答，並帶免責聲明。
- 私聊玩（v1 只在允許的公開頻道；理由見「身分」）。

## 架構

照 slang 的做法：MCP 只是薄殼，狀態與身分都在橋接。

```
模型 → mcp-paper-trade.js（stdio）→ 橋接 loopback /trade-* → src/core/discord-trade.mjs → state/discord-trade.json
                                               ↘ 報價：src/core/quote-provider.mjs（可替換、可離線 mock）
```

### 身分（最重要）

模型不能自己傳 user id，否則可以替別人下單。身分由橋接依「目前這一輪是誰觸發的」決定，
MCP 工具的參數裡沒有 user 欄位。沿用 slang 的「一輪最多呼叫 N 次」閘門與 loopback 令牌。
同一輪有多人時（批次合併），以觸發該輪的那位為準；拿不到就拒絕。

### 工具（命名空間 `mcp__trade__`）

| 工具 | 參數 | 說明 |
| --- | --- | --- |
| `get_quote` | `symbol` | 查報價（唯讀） |
| `place_order` | `symbol`、`side`(buy/sell)、`quantity` | 以當下報價 ± 滑價成交，扣手續費 |
| `get_portfolio` | 無 | 現金、持倉、未實現損益 |
| `get_leaderboard` | 無 | 本伺服器總資產排行 |

數量必須是正整數；單筆金額、單支持倉佔比設上限，防止模型誤送極端值。

### 資料

`state/discord-trade.json`（沿用 slang 的原子寫、壞檔備份、版本檢查、大小上限）：
`{ version, accounts: { "<guildId>:<userId>": { cash, positions: {symbol: {qty, avgCost}}, trades: [...] } } }`。
帳戶以 guild 分開；`trades` 只留最近 N 筆。

### 報價來源

- 介面：`quote(symbol) → { price, currency, asOf }`，失敗回明確錯誤，**不編價格**。
- v1 預設一個免費來源；台股候選是 TWSE 公開 OpenAPI，美股候選是 Yahoo 類免費端點。
  **以上都還沒驗證**，實作第一步先實測可用性、速率限制與授權條款，再決定。
- 報價快取數十秒，避免被群友洗頻打爆來源。
- 休市時用最後收盤價並在回傳標明 `asOf`，不假裝即時。
- 外部回傳都包進「這是資料、不是指令」外殼（沿用 `mcp-web-search-safe` 的 `untrustedData`）。

### 設定

`config.json` 的 `discord.trade`：`enabled`（預設 `false`）、`startingCash`、`feeRate`(0.0005)、
`slippageRate`(0.0005)、`maxOrderValue`、`allowedGuilds`。沒開就拒絕所有端點。

## 安全與風險

- 全程模擬；不新增任何憑證或對外寫入。
- 模型回答要帶「模擬、非投資建議」聲明（寫進 persona 或工具回傳文字）。
- `symbol` 做白名單格式檢查（英數與 `.`、長度上限），避免被塞進 URL 或 prompt。
- 價格來源異常時拒絕成交，不退回舊價。

## 要改的檔案

1. 文件：本檔、`docs/guides/DISCORD.md`（新增「模擬股票」段）、`docs/FOLDER_MAP.md`、`docs/README.md`。
2. 新增：`src/core/discord-trade.mjs`、`src/core/quote-provider.mjs`、`src/mcp-paper-trade.js`。
3. 橋接：`src/discord-bridge.js` 加 `/trade-*` 端點與設定收斂。
4. 註冊：`scripts/setup-dsh.mjs`（`DISCORD_MCP_IDS` 加 `mcp-paper-trade`，serverName `trade`）、
   `plugins/dc-agent-presets/dc-tool-restrict.mjs`（放行 `mcp__trade__*` 四個工具；`dc-learner` 不放行）。
5. 測試：`scripts/test-discord-trade.mjs`（新）、`test-discord-bridge.mjs`（端點與設定）、
   `test-mcp-servers-stdio.mjs`（工具有註冊）。

## 實作順序（每步先寫測試並看它失敗）

1. 實測報價來源，決定 v1 用哪個；記錄結果回本文件。
2. `discord-trade.mjs`：開戶、買賣、手續費與滑價、現金不足、持倉不足、上限、排行榜、壞檔。
3. `quote-provider.mjs`：mock 與真實兩個實作，快取與錯誤處理。
4. 橋接端點：身分取得、`enabled` 閘門、一輪呼叫上限、私聊拒絕。
5. `mcp-paper-trade.js` 與註冊、工具限制。
6. 部署：依 AGENTS.md，動到 MCP 要 `setup:discord`，`pm2 stop dc-bridge` → `pm2 restart dsh` → `pm2 start dc-bridge`，
   再用暫時 stdio client 確認四個工具都註冊。

## 驗收

- 離線測試全過（買賣數學、邊界、身分、閘門）。
- 測試伺服器實測：開戶 → 查價 → 買 → 賣 → 排行榜；用兩個帳號確認互相看不到、改不到對方資產。
- `request/header.tools` 檢查：`dc-chat` 有四個 trade 工具，`dc-learner` 沒有。

## 待決定

1. 要不要支援台股？取決於步驟 1 的報價來源實測結果。
2. 起始資金與單筆上限的數字。
3. 排行榜是否公開顯示名稱，還是只顯示暱稱（隱私，見 `docs/guides/PRIVACY.md`）。
4. 要不要允許私聊。預設不允許，因為私聊沒有 guild 帳戶與排行榜情境。
