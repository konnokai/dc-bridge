---
name: discord-auto-reactions
description: 橋接自動 reaction 的觸發、限制與開關
---

`maybeReact()` 是橋接收到訊息時執行的自動行為，和模型呼叫 `add_reaction` 是兩條不同路徑。符合條件的伺服器文字訊息會依表情關鍵字分數、機率、頻道冷卻與全域每小時上限決定是否按；安靜時、`/` 或 `!` 開頭、含圖片或敏感 embed 的訊息會跳過。

- `config.json` 路徑是 `discord.reactions.enabled`，欄位名是 `enabled`；只有 `true` 會開啟。直接改檔要重啟 `dc-bridge`；控制台改設定會即時生效並寫回檔案。
- 關掉自動 reaction 不會停用模型的 `add_reaction` 工具。
- 橋接 log 的「加了 reaction」只由 `maybeReact()` 寫出。若該 Discord 訊息的 bot reaction 存在、模型該回合卻沒有 `add_reaction` tool call，先查這條自動路徑。它可能在模型決定不接話前就按下，屬於既有行為與觀感風險。
- 2026-11-13 伺服器設定為 enabled、15% 機率、同頻道 10 分鐘冷卻、每小時最多 10 次、最低關鍵字分數 1；正規化預設分數是 2，伺服器值可能已變。

相關：[[discord-agent-extras]]、[[discord-quiet-gate]]。
