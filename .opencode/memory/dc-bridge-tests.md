---
name: dc-bridge-tests
description: 這個 repo 的測試套件怎麼跑，PowerShell 下怎麼拿到可讀的結果，以及 preset patch 何時要重生
---

`npm run test:discord` = `scripts/test-discord-all.mjs`，用 glob 依序跑所有
`scripts/test-discord-*.mjs`（每支 180 秒上限），最後印 `Discord suite: N/M scripts passed.`，
失敗的另外印 `FAILED <檔名>`，exit code 1。

最大的單檔 `scripts/test-discord-bridge.mjs` 自己印 `✅ Discord 橋接離線回歸通過`
或 `❌ N 項失敗`。

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

相關：[[codex-imagegen-internals]]、[[opencode-local-inspection]]（同一套亂碼處理）
