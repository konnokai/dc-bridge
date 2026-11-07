---
name: discord-session-reload
description: /reload-system-prompt 交接摘要系統：產生摘要、新會話帶入一次、/reset 清除、敏感閘門、排隊訊息保留
---

`/reload-system-prompt`：排進同一條會話佇列，等目前回合結束後在舊會話產生交接摘要，再清掉會話。摘要失敗就不清，避免把還接得上的對話弄丟。

- 交接摘要存於 `state/discord-reload-summaries.json`；重載後新會話第一則 prompt 帶入一次（prompt 真的進 DSH 才用掉，送失敗下一則還會再帶）。
- `/reset` 連同還沒用掉的交接摘要一起清掉；下一則訊息完全重來。
- 重載期間排隊中的訊息留在 bridge，重載後進新會話；換代次後立刻改排隊批次的 epoch。
- 交接摘要有敏感資訊閘門，命中則不保存。
- 每個 key 只刪自己那一筆；中間被新的 reload 覆蓋就不能動別人的摘要。
- 會話重置後第一批先說話（`b15b5ba`）。
- 實測（2026-11-03）：多頻道重載，摘要 537~913 字；`state/discord-reload-summaries.json` 有 5 個頻道摘要。
- 相關：[[discord-channel-notes]]、[[discord-persona]]。