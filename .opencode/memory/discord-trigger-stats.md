---
name: discord-trigger-stats
description: 對話觸發統計：計數規則、console 分頁、bot 查詢與 /forget
---

觸發統計只算成功送出的 `send_message`／`send_sticker`／`create_poll`，每回合一次。

- ★（有人叫 bot）的回合只計 ★ 使用者；否則計批次內所有發言者。
- 儲存：`src/core/discord-trigger-stats.mjs`；console 有「對話」分頁（`/api/triggers`）；`/api/status` 保留前 3 名。
- Bot 工具 `conversation_stats` 回傳全域總數，但只顯示同伺服器的名字（跨伺服器隱私）。
- `/forget` 可刪除自己的觸發統計。
- 生圖也計入觸發統計：`noteDraw()` 在 `deliver` 有 `file` 時呼叫 `recordDraws()`，`discord-trigger-stats.mjs` 記 `drawCount`／`totalDraws`；`conversation_stats` 輸出「畫圖 N 次」與每人 `（畫圖 N 次）`。
- Codex 額度不足時暫停生圖：`CODEX_DRAW_MIN_FIVE_HOUR_PERCENT = 15`、`CODEX_DRAW_MIN_WEEKLY_PERCENT = 5`（`src/core/discord-codex-quota.mjs`）；額度快照寫 `state/discord-codex-quota.json`。`drawQuotaBlock()` 對未來 timestamp 視為無效（避免時間往回跳時舊禁止狀態多撐），排隊期間真正開 Codex 前再查一次額度。
- MCP `/send` 送出統計抽到 `src/core/discord-send-handler.mjs`：純文字只加對話；同一輪送圖只加一次對話、畫圖加次數；送出失敗不記。
- 已部署；統計仍正常（36 人／142 次）。

相關：[[discord-blacklist-stale]]、[[discord-image-jobs]]。