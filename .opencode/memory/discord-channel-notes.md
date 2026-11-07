---
name: discord-channel-notes
description: 頻道筆記（discord-notes）與頻道標籤（style）兩套記憶的收斂與資料處理
---

頻道有兩套記憶：頻道筆記（`src/core/discord-notes.mjs`，`state/discord-notes.json`）與頻道標籤／風格（`kind: 'style'`，`src/core/discord-slang.mjs` 管的 `state/discord-slang.json`）。

- 頻道筆記：`note_event` 記「群裡發生的事」＋`search_notes`／`forget_note` 查刪；每日 04:00 自動摘要（`by: 'summary'`），每條有 TTL（預設 30 天、摘要 7 天），`notes.enabled` 開就直接注入。控制台有 `/api/notes` 與 `/api/notes/delete`。
- 注入上限：`injectMax: 5` 條、`maxChars: 600` 字；同一會話 30 分鐘內不重複帶入；`summaryTried` 在記憶體，重啟後同一天可能再試。
- 摘要 token 計入 `internal:頻道摘要`，控制台「花費」可見，不算入頻道用量。
- 頻道標籤：學習會話抽候選 + 模型用 `mcp__slang__record_channel_tag` 收錄，管理員在控制台確認才注入；無 TTL，每頻道最多 5 條（候選與已確認合計，已拒絕不算）、300 字。滿了學習與 `record_channel_tag` 都不再收，回 409，要換先在控制台刪一條。
- 線上觀察：`note_event` 從未被模型用過（全部 `by: 'summary'`）；已確認標籤 115 條、`seen` 全為 1，一次性事件被存成永久標籤。
- 收斂方向：抽取 prompt 只收不隨話題變的穩定習慣（回覆長短、語氣、常用語尾、表情貼圖、互動節奏），一次性的話題或事件不算（由頻道筆記每日摘要記）；`recordChannelTag` 對已存在的標籤原樣回傳、不復活 rejected，滿額回 `{full:true,max}`。
- 清理線上資料要用控制台刪除，不能用「拒絕」（拒絕的標籤會在 `styleLabels` 留 30 天當範例）；`slangStore` 在記憶體，直接改檔下次存檔會覆蓋，需先 `pm2 stop dc-bridge` 或走控制台。
- `pruneSlang` 在每次存檔跑。

相關：[[discord-slang-mcp]]。