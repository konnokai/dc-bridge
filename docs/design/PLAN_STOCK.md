# Discord 模擬股票交易系統企劃書

**版本：v0.4 — 精簡 MVP：台股、盤後結算、SQLite、Bot 交易員**

**狀態：第一版已實作（2026-11-05）。** 這份文件仍是規則的權威來源；第二階段項目尚未實作。

**定位：** Discord 群組內使用的虛擬股票交易遊戲。玩家與 Bot 都是參與者。

**適用對象：** 企劃者、Bridge／MCP 後端開發者、測試人員

**設計原則：** 簡單、可理解、可維護；先求交易正確，不追求盤中即時撮合。

---

## 0. 決策記錄

| 項目 | 決定 | 日期 |
|---|---|---|
| 成交模式 | **A 模式：盤中或預約下單、收盤結算** | 2026-11-05 |
| 交易資料 | **SQLite**（Node 26 內建 `node:sqlite`），只用於交易域 | 2026-11-05 |
| Bot 參與 | **第一階段就做**：模型自己判斷、可讀新聞、有 token 上限 | 2026-11-05 |
| 控制台 | 新增「股盤」分頁；交易設定放在既有「設定」分頁 | 2026-11-05 |
| 持股公開 | **A：公開**（遊戲資料；`/portfolio` 仍是私下查看選項） | 2026-11-05 |
| MVP 範圍 | **精簡 MVP**：台股、股數下單、A 模式；美股／匯率、金額下單、snapshots、滑價留第二階段 | 2026-11-05 |
| 舊計畫 | `PLAN_PAPER_TRADE.md` 作廢，內容以本文件為準 | 2026-11-05 |

**A 模式的代價要先講清楚：**

- `get_quote` 顯示的是最近一次官方收盤價，不是盤中即時價。盤中查價會標「今日尚未收盤」。
- `place_order` 只回 `pending`，不是「已成交」。19:00 後才用當日收盤資料結算；收盤價、法人與晚報一次收齊。
- 好處是不用取得台股即時報價授權，也沒有「拿舊價成交」的套利問題。
- 如果一定要「現在多少錢、現在成交」，那是 B 模式，需要即時報價授權；本文件不採用。

### 0.1 MVP 邊界

| 功能 | 第一版（精簡 MVP） | 第二階段（完整版） |
|---|---|---|
| 市場 | 台股上市／上櫃 | 美股＋匯率 |
| 下單 | 股數 | 金額下單 |
| 成交 | A 模式收盤結算 | 同左 |
| 快照 | 不寫 snapshots | 每日 snapshots |
| 滑價 | 固定 0 | 可設定滑價 |
| 其他 | 費用、稅、持股、損益、排行榜、Bot、股盤分頁 | 限價、取消、走勢圖、公司行動、重置、賽季 |

**第一版先把台股、股數下單、A 模式做正確；美股、匯率、金額下單、snapshots、滑價留第二階段。** 這不是刪掉設計，相關欄位與流程先保留在文件裡，等第二階段再啟用。

---

## 1. 企劃目標

本系統讓 Discord 使用者與 Bot 透過對話，使用虛擬資金買賣真實市場中的股票，並比較投資表現。

這是模擬遊戲，不連接真實券商帳戶，也不執行任何真實金錢交易。

### 1.1 核心玩法

玩家與 Bot 各獲得 NT$1,000,000 的起始虛擬資金，使用同一套規則、同一種費用、同一個排行榜。

玩家可以：

1. 查詢台股最近收盤價與市場狀態（美股第二階段）。
2. 盤中或預約時段排隊買入或賣出，收盤後結算。
3. 查看自己的資產、持股、pending 訂單及損益。
4. 查看伺服器內其他玩家與 Bot 的投資排名。
5. 問 Bot 自己的模擬持股與績效。

例如：

**玩家：**「台積電現在多少錢？」

**Bot：**「台積電（2330）最近收盤價 NT$1,000，報價時間 2026-11-04 13:30。現在是盤中，這不是即時報價；今天下單會用今日收盤價結算。」

**玩家：**「幫我買 10 股。」

**Bot：**「已排隊買入台積電 10 股（訂單 ORD-…），現金先保留。今天收盤後結算，成交價與費用會再通知。」

收盤後：

**Bot：**「模擬成交：買入台積電 10 股，成交價 NT$1,000，手續費 NT$14，實扣 NT$10,014。現金餘額 NT$989,986。」

上述價格僅供說明。

### 1.2 第一版不做的功能

- 真實股票交易、券商 API、真實金錢
- 盤中即時成交（第一版是盤後結算）
- 限價單、取消委託
- 融資、放空、槓桿、當沖、信用交易
- 小數股、T+2 交割、股利自動入帳與股利所得稅、二代健保
- ETF、權證、期貨、選擇權等特殊商品（除非另外完成分類與費率）
- 真實交易所等級的撮合、委託簿、成交量模型
- 自動替玩家選股
- 可兌換現金或實體獎品的競賽
- 美股與匯率、金額下單、每日 snapshots、滑價（第二階段）

第一版以「玩家能正確下單、收盤結算、查看資產與排名」為完成目標。

---

## 2. 基本股票概念

本章提供給不熟悉股票交易的開發者閱讀。

### 2.1 股票與持股

股票是一種價格會變動的資產。

玩家買進股票後，帳戶會減少現金，增加股票持有數量。買入當下不代表賺錢或虧錢；資產價值會隨市場價格變動。

### 2.2 市價單與盤後結算

本遊戲第一版採用簡化市價單，但**不是即時成交**。

流程是：

1. 玩家在市場開放時提出買入或賣出。
2. Bridge 檢查身分、標的、數量、現金或持股。
3. 建立 `pending` 訂單，保留現金或股票。
4. 市場收盤、官方收盤資料可用後，系統以收盤價加減滑價結算。
5. 成交或拒絕後，更新帳戶並通知頻道。

玩家指定：

- 買入或賣出
- 股票代號
- 數量或金額

系統確認市場開放、標的合法、價格有效及資金足夠後，完成排隊。成交價以結算時的官方收盤價為準，不保證等於下單時看到的價格。

### 2.3 零股

台灣股票通常以每張 1,000 股為交易單位，也有零股交易。

為了降低遊戲門檻，本系統直接以「股」計算，玩家可以買 3 股台積電，不需要一次買 1,000 股。

這是遊戲簡化，**不是台股零股撮合模擬**。台股零股是分盤、限價、另有撮合間隔；本遊戲不模擬那個市場。

第一版台股使用整數股；美股第二階段也使用整數股，不支援小數股。

### 2.4 交易成本

本遊戲將成本拆成：

- **手續費：** 每次買賣產生的費用。
- **交易稅：** 賣出時產生的稅費。
- **滑價：** 成交價與官方收盤價之間的差距。
- **換匯價差：** 台幣與美元轉換時的成本。

各項費用由系統計算，模型不自行計算或決定。

### 2.5 已實現與未實現損益

**未實現損益：** 股票還沒賣出，但市場價格已經改變。

**已實現損益：** 股票已經賣出，買賣差價及相關費用已經確定。

兩者分開顯示。`pending` 訂單不算已成交，也不產生已實現損益。

---

## 3. 市場與交易規則

### 3.1 支援市場

第一版支援台股；美股欄位先保留給第二階段：

