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
- 重載摘要只在 retire 後代次仍為 `epochBeforeRetire + 1` 時寫回；中間被另一個 /reset 插進來就跳過，避免覆蓋別人的摘要；`turnGate.resume` 的 `force` 跟著 `cleared`。
- 重連期間 `/ask` 不再直接拒絕，會排進佇列等快照到齊再跑。
- `/ask` 檢查必須原子：`privateTurnBlock` 集中檢查（DSH 佇列、頻道回合、/ask 是否進行中），檢查完到 `turnGate.submit` 之間不能再 await，避免 TOCTOU 插隊；`pendingPrompts` 失敗回 `code: 'unavailable'`。
- `/reset` 與 `/reload-system-prompt` 的執行權限改為 **Administrator**（不再接受只有 ManageGuild）：Discord 選單 `default_member_permissions` 與執行期 `canResetConversation()` 都只看 Administrator bit；ManageGuild 加其他權限也不放行。私聊仍只認 ownerIds。
- 重載確認框與頻道名顯示：頻道名缺時顯示「這個頻道」而非 `#undefined`。
- 實測（2026-11-03）：多頻道重載，摘要 537~913 字；`state/discord-reload-summaries.json` 有 5 個頻道摘要。
- 相關：[[discord-channel-notes]]、[[discord-persona]]。