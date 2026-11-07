---
name: discord-mention-names
description: 批次與歷史查詢中的 @/#/role mention 轉名字、回覆標記
---

Discord 訊息裡的 mention 在送進模型前會換成名字，id 不外洩。

- 轉換：`<@id>`、`<@!id>` → `@暱稱`，`<#id>` → `#頻道名`，`<@&id>` → `@身分組名`。
- 名字只從該則訊息的 `mentions` 取，不打 API；查不到寫 `@未知`／`#未知`，不把數字 id 留給模型。
- `resolveMentions`（`src/core/discord-batch.mjs`）做轉換；名字會過 `defang`／`visibleName`，避免偽造 `★`、`【管理員】`。
- 回覆：沒有引用內容時顯示 `↪回覆 X`；有引用內容時維持 `[引用 X：…]`。persona 規則：`↪回覆 X` 表示在回 X，不是在叫模型。
- 同一套換法用於 `【最近頻道訊息】`、`read_history`、`search_history`、`view_message`（含 embed 標題/說明/欄位與投票題目/選項）。
- 守衛：頻道名只在 `channel.guildId === message.guildId` 且成員有 ViewChannel 時才換；查不到成員時退回 @everyone 判斷（fail-closed）；私密討論串（PrivateThread）一律 `#未知`，避免跨服或私密頻道名洩漏。`repliedName` 先查 `mentions.members`，再退回 `guild.members.cache`，名字不可見時回 `未知`，避免標記消失。`【最近頻道訊息】` 的內文也會過 `defang`。
- 黑話語料：歷史路徑改用 `resolveMentions(entry.content, entry)`；`maybeReact` 仍吃原始文字，避免影響表情關鍵字比對。
- 重啟後名稱掉回全域名稱：bot 沒開 GuildMembers 意圖，`channel.messages.fetch()` 是 REST，回來的訊息沒有 `member`；`Message#member` 是 getter，查 `guild.members.cache`。新增 `warmMemberCache(guild, messages)`（`src/core/discord-context.mjs`）對快取缺的成員逐一 `guild.members.fetch(id)`（單一成員端點不需特權意圖），在 `buildBatchPrompt` 組最近訊息前呼叫。只補抓「最近頻道訊息」的人；引用、每日摘要、`read_history`／`search_history`／`view_message`、自由參與後續批次仍可能掉回全域名稱；已離開成員每批重抓一次；429 會等待、webhook 作者未跳過（reviewer 找出的缺口）。

相關：[[discord-message-preview]]、[[discord-history-quota]]。