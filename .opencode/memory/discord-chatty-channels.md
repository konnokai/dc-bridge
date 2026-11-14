---
name: discord-chatty-channels
description: chattyChannels 主動參與模式、【參與度】提示、followup 上限，以及 2026-11-13 部署的讓位與純媒體閘門
---

`discord.chattyChannels`：頻道 ID 陣列，列在這裡的頻道不套「10 分鐘送了幾則」活動行與 N×5 閘門，批次前多一段【參與度】提示，沒 ★ 也可以接，並允許用 `schedule_followup` 自己排回訪開新話題。

- Config 驗證：`src/core/discord-core.mjs`（`idList`，拒絕數字/非陣列/壞 ID）；`isChattyChannel` 處理空值。討論串不繼承母頻道的 `chattyChannels`，要另外列自己的 ID。
- 批次提示：`src/core/discord-batch.mjs`（`CHATTY_HINT_LINES`、`CHATTY_FOLLOWUP_HINT`、`formatParticipationHint(chatty, { followup })`）+ `src/discord-bridge.js`。chatty 時不印活動行；normal 頻道 byte-for-byte 不變。
- `defang` 把 【 轉成 [，防止群友偽造 【參與度】 區塊。
- Persona 優先規則：`dsh/agent-presets/dc-chat/agent.cordis.yml` 行 35，明確蓋掉「只有兩種才接」、「只會附和就跳過」、「不接是最常見」、「預設不接」，並處理沒 ★ 時「你」指誰。★、⊘、安全邊界照舊。
- Phase 2 回訪：chatty 頻道可用 `schedule_followup` 排 30~90 分鐘後開新話題；回訪 prompt 帶「舊話題冷了可以直接起一個新的」並帶【黑名單現況】。2026-11-10 起 chatty 也跟一般頻道一樣每天最多 6 次（拿掉每天 2 次特殊上限）；cap 持久化（`state/discord-followups.json`），重啟後累計，host timezone。
- chatty 沒有發言上限，只靠「一兩句、不當主持人」與每輪最多 5 則；覺得吵就從 `chattyChannels` 拿掉，不用重新部署。
- review 發現：normal 頻道 followup 也帶【黑名單現況】（`src/discord-bridge.js:3594-3600`），值得保留；chatty followup 不帶 recent messages，模型須 `read_history`。
- chatty 但還要求 @bot 的啟動警告只在 ClientReady 跑一次，不會在 console settings save 或 `/mention` 後重跑。
- 部署：2026-11-07 部署到測試伺服器，config.json `chattyChannels` 填三個頻道；測試 `scripts/test-discord-participation.mjs`（33 項）。

## 接話問題與讓位閘門（2026-11-13 舊版；2026-11-14 起已 supersede）

- 從 session log 擷取實際 `system/message` 與五種 user prompt（3 個不應接話案例、2 個應接話案例），每種提示詞版本各重播 10 次；只提供 `send_message` 工具。
- 判斷是否接話要看實際 tool call；CoT（模型推理文字）偶爾說要跳過，最後仍呼叫工具。CoT 可用來找原因，不可代替行為計數。
- Command Code 直連重播：不帶 DSH 的 `User-Agent` 得到 403；帶 `deepseek-harness/<已安裝的 dsh-llm 版本> (+https://github.com/deepseek-ai/deepseek-harness)` 與 `accept-encoding: identity` 後成功。憑證從 DSH 讀取，不寫進 fixture。
- 送出次數／每案例 10 次：`neg_you`（同一串中間有人插話）舊版 10、v2 0、v3 6、v4 0；`neg_give`（語意不明的玩笑）10、0、1、4；`neg_image`（只有圖片）3、1、0、3；`pos_lily`（沒有 ★ 的頻道問題）10、7、8、8；`pos_mh`（★ 直接提問）10、10、9、10。
- v4 壓住主要的 `neg_you` 案例，仍有 `neg_give` 4/10、純圖片 3/10 誤送；正例為 8/10、10/10。樣本小，提示詞單獨調整仍不穩；因此已改用提示詞規則加橋接硬閘門。
- 舊版 `src/core/discord-batch.mjs` 的 `shouldYield` 只用於 chatty 頻道：bot 最後一則回給作者 T、批次最後一則仍由 T 發出、T 與 bot 送出之間有其他人插話（包含 `deny.self` 的 ⊘），且未超過 5 分鐘，才判定讓位。★、叫 bot 名字、回訪、提醒、系統訊息及沒有可用 `reply_to` 都放行。
- 插話區間用 Discord snowflake id 排序。若 T 的新訊息在 bot 回覆送出前已到（交錯），起點取 `max(reply_to.id, seenId)`；`seenId` 防止把 bot 這輪已看過的訊息誤算成插話。非數字 id 放行。
- `noteHuman` 必須在 `deny.self` 的 return 前記錄，否則 ⊘ 不會成為插話者；`activity.record` 留在 return 後，避免改變一般頻道的活動統計。
- `createMessageRefs.register` 遇到同一訊息再次登記、但沒有新 meta 時，必須保留舊 meta；history／補句等路徑會重登訊息，清掉 meta 會讓閘門查不到 `reply_to` 作者。補句登記也要帶作者與時間。
- chatty 純媒體批次由 `isMediaOnlyBatch` 跳過；目前只辨識無文字的圖片／貼圖，不涵蓋只有連結的訊息。bot 名稱比對只看 `rawText`，目前字串固定為「大肥魚／肥魚」，改 persona 名稱時要同步修改。
- 跳過時執行 `primedKeys.delete` 並將最後一則放進 `silentPending`，讓後續批次補帶 context；若被跳過批次長於 `context.messages`，較舊訊息可能漏掉。
- 截至 2026-11-13，`YIELD_GATE_SHADOW = true`，兩個閘門都只記 log、不影響模型回合。影子 log 在 `~/.pm2/logs/dc-bridge-out.log`，包含 bot、seen、T、batch、recent 的 id，不含訊息本文。commit `0ce887f` 已部署測試伺服器；當時尚未切正式模式或 `/reset`。
- 收窄前的設定快照（2026-11-14）：`chattyChannels` 有三個頻道，正式群不在名單，所以舊版兩個閘門不會在正式群執行；那邊的 ★ 插話接手由 persona 判斷。之後讓位閘門改成所有頻道執行，見下方收窄紀錄。
- 影子 log 實測（11-14 00:00–21:51，21 小時）：讓位 18 次、純媒體 19 次，全部在 `739040035571236905`。兩個誤擋：12:26 凱爾希（在回答 bot 自己問「飛天貓是哪隻」）、18:13 頭上的沒晃啊（畫圖回饋）。共同點是 T 的訊息不是回覆 bot。
- 2026-11-14 收窄並改到所有頻道：只擋「T 回覆的正是 bot 回給他的那一則」（`replyTargetId`，轉發不算），bot 那一則用每個人各自的最後幾則（`botLastByUser`，長訊息切段都留）；還要 bot 之後也回過插話的人（`botAfter`）。同批有別人的 ★ 整批不擋。★ 不再豁免。純媒體閘門仍只給 chatty、仍要求沒有 ★。影子 log 多了 `reply`、`botAfter`、`others★` 三個欄位。
- 將 `YIELD_GATE_SHADOW` 改成 `false` 會同時啟用兩個閘門：匹配的批次不會送進模型，因此不會有回覆、typing 或 token 用量。跳過批次會在後續 context 補帶，但可能受 `context.messages` 上限影響。兩閘門共用此開關，不能分開啟用。
- 驗證：`node scripts/test-discord-participation.mjs`、`node scripts/test-discord-bridge.mjs`、`node scripts/build-agent-preset-patches.mjs --check` 通過；`npm run test:discord` 為 31/31 scripts passed。

## 插話接手規則與閘門收窄（2026-11-14）

- 21:36 的重複回覆是 persona 規則缺口：模型知道有人插話，但 ★「每則都要回」與只適用無 ★ 的插話規則互相衝突。persona 現在明訂：同一件事已答過、另一位人類（含 ⊘）插話、原提問者又接著問時，只按一個 reaction、不送文字；即使這則標 ★ 也適用。此規則適用所有頻道。
- persona 修正提交 `0beb5af`，橋接閘門收窄提交 `3a7961d`；合併為 `c46a5df` 後已 push `origin/main` 並部署測試伺服器（2026-11-14）。部署時 `YIELD_GATE_SHADOW` 仍為 `true`。
- 收窄後的 `shouldYield` 只在 T 回覆 bot 曾回給 T 的訊息時考慮讓位。`replyTargetId` 只接受同頻道、一般回覆（type 0），排除轉發與跨頻道／討論串起點；`botLastByUser` 保存每位使用者最近 bot 回覆的訊息 ID，含長訊息分段。條件還要求：5 分鐘內、有其他人類在回覆目標與 T 的新訊息間插話，而且 bot 之後也回過插話者。這可避免把單純閒聊插話當成接手。
- 同批若有其他人的 ★，整批放行；叫 bot 名字也放行。讓位閘門改為所有頻道執行（排除 followup、reminder、system）；純媒體閘門仍只在 chatty 頻道執行。
- `YIELD_GATE_SHADOW` 仍為 `true`，因此新條件只寫 log、不阻擋模型。log 加入 `reply`、`botAfter`、`others★`；先觀察新 log，再決定是否啟用。舊版影子 log 的 18 次讓位中曾有 2 次誤擋；那份數據是收窄前的條件，不能當成新條件的誤擋率。
- 最終驗證：`npm run test:discord`（31/31）、`node scripts/build-agent-preset-patches.mjs --check` 與參與測試通過。部署後確認伺服器 HEAD 與 `state/.deployed-sha` 都是 `c46a5df`、`dc-bridge` 和 `dsh` online、bridge 有登入紀錄且 error log 沒增加。

- 相關：[[discord-quiet-gate]]、[[discord-blacklist-stale]]、[[discord-persona]]。
