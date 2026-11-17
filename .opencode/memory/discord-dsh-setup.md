---
name: discord-dsh-setup
description: setup-dsh 的共用 profile 副作用與舊 bundle 清理安全界線
---

- `scripts/setup-dsh.mjs` 會清理舊 QQ MCP／bundle 設定；若同一個 DSH profile 仍供舊 QQ bridge 使用，重跑 setup 會移除那些註冊。
- 清理 `~/.dsh/plugins/<舊 bundle>` 與 profile 的 `node_modules` 時，只刪 symbolic link／junction。遇到實體目錄要警告並保留，不能遞迴刪除。
- `node scripts/test-discord-prts.mjs` 覆蓋舊 bundle 連結清理，並確認連結目標的實體檔案仍存在。

相關：[[discord-deploy]]、[[discord-upstream-sync]]。
