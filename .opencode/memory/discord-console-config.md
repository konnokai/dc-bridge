---
name: discord-console-config
description: 控制台功能設定的 API 白名單、立即生效與 config.json 寫回規則
---

- 控制台欄位只是前端；`updateConfig` 必須在伺服器端逐欄白名單，再交給 `normalizeDiscordConfig` 驗證。不要整區展開接收，否則拿到控制台 token 的人可改到危險欄位。
- 不開放從控制台改 `tts.baseUrl`（可造成 SSRF）、`videoLinks.ytDlpPath`（可執行任意程式）、`emoji.dir`（會影響檔案刪除路徑）、`slang.learnerPreset`（會改 preset）；這些只從 `config.json` 設定。
- 功能設定區塊與純量只在該次 patch 有送出時才寫回 `config.json`。否則 `/blacklist`、`/mention` 等共用更新流程會把整份 normalize 後的預設值寫進檔案，蓋掉原始設定。
- 設定寫檔先用暫存檔，再 rename；先刪同名舊暫存檔，確保新檔套用 `0600`，寫入或 rename 失敗時清掉暫存檔。先寫檔成功，再更新記憶體狀態。
- `reactions.probability` 是小數，必須用不做 `Math.round` 的 `clampFloat`；整數用的 `clamp` 會把 `0.15` 變成 `0`，令自動 reaction 永遠不觸發。
- 修正程式不會修復已寫入設定檔的 `0`；2026-11-13 測試伺服器曾因此失去自動 reaction，已手動恢復為 `0.15`。
- 數字輸入留空時不要送 patch：`Number('')` 會得到 `0`，而表單使用 `novalidate`。控制台也應略過非有限數值。
- 批次器設定若要在運行中更新，必須以 getter 讀取目前 `cfg.discord.batch`，不能只在啟動時複製數值。現有批次的 timer 不會因設定儲存而自動重排；後續批次操作才讀到新值。

相關：[[discord-console-settings]]、[[discord-deploy]]。
