---
name: discord-agent-tools-structure
description: agent-tools 拆分決策、子 factory 依賴檢查與讀取／交易層邊界
---

- 2026-11-20 採用「只拆讀取層與交易層」的方向，不把所有 handler 拆成獨立模組。讀取層集中 history/search/recall/view/user/server/stats；交易層集中 quote/symbols/order/portfolio/leaderboard 與 Bot 交易。檔案留在 `src/core/` 扁平結構，命名為 `discord-bridge-agent-read.mjs`、`discord-bridge-agent-trade.mjs`。
- `discord-bridge-agent-tools.mjs` 保留共用送出骨架與 `createAgentTools` 組裝；入口接線不變。多數 handler 是薄轉接，全部拆開不會增加測試價值，卻會放大 deps 漏接風險。`src/core/` 的結構檢查只掃一層，放子資料夾會漏掉 C／D／F 檢查。
- 拆子 factory 前先擴大結構檢查 G：用 AST 檢查 bridge 模組內所有 `createXxx({...})` 呼叫，對照 factory 的 deps 簽名；物件 shorthand 也要認得，並用故意漏 key 的 fixture 驗證檢查會失敗。舊 G 只看入口接線，抓不到 `createAgentTools` 內部的子 factory 漏接。測試入口 `scripts/test-discord-all.mjs` 會自動跑 `scripts/test-discord-*.mjs`。
- 讀取與交易模組可以共用無狀態 helper 的直接 export；不要為方便建一個塞滿 deps 的 context 物件。子 factory 仍由 `createAgentTools` 組裝，避免 deps 經入口來回轉接。拆分時一併刪除未使用的 `imageKnowledge`、`agentHandlers` 回傳值。
- 2026-11-20 完成拆分後，`discord-bridge-agent-tools.mjs` 留共用骨架與組裝，讀取／交易 handler 分別在 `discord-bridge-agent-read.mjs`、`discord-bridge-agent-trade.mjs`。共用無狀態文字 helper（`flat`、`textArg`、`authorName`、`withStickers`、`embedPreview`、`stickerLabel`）集中在 `discord-context.mjs`，各模組直接 import；`stickerLabel` 從 `discord-media.mjs` 移出，避免 context 與 media 形成循環依賴。
- `mergeHandlers` 以 `Object.hasOwn` 偵測重複工具名並丟錯；`scripts/test-discord-agent-tools.mjs` 應測名稱衝突與讀取／交易 handler 的簡單接線行為。結構檢查 G 已支援 `createXxx(deps)` 在函式本體解構的 deps，也能展開預設參數並略過 rest property；spread 與非物件參數仍無法靜態核對。
- 安靜閘門不是可直接合併的重複碼：`send`、`sendVoice`、`sendVoiceFile`、`prtsArtwork` 用 `quietSendBlocked`，部分送檔情境有例外；`poll` 則直接檢查 `quietAt`。先分別確認語意與測試，不要因重構改變行為。
- 抽取程式碼時，AST 節點的 `range` 不含前置註解、逗號和縮排；直接拼接屬性或宣告曾產生語法錯誤。若用一次性切割腳本，需明確保留註解與分隔符，並立即對產物跑 `node --check`。
- 此次要求連同已發現項目處理：檔頭對晚宣告依賴「一律走 getter」的說法不準確，函式依賴應使用轉發箭頭；`FEATURE_LAYERING.md` 當時列出 2,466 行，但檔案實測為 2,578 行（2026-11-20，數字可能隨後續修改過期）。

相關：[[dc-bridge-tests]]、[[discord-agent-gaps-plan]]、[[graphify-query]]。
