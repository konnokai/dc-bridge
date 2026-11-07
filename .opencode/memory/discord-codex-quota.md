---
name: discord-codex-quota
description: Codex（ChatGPT 方案）額度查詢、生圖守門、5 小時窗口重置 ping；app-server JSON-RPC 與快照
---

模組：`src/core/discord-codex-quota.mjs`。生圖開關在 preset `dc-tool-restrict.config.allowImageGen`；沒開生圖就不查額度、也不排重置 ping。

## 查詢

- 用短命的 `codex app-server`（JSON-RPC）：先 `initialize`（`clientInfo` + `capabilities.experimentalApi: true`），再 `account/rateLimits/read`（params null）。拿到回應就 SIGKILL。app-server 自己刷新 `~/.codex/auth.json`，橋接不碰 token。
- `normalizeCodexRateLimits()`：`result.rateLimits ?? result.rateLimitsByLimitId.codex`；primary=5 小時窗口、secondary=每週窗口；`usedPercent` 轉 0-100、`resetsAt` 秒→毫秒。
- REST 備案（研究）：`GET https://chatgpt.com/backend-api/wham/usage` 帶 `Authorization: Bearer <access_token>` 與 `chatgpt-account-id`，回 `rate_limit.primary_window`（18000s）／`secondary_window`（604800s）的 `used_percent`／`reset_at` 與 `credits.balance`。實作未採用。
- 快取：成功 5 分鐘、失敗 60 秒（`createCodexQuota`）；控制台 5 秒刷新也不會一直開 app-server。
- 額度快照寫 `state/discord-codex-quota.json`（env `DC_CODEX_QUOTA_FILE` 可覆寫），欄位 `fetchedAt`、`drawAllowed`、`drawBlockedReason`、`fiveHour`、`weekly`；10 分鐘內有效；缺檔／壞檔／過期／未來 timestamp 都 fail-open；查詢或寫入失敗不影響查詢。

## 生圖守門

- `codexDrawGate()`：5 小時剩 < 15%（`CODEX_DRAW_MIN_FIVE_HOUR_PERCENT`）或每週剩 < 5%（`CODEX_DRAW_MIN_WEEKLY_PERCENT`）就暫停生圖。
- 進 queue 前與真正開 Codex 前各查一次。
- `/status` 一行：`formatCodexQuota()` 印 5 小時／每週剩餘與重置時間、重置券張數、credits。

## 5 小時窗口重置 ping

- `createCodexResetPinger()`：到 `resetsAt + 30s`（`CODEX_RESET_GRACE_MS`）後送一則 `test` 把新窗口打開，模型 `gpt-6-luna`、low reasoning、ephemeral、read-only、關 shell/unified_exec/view_image，逾時 90 秒。
- 狀態存 `state/discord-codex-reset.json`（`lastPingedResetAt`、`lastAttemptAt`、`lastPingError`）；橋接重啟不會對同一個 resetsAt 重送；失敗 15 分鐘（`CODEX_RESET_RETRY_MS`）後再試；每週額度用完（usedPercent ≥ 100）時不 ping；狀態檔讀寫失敗就停 ping。
- 輪詢間隔取 `min(5 分鐘, 下次重置時間)`，至少 1 秒。

## 相關

[[discord-image-jobs]]、[[discord-usage-pricing]]。