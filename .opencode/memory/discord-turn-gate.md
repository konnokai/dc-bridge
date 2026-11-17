---
name: discord-turn-gate
description: createTurnGate 的 ticket、DSH turn 對應，以及漏接 turn/start 時避免佇列錯位
---

- `createTurnGate` 為每批工作發 ticket。長回合的舊收尾必須用自己的 ticket 呼叫 `releaseNormal(key, ticket)`，避免 5 分鐘保險絲已放行後，舊回合提早釋放新批次。
- Bridge 以 FIFO 將已投遞批次配給 DSH `turn/start`。漏接 start 或 DSH 將 prompt 當斜線命令時，可能留下已不持閘門的舊項，令後續批次錯配。配對時用 `owns(key, ticket)` 清掉舊項，並同步清理 `pendingUsers`、`pendingDirectMessages`、`pendingLastMessages`；沒配到批次時也要清除舊 `turnTickets`。
- `autoCompact` 最多等 180 秒，finally 只可釋放收到的 ticket；沒有 ticket 時不能釋放目前閘門。
- 2026-11-17 的 `b2a887a` 修正重連後舊 `turn/end` 釋放新批次：`turnTickets` 存 `{ turn, ticket }`，只在 turn 編號相符時放行；比對失敗不刪除目前紀錄。沒有 pending turn 時，只有「比先前已見 turn 更新」且 `pendingDirect` 首批仍持有閘門，才作為漏接 `turn/start` 的補救。記錄最大 turn 時先保存舊值，避免重連補送事件被誤認為新回合；舊事件與 Web GUI 回合不釋放 Bridge 閘門。TTFT 保底釋放也取 ticket 欄位。
- 上述修正通過 `node --check` 與 `npm run test:discord`（34/34）。batch→turn FIFO 配對仍沒有獨立單元測試。

相關：[[discord-auto-compaction]]、[[dc-bridge-tests]]。
