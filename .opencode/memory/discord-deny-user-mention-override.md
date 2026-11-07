---
name: discord-deny-user-mention-override
description: deny.users（管理員封鎖）與 deny.self（自己 /blacklist 退出）分工；閘門、上下文過濾、被動路徑、slash、updateConfig、測試與缺口
---

兩份名單分工（2026-11-07 拆分）：

- `deny.users`：管理員封鎖（控制台／`config.json`）。bot 完全不處理他的訊息，@bot 也一樣，也不能自己用 `/blacklist` 解除。
- `deny.self`：使用者自己用 `/blacklist` 退出。私聊全擋；伺服器頻道不再整則丟掉——沒叫 bot 的訊息不進批次，但記入 `silentPending`，下一批重新抓頻道上下文時以 `⊘` 背景身分送進 DSH（受 `context.messages`／`context.maxChars` 限制，`context.enabled=false` 時永遠不進）。他 @bot 或回覆 bot 的那一則照常處理（含黑話語料、觸發統計、記憶記錄）；這個例外 2026-10-29 擴到 `read_history`、`search_history`、`user_info` 也看得到該則，但每日摘要仍排除，`deny.users` 與私聊沒有例外。
- `deny.guilds`／`deny.channels`、私訊、slash 指令都不受例外影響。

## 實作

- `src/core/discord-core.mjs`：
  - `isConversationAllowed()`：`deny.users` 一律擋；`deny.self` 只在 `!(ignoreUserDeny && guildId)` 時擋。`ignoreUserDeny` 只跳過 self，且只在伺服器頻道生效。
  - `isDeniedUser(cfg, userId)`：兩份名單任一命中都算「被擋的人」，給被動路徑用。
  - `withSelfMutedUser(deny, userId, muted)`：改寫 `deny.self`，其他欄位原樣保留（舊名 `withDeniedUser`，寫 `deny.users`）。
- `src/discord-bridge.js` `handleMessage()`：`mentioned`／`repliedUserId` 提到閘門前，`addressedToBot = Boolean(guildId) && shouldHandleGuildMessage(..., true)`，帶 `ignoreUserDeny: addressedToBot`；`direct` 沿用 `addressedToBot`。
- 被動路徑（`isDeniedUser` 兩份名單都擋）：recent-channel-history priming、每日摘要（`:3051`）、`read_history`（`:1307`，但 self @ 例外 expanded 2026-10-29）、`search_history`（`:1338`，同上）、`view` 目標訊息（`:1353`，回 403）與被回覆的那則（`:1361`）、批次引用原文（`:2413`）、頻道上下文＋黑話樣本（`:2448`）、`user` 工具的記憶 facts（`:1444`）。
- `view` 的轉發內容（messageSnapshots）不查作者，文件已寫明。
- `/blacklist`（slash）：管理員封鎖的人不能自己解除（回「請找管理員」）；其餘 toggle `deny.self`；私聊全擋；`/blacklist` 與 `/mention` 改成 optionless toggle。
- `/reset`、`/status`、`/forget` 得 `dmPermission: true`；`/status` 印 頻道/私聊；`/reset` 非擁有者閘門用 `userId: ''` 問頻道。
- 所有文字指令移除（`!reset`、`!new`、`!status`、`!forget` 當一般聊天）。
- `updateConfig()`：`deny` 逐欄合併（`{ ...cfg.discord.deny, ...(patch?.deny ?? {}) }`），console 表單只送部分欄位也不蓋掉 `deny.self`；先讀檔、寫檔、rename，再改記憶體，寫檔失敗狀態不變；函式同步、無 await。

## 伺服器頻道的非 ★ 訊息（commit ab93f52）

- `handleMessage()`：非 ★ 且作者在 `deny.self` 時不進批次，但 `primedKeys.delete(key)` 並 `silentPending.set(key, message.id)`，下一批重新抓上下文。
- `buildBatchPrompt()`：`wantContext` 會重新抓；過濾掉批次自身、`deny.users`、模型不理名單、`//` 訊息，但保留 `deny.self`（黑話語料不收）；`silentPending` 只在訊息 id ≤ boundary 時清掉，代表已落在這次抓的範圍；用 `isSilentMessage` 標 `silent`。
- `formatRecentContext()`：退出者那一行寫 `#編號 ⊘暱稱：內容`，標題加「⊘ = 已退出，只看不回」；群友自己打的 `⊘` 先被 defang 換成 `∅`。
- `deliverPrompt()`：`silentPending` 還有東西就不標 `primedKeys`，下一批用更晚的 boundary 再抓一次（解「A 問完、退出的人 Y 才接話」）。
- 硬擋：`reply_to`／`send_image`／`send_sticker` 指向非 ★ 的 `deny.self` 訊息 → 403（拒絕訊息寫明原因）；`add_reaction` → 403；`remember_user` → 403；`forget_user_fact` 不受限（`checkRead: false`）；`user_info` 的記憶 facts gate on `canReadMessage`（line 2779）；`view_message`／`read_history`／`search_history` 仍看不到（`canReadMessage`）。
- 每日摘要、黑話語料、觸發統計、`handleReaction`（缺口）仍排除／未查；純 silent 訊息不會開回合，因此進度貼文不會外洩。

## 測試

`scripts/test-discord-bridge.mjs`：@ 放行、伺服器／頻道／母頻道黑名單擋得住、私聊不適用、`/blacklist` toggle、@ 例外。

## 已知缺口

- `view` 轉發內容不查作者（跨頻道抓來源成本大，維持現狀）。
- 被擋的人的名字仍可能經 `replyName` 露出（只名字，內文不漏）。
- `ignoreUserDeny` 命名偏寬（實際只跳過 self）。
- `handleMessage` 在 `main()` closure，無整合測試。

## 相關

[[discord-blacklist-stale]]、[[discord-view-message]]、[[discord-session-reload]]。