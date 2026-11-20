---
name: dc-bridge-tests
description: 這個 repo 的測試套件怎麼跑，PowerShell 下怎麼拿到可讀的結果，以及 preset patch 何時要重生
---

`npm run test:discord` = `scripts/test-discord-all.mjs`，用 glob 依序跑所有
`scripts/test-discord-*.mjs`（每支 180 秒上限），最後印 `Discord suite: N/M scripts passed.`，
失敗的另外印 `FAILED <檔名>`，exit code 1。

最大的單檔 `scripts/test-discord-bridge.mjs` 自己印 `✅ Discord 橋接離線回歸通過`
或 `❌ N 項失敗`。

媒體測試檔已改名 `scripts/test-discord-media-normalize.mjs`（原 `test-media-normalize.mjs`），
部署腳本在本機與遠端都會跑它。

## 拿結果的方式（2026-11 實測）

PowerShell 直接看 stdout 會亂碼（CP950 解），`Select-String` 過濾也一樣。
可靠的作法只有一個：先重定向到檔案，再用 Read／Grep 工具看。

```powershell
cmd /c "node scripts/test-discord-bridge.mjs > test-out.txt 2>&1"; "exit=$LASTEXITCODE"
```

- 用 Grep 找 `^❌` 與 `GIF|animated`，用 Read 看尾段。
- `Get-Content test-out.txt` 會被 guard 擋（非 ASCII 檔）。
- 成敗只看 `exit=` 和 `❌` 行數，不要讀被解壞的中文。
- 跑完刪掉 `test-out.txt`／`test-all-out.txt`，那是不追蹤的暫存檔。

## preset patch

改 `dsh/agent-presets/<preset>/agent.cordis.yml` 之後一定要
`node scripts/build-agent-preset-patches.mjs`，再用 `--check` 確認產物沒漂移。
`scripts/deploy-discord.mjs` 本機與遠端都會跑 `--check`，沒同步就部署失敗。

## 控制台 UI 測試（2026-11）

- `npm run test:console-ui` = `scripts/test-console-ui.mjs`，用 Playwright + Chromium；**缺任一就直接中止**，不會自動改用本機 Chrome/Edge。要跑先裝：`npm install --no-save playwright` + `npx playwright install chromium`，或設 `PLAYWRIGHT_MODULE` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。
- OpenChamber 這台沒有本機 Chrome/Playwright，`npm run test:console-ui` 會直接中止，不算失敗。目視檢查改用 `openchamber_web`（`browser.open`／`snapshot`／`click`／`close`）開 `http://127.0.0.1:...`；要先起臨時 server（照 `test-console-ui.mjs` 的 `startConsole({ host, port, token, htmlPath, handlers })` 寫法，handlers 必須包含頁面會打的每個 `/api/*`，缺一個就 500）。不要用 obscura：它會擋私有 IP，`127.0.0.1` 和區網都開不了。
- 覆蓋含 Discord 控制台「回訪排程」卡片與取消按鈕、固定欄寬、375px 不溢出。2026-11-18 加入 360px 設定頁回歸：刻意放大 select／time 欄位，檢查頁面不溢出、欄位不超卡片、checkbox 不被壓扁；同日另在 iPhone Chrome 實機驗證。版面細節見 [[discord-console-mobile-layout]]。
- `test-console-ui.mjs` 會精確檢查功能設定欄位總數；新增欄位時要同步更新該數字。2026-11-17 的總數由 52 更新為 55；改預期值後的後續測試結果見下。
- 2026-11-08 曾有兩支 FAIL：「All submitted payloads exactly match the pre-redesign console baseline」與「Token usage trend chart renders bars, tiers and range/metric switching（切到 7 天後桶寬變成 6 小時）」。這是歷史紀錄；2026-11-17 重跑時趨勢圖失敗未再出現，但 baseline payload 失敗仍在。是否與當次改動相關仍未確認。

### Vite + Vue 控制台（2026-11-20）

- `test-console-static.mjs` 和 `test-console-ui.mjs` 都保留：前者不需瀏覽器，驗來源碼契約與打包產物指紋；後者用 Playwright 測實際打包頁面的互動與版面。兩者不互相取代。
- `node scripts/build-console.mjs --check` 用原始碼指紋確認產物同步，避免逐位元組比對受 CRLF 影響。`.gitattributes` 也固定 `console/**` 和 `public/discord-console.html` 為 LF。
- Vue 遷移後，UI 測試只連 `startConsole()` mock；不連正式 Discord、DSH 或 `state/`。2026-11-20 驗證為 UI 16/16、static 全通過。