| 項目 | 台股（第一版） | 美股（第二階段） |
|---|---|---|
| 幣別 | TWD | USD |
| 股票代號 | 2330、2317 | AAPL、MSFT |
| 市場 | 上市（TWSE）、上櫃（TPEx） | 美國主要交易所 |
| 交易單位 | 整數股 | 整數股 |
| 下單時間 | 台北 09:00–13:30；預約單 14:50–次一交易日 09:00 | 美東 09:30–16:00（早收 13:00） |
| 結算 | 當日官方收盤價（13:30） | 當日官方收盤價（16:00 ET） |
| 漲跌幅 | 一般股票 ±10%，有例外 | 無一般性每日 ±10% 限制 |
| 休市 | 台灣交易所行事曆 | 美國交易所行事曆 |

- 表上的 13:30 是收盤時間；實際結算在 19:00 後，等收盤價、法人與晚報資料齊。
- 交易日的 14:50 至次一交易日 09:00 收預約單，記在下一個交易日，等那天 19:00 後才結算；
  13:30–14:50 不收單。休市日整天都在上一交易日開始的預約窗裡（週六、週日排到週一）。
- 不模擬 09:10 第一次撮合與之後每 5 秒的集合競價；A 模式統一用當日收盤價結算。

- （第二階段）美股交易時間要正確處理夏令與冬令時間，使用 IANA 時區 `America/New_York`，不要硬寫 UTC-5／UTC-4。
- 交易時間、休市日及特殊交易狀態以市場資料為準，不單純依星期幾判斷。
- （第二階段）早收日（例如 2026-11-27、2026-12-24）以 13:00 ET 為收盤。
- 年度休市日（TWSE／NYSE）用靜態清單，每年更新；颱風等臨時休市由控制台開關或當日無收盤資料判定。
- 第一版用 `trade.extraHolidays` 補臨時休市日；沒有補到的那天仍可能接受下單，隔天找不到收盤資料時會拒絕訂單。
- 臨時休市（颱風、交易所公告）沒有新鮮收盤資料就不結算，不用舊價硬算。

台股一般股票 tick（升降單位）：

| 股價 | tick |
|---|---|
| 未滿 10 元 | 0.01 |
| 10–未滿 50 元 | 0.05 |
| 50–未滿 100 元 | 0.1 |
| 100–未滿 500 元 | 0.5 |
| 500–未滿 1000 元 | 1 |
| 1000 元以上 | 5 |

ETF 的 tick 不同（未滿 50 元 0.01、50 元以上 0.05），第一版不開放。（第二階段）美股用 0.01 美元。

第一版只開放台股一般上市、上櫃普通股；美國普通股第二階段。ETF、處置股票、變更交易方法、全額交割、暫停交易、新上市無漲跌幅限制期間，先不開放。

### 3.2 股票代號與商品主檔

`get_quote` 可以接受股票代號或名稱：

- `2330`
- `台積電`
- `AAPL`
- `Apple`

系統需要一份 symbol master（商品主檔），每個標的至少記：

- `symbol`
- `name`
- `aliases`（別名）
- `market`（TW／US）
- `exchange`（TWSE／TPEx／NASDAQ／NYSE）
- `currency`
- `type`（stock／etf／…）
- `tickSize`
- `tradable`
- `note`

第一版用白名單，台股上市／上櫃各 20–30 檔；美股 20–30 檔第二階段。名稱比對順序：精確 → 別名 → 子字串 → 候選清單。多個候選時回傳清單，由玩家選擇；模型不自行猜測。

台股上市與上櫃要分別識別；同一代號不會同時是上市與上櫃，但報價來源與行事曆不同。

### 3.3 帳戶幣別與匯率

第一版只有台幣帳戶，不換匯；以下美股換匯規則第二階段才啟用。

（第二階段）玩家買進美股時，系統將成交金額換算為台幣。美股持股保留美元價格與原始股數，但**成本基礎統一記在 TWD**，這樣賣出時不會把股票損益和匯損混在一起。

**換匯規則：**

- 使用系統指定的每日匯率來源。
- 買入與賣出套用固定換匯價差。
- 每筆成交保存當時使用的匯率。
- （第二階段）美股結算時用結算當下最近一筆有效匯率，存 `asOf`；估值也用同一筆或最近有效匯率。
- 匯率以整數比率保存（例如 TWD per USD × 1,000,000），不要用浮點數累積。
- 匯率資料要顯示 `asOf`；沒有當日匯率時，沿用最近有效匯率並標明。

第一版不建立美元錢包。

### 3.4 交易費用

費率由設定檔管理，不寫死在交易程式內。

建議初始設定：

| 項目 | 模擬規則 |
|---|---|
| 台股一般股票手續費 | 成交金額 0.1425%（買賣各一次） |
| 台股一般股票賣出證交稅 | 成交金額 0.3% |
| 美股模擬佣金（第二階段） | 0 |
| 美股 SEC／TAF（第二階段） | 可選，費率會變，不硬寫 |
| 滑價（第二階段；第一版固定 0） | 由設定檔決定 |
| 換匯價差（第二階段） | 由設定檔決定 |
| 最低手續費 | 可設定，預設 0 |

- 第一版只套用台股一般股票手續費與證交稅；美股、滑價、匯差第二階段才啟用。
- 台股 ETF 賣出稅率 0.1%、現股當沖 0.15%（優惠至 2027-12-31），第一版不開放，不套用一般股票規則。
- 手續費、稅、滑價、匯差都要有明確的 rounding 規則；買進與賣出的 rounding 方向要固定，不能每次不同。
- 金額以整數最小單位計算（TWD 分、USD 分），顯示時再換成元。
- A 模式用收盤單一價，滑價預設 0；若要模擬滑價，先處理 tick 級距（台股 1,000 元一個 tick 是 5 元），不要用固定百分比直接加。

---

## 4. 報價與結算機制

這是第一版最重要的技術決策。

### 4.1 查價與成交分開處理

**查價：** 顯示最近一次官方收盤價、報價時間與市場狀態。

**成交：** 玩家下單只建立 `pending` 訂單；收盤後用官方收盤價結算。

兩者不是同一筆資料。查價可以看到「昨日收盤」；成交用「今日收盤」。不要拿查價的舊價格直接成交。

盤中查價的回答要明確：

- 「最近收盤價 NT$X（YYYY-MM-DD 13:30）」
- 「現在是盤中，這不是即時報價」
- 「今天下單會用今日收盤價結算」

### 4.2 報價來源

第一版以**台股盤後官方資料**為主；美股第二階段：

- 台股上市：臺灣證券交易所 OpenAPI（盤後日資料）
- 台股上櫃：櫃買中心 OpenAPI（盤後日資料）
- 三大法人：TWSE T86 日報、TPEx OpenAPI（收盤後）
- 重大訊息：TWSE OpenAPI `t187ap04_L`、TPEx OpenAPI `mopsfin_t187ap04_O`（收盤後；有時隔天才更新，復盤抓最近交易日）
- 美股（第二階段）：Finnhub 收盤後 `/quote`（免費方案，個人／非商業用途；使用前確認條款與限額）
- 匯率（第二階段）：台銀／央行每日牌告，或 FinMind 免費外幣資料；實作前實測

不採用的來源：

- Yahoo Finance 非官方介面：不穩定、條款不清，不當主來源。
- 台股即時行情：證交所的即時與延遲資訊都要授權；免費 OpenAPI 不是盤中。Fugle 免費方案有即時 WebSocket，但條款禁止把行情傳送給第三人；Discord 多人伺服器有風險。除非取得授權，第一版不用。

正式採用前要確認：

1. 是否支援所需市場。
2. 能否取得價格與 `asOf`。
3. 更新時間是否早於結算排程。
4. API 額度是否足夠。
5. 使用及轉發條款是否允許 Discord 多人使用。

不需要第一版就實作多套自動切換來源。先選一個主要來源；失敗時拒絕結算，不編價格。

### 4.3 訂單生命週期

第一版只有市價單，流程固定：

