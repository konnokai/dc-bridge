---
name: discord-chatty-channels
description: chattyChannels 頻道主動參與模式：config 驗證、【參與度】提示、persona 優先規則、followup 6/天（2026-11-10 起與一般頻道同）、spoofing 防護
---

`discord.chattyChannels`：頻道 ID 陣列，列在這裡的頻道不套「10 分鐘送了幾則」活動行與 N×5 閘門，批次前多一段【參與度】提示，沒 ★ 也可以接，並允許用 `schedule_followup` 自己排回訪開新話題。

- Config 驗證：`src/core/discord-core.mjs`（`idList`，拒絕數字/非陣列/壞 ID）；`isChattyChannel` 處理空值。討論串不繼承母頻道的 `chattyChannels`，要另外列自己的 ID。
- 批次提示：`src/core/discord-batch.mjs`（`CHATTY_HINT_LINES`、`CHATTY_FOLLOWUP_HINT`、`formatParticipationHint(chatty, { followup })`）+ `src/discord-bridge.js`。chatty 時不印活動行；normal 頻道 byte-for-byte 不變。
- `defang` 把 【 轉成 [，防止群友偽造 【參與度】 區塊。
- Persona 優先規則：`dsh/agent-presets/dc-chat/agent.cordis.yml` 行 35，明確蓋掉「只有兩種才接」、「只會附和就跳過」、「不接是最常見」、「預設不接」，並處理沒 ★ 時「你」指誰。★、⊘、安全邊界照舊。
- Phase 2 回訪：chatty 頻道可用 `schedule_followup` 排 30~90 分鐘後開新話題；回訪 prompt 帶「舊話題冷了可以直接起一個新的」並帶【黑名單現況】。2026-11-10 起 chatty 也跟一般頻道一樣每天最多 6 次（拿掉每天 2 次特殊上限）；cap 持久化（`state/discord-followups.json`），重啟後累計，host timezone。
- chatty 沒有發言上限，只靠「一兩句、不當主持人」與每輪最多 5 則；覺得吵就從 `chattyChannels` 拿掉，不用重新部署。
- review 發現：normal 頻道 followup 也帶【黑名單現況】（`src/discord-bridge.js:3594-3600`）， worth keeping；chatty followup 不帶 recent messages，模型須 `read_history`；cap 2/天。
- chatty 但還要求 @bot 的啟動警告只在 ClientReady 跑一次，不會在 console settings save 或 `/mention` 後重跑。
- 部署：2026-11-07 部署到測試伺服器，config.json `chattyChannels` 填三個頻道；測試 `scripts/test-discord-participation.mjs`（33 項）。
- 相關：[[discord-quiet-gate]]、[[discord-blacklist-stale]]、[[discord-persona]]。