---
name: discord-bridge-layering
description: Discord bridge 的 core factory 分層、結構檢查與拆模組時的架構決策
---

- 2026-11-20 完成 `discord-bridge.js` 分層後，入口負責 client／store／狀態建立、`createXxx(deps)` 接線、Gateway 註冊、啟動與 shutdown；功能邏輯放 `src/core/`。入口接線本身不必再拆，除非能增加實際測試價值。新功能慣例見 `docs/guides/FEATURE_LAYERING.md`。
- `scripts/test-discord-bridge-structure.mjs` 隨 `npm run test:discord` 執行。七類檢查涵蓋入口接線的 let／TDZ、core import、範圍未解析名稱、死 import、import/export 連結，以及 factory deps 簽名是否都有接線 key。接線 parser 要認得 shorthand、`key: value` 與多行值開頭（如 `files: {`）；曾漏掉 `withTimeout`，令供應商目錄和設定儲存都失效，但錯誤被 catch 吞掉。2026-11-20 訊息入口搬移時，review 又抓到 `enqueuePrompt` TDZ、三個漏 import 和 `emojiCatalogs` 快照；結構測試以故意破壞接線與 import 驗證能抓到這些類別。
- 使用 `espree`／`eslint-scope` 做範圍檢查時，`espree.parse` 要設 `range: true`；eslint-scope 9.x 缺少 range 會丟 TypeError。
- `createConsoleLayer` 因內含 `await startConsole()` 必須是 async factory，入口也要 await。它在 login 後才初始化；啟動空窗的 token 轉發回傳空字串，`updateConfig` 轉發 null-safe。此空窗很短，但其中的 `updateConfig` 呼叫會靜默無操作。
- 搬移大區塊時用錨點腳本，不靠固定行號或手抄；避開巢狀 `return {`，並先刪原區間再插別名。搬完逐行比對來源，只放行明確登記的 getter／接線變更，並跑 `node --check`、結構檢查和完整 Discord suite。語法檢查與測試全綠仍曾漏掉執行期 deps 未接線，細節見 [[discord-bridge-turns]]。
- `docs/guides/FEATURE_LAYERING.md` 是新功能分層規範，專案 `AGENTS.md` 要求實作前先讀。邏輯放進 `src/core/` 的 `createXxx(deps)`，入口只接線。
- 2026-11-20 拆 `discord-bridge.js` 的顧問結論：檔案大不是唯一問題，主要結構障礙是約 8,000 行都在同一個 `main()` closure；純粹搬檔不會自動增加可測性。依耦合拆成 10 組比硬湊 8 組合理：runtime-state、stores、output、dsh-sessions、turns、agent-tools、background、trade-runtime、inbound、console-handlers。
- 拆分模組只由入口匯入，模組間不互相 import；依賴用注入。`turns` 保留事件流、訊息投遞與提問審批等同一回合狀態機，不要為了切檔把高頻雙向呼叫改成 callback。
- 工廠只建立狀態與接線，不啟動 timer、不 follow session、不註冊 Gateway event。入口建好 client、api、所有模組與 hooks 後，再統一啟動；這樣可用 fake client/api 測接線，但 Gateway 與真實 DSH 事件仍需整合驗證。
- 只有唯一寫入者擁有可重綁定的 `let`；其他模組透過 getter 讀。`updateConfig` 會替換多個 `cfg.discord.*` 子物件，因此 deps 傳 `cfg` 根物件，使用時重新讀子路徑，不能在 factory 建立時解構舊參照。不能重綁定的 `const` 物件可直接傳參照。
- `retireSession` 是跨模組清理中心。拆分時將 per-key/session 狀態集中由 `runtime-state.forgetKey()`／`forgetSession()` 清除；副作用交給 `onRetire` hook。epoch 必須先遞增再 `turnGate.rebase`，`onRetired` 必須在刪除 session 對映後呼叫。
- 晚綁定 callback 用入口持有的 hooks 物件接線，所有 hook 完成後再 freeze；不要把 callback 放進會離線排隊或被 `mergeJobs` 合併的 job meta。初始化與 queue 合併影響是設計風險，需用測試確認。
- 2026-11-20 `0500978` 提交 runtime-state、stores 與 turns 初拆；`d6fe960` 再提交訊息入口搬移與結構檢查。後者通過結構檢查及 `npm run test:discord`（37/37），當時只在本機分支、未 push；整體模組拆分仍未完成。
- runtime-state 目前有 48 個 Map／Set：`KEY_SCOPED` 40、`SESSION_SCOPED` 5、`SURVIVES_RESET` 1、`OWNED_ELSEWHERE` 2。語音冷卻必須在 `/reset` 後保留（無工具提醒的 10 分鐘冷卻已於 2026-11-22 移除）；`voiceJobs` 和 `ttftTimers` 由副作用清理。分類測試要用獨立的預期清單，並驗證分類無遺漏、無重複，以及 reset 行為。
- `pending` 留在入口，因為清除時要取消 timer 並回覆 DSH；`turnSentTexts` 則納入 per-key 清理。背景 prompt 收尾共用 `runtime.forgetSession()`，避免再維護另一份 session 狀態清單。
- 2026-11-20 `createDirtyStore` 統一記憶、筆記、知識、梗圖與開發回饋的延遲存檔。存檔失敗保留 dirty 狀態；`warningLabel` 與 `label` 分開以保留原本不同的 log 標籤。梗圖需立即寫索引時呼叫 `markDirty()` 再 `flush()`；這會留下已 unref 的延遲 timer，存檔失敗時也會再嘗試一次。
- 尚待確認的風險：`archive` 當時只在啟動時依 `historyArchive.enabled` 建立；`updateConfig` 換設定後可能不會重建。此行為未驗證，也可能是刻意要求重啟。

相關：[[discord-agent-tools-structure]]、[[discord-bridge-turns]]、[[dc-bridge-tests]]。