1. **下單**：玩家在市場開放時提出。Bridge 驗證身分、標的、數量、現金／持股、單筆上限。
2. **排隊**：建立 `pending` 訂單；買入保留現金，賣出保留股票。回傳 `orderId` 與 `pending`。
3. **結算**：市場收盤、官方收盤資料可用後，結算 job 取得收盤價。
4. **計算**：成交價 = 收盤價 ± 滑價；計算手續費、稅（匯差第二階段）、淨額；檢查漲跌停與價格有效性。
5. **入帳**：在同一個 SQLite transaction 更新現金、持倉、訂單、現金流水。
6. **通知**：成交或拒絕後，在原本頻道通知；`get_portfolio` 可看到最近訂單。

**結算時間**

- 19:00 前不結算：收盤價、法人與晚報通常還沒齊。
- 19:00 後每 `settlement.twCheckMinutes` 分鐘檢查一次；資料日期等於 `trade_date` 才成交。
- 資料延遲就繼續等；不會用昨天的收盤價冒充今天。

**數量與保留**

- `quantity` 買單：台股用漲停價估算保留額；美股（第二階段）用最近收盤價加 `reserveBufferPct`（預設 5%）與匯率緩衝。結算實際成本低於保留時釋放差額；超過保留且可用現金不足時拒絕。
- `amount` 買單（第二階段）：保留指定金額；收盤後找最大的整數股數 `n`，使 `n × 成交價 + 手續費 + 匯差 ≤ amount`（無條件捨去），不足 1 股就拒絕；`orders.qty` 在結算時才寫入。
- `quantity` 賣單：保留股數；成交後入帳。
- 30% 上限：`quantity` 用估算成本、`amount` 用指定金額，只在排隊時檢查；結算時只檢查現金是否足夠。
- 第一版只支援 `quantity`（股數）；`amount` 第二階段。

結算價規則（第一版滑價固定 0；第二階段才會有非零滑價）：

- 買入價 = 官方收盤價 + 滑價。
- 賣出價 = 官方收盤價 − 滑價。
- 滑價後要遵守 tick size：買進無條件進位，賣出無條件捨去，不能讓玩家拿到比規則更好的價格。
- 台股漲停：買單拒絕；跌停：賣單拒絕。美股不套用 ±10%（第二階段）。
- 漲跌停價用資料源提供的參考價計算；除權息日的參考價不等於昨收，不能自己用昨收算。
- 官方收盤價為 0、缺失、或日期不是結算日：不成交，保留 pending 或拒絕。

**結算順序**

- 同一帳戶的 pending 訂單照 `created_at` 依序結算。
- 同一標的同一天有反向 pending 單（買＋賣）時，先拒絕新單；MVP 不模擬當沖。

結算失敗：

- 資料暫時抓不到：保留 pending，下一個結算窗口再試。
- 超過一個交易日仍無法結算：拒絕訂單，釋放保留的現金／股票，通知玩家。

第一版不提供取消；取消留第二階段。

### 4.4 延遲與過期處理

A 模式沒有「盤中舊價成交」問題，因為成交只用當日官方收盤價。但仍要處理：

- 查價資料過期：顯示 `asOf`，不要說「現在」。
- 結算資料日期不符：不成交。
- 休市、臨時休市、資料中斷：不結算，保留或拒絕。
- 不要用上一次收盤價冒充今日收盤價。

### 4.5 非交易時間

下單時間照台股盤中零股規則：

- 交易日 09:00–13:30：可直接排隊，記在當天。
- 交易日 14:50–次一交易日 09:00：收預約單，記在下一個交易日；休市日整天都在這個窗裡。
- 13:30–14:50：不收單，回覆下一段下單時間（當天 14:50）。
- 已排隊的訂單：等自己的 `trade_date` 收盤結算，預約單不會在當天晚上先成交。
- 預約單排好之後才宣布的休市日（颱風等）：該筆單失效並釋放保留，不會當成逾期。
- 報價資料過舊（早於 `trade_date` 的前兩個交易日）仍拒絕；連假後來源還沒更新就不收單。

---

## 5. 帳戶與資產計算

### 5.1 帳戶建立

玩家第一次成功排隊下單時，自動建立模擬帳戶。

- 每個 Discord user ID 對應一個帳戶。
- 帳戶跨伺服器共用，不因使用者更改暱稱而改變。
- 初始資金：NT$1,000,000。
- Bot 使用獨立帳戶 `bot:<clientId>`，在功能開啟時建立，不與任何玩家共用。
- 帳戶一旦建立，即使沒有持倉也保留；`/forget` 才刪除。

### 5.2 資產公式

第一版只有台股；以下美股與匯差描述第二階段。

**現金餘額**

初始現金 − 買入實際支出 + 賣出實際收入 − 費用 − 稅。

**保留現金**

`pending` 買單保留的金額。保留現金仍是資產，但不能用來下新單。

**可用現金**

現金餘額 − 保留現金。

**持股市值**

持有股數 × 最近官方收盤價。美股再換算為台幣（第二階段）。

**帳戶淨值**

現金餘額 + 所有持股市值。`pending` 訂單不改變淨值，只改變可用現金。

**未實現損益**

持股市值 − 尚未賣出持股的成本。成本包含買入手續費（換匯價差第二階段）。

**已實現損益**

賣出淨收入 − 已賣出股數對應的持股成本。賣出淨收入已扣賣出手續費、稅（匯差第二階段）。

**總報酬率**

（目前帳戶淨值 − 起始資金）÷ 起始資金 × 100%。

第一版沒有額外入金、出金，因此使用這個簡化公式。

### 5.3 平均成本

同一股票分批買進時，使用加權平均成本法。

- 買入成本 = 成交金額 + 手續費（美股換匯價差第二階段）。
- 賣出部分股票時，按平均成本計算該部分的已實現損益。
- 賣出後若持股歸零，刪除該持倉列，但保留現金流水與訂單紀錄。

### 5.4 資產估值

估值與成交是不同操作。

- 使用最近一次有效官方收盤價。
- 每筆估值保留 `asOf`；不同市場可以有不同估值時間。
- 美股用同一交易日的估值匯率換算台幣（第二階段）。
- 休市時使用最近收盤價，不代表能以該價格成交。
- 股利、分割、減資等公司行動未自動處理前，遇到事件要停止該標的交易與估值，並標記人工處理。第一版不可默默讓持倉縮水。事件來源用交易所公告或公司行動資料；沒有來源時由管理員手動凍結。

### 5.5 現金流水

每一筆現金變動都要寫入 `cash_ledger`：

- 買入扣款
- 賣出入帳
- 手續費
- 交易稅
- 換匯價差（第二階段）
- 股利（若日後支援）
- 人工調整

每筆記 `account_id`、`order_id`、`kind`、`amount`、`balance_after`、`created_at`。這是稽核與對帳的依據，只追加，不修改歷史。

---

## 6. 系統架構

沿用現有 Discord Bridge 與 MCP 設計。

### 6.1 職責分工

**Discord Bridge**

- 接收玩家訊息，識別訊息來源及使用者。
- 管理帳戶、訂單、持倉與現金流水。
- 驗證下單權限與交易限制。
- 執行排隊、結算、資產計算。
- 保存交易紀錄（SQLite）。
- 執行 Bot 交易排程與公告。
- 提供控制台 API。

**MCP 工具**

- 提供模型可以呼叫的操作介面。
- 傳遞查價、下單、持股、排行榜、Bot 持股請求。
- 回傳 Bridge 的執行結果。
- 不做價格計算、不直接改資料庫。

**模型**