### Bridge 拆模組時的原始碼斷言（2026-11-20）

- `scripts/test-discord-bridge.mjs` 的來源碼斷言要同時讀 `src/discord-bridge.js` 與 `src/core/discord-bridge-*.mjs`；否則搬檔會讓斷言失去覆蓋。
- 錨點不存在時要直接丟錯。`indexOf()` 回傳 `-1` 後再 `slice()` 會得到空字串，否定式 `!includes()` 可能因此靜默通過。依賴先後順序的斷言應先抓指定函式本體，再在本體內比對。
- 2026-11-20 加上合併來源、錨點與函式本體擷取後，`node --check src/discord-bridge.js` 通過，`npm run test:discord` 為 36/36；這是當日拆分前兩步的結果。分層與接線檢查見 [[discord-bridge-layering]]。
- 2026-11-20 runtime-state 測試應用固定期望清單比對分類，並實際塞入資料後呼叫 `forgetKey()`／`forgetSession()`；不要只用分類清單本身產生測試資料與檢查項目，否則改錯分類仍會全綠。冷卻狀態也要驗證 reset 後保留。
- 提問／審批與 TTFT 可用 fake `api`、fake `sendLong` 測實際 payload、取消與逾時，不需連 Discord/DSH。測試 `sessions` 要用物件，因事件程式以 `sessions[key]` 讀取；傳 `Map` 會讓超時取消路徑失效。
- 2026-11-20 提問／審批與 TTFT 行為測試完成後，`npm run test:discord` 為 36/36。這是當日結果快照；模組範圍見 [[discord-bridge-turns]]。
- 事件流測試要送 `turn/start` 與 `turn/end`，不能只送未知事件走 default 分支；驗證 `releaseNormal` 收到投遞時的 ticket、回合紀錄有寫入、`lastFrameAt` 更新，並確認斷線清理。2026-11-20 訊息入口搬移後的 suite 為 36/36；當時 review 尚未完成，見 [[discord-bridge-turns]]。
- 若來源碼斷言檢查的邏輯已搬到 factory 模組，測試要合併讀入口與 `src/core/discord-bridge-*.mjs`。2026-11-20 的 `test-discord-participation.mjs` 原本只讀入口，因而 12 項整合斷言失敗；改成讀合併來源後通過。

## 移除舊功能測試時（2026-11-17）

- 依測試實際 import 的程式與覆蓋範圍判斷是否專屬舊功能，不要只看檔名或測試字串。QQ 清理曾誤刪 Discord 仍共用的 `test-audit-protocol.mjs`、`test-audit-security-mcp.mjs`、`test-media-search.mjs`；複查後恢復並納入 `test-audit.mjs`。
- `test-audit-protocol.mjs` 測 `src/dsh-client.js` 的共享連線安全與協定：launch token 僅允許送往本機、並行 401 共用 auth exchange、`commands/execute` 參數、session retire inbox projection、follow 失敗重試。
- `test-audit-security-mcp.mjs` 有 Discord `mcp-web-search-safe` callback 的安全測試；`test-media-search.mjs` 測 Discord 的共用 `src/web-search.js`。模組仍有 Discord caller 時，保留或搬成 Discord 命名的測試並放回套件。
- 2026-11-17 驗證：`test-audit.mjs` 18/18、`test-discord-all.mjs` 32/32、preset patch 測試通過；`test-console-ui.mjs` 36/37，仍有「All submitted payloads exactly match the pre-redesign console baseline」失敗。這次沒有證據確認該 UI 失敗是否與改動相關。
- 2026-11-17 hedge 額度雙卡改動後，`npm run test:discord` 為 32/32；`npm run test:console-ui` 為 35/37、exit 1。當次輸出未保留失敗項目名稱，無法判定是否由該改動造成；同日 OpenChamber 已目視確認主線與備援額度卡都顯示。

相關：[[codex-imagegen-internals]]、[[opencode-local-inspection]]（同一套亂碼處理）、[[discord-media-handling]]、[[discord-open-politics-preset]]、[[discord-console-mobile-layout]]。
