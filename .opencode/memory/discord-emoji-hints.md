---
name: discord-emoji-hints
description: prompt 表情提示的多樣性輪替與打錯表情名稱的候選回覆
---

- `buildEmojiHint`（`src/core/discord-emoji.mjs`）在本服提示中列使用次數前 5 名，再從本服其餘目錄按 emoji id 排序、依本地日期每天輪替 3 個；冷門池包含從未使用的表情。跨服仍列前 4 名，私聊路徑不變。
- 固定按 id 輪替，不按使用次數排序：使用次數會變，會令同一天候選順序跳動。提示內容每日變更時，`onceInSession` 會在同一會話重送。
- `deliverReaction` 找不到自訂表情名稱時，會附 `retrieveEmojis` 算出的最多 5 個候選；`search_emojis` 的工具描述鼓勵想換不同表情或預覽表情時再查，避免要求每次都多呼叫工具。
- 2026-11-17 測試機主伺服器有 137 個目錄表情、48 個曾被群友使用；前 8 名佔 2,934 次使用中的 84.8%。這項量測促成候選輪替，兩週後可重看占比驗證效果。
- 測試在 `scripts/test-discord-bridge.mjs`；改表情提示時同時更新 `docs/guides/DISCORD.md`，並跑該測試。

相關：[[discord-emoji-catalog]]、[[discord-auto-reactions]]。
