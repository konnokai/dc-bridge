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
- 覆蓋含 Discord 控制台「回訪排程」卡片與取消按鈕、固定欄寬、375px 不溢出；沒有 Playwright 時手機寬度溢出**未驗證**，只驗桌面。
- 2026-11-08 觀察到 `npm run test:console-ui` 有兩支 FAIL：「All submitted payloads exactly match the pre-redesign console baseline」與「Token usage trend chart renders bars, tiers and range/metric switching（切到 7 天後桶寬變成 6 小時）」。未確認是否與當次改動相關；部署前應再跑一次確認。

相關：[[codex-imagegen-internals]]、[[opencode-local-inspection]]（同一套亂碼處理）、[[discord-media-handling]]。
