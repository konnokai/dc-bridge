---
name: discord-deny-user-mention-override
description: deny.users（管理員封鎖）與 deny.self（自己 /blacklist 退出）分工；閘門、上下文過濾、被動路徑、slash、updateConfig、測試與缺口
---

兩份名單分工（2026-11-07 拆分）：

- `deny.users`：管理員封鎖（控制台／`config.json`）。bot 完全不處理他的訊息，@bot 也一樣，也不能自己用 `/blacklist` 解除。
- `deny.self`：使用者自己用 `/blacklist` 退出。訊息照樣不處理，**唯一例外**是他 @bot 或回覆 bot 的那一則照常處理（含黑話語料、觸發統計、記憶記錄）。
- `deny.guilds`／`deny.channels`、私訊、slash 指令都不受例外影響。

## 實作

- `src/core/discord-core.mjs`：
  - `isConversationAllowed()`：`deny.users` 一律擋；`deny.self` 只在 `!(ignoreUserDeny && guildId)` 時擋。`ignoreUserDeny` 只跳過 self，且只在伺服器頻道生效。
  - `isDeniedUser(cfg, userId)`：兩份名單任一命中都算「被擋的人」，給被動路徑用。
  - `withSelfMutedUser(deny, userId, muted)`：改寫 `deny.self`，其他欄位原樣保留（舊名 `withDeniedUser`，寫 `deny.users`）。
- `src/discord-bridge.js` `handleMessage()`：`mentioned`／`repliedUserId` 提到閘門前，`addressedToBot = Boolean(guildId) && shouldHandleGuildMessage(..., true)`，帶 `ignoreUserDeny: addressedToBot`；`direct` 沿用 `addressedToBot`。
- 被動路徑（`isDeniedUser` 兩份名單都擋）：recent-channel-history priming、每日摘要（`:3051`）、`read_history`（`:1307`）、`search_history`（`:1338`）、`view` 目標訊息（`:1353`，回 403）與被回覆的那則（`:1361`）、批次引用原文（`:2413`）、頻道上下文＋黑話樣本（`:2448`）、`user` 工具的記憶 facts（`:1444`）。
- `view` 的轉發內容（messageSnapshots）不查作者，文件已寫明。
- `/blacklist`（slash）：管理員封鎖的人不能自己解除（回「請找管理員」）；其餘 toggle `deny.self`；私聊全擋；`/blacklist` 與 `/mention` 改成 optionless toggle。
- `/reset`、`/status`、`/forget` 得 `dmPermission: true`；`/status` 印 頻道/私聊；`/reset` 非擁有者閘門用 `userId: ''` 問頻道。
- 所有文字指令移除（`!reset`、`!new`、`!status`、`!forget` 當一般聊天）。
- `updateConfig()`：`deny` 逐欄合併（`{ ...cfg.discord.deny, ...(patch?.deny ?? {}) }`），console 表單只送部分欄位也不蓋掉 `deny.self`；先讀檔、寫檔、rename，再改記憶體，寫檔失敗狀態不變；函式同步、無 await。

## 測試

`scripts/test-discord-bridge.mjs`：@ 放行、伺服器／頻道／母頻道黑名單擋得住、私聊不適用、`/blacklist` toggle、@ 例外。

## 已知缺口

- `view` 轉發內容不查作者（跨頻道抓來源成本大，維持現狀）。
- 被擋的人的名字仍可能經 `replyName` 露出（只名字，內文不漏）。
- `ignoreUserDeny` 命名偏寬（實際只跳過 self）。
- `handleMessage` 在 `main()` closure，無整合測試。

## 相關

[[discord-blacklist-stale]]、[[discord-view-message]]、[[discord-session-reload]]。