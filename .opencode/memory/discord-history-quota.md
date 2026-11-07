---
name: discord-history-quota
description: read_history／search_history 每回合合計最多 3 次的配額與長距查詢限制
---

`read_history` 與 `search_history` 共用每回合 3 次配額（`HISTORY_PER_TURN_LIMIT = 3`，`src/core/discord-agent.mjs`）。

- 第 4 次回 429。
- `search_history` 每次掃 300 則（3 頁）。
- persona 規則：長距懶人包類請求（例如「昨天晚上八點到現在」）要拒絕或限制在 1–2 次搜尋，避免卡住其他對話。
- 兩個工具都支援 `date` 參數（`YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`，bridge 主機時區，`parseHistoryDate` 在 `src/core/discord-context.mjs`）；`date` 與 `before` 互斥。`date` 轉成 snowflake（`SnowflakeUtil.generate`，時間夾到 Discord epoch 以上）當起點。`read_history` 有 `date` 時往前（舊→新）讀；沒有時往回讀。`search_history` 有 `date` 時從該時間起掃。
- `date` 在未來直接回「還沒有訊息」；無效日期回 400。

相關：[[discord-skip-marker]]、[[discord-mention-names]]。