- 理解玩家的自然語言。
- 判斷玩家想查價、買入或賣出。
- 呼叫適當工具。
- 將結果轉換成容易理解的回覆。

模型不負責決定成交價格、計算資產或修改帳戶資料。

**Bot 交易員**

- 由 Bridge 排程，在盤中不定時啟動一個獨立的模型回合。
- 可查價、看自己的持倉、讀新聞。
- 最多下一筆單；也可以選擇不交易。
- 由 Bridge 驗證後才寫入訂單。

### 6.2 MCP 工具

#### 玩家工具

##### `get_quote(query)`

查詢台股最近收盤價（美股第二階段）。

輸入：股票代號或名稱。

輸出：

- 股票名稱及代號
- 市場與交易所
- 最近收盤價及幣別
- 漲跌幅（有昨收才提供）
- 報價時間 `asOf`
- 市場狀態（盤中／收盤／休市）
- 是否可下單

如果名稱對應多個標的，回傳候選清單，不回價格。

##### `place_order(message, side, symbol, quantity)`

排隊買入或賣出。

輸入：

- `message`：本回合觸發訊息的 #編號（身分驗證用）
- `side`：`buy`／`sell`
- `symbol`：商品主檔裡的代號
- `quantity`：股數（第一版只收股數；`amount` 第二階段）

規則：

- 第一版只支援 `quantity`；`amount` 買單第二階段。
- （第二階段）以金額買入時，Bridge 先保留指定金額；收盤後用實際成交價換算股數（無條件捨去），不得超過指定金額；換不到 1 股就拒絕。
- 一回合最多 1 筆成功排隊訂單。
- 回傳 `{ status: 'pending', orderId, reserved, message }`，不是「已成交」。

輸出：

- 訂單編號
- 狀態（`pending`）
- 保留股數（`amount` 第二階段才保留金額）
- 預計結算時間
- 交易後可用現金
- 提醒：收盤後才成交

##### `get_portfolio(message 可省略)`

查詢自己的帳戶。

輸出：

- 現金、保留現金、可用現金
- 持股、平均成本、持股市值
- 已實現損益、未實現損益
- 帳戶淨值、總報酬率
- 最近 5 筆訂單（`pending`／`filled`／`rejected`）

`message` 可省略；省略時用本回合唯一的 direct 觸發者。同一回合有多個觸發者時，必須給 `message`，Bridge 用 `turnDirectMessages` 的作者決定身分；指向不到或指向兩人就拒絕。

##### `get_leaderboard(period 可省略)`

查詢伺服器排行榜。

- 第一版用總報酬率排序。
- `period` 預設 `all`；日、週、月排名第二階段。
- 最多顯示前 10 名，名稱使用伺服器暱稱。
- Bot 標示 `🤖`；是否納入前 10 名由設定決定。

##### `get_bot_portfolio()`

唯讀查詢 Bot 的模擬帳戶。玩家問「你自己賺多少」「你買了什麼」時使用。不回傳任何玩家帳戶資料，也不能下單。

#### Bot 專用工具

##### `bot_place_order(side, symbol, quantity, reason, note)`

只有 Bot 排程回合可以呼叫。第一版只收股數；`amount` 第二階段。

- 沒有 `message`、沒有 user id；身分固定是 `bot:<clientId>`。
- Bridge 要確認：目前是 Bot 的排程回合、key 是 Bot 專用頻道、`botTurnActive` 為 true。
- 一回合最多 1 筆。
- `reason` 給控制台與稽核查看，最多 300 字。
- `note` 是公告用的一句話，最多 200 字；沒有就由 Bridge 用模板。
- 回傳 `pending` 訂單，不是成交。

`dc-chat` 與 `dc-learner` 都不能看到這個工具。

### 6.3 Bot 交易員

Bot 是第一版的正式參與者，不是第二階段功能。

**身分與帳戶**

- 帳戶 ID：`bot:<clientId>`。
- 起始資金、費用、單筆上限、漲跌停規則都與玩家相同。
- 玩家不能代 Bot 下單；Bot 也不能代玩家下單。
- Bot 不出現在 `/forget` 的刪除範圍。

**執行方式**

- Bridge 內建排程器，每 5 分鐘檢查一次。
- 只在市場開放時啟動；每日最多 1 次決策、最多 1 筆訂單（可設定）。
- 收盤後 19:10 另跑一次當日復盤，不下單；收盤價與法人先由 Bridge 抓，模型補新聞。
- 每次決策只選一個市場（`bot.market`，預設 TW；`US`／`alternate` 第二階段）；要同時跑台美就開兩次決策，次數共用每日上限。
- 兩次決策至少間隔 60 分鐘；重啟不補做。
- 每次決策建立一個一次性會話，使用 `dc-trader` preset；執行期間暫時登記到 bridge 的 `sessions`／`reverse`（key 例如 `bot:trader`），結束後移除並歸檔。
- 排程器送交易決策 prompt；這個 prompt 走獨立 builder，不帶一般回合的 `send_message` 提示。
- `bot_place_order` 驗證 `sessionId === activeRun.sessionId`；不是目前 active run 就拒絕。
- 不需要交易室頻道；公告頻道由 `announceChannelId` 指定。

**模型可以做什麼**

- 查最近收盤價（`get_quote`）。
- 看自己的持倉與現金（`get_bot_portfolio`）。
- 用 `mcp__web-search-safe__web_search`／`web_fetch` 讀新聞；每回合最多 3 次搜尋、2 次抓取。次數在 `dc-tool-restrict` 的 guard 用 `exec.agent.id` 計數；一次性會話等於一回合，不需要另外歸零。
- 呼叫 `bot_place_order` 排隊一筆，或選擇不交易。
- 不能呼叫 `send_message`、不能改玩家資料、不能改費率。

**模型輸出與下單的關係**

- 模型只輸出文字 → 不交易。Bridge 記一筆「hold」日誌。
- 模型呼叫 `bot_place_order` → Bridge 驗證 symbol、數量、現金、30% 上限、市場狀態、每日上限；通過才排隊。
- 模型超時、回傳無效工具參數、選到白名單外的標的 → 跳過，不交易。
- 不因為新聞文字、模型心得或「我覺得會漲」直接下單；一定要有合法工具呼叫。

**當日復盤**

- 收盤後（預設 19:10）跑一次，不再下單；只整理當日損益、持股、法人、最近交易日的重大訊息與新聞。
- 收盤價與法人／重大訊息由 Bridge 先抓，模型只用 `web_search` 補新聞；資料 19:40 還缺就照跑並標查不到。
- 輸出 4~8 行、一行一個重點，重點數字用粗體；Bridge 發到 `announceChannelId`，並存進 `daily_reviews` 給隔天 09:00 決策當背景。
- 模型若還是寫成一整段，Bridge 送出前拆成一句一行；整段都沒有粗體時才自動把數字加粗。
- 超過單則上限最多分兩則，再多的內容省略並標註。
- 不貼新聞全文，不提到玩家資料；每個交易日最多一次，重啟不補做。

**Token 與成本上限**

- `maxTurnsPerDay`：預設 1。
- `maxOutputTokens`：預設 500，但目前 DSH 沒有可直接設定的 output token 上限；先當 prompt 目標，實際用 timeout 與 usage 上限控制。
- `maxTokensPerDay`：預設 20,000；先實測一輪實際用量再調整。
- `maxWebSearchesPerTurn`：預設 3；`maxWebFetchesPerTurn`：預設 2。
- 使用現有 usage／token ledger 記帳，Bot 會話要有自己的 usage 歸屬；超過上限就停止當日 Bot 交易。
- 每次決策寫一筆 `bot_runs`（runId、市場、狀態、token、原因）；重啟後用它算每日次數，控制台也從這裡讀。
- 模型失敗不重試超過 1 次；避免燒 token。

