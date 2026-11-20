# 功能落點：core factory 與入口接線

> 規範。新功能照「之後的新功能」段走。後面是 2026-11-20 拆解
> `src/discord-bridge.js` 的交接記錄，用來查模組位置、搬運地雷與部署方式。

## 之後的新功能：寫進 core，入口只接線

這輪拆完後，入口的形狀已經固定：**新功能邏輯直接寫進 `src/core/` 的 factory
（`createXxx(deps)`），入口只留 deps 接線。**

### 為什麼

1. **可測性。** 入口閉包裡的函式只能靠讀原始碼字串比對來「測」；core 模組的 deps
   是注入的，可以離線跑行為測試。這是整輪重構的動機。
2. **結構檢查從第一天就罩著。** 七項檢查都建立在「模組有明確 deps 簽名」上。
   新功能直接寫進 core，接錯會在 `npm run test:discord` 就紅；寫在入口閉包裡，
   只能等執行期炸。
3. **事後搬運的成本很高。** 這輪五輪 review 抓了 15 個「測試全綠但上線必炸」的
   問題。一開始就寫對位置，就沒有搬運這一步。

### 兩個但書

- **接線層本身不要拆。** 入口剩下的約 1900 行（client 建立、deps 組裝、Gateway
  註冊、啟動順序、shutdown）是組裝清單。拆出去只會多一層轉發，沒有測試價值。
- **邊界照主題切。** 這輪的切法是依耦合（usage、trade、console、background……），
  不是把所有東西塞一個模組。依賴晚宣告或會重新賦值的，照下面選接法。

### deps 接線的型別規則

| 情況 | 接法 | 原因 |
| --- | --- | --- |
| 函式在 factory 之後才宣告 | 轉發箭頭 `fn: (...args) => fn(...args)` | getter `getFn: () => fn` 的呼叫端要寫兩層括號；少一層會拿回函式本體，工作沒做、測試也全綠 |
| 值會重新賦值，或值在 factory 之後才宣告 | getter `getX: () => x`，模組端寫 `getX()` | 直接傳會拿到當下快照，控制台改設定後不生效 |
| 其他 | 直接傳 | |

### 一句話

功能進 core、接線留入口、照這份的固定做法走。

## 這輪拆解的目標

把 `src/discord-bridge.js`（原 8554 行、`main()` 一個閉包包住 8016 行）拆成模組，讓原本只能靠「讀原始碼字串比對」才測得到的功能變成可注入依賴、可寫行為測試。

## 完成狀態（2026-11-20）

**拆完了。** 入口 8554 → 1912 行，11 個模組共 7489 行。入口現在是接線層：
client 建立、基礎 store／狀態、每層 factory 的 deps 接線、Gateway 註冊、
啟動與 shutdown。

- 分支：`refactor/split-discord-bridge`（本機，**沒有 push**）
- 測試：`npm run test:discord` → **37/37 scripts passed**
- `node scripts/test-discord-bridge-structure.mjs` 七項全綠

## 模組清單（都在 `src/core/`）

| 檔案 | 行數 | 內容 |
| --- | --- | --- |
| `discord-bridge-runtime-state.mjs` | 93 | per-key 執行期狀態 |
| `discord-bridge-stores.mjs` | 50 | 五個 store 的去抖存檔 |
| `discord-bridge-turns.mjs` | 1380 | 回合層：提問審批、事件流、訊息入口、TTFT |
| `discord-bridge-usage.mjs` | 113 | Token 帳本、回合紀錄、三個 provider 額度 |
| `discord-bridge-dsh-sessions.mjs` | 348 | preset 檢查、ensureSession、退役、交接摘要 |
| `discord-bridge-output.mjs` | 86 | 會話改名、頻道解析、分條發送 |
| `discord-bridge-agent-tools.mjs` | 2466 | agentHandlers／apiHandlers、createAgentSender、生圖工作 |
| `discord-bridge-background.mjs` | 881 | 黑話學習、小刻食堂、回訪、每日摘要、側寫、後台提問 |
| `discord-bridge-trade.mjs` | 459 | 模擬股票：服務、結算、Bot 交易員、applyTradeConfig |
| `discord-bridge-inbound.mjs` | 607 | 訊息、reaction、typing、slash 命令的准入分派 |
| `discord-bridge-console.mjs` | 1006 | 控制台 HTTP API、供應商（hedge）設定、updateConfig；**factory 是 async**（段內有 await startConsole） |

