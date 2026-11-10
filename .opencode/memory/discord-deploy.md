---
name: discord-deploy
description: 部署到 Discord 測試伺服器的腳本行為、已知誤判風險與回退
---

- 腳本：`scripts/deploy-discord.mjs`，順序固定，任何一步失敗就停；本機與遠端測試、SHA256 比對、健康檢查後才寫 `state/deploy.json`。
- 只部署 HEAD：dry run 可在 dirty tree 跑（印警告），真正部署會 fail；`--files` 部分部署不更新 marker。
- `package.json`／`package-lock.json` 有改就停，先到伺服器跑 `npm install` 再重新部署。
- DSH 重啟範圍：掃 `src/mcp-*.js` 遞迴 import，加上 `dsh/agent-presets/`、`plugins/`、`scripts/setup-dsh.mjs`；其他只重啟 `dc-bridge`，只改文件不重啟。
- 已知誤判風險（不會誤報成功）：等待 8 秒後檢查 `已登入：`，Discord 登入超時就 false-fail；`pm2 jlist` 前若有提示訊息會讓 `JSON.parse` 失敗。升級時改成輪詢最多 ~30 秒。
- 部署前工作目錄乾淨檢查排除 `.opencode/memory` 與 `.agents`（pathspec `-- . ':(exclude).opencode/memory' ':(exclude).agents'`）；dream 背景改記憶檔不再擋部署。只部署 commit 過的內容，程式碼未 commit 改動仍擋（2026-11-07）。
- `test-discord-bridge.mjs` 曾在部署套件執行時失敗、單獨重跑通過（原因未查），當成偶發；部署腳本會停在該步，可重跑部署（2026-11-07）。
- 本機 SSH 的 `~/.ssh/known_hosts` 若缺 `192.168.98.21`，部署會掛在 `Host key verification failed`（2026-11-09）。
  已加 ed25519 指紋 `SHA256:Wf+35HkgELN7SBQs/SKRNzV8qJ9+JPshfJQPOevOfJU`，與伺服器 `/etc/ssh/ssh_host_ed25519_key.pub` 一致；
  不想要這筆就刪掉那一行。
- 回退：備份 `~/dc-bridge-backups/deploy-<時間>.tgz` 含被刪檔案；失敗時腳本印備份路徑與對應 pm2 指令；DSH 路徑回退要重跑 `setup:discord`。
- 改了 persona／preset 不用 `/reload-system-prompt`：DSH 重啟後會把新的 system prompt 帶進已經開著的會話（2026-11-10 實測）。部署時 DSH 重啟即生效。

相關：[[discord-prts-mcp]]。