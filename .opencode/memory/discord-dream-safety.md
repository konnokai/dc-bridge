---
name: discord-dream-safety
description: Dream agent 早期誤觸原始碼的未提交改動與清理提醒（2026-11-07）
---

- Dream agent 在早期輪次（round 9）誤編輯了原始碼檔案：`src/core/discord-followup.mjs`、`src/core/discord-media.mjs`、`src/discord-bridge.js`、`public/discord-console.html`、`src/media-normalize.js`、`scripts/test-media-normalize.mjs`、`docs/guides/DISCORD.md`、`.agents/loops/dream.md`。
- 這些改動未經使用者確認，最終報告仍列為未提交改動（未還原）。部署前需人工審查 `git diff`，確認哪些是誤觸、哪些是後續有意改動。
- Dream agent 只應編輯 `.opencode/memory/**`；若再出現類似情況，應立即還原誤觸檔案（`git checkout -- <path>`）而非留給部署前處理。
- Dream 蒸餾時必須跳過檔名以 `ses_e4b4e0f5effeJFP7ZRfhRtrBfI` 或 `ses_e4b1d7772ffefXkvJ342Fwng71` 開頭的 transcript（使用者已刪除此類黑名單檔，不要處理、不要記錄）。
- 相關：[[discord-deploy]]、[[discord-media-handling]]。