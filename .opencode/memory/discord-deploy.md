---
name: discord-deploy
description: 部署到 Discord 測試伺服器的腳本行為、已知誤判風險與回退
---

- 腳本：`scripts/deploy-discord.mjs`，順序固定，任何一步失敗就停；本機與遠端測試、SHA256 比對、健康檢查後才寫 `state/deploy.json`。
- 只部署 HEAD：dry run 可在 dirty tree 跑（印警告），真正部署會 fail；`--files` 部分部署不更新 marker。
- `package.json`／`package-lock.json` 有改就停，先到伺服器跑 `npm install` 再重新部署。
- DSH 重啟範圍：掃 `src/mcp-*.js` 遞迴 import，加上 `dsh/agent-presets/`、`plugins/`、`scripts/setup-dsh.mjs`；其他只重啟 `dc-bridge`，只改文件不重啟。
- 已知誤判風險（不會誤報成功）：等待 8 秒後檢查 `已登入：`，Discord 登入超時就 false-fail；`pm2 jlist` 前若有提示訊息會讓 `JSON.parse` 失敗。升級時改成輪詢最多 ~30 秒。
- 部署前工作目錄必須乾淨；dream 程序可能在 commit 後修改 `.opencode/memory/`，需要另外包 memory commit 再部署（2026-11-07 實例）。
- `test-discord-bridge.mjs` 曾在部署套件執行時失敗、單獨重跑通過（原因未查），當成偶發；部署腳本會停在該步，可重跑部署（2026-11-07）。
- 回退：備份 `~/dc-bridge-backups/deploy-<時間>.tgz` 含被刪檔案；失敗時腳本印備份路徑與對應 pm2 指令；DSH 路徑回退要重跑 `setup:discord`。

相關：[[discord-prts-mcp]]。