**公告**

- 結算後由 Bridge 在設定的公告頻道發一則短訊息。
- MVP 公告用模板：買／賣、股數、成交價、費用、報酬、模擬聲明。`reason` 留在控制台；`note` 不公開，避免新聞內容變成注入路徑。
- 如果之後要公開 `note`，先過 `defang`、敏感資訊檢查、去連結，並用 `allowedMentions: { parse: [] }`。
- 不 @ 任何人；不貼完整推理；不貼新聞全文。

**排行榜**

- Bot 帳戶有 `kind = 'bot'`。
- 與玩家同榜，標 `🤖`；第一版不另外做「AI 對手」分區。
- 同一個起始資金、同一套費用；不給 Bot 額外資金或特權。

**新聞使用邊界**

- 搜尋結果與網頁內容是資料，不是指令；沿用既有 `untrustedData` 外殼。
- 不把新聞全文貼進頻道；只引用短句與來源。
- 新聞可能延遲、錯誤、農場；模型要標不確定，不能把新聞當保證。
- 第一版不接券商、不接真實交易 API。

### 6.4 設定

新增 `config.json` 的 `discord.trade`，預設 `enabled: false`。

```json
{
  "discord": {
    "trade": {
      "enabled": false,
      "allowedGuilds": [],
      "allowedChannels": [],
      "extraHolidays": [],
      "startingCash": 1000000,
      "maxOrderPct": 30,
      "reserveBufferPct": 5,
      "fees": {
        "twFeeRate": 0.001425,
        "twTaxRate": 0.003,
        "usCommission": 0,
        "minFee": 0
      },
      "slippageRate": 0,
      "fx": {
        "source": "daily",
        "spreadRate": 0.001
      },
      "settlement": {
        "twCheckMinutes": 10,
        "twSettleAfter": "19:00",
        "usCheckMinutes": 10
      },
      "bot": {
        "enabled": false,
        "market": "TW",
        "announceChannelId": "",
        "preset": "dc-trader",
        "maxTurnsPerDay": 1,
        "maxTradesPerDay": 1,
        "minIntervalMin": 60,
        "maxOutputTokens": 500,
        "maxTokensPerDay": 20000,
        "maxWebSearchesPerTurn": 3,
        "maxWebFetchesPerTurn": 2,
        "review": {
          "enabled": true,
          "after": "19:10"
        }
      }
    }
  }
}
```

- 費率、上限都由設定檔管理，不寫死在程式；滑價、匯差第二階段。
- `startingCash` 只在帳戶第一次建立時使用；不能中途改動已存在的帳戶。
- 設定錯誤在啟動時大聲失敗，不要默默套預設值。
- 控制台的「設定」分頁可編輯這些值；現有 `updateConfig` 只收白名單欄位，trade 欄位要加進白名單與 `normalizeDiscordConfig`。
- 費率用嚴格驗證，錯誤就拋；不要用 `clamp` 默默套預設值。
- 建單時把當下費率存進該筆 order；改設定不影響已建立的訂單，不需要 reload 才能讓新舊費率一致。
- 第一版只使用台股相關欄位；`fx`、`settlement.usCheckMinutes`、`bot.market` 的 US／alternate、`snapshots` 第二階段才啟用。
- `settlement.twSettleAfter` 預設 19:00：19:00 前不結算，避免收盤價、法人與晚報還沒齊就先成交。
- `bot.review` 是收盤後復盤：預設 19:10，一次決策後會等法人資料，19:40 後仍缺就照跑並標查不到。

### 6.5 MCP 與 preset 整合

- 新增 `src/mcp-trade.js`，serverName `trade`。
- `scripts/setup-dsh.mjs` 的 `DISCORD_MCP_IDS` 加 `mcp-trade`。
- `dc-session-token.mjs`：`TOKEN_TOOLS` regex 加 `trade`；`mcp-trade.js` 每個工具都要宣告 `token`。
- `dc-tool-restrict.mjs`：新增 `trade: 'player' | 'bot' | 'none'`。
  - `dc-chat`：`trade: 'player'`，放行 `get_quote`、`place_order`、`get_portfolio`、`get_leaderboard`、`get_bot_portfolio`。
  - `dc-trader`：`trade: 'bot'`，放行 `get_quote`、`get_bot_portfolio`、`bot_place_order`，以及 web search／fetch；不放行 Discord 發送。
  - `dc-learner`：`trade: 'none'`，全部不放行。
  - 註冊期用 `ctx.tools.restrict` 藏掉不該看到的工具；guard 再擋一次。
- 新增 `dc-trader` preset（人格、工具面、`dc-session-token`、`dc-tool-restrict`）。
- 一次性 Bot 會話用 `dc-trader`；不需要 per-key preset override。
- `discord-agent.resolve` 要接受 `bot:` key；一次性會話暫時登記到 `sessions`／`reverse`，回合結束移除並歸檔。
- 每次 Bot 決策建立 `activeRun`（sessionId、runId、market）；`bot_place_order` 驗證 `sessionId === activeRun.sessionId`，不是目前 active run 就拒絕。
- `mcp-trade.js` 的每個工具都要宣告 `token`，否則 MCP SDK 會把外掛補的值剝掉。
- 更新 MCP 設定後依現有流程重啟 DSH（`setup:discord` → `pm2 stop dc-bridge` → `pm2 restart dsh` → `pm2 start dc-bridge`）。

---

## 7. 下單權限與基本限制

### 7.1 誰可以下單？

只有本回合明確觸發 Bot 的玩家可以下單。

- `place_order` 使用觸發訊息編號，但 Bridge 不能只信這個編號。
- 身分由 session token → 目前 `key` → `turnUsers` 決定。
- `message` 必須在 `turnDirectMessages` 裡，作者要等於 `turnUsers` 的那個人。
- `turnUsers` 超過 1 人時，`message` 必須指向其中一位的 direct 訊息；指向不到或指向兩人就拒絕。
- `direct === false`（自由參與）、回訪、`/ask`、重連補建 → 一律拒絕。
- 模型提供的名稱只作輔助，不作帳戶身分依據。
- Bot 只能走 `bot_place_order`，不能使用玩家的 `place_order`。

### 7.2 什麼情況才算下單？

必須具有明確的：

- 買入或賣出意圖
- 股票標的
- 股數或金額

例如「幫我買 10 股台積電」可以下單。

「台積電會不會漲？」不能下單。

「幫我買 10 股」若上一句剛查同一檔，可以承接那個標的，但回覆要寫明標的；不明確就先問。

下單訊息必須是 ★（direct）。補句沒有 ★ 時，只能先問，不能直接下單；若要把補句算進同一筆，Bridge 要把它加進 `turnDirectMessages`。

資訊不足時，先詢問玩家。模型不得自行補一個沒出現過的代號。

### 7.3 交易限制

第一版：

- 不允許現金餘額變成負數；買單先保留現金。
- 不允許賣出超過可用持股；賣單先保留股票。
- 單筆買入金額不得超過帳戶淨值的 30%。
- 交易數量必須為正整數，拒絕 0、負數、NaN、Infinity。
- 只允許在市場開放時排隊。
- 只允許商品主檔內、`tradable: true` 的標的。
- 漲停不給買、跌停不給賣；特殊交易狀態先拒絕。
- 單筆上限是硬性限制，不另外設計超限確認流程。

### 7.4 重複下單與併發

