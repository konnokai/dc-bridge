---
name: discord-deny-user-mention-override
description: deny.users 被擋的人 @bot 或回覆 bot 時仍處理；閘門、上下文過濾、測試與已知缺口
---

`deny.users`（管理員封鎖或使用者自己 `/blacklist`）原本全擋。現在例外：
被擋的人**在伺服器頻道 @bot 或回覆 bot 的那一則**照常處理，讓他還能找 bot 說話。
`deny.guilds`／`deny.channels`、私訊、slash 指令不受例外影響。

## 實作

- `src/core/discord-core.mjs`：`isConversationAllowed()` 加 `ignoreUserDeny`（預設 false）。
  只跳過 `deny.users`，且只在伺服器頻道生效（`ignoreUserDeny && guildId`）。
- `src/discord-bridge.js` `handleMessage()`：把 `mentioned`／`repliedUserId` 提到閘門前，
  `addressedToBot = Boolean(guildId) && shouldHandleGuildMessage(..., true)`，
  帶 `ignoreUserDeny: addressedToBot`。`direct` 直接沿用 `addressedToBot`。
- 頻道上下文（`:2450`）原本沒過濾 `deny.users`，加了 `!cfg.discord.deny.users.includes(entry.author?.id)`，
  使被擋的人沒 @ 的閒聊不進 prompt、不收黑話樣本；每日摘要（`:3053`）仍過濾。
- `/blacklist` 回覆文字補上例外；文件 `docs/guides/DISCORD.md` 三處同步。

## 測試

`scripts/test-discord-bridge.mjs` 第 2 節新增：@ 放行、伺服器／頻道／母頻道黑名單擋得住、私聊不適用。

## 已知缺口（Found）

- `read_history`／`search_history` 不過濾 `deny.users`，仍讀得到被擋的人的訊息。
- `memoryTarget` 沒看黑名單，模型可用訊息編號記下他的事。
- `handleMessage` 在 `main()` closure，無整合測試，只有核心 predicate 被測。
- 設計問題：`deny.users` 同時是「使用者自己退出」與「管理員封鎖」兩種用途；
  改完後被封鎖的人只要 @bot 就能觸發回合。若要完全封鎖，需拆成兩份名單。

## 相關

[[discord-blacklist-stale]]、[[discord-view-message]]。