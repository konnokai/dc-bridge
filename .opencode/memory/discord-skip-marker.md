---
name: discord-skip-marker
description: `\//` 標記讓橋接整則忽略某則訊息；實作與 bot 訊息例外
---

在訊息開頭打 `\//`（畫面顯示 `//`），橋接整則跳過：不送模型、不進上下文、不算觸發統計、不學黑話、不加表情、不執行指令、不能當提問答案。

- 實作：`src/core/discord-core.mjs` 的 `isSkippedMessage(content, botUserId)` = strip bot mention → trim → NFKC normalize → `/^\\?\/\//`。
- 接受 `\//`、`//`、全形 `＼／／`、`@bot \//…`；`\o/`、`\(^o^)/`、句中 `//`、`http://`、`/reset` 不會觸發。
- `handleMessage` 最早 return；context fetch、引用、`read_history`、`search_history`、`view` 也過濾。
- **bot 自己的訊息不套規則**（避免模型忘記自己講過 `//` 開頭的話）；其他 bot 的 `//` 訊息也會進 context（小差異）。
- 已知缺口：轉發一則 `//` 訊息時原文仍從 `messageSnapshots` 進模型；20 則以上連續 `//` 時 `read_history` 回「沒有更早的訊息了」；context 實際帶入的訊息會少於 `context.messages`。
- 已部署並在 log 確認「跳過 …（// 標記）」。

相關：[[discord-blacklist-stale]]。