- 一回合最多 1 筆成功排隊訂單。
- 玩家用 `UNIQUE(account_id, source_message_id)`：一則觸發訊息最多一筆單；Bot 用 `request_id = 'run:<runId>'`。
- `orders.request_id` 加 UNIQUE；同一筆重送回傳原訂單，不再次建立。
- 同一帳戶的交易用 SQLite transaction 與 per-account mutex 依序處理。
- 兩個請求同時到達時，先搶到 transaction 的贏；另一個重讀餘額後再判斷。
- 寫入失敗時不得回報成功；transaction rollback。

### 7.5 Bot 的限制

- `bot_place_order` 只在 Bot 排程回合可用。
- 每個排程回合最多 1 筆。
- 每日最多 `maxTurnsPerDay` 次決策、`maxTradesPerDay` 筆訂單。
- 超過 token 上限就停止。
- Bot 的下單參數也要過同一套 symbol、現金、30%、市場狀態檢查。
- Bot 不能把玩家的訊息當成下單依據；它的 prompt 只含自己的持倉、報價與新聞。

---

## 8. 儲存與交易紀錄

第一版交易域使用 SQLite。其他 Bridge 狀態（會話、記憶、筆記、回訪）維持原本的 JSON 檔。

### 8.1 為什麼用 SQLite

- 一筆交易要同時改現金、持倉、訂單、現金流水；SQLite 一個 transaction 就能保證全成或全敗。
- `pending` 訂單、保留現金、收盤結算、Bot 交易、`/forget` 都是跨表操作。
- `request_id` 的 UNIQUE 約束直接做重複下單防護。
- 控制台查詢帳戶、訂單、流水比讀大 JSON 簡單。
- Node 26 內建 `node:sqlite`，不需要新增 native dependency。

注意：Node 26.12 只有 `DatabaseSync`；26.13 起多了 `Database`，`DatabaseSync` 變成 deprecated 別名。程式用 `sqlite.Database ?? sqlite.DatabaseSync`，兩版都能跑。若之後要完全避開變動中的 API，再評估 `better-sqlite3`，但要處理原生模組部署。

### 8.2 資料庫

檔案：`state/discord-trade.sqlite`（權限 0600）。

啟動設定：

- `PRAGMA journal_mode = WAL`
- `PRAGMA busy_timeout = 5000`
- `PRAGMA foreign_keys = ON`

主要資料表：

```sql
accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- player / bot
  cash_cents INTEGER NOT NULL,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  starting_cash_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

positions (
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  qty INTEGER NOT NULL,
  reserved_qty INTEGER NOT NULL DEFAULT 0,
  cost_basis_cents INTEGER NOT NULL,  -- 總成本，顯示時再除以股數
  PRIMARY KEY (account_id, symbol)
);

orders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,  -- 玩家 msg:<messageId>；Bot run:<runId>
  account_id TEXT NOT NULL,
  actor TEXT NOT NULL,             -- player / bot
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty INTEGER,                     -- amount 買單在結算時才寫入
  amount_cents INTEGER,
  currency TEXT NOT NULL,          -- 原幣
  trade_date TEXT NOT NULL,        -- 市場當地日期，驗證收盤日
  guild_id TEXT,
  channel_id TEXT,
  source_message_id TEXT,          -- 玩家下單的觸發訊息；Bot 為 NULL
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  reserved_qty INTEGER NOT NULL DEFAULT 0,
  fee_rate_ppm INTEGER NOT NULL DEFAULT 0,
  tax_rate_ppm INTEGER NOT NULL DEFAULT 0,
  min_fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,            -- pending / filled / rejected
  created_at TEXT NOT NULL,
  settled_at TEXT,
  fill_price_cents INTEGER,        -- 原幣最小單位
  gross_cents INTEGER,
  fee_cents INTEGER,
  tax_cents INTEGER,
  fx_rate_micro INTEGER,
  fx_spread_cents INTEGER,
  net_cents INTEGER,               -- TWD 最小單位
  quote_source TEXT,
  quote_as_of TEXT,
  reason TEXT,
  reject_reason TEXT,
  note TEXT
);

cash_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  order_id TEXT,
  kind TEXT NOT NULL,              -- buy / sell / fee / tax / fx / dividend / adjust
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

snapshots (
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  market TEXT NOT NULL,
  nav_cents INTEGER NOT NULL,
  as_of TEXT NOT NULL,
  fx_rate_micro INTEGER,
  PRIMARY KEY (account_id, date, market)
);

account_guilds (
  account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (account_id, guild_id)
);

bot_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'decision',  -- decision / review
  started_at TEXT NOT NULL,
  ended_at TEXT,
  market TEXT,
  status TEXT,                    -- decision: hold/pending/error；review: ok/error
  tokens INTEGER DEFAULT 0,
  reason TEXT
);

daily_reviews (
  date TEXT PRIMARY KEY,          -- 交易日 YYYY-MM-DD
  created_at TEXT NOT NULL,
  summary TEXT NOT NULL,          -- 隔天決策會引用，最多顯示 1500 字
  tokens INTEGER NOT NULL DEFAULT 0
);
```

- 金額全部用整數最小單位；匯率用整數 micro 值，避免浮點誤差。
- `reserved_cents`／`reserved_qty` 是 pending 訂單的保留量；成交或拒絕後歸零。
- 玩家訂單用 `UNIQUE(account_id, source_message_id)` 防重複；Bot 用 `request_id = 'run:<runId>'`。
- `orders` 的狀態會從 `pending` 變成 `filled`／`rejected`；`cash_ledger` 只追加。
- `fill_price_cents` 用原幣最小單位；`net_cents` 用 TWD 最小單位。
- `snapshots` 第二階段才寫入；PK 含 `market`，避免台股與美股同一天撞鍵。第一版不寫。
- `bot_runs` 記每次 Bot 決策；重啟後用它算每日次數，控制台也從這裡讀最近決策。

### 8.3 寫入順序與失敗處理

**排隊（買入）**

1. `BEGIN IMMEDIATE`
2. 讀帳戶與持倉，檢查可用現金、30% 上限、標的狀態。
3. 插入 `orders (status='pending')`。
4. `accounts.reserved_cents += 保留金額`。
5. `COMMIT`。

**排隊（賣出）**

1. `BEGIN IMMEDIATE`
2. 檢查 `qty - reserved_qty` 足夠。
3. 插入 order。
4. `positions.reserved_qty += qty`。
5. `COMMIT`。

**結算**

1. `BEGIN IMMEDIATE`
2. 讀 pending order，重新確認價格與市場狀態。
3. 更新 `accounts.cash_cents`、`reserved_cents`、`positions.qty`、`cost_basis_cents`、`reserved_qty`。
4. 寫 `cash_ledger`。
5. 更新 `orders.status`、成交價、費用、稅、匯率（第二階段）。
6. `COMMIT`。

- 任何一步失敗就 `ROLLBACK`，回傳錯誤，不修改帳戶。
- 寫入成功後才回報成功。
- 程序重啟後，pending 訂單仍在；結算 job 從資料庫重新讀取，不靠記憶體。
- 超過一個交易日仍無法結算的訂單，轉 `rejected`，釋放保留量，記錄 log 並通知玩家。

### 8.4 備份與異常

- 每日結算後備份：`VACUUM INTO 'state/backups/discord-trade-YYYYMMDD.sqlite'`，保留 7 份。
- 資料庫無法開啟或損毀：暫停交易，不要自動重建空 DB；保留原檔並通知管理員。
- 讀取失敗時：控制台顯示錯誤，玩家查詢回「系統維護中」，不假裝有資料。
- 交易紀錄與帳戶狀態以 SQLite 為唯一真相；不再另寫 JSONL 訂單檔。

### 8.5 `/forget`

`/forget` 要在同一個 transaction 刪除該使用者的：

- `accounts`
- `positions`
- `orders`
- `cash_ledger`
- `snapshots`
- `account_guilds`