這輪的 commit（全部本機）：

e956426 結構檢查補齊宣告掃描、twitter 測試合併讀法 →
569b5a9 usage 層 → 235e396 DSH 會話層 → bdb258b 送出層 →
c560101 agentTools 層 → b8d4040 修 review#1（4 blocker）→
ffdfa2e background 層 → d6e1847 修 review#2（6 blocker）→
c278f17 AGENTS.md 教訓 → 948cb78 trade 層 → c88ea8d 修 review#3（minor）→
6bb9faa inbound 層 → 8cb3339 修 review#4（minor）→
01cb421 console 層 → 4ac315e 修 review#5（1 blocker＋3 minor）

## 五輪 review 的統計

每輪 review 都真的抓到過測試全綠但執行期會炸的問題，共 15 個：
getter 呼叫少一層括號（getEnsureSession 讓正常投遞全壞）、
import 來源錯／漏（truncateText、fs／path）、alias 洗掉
（KNOWLEDGE_BODY_MAX_CHARS 讓入口載入不了）、入口殘留讀寫
（9 個名字）、簽名有但接線漏（withTimeout 讓供應商頁全壞）。
**教訓都已進 AGENTS.md Lessons 或結構檢查的自動項。**

## 結構檢查七項（`scripts/test-discord-bridge-structure.mjs`）

- A/B：接線不用入口 let、接線名字宣告在 factory 呼叫前（TDZ）
- C：core export 用了要 import
- D：**範圍分析**（espree＋eslint-scope）——模組與入口的未解析名字都要是 0
- E：入口死 import 歸零
- F：import 的名字目標模組真的有 export（連結檢查）
- G：**factory 簽名解構的 deps，接線都要給**（`withTimeout` 漏接那次的防護）

devDependencies 加了 `espree`＋`eslint-scope`。D 項要 `espree.parse(..., { range: true })`
——沒有 range 時 eslint-scope 9.x 會內部炸 TypeError。

## 每一步的固定做法（如果之後還要動）

1. 邊界用括號深度算，不要正則找 `});`。
2. 腳本切，不手抄；**錨點版腳本**（找 `// ── 區塊名` 行）比死行號穩。
3. 逐字比對 `git show HEAD~1` 的原區間；登記改動（getter、dedent）列白名單。
4. `node scripts/test-discord-bridge-structure.mjs`（七項）。
5. `npm run test:discord`（37 個）。
6. `subagent` 指定 `agent: "opus"` 送 review；測試全綠不代表能跑。

## 搬運地雷（全踩過，全有防護）

- 晚宣告的函式依賴用**轉發箭頭** `fn: (...args) => fn(...args)`，不要 getter
  ——getter 呼叫端要兩層括號，寫錯會靜靜拿回函式本體。
- 清 import 的腳本要保留 alias 原文（`A as B` 的 as 後段會被 `split(/\s+as\s+/).pop()` 洗掉）。
- 入口 let 搬進模組後，控制台顯示／shutdown 的殘留讀寫要改成走模組出口。
- 切分腳本的 splice **嚴格由後往前**；先跑賦值類再跑 splice 會讓行號位移。
- 段內有頂層 await 時 factory 要 async，入口接線要 await（console 層的案例）；
  async factory 前後有事件空窗，轉發要 null-safe。
- factory 簽名加 deps 後**記得同步入口接線**——簽名有、接線漏，只有結構檢查 G 項會紅。

## 部署

照 `AGENTS.md`：`node scripts/deploy-discord.mjs`。這輪沒碰 `src/mcp-*.js` 與
`plugins/**`，只需 `pm2 restart dc-bridge`；devDependencies 新增會讓伺服器
`npm ci` 多裝 espree／eslint-scope，無害。回退用 `--sha <上一個 commit>`。

五輪 review 全部過了（最後一輪 4ac315e 修完）；`ffdfa2e`（background 層）
是先 commit 後補修的——歷史教訓，之後的層都是先 review 修完才收。
