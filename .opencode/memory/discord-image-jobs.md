---
name: discord-image-jobs
description: 背景生圖工作追蹤、取消語意、GIF 拒絕與已知缺口
---

橋接的 `generate_image` 實際由 Codex `image_gen` 在背景跑，橋接端用
`src/core/discord-image-jobs.mjs` 追蹤工作（start/poll/done/cancel/stale sweep）。

## 取消語意

- `mcp__discord__cancel_image` 刪掉該頻道所有還在跑／排隊中的工作（`cancelImageJobs`）。
- 外掛下一次 poll 回 `cancel:true`，Codex 中止；取消後才送的 `done` 回 404，不排進會話、不記畫圖歸屬。
- 取消後 `sweepStaleImageJobs` 回空，不會送假的失敗通知。
- 已知缺口：`src/discord-bridge.js:1954` 的 `cancelImage` 仍是行內寫法，只有核心函式測試，沒有端點測試。

## GIF

- Codex 不支援 `image_generation_animation` 時，`animated:true` 在 spawn 前就拒絕，不回報 start。
- 靜態生圖的 `extraArgs` 不含 `--enable`；GIF 才加 `--enable image_generation_animation`。
- `plugins/dc-agent-presets/dc-draw-image.mjs` 用 `spawnSync` 問 GIF feature（最多卡 10 秒，失敗會快取）；
  只看 `result.file` 判斷是否 GIF（0.168 實際輸出格式未確認，屬推測）。

## 測試

- `scripts/test-discord-bridge.mjs`、`scripts/test-discord-image-jobs.mjs`。

相關：[[codex-imagegen-internals]]。