Bot 帳戶不在刪除範圍。若日後需要保留稽核紀錄，改成匿名化（把 user id 換成不可逆雜湊），不要同時刪一半。

MVP 接受「刪除後重開帳戶」；若要比賽公平，排行榜可加「帳戶建立滿 N 天」門檻，或把重置留給管理員。

---

## 9. 排行榜

### 9.1 基本規則

- 以帳戶總報酬率排序。
- 不以現金或單純獲利金額排序。
- 只顯示目前伺服器的成員。用 `account_guilds` 記錄玩家在哪些伺服器下過單，排行榜只查這些成員；必要時再 `guild.members.fetch` 取名稱，不要抓整個大型伺服器。
- 使用伺服器暱稱。
- 最多顯示前 10 名。
- Bot 標示 `🤖`；第一版固定與玩家同榜，不另外做「AI 對手」分區。
- 同分時依淨值、再依建立時間排序。

帳戶跨伺服器共用，因此玩家在其他伺服器進行的交易也會影響同一個帳戶的排名。

### 9.2 估值時間

第一版區分：

**參考排行榜**

使用最新可用收盤價計算，允許不同市場存在估值時間差；每一列顯示 `asOf`。

**每日結算資料（第二階段）**

每個市場收盤結算後寫入 `snapshots`，包含淨值、估值時間與匯率。第一版不寫；正式賽季排名第二階段再指定統一結算時間。

第一版不需要完整走勢圖。

### 9.3 排行榜公平性

- 不允許玩家自行輸入價格、資產或損益。
- 不設計複雜反作弊評分。
- Bot 與玩家使用同一套起始資金、費用與上限。
- 若日後加入賽季與重置，再補充規則。

---

## 10. Discord 操作與控制台

### 10.1 斜線指令

`/portfolio`

查詢自己的帳戶，預設使用僅本人可見的回覆。內容包含現金、保留現金、持股、損益、淨值、報酬率與最近訂單。

`/forget`

依現有隱私刪除流程處理玩家資料；模擬帳戶、持倉、訂單、現金流水與快照也納入刪除範圍。交易稽核紀錄是否匿名化，依資料保留政策決定。

### 10.2 控制台

控制台已經有分頁（`public/discord-console.html`），新增一個「股盤」分頁；交易設定放在既有「設定」分頁。

**股盤分頁（唯讀）**

- 帳戶清單：玩家／Bot、現金、保留現金、淨值、報酬率
- 持股明細：symbol、股數、平均成本、市值、未實現損益
- 訂單：pending／filled／rejected、時間、symbol、side、qty、成交價、費用、稅、actor
- 報價來源狀態：來源、最後成功時間、延遲、錯誤
- Bot 狀態：最近決策、最近交易、token 使用量、下次檢查時間
- 排行榜（即時估值；snapshots 第二階段）

**設定分頁**

- 功能總開關
- allowedGuilds／allowedChannels
- 起始資金、台股費率、稅率、單筆上限；滑價、匯差第二階段
- Bot 開關、公告頻道、preset、market、每日次數、token 上限、新聞搜尋／抓取上限

**限制**

- 不在股盤分頁做下單、改餘額、改持倉。
- 持股與餘額可在 Discord 公開（A）。這是遊戲資料，不是真實資產；`/portfolio` 仍是私下查看的選項，控制台也看得到。
- 控制台 API 需要 token；沿用現有授權。

新增 API：

- `GET /api/trade/overview`
- `GET /api/trade/accounts`
- `GET /api/trade/orders`
- `GET /api/trade/quotes`
- `GET /api/trade/bot`

設定走現有 `/api/config`。

### 10.3 現有專案整合

沿用專案既有慣例：

- `dc-tool-restrict` 放行工具，依 preset 分開。
- `setup-dsh --discord` 掛載 MCP。
- persona 加入交易意圖判斷規則。
- 每輪工具呼叫上限：`place_order` 1 次、查價 3 次、持股 1 次、排行榜 1 次。
- 工具進度訊息：`describeToolCall` 要認得新工具，顯示「查價中」「下單中」而不是原始工具名。
- 敏感資訊保護：報價 API key 只放在 Bridge 設定，不進 prompt、不進工具參數。
- 更新 MCP 設定後依現有流程重啟 DSH。

### 10.4 部署

改到 MCP／preset 時：

1. `npm run setup:discord`
2. `pm2 stop dc-bridge`
3. `pm2 restart dsh`
4. `sleep 5`
5. `pm2 start dc-bridge`
6. 用暫時 stdio client 確認 `get_quote`、`place_order`、`get_portfolio`、`get_leaderboard`、`get_bot_portfolio`、`bot_place_order` 都註冊。
7. 確認 `dc-chat` 看得到玩家工具、看不到 `bot_place_order`；`dc-trader` 看得到 Bot 工具與 web search。

---

## 11. 功能分期

### MVP：精簡版可遊玩的第一版

> MVP（Minimum Viable Product）在這裡指「第一個可上線、可玩的版本」，不是最終完整版；下面 12 項是上線門檻。美股、匯率、金額下單、snapshots、滑價不在這個門檻內。

1. 台股盤後查價（最近收盤價、`asOf`、市場狀態）。
2. 台股商品主檔與名稱解析。
3. 玩家帳戶、pending 訂單、收盤結算。
4. 台股手續費、證交稅、tick size、漲跌停。
5. 持股查詢、已實現／未實現損益、淨值、報酬率。
6. 伺服器排行榜（含 Bot 標示）。
7. SQLite 交易域、現金流水。
8. Bot 交易員：台股、模型判斷、讀新聞、token 上限、結算後公告、19:10 當日復盤。
9. 控制台「股盤」分頁與交易設定。
10. `/portfolio`、`/forget`。
11. Discord Bridge／MCP／preset 整合。
12. 交易紀錄與異常處理。

### 第二階段：完整版（原全量 MVP）

- 美股與匯率（Finnhub、匯差、跨時區結算）
- 金額下單
- 每日 snapshots
- 滑價

### 第二階段：交易體驗擴充

- 限價單
- 取消委託
- 掛單管理
- 日、週、月報酬統計
- 資產走勢圖
- 股票分割、減資、除權息自動處理
- 帳戶重置
- 更複雜的 Bot 策略（多標的、停利停損、跟隨玩家？先不做）

公司行動需要特別注意：在尚未支援相關調整前，若遇到股票分割、合併、減資或重大價格調整，應停止該標的交易與估值，並人工調整持倉；不要讓持倉憑空縮水。

### 第三階段：社群玩法

- 賽季排行榜
- 歷史紀錄
- 自選股
- 到價提醒
- 投資成就
- 其他群組競賽功能

是否加入放空、融資等功能，依玩家需求再決定。

---

## 12. 驗收標準

第一版以實際操作結果驗收，不以程式碼行數或額外架構完整度為標準。

