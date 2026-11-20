---
name: discord-deploy
description: 部署到 Discord 測試伺服器的腳本行為、已知誤判風險與回退
---

- `scripts/deploy-discord.mjs` 只部署已推送的 HEAD；依序檢查工作目錄與遠端 tracked 檔案、checkout、測試、setup（需要時）、重啟與健康檢查，任何一步失敗就停。
- 遠端一律跑 `npm ci`，再檢查 tracked 檔案沒有變動；即使 `--skip-tests` 也會安裝依賴。這避免測試因新增套件而 `ERR_MODULE_NOT_FOUND`，也避免 `npm install` 改寫 lockfile。
- 健康檢查成功後才寫 `state/.deployed-sha`。若遠端 HEAD 已是目標 SHA，或 marker 與目前 HEAD 不同，會走修復流程並重跑必要 setup、重啟與健康檢查；這可避免上次部署中斷後只看新 commit 的差異而漏重啟。
- `package.json`／`package-lock.json` 有變更也要重啟 `dc-bridge`，避免程序繼續載入舊依賴。DSH 重啟範圍：掃 `src/mcp-*.js` 與 `plugins/**/*.mjs` 的相對 import 遞迴圖；加上 `dsh/agent-presets/`、`plugins/`、`scripts/setup-dsh.mjs`。只改 plugin 引入的本地模組也會觸發 `setup:discord` 與 DSH 重啟；其他變更只重啟 `dc-bridge`，純文件不重啟。
- 自 2026-11-12 起，本機工作目錄檢查也排除 `docs/`：文件不在伺服器執行，未提交文件不應擋部署。但腳本只部署 HEAD 的 tracked 檔案，未提交文件不會跟著部署。
- 2026-11-13 的 `dfe7935` 部署完成本機與遠端測試；健康檢查確認 `dc-bridge`、`dsh` online，且新 log 有 Discord 登入訊息。這不代表 TTS 語音投遞已做端到端驗證。
- 2026-11-17 測試伺服器部署 `0aa8375` 已於 2026-11-18 被 `346642e` 取代；當時的回退目標 `928dc69` 也已過時。
- 2026-11-18 測試伺服器部署 `346642e` 通過 `deploy-discord.mjs` 健康檢查，`dc-bridge`、`dsh` online，且新 log 有 Discord 登入訊息；已由 2026-11-19 的 `abb35c0` 取代。
- 2026-11-19 `node scripts/deploy-discord.mjs` 部署 `abb35c0` 成功；已由 2026-11-20 部署取代。
- 2026-11-20 `node scripts/deploy-discord.mjs` 部署 `660c027` 成功；後由 `2a2ff7f` 取代。
- 2026-11-20 部署 `2a2ff7f` 成功：本機與遠端 preset patch、Discord 測試通過，只重啟 `dc-bridge`，健康檢查確認程序 online 且新 log 有 Discord 登入訊息。沒有實際發送 Discord 訊息驗證投遞。
- 2026-11-18 發現 deploy 輸出可能帶出控制台 token 明文；不要把含 token 的部署輸出貼到公開位置。token 值不記錄；這個既有行為未在當次修正。
- 2026-11-17 `deploy-discord.mjs` 輸出精簡改動已提交並推送為 `c1e431e`：本機測試成功時隱藏輸出，失敗時最多印末 120 行；遠端成功測試不輸出，失敗時印步驟標籤與末 30 行；遠端錯誤不再回印整段腳本。當日已跑 `node --check scripts/deploy-discord.mjs` 和 `--dry-run`，沒有實際部署。`--skip-tests` 分支仍會印 skip 警告，未驗證。
- 2026-11-13 遠端 `npm install` 曾回報 7 個 audit vulnerability（5 moderate、1 high、1 critical）；沒有檢查套件明細，屬當日觀察，不代表目前仍有相同數量。
- 部署前工作目錄乾淨檢查排除 `.opencode/memory` 與 `.agents`（pathspec `-- . ':(exclude).opencode/memory' ':(exclude).agents'`）；dream 背景改記憶檔不再擋部署。只部署 commit 過的內容，程式碼未 commit 改動仍擋（2026-11-07）。
- 2026-11-20 收集部署輸出時，將重導向檔放在 repo 外（例如 `$env:TEMP`）；放在 repo 內會新增未追蹤檔，讓乾淨工作目錄檢查失敗。
- 本機 SSH 的 `~/.ssh/known_hosts` 若缺 `192.168.98.21`，部署會掛在 `Host key verification failed`（2026-11-09）。
  已加 ed25519 指紋 `SHA256:Wf+35HkgELN7SBQs/SKRNzV8qJ9+JPshfJQPOevOfJU`，與伺服器 `/etc/ssh/ssh_host_ed25519_key.pub` 一致；
  不想要這筆就刪掉那一行。
- 2026-11-19 部署新增追蹤路徑時，遠端未追蹤的同名目錄 `deploy/` 會讓 `git checkout` 因檔案覆蓋衝突而失敗。先用 `git status --short` 確認，再把衝突目錄移到 repo 外暫存；不要用 `git clean`。部署並驗證後再清理暫存。
- 2026-11-19 首次啟用 Alloy 的 `state/discord-turns.jsonl` 來源時，先建立檔案再重建 Alloy：`install -m 600 /dev/null state/discord-turns.jsonl`。日誌確認 Alloy 開始 tail 後，等 bridge 寫入自然紀錄，再查 Loki；不要偽造正式回合資料。
- 已取代（2026-11-13）：舊版的 `state/deploy.json`、`npm install` 與部分部署流程不適用目前腳本；部署以 `state/.deployed-sha` 和 `npm ci` 為準。

相關：[[discord-prts-mcp]]、[[discord-console-config]]。
