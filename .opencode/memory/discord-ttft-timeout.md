---
name: discord-ttft-timeout
description: TTFT 超時取消慢回合：設定、串流偵測、取消與保底放行
---

模型想太久（第一個 token 超過 `discord.ttftTimeoutMs`）時取消該回合，但不砍正在跑的 MCP 工具。

- 設定：`discord.ttftTimeoutMs` 預設 30000，範圍 5000–120000，`0` 關閉；`config.example.json` 有範例。
- 只對橋接自己排進去的批次計時；`/compact` 與自動壓縮不計時。
- 偵測：DSH follow 請求帶 `assistantStream: true`；`src/dsh-client.js` 處理 `assistant-stream` 幀，第一個 chunk 送合成 `assistant/first-token` 事件（reasoning chunk 也算）。
- 停錶條件：`assistant/first-token`、`assistant/message`、`tool/call`、`compaction/start`、`turn/end`。收到第一個 token 後工具跑多久都不歸此機制。
- 超時動作：送 `session/cancel`（保留 inbox）、5 秒保底放行 gate；保底時記下 abandoned turn，遲到的 `turn/end` 不會再放掉下一批 gate。
- 取消失敗只寫 log，不放 gate、不送誤導訊息。5 分鐘 `TURN_RELEASE_MS` 保險絲仍在。
- 已部署；TTFT 行為無自動化測試（僅設定範圍測試 + live DSH 串流探針）。

相關：[[discord-quiet-gate]]。