| 測試 | 預期結果 |
|---|---|
| 查詢台積電 | 顯示正確標的、最近收盤價、`asOf`、市場狀態；不假裝即時 |
| 買入 10 股 | 建立 pending、保留現金、持倉尚未增加 |
| 結算時現金不足 | 拒絕，釋放保留，不讓餘額變負 |
| 收盤結算 | 現金、持倉、費用、稅、淨額正確；訂單變 filled |
| 19:00 前結算 | 不成交；等 19:00 後資料到齊才結算 |
| 當日復盤 | 19:10 後跑一次；有收盤價、法人、重大訊息與新聞摘要；不下單 |
| 隔天決策 | 09:00 後第一次決策會帶入前一天的復盤摘要 |
| 現金不足 | 拒絕，不建立訂單，不改帳戶 |
| 賣出超額 | 拒絕，不保留股票 |
| 市場休市 | 休市日可下預約單，排到下一個交易日；13:30–14:50 不收單 |
| 預約單 | 14:50 後下的單 `trade_date` 是下一個交易日，當天晚上不結算 |
| 漲停買入 | 拒絕 |
| 跌停賣出 | 拒絕 |
| 報價／收盤資料過期 | 不結算；保留或拒絕，不用舊價 |
| 同筆請求重送 | 回傳同一筆 pending／filled，不重複下單 |
| 多個觸發者 | `message` 指向其中一位才可下單；指向不到或兩人就拒絕 |
| 自由參與／回訪／`/ask` | 不得下單 |
| 他人要求代下單 | 不得修改他人帳戶 |
| 股價上漲 | 淨值與未實現損益正確增加 |
| 重新啟動 Bridge | pending 訂單保留，DB 與現金流水一致 |
| SQLite 寫入失敗 | rollback，不回報成功 |
| 排行榜 | 依報酬率正確排序，Bot 有標示 |
| Bot 排程 | 只在市場開放時啟動，每日上限正確 |
| Bot 讀新聞 | 有搜尋上限；搜尋失敗不影響下單判斷 |
| Bot 超時／工具參數無效 | 不交易，記 log |
| Bot 重啟 | 不重複下單，不補做 |
| Bot 帳戶隔離 | 玩家不能改 Bot 帳戶，Bot 不能改玩家帳戶 |
| `/forget` | 刪除該玩家交易資料；Bot 帳戶不動 |
| 控制台股盤 | 看得到帳戶、持股、訂單、報價狀態；不能下單 |
| 控制台設定 | 交易參數可保存；已建立訂單不受影響 |

### 第二階段驗收（原全量 MVP）

| 測試 | 預期結果 |
|---|---|
| 以金額買入 | 保留指定金額；收盤後換算股數；不足 1 股拒絕 |
| 美股交易 | 匯率、成本、費用正確換算 |
| 每日 snapshots | 每個市場結算後寫入，PK 不撞鍵 |
| 滑價 | 設定值生效；tick 對齊方向正確 |

---

## 13. 開發前需要確認的事項

以下事項會影響實際交易結果，應在施工前確認。

### A. 盤後資料來源

- TWSE／TPEx OpenAPI 的實際更新時間，是否穩定早於結算排程。
- （第二階段）Finnhub 免費方案在收盤後 `/quote` 的行為、限額與條款。
- （第二階段）匯率來源與每日更新時間。
- 若資料延遲，結算排程要往後移，不能硬抓舊資料。

### B. 台股即時報價（本版不採用）

若未來要改成 B 模式，先確認：

- 證交所即時／延遲資訊授權。
- Fugle 免費或付費方案的轉發條款。
- FinMind 的方案與轉散布限制。
- Discord 多人使用是否算「傳送予第三人」。

### C. 滑價與換匯價差（第二階段）

第一版固定滑價 0、無換匯；第二階段再決定：

- 台股滑價
- 美股滑價
- 買入／賣出匯差
- 最低手續費

建議從簡單設定開始，不模擬真實市場深度。

### D. 商品範圍

- 台股上市／上櫃各哪些標的。
- （第二階段）美股哪些標的。
- ETF、處置股票、變更交易、全額交割是否全部排除。
- 新上市無漲跌幅期間的處理。

### E. 公司行動

- 第一版是否完全不自動處理股利、分割、減資。
- 遇到事件時要停止交易與估值，還是自動調整。
- 若停止，持倉要用哪個價格凍結、誰來人工調整。

### F. Bot 設定

- 每日決策次數與交易次數。
- 每次 output token 與每日 token 上限。
- 新聞搜尋與抓取次數上限。
- Bot 是否納入玩家排行榜前 10 名。
- 公告頻道；第一版 Bot 只做 TW，US／alternate 第二階段。

---

## 14. 開發原則

本企劃不要求後端建立真實券商等級的交易系統。

開發時優先遵守：

1. **先求正確：** 現金、持倉、費用、稅（匯率第二階段）不能算錯；寧可慢，不要錯。
2. **規則明確：** 交易與資產計算由程式負責，不交給模型自由判斷。
3. **少做預防性設計：** 不為尚未出現的需求建立複雜架構。
4. **必要保護：** 保留身分驗證、資金檢查、重複請求防護與資料一致性。
5. **方便維護：** 參數集中設定，交易計算邏輯獨立且容易測試。
6. **循序擴充：** 第一版不需要一次完成全部股票市場規則。
7. **單一真相：** 交易域以 SQLite 為準；不要同時維護 JSON 與 DB 兩份帳。
8. **模型只做意圖：** 模型不決定成交價、不計算費用、不直接改資料。

**完成標準：玩家可以理解操作、系統能正確處理排隊與結算、開發者能依文件自行驗證結果。**

---

## 15. 預計要改的檔案

1. 文件：本檔、`docs/guides/DISCORD.md`、`docs/FOLDER_MAP.md`、`docs/README.md`、`config.example.json`。
2. 新增：
   - `src/mcp-trade.js`
   - `src/core/discord-trade.mjs`
   - `src/core/discord-trade-db.mjs`
   - `src/core/quote-provider.mjs`
   - `src/core/institutional-provider.mjs`
   - `src/core/material-provider.mjs`
   - `src/core/bot-trader.mjs`
   - `plugins/dc-agent-presets/presets/dc-trader.patch.yml`（由 preset build 流程產生）
3. 修改：
   - `package.json`：`engines` 提到 Node >=26；確認本機與伺服器版本。
   - `src/discord-bridge.js`：`/trade-*` 端點、身分閘門、結算排程、Bot 一次性會話與排程、控制台 handlers。
   - `plugins/dc-agent-presets/dc-tool-restrict.mjs`：trade／bot／web 工具白名單與計數。
   - `plugins/dc-agent-presets/dc-session-token.mjs`：`TOKEN_TOOLS` 加 `trade`。
   - `src/core/discord-agent.mjs`：一次性 Bot 會話的 token resolve。
   - `src/core/discord-console.mjs`：`/api/trade/*` 路由。
   - `src/core/discord-core.mjs`：`normalizeDiscordConfig` 加 `trade`。
   - `src/core/discord-usage.mjs`：Bot usage 歸屬。
   - `scripts/setup-dsh.mjs`：`mcp-trade` 與 `dc-trader`。
   - `scripts/build-agent-preset-patches.mjs`：`DISCORD_PRESETS` 加 `dc-trader`。
   - `public/discord-console.html`：股盤分頁與設定欄位。
   - `dsh/agent-presets/dc-trader/{preset.yml,agent.cordis.yml}`：`dc-trader` 來源。
   - `dsh/agent-presets/dc-chat/`：persona 加交易規則。
4. 測試：
   - `scripts/test-discord-trade.mjs`（新）
   - `scripts/test-discord-trade-db.mjs`（新）
   - `scripts/test-discord-bot-trader.mjs`（新；`test-discord-all.mjs` 只跑 `test-discord-*.mjs`）
   - `scripts/test-discord-institutional.mjs`（新；法人日報解析）
   - `scripts/test-discord-material.mjs`（新；重大訊息解析）
   - `scripts/test-discord-bridge.mjs`（端點、身分、設定）
   - `scripts/test-mcp-servers-stdio.mjs`（工具註冊）
   - `scripts/test-console-ui.mjs`（股盤分頁）
   - `scripts/test-agent-preset-patches.mjs`（preset 清單）

> 第二階段（美股、金額下單、snapshots、滑價）的測試等第二階段再做；第一版不納入驗收。
