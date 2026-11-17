---
name: discord-memory
description: 群友記憶的名稱欄位、keying 與衍生側寫
---

群友記憶掛在 `author.id`（userId）上，所有伺服器共用；名字只是附帶顯示。

- 名字取 `visibleName`（`src/core/discord-batch.mjs:31`）依序第一個有效的：伺服器暱稱 → Discord 全域顯示名稱 → 帳號本名。呼叫路徑：`authorName`（`src/discord-bridge.js:1477`）→ `memoryTarget` 產生 `shown` → `rememberFact` 寫進 `entry.name`（`src/core/discord-memory.mjs`）。
- 模型呼叫時傳的 `name` 參數**不會被記下來**，只拿來核對「這則訊息是不是這個人說的」（`src/discord-bridge.js:1657`）；#編號 指錯人時不能記到別人身上。
- REST 抓回來的訊息沒帶 `member` 時，`src/discord-bridge.js:1655` 會另外抓一次；抓失敗就掉到全域名稱，這時記下的名字可能跟你在頻道看到的不一樣（與重啟後的成員快取問題同源）。

互動次數（2026-11-07 後）：

- `triggerStore.users[userId]` 記 `count` 與 `lastAt`（`noteTrigger` 只在 bot 真的送出時記）；`formatMemoryBlock`（`src/core/discord-memory.mjs:173`）透過 `relationOf` 在群友記憶那一行後面接 `你回過他 N 回合，最後一次 X 前`。
- 沒有記憶（facts 為空）但有互動紀錄的人也會出現這一句；沒有 facts 時用「天」當去重鍵，同一會話 30 分鐘內不重複帶。
- 文字用「回過他 N 回合」而非「聊過 N 次」，因為 `noteTrigger` 只在 bot 真的送出時記。

側寫（2026-11-17）：

- `profile`／`profileAt` 放在同一個 `discord-memory.json` user entry，不另開檔、不提高 `MEMORY_VERSION`；loader 要保留這兩欄，避免把既有記憶當壞檔移走。
- 每日背景工作沿用每日摘要的 timer／小時設定與 `dc-learner`。最多處理 12 人；只挑至少 4 條事實、事實更新過且距上次側寫超過 7 天的人。
- 候選排除管理員封鎖與模型不理名單。輸出只接受本次候選名單裡的 userId；內容只歸納既有興趣、偏好與近況，不推測性格或評價好壞；文字經 `defang`，上限 60 字。
- prompt 注入時側寫接在事實後；字數預算不足時先省略側寫。更新側寫會改變去重鍵，讓新側寫即時重送。`user_info`、`/memory` 與控制台會顯示；控制台只讀，手動修改需另加釘選機制，否則每日重算會覆蓋。
- 側寫 prompt 將每位使用者放在獨立 `<user id>` 區塊，名字與事實先用 `escapeLearnerText` 跳脫；解析只收字串側寫，存檔前套 `defang` 與敏感資訊檢查。
- 刪除單條事實或淘汰過期推測時會清掉衍生側寫，避免已刪內容仍由摘要洩漏。背景產生候選時記錄 `updatedAt`，寫入時比對，避免舊事實覆蓋 `/forget` 或新記憶。若剩餘事實少於 4 條，側寫會保持空白，直到重新符合候選門檻。
- 每日摘要與側寫背景工作依序執行；失敗會記錄並排下一次，避免同時建立共用 workspace 或產生未處理 rejection。
- 2026-11-17 測試機有 7 人符合至少 4 條事實門檻；這是當日快照，不代表目前人數。

相關：[[discord-mention-names]]、[[discord-channel-notes]]、[[discord-trigger-stats]]、[[discord-hindsight-evaluation]]。
