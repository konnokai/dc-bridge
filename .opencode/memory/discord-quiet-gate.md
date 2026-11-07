---
name: discord-quiet-gate
description: 安靜期間用 /send 閘門擋下 send_message/send_sticker/create_poll，reaction 與 send_image 檔案仍可送
---

安靜時原本只擋非 ★ 批次，模型仍會回文字。改成在 `/send` 閘門層處理：

- `quietSendBlocked`（`src/core/discord-quiet.mjs`）：安靜期間 `send_message`、`send_sticker`、
  `create_poll` 被擋；`send_image` 帶檔案仍可送；reaction 允許。
- `send_message`／`send_sticker`／`create_poll` 全部走同一道門。
- `NO_TOOL_REMINDER` 在安靜時不排。
- prompt 改成「安靜時只按 reaction」。
- `edit_message` 目前**不受**安靜 gate 影響（刻意保留，觀察一週）。
- B2 安靜狀態（`set_quiet`）詳見 [[discord-agent-extras]]。

相關：[[discord-blacklist-stale]]、[[discord-message-preview]]。