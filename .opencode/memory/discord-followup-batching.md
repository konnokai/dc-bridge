---
name: discord-followup-batching
description: 送出前攔補句：urgent 8 秒、take/takeFollowups、hold 同 step、測試 20 項（commit 622568c）
---

有人 @bot 的那批只等 4 秒就送進模型，15 秒後才到的補句只能開第二個回合，bot 連送兩則。修正：

- `urgentMs` 預設 4→8 秒（`src/core/discord-batch.mjs`）。
- 新增 `take()`：只取指定使用者、純文字、不取附件／貼圖／embed／component／轉發；取完後照剩下的訊息重算 urgent 與送出時間。
- 新增 `takeFollowups()`。
- `src/discord-bridge.js`：`send_message` 送出純文字前攔補句（安靜檢查後、`prepareRefusal` 前），一個回合一次；同一個 step 的其他 send 也 hold 到 `step/start`，避免只送出後半句；`/reset`、turn/start、turn/end、斷線都會清狀態。
- `/reset`、turn/start、turn/end、斷線都會清狀態。
- 一般批次（20 秒）與私聊（沒有 @）不受影響；F 只救「回合開始後約 8 秒內」到的補句，救不到 15 秒那種。

## 已知限制（Found）

- 已 flush 進 `turnGate` 佇列的補句不攔。
- 攔截回覆只帶回覆對象名字，沒帶引用內文與 `muted` 標記（`src/core/discord-batch.mjs:520`）。
- bridge 的 `send` 接線沒有離線測試，要靠部署後 log 驗收。
- 攔截後回合若被取消，已取走的補句不會回到下一批（罕見）。
- 攔截的那次 tool/call 仍會被記成「工具呼叫失敗」，progress 也會被標成已回覆（`src/discord-bridge.js:3074`、`:3076`）。

## 部署

commit 622568c（2026-11-07），push 到 origin/main；沒有部署到測試伺服器（使用者說先不用）。`feat/async-image-generation` worktree 已刪除。

測試：`npm run test:discord` → 18/18 scripts passed，`## 7d3b` 20 項全通過。

相關：[[discord-batch-debounce]]、[[discord-blacklist-stale]]。