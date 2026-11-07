---
name: discord-memory
description: 群友記憶（remember_user）的名稱欄位與 keying
---

群友記憶掛在 `author.id`（userId）上，所有伺服器共用；名字只是附帶顯示。

- 名字取 `visibleName`（`src/core/discord-batch.mjs:31`）依序第一個有效的：伺服器暱稱 → Discord 全域顯示名稱 → 帳號本名。呼叫路徑：`authorName`（`src/discord-bridge.js:1477`）→ `memoryTarget` 產生 `shown` → `rememberFact` 寫進 `entry.name`（`src/core/discord-memory.mjs`）。
- 模型呼叫時傳的 `name` 參數**不會被記下來**，只拿來核對「這則訊息是不是這個人說的」（`src/discord-bridge.js:1657`）；#編號 指錯人時不能記到別人身上。
- REST 抓回來的訊息沒帶 `member` 時，`src/discord-bridge.js:1655` 會另外抓一次；抓失敗就掉到全域名稱，這時記下的名字可能跟你在頻道看到的不一樣（與重啟後的成員快取問題同源）。

互動次數（2026-11-07 後）：

- `triggerStore.users[userId]` 記 `count` 與 `lastAt`（`noteTrigger` 只在 bot 真的送出時記）；`formatMemoryBlock`（`src/core/discord-memory.mjs:173`）透過 `relationOf` 在群友記憶那一行後面接 `你回過他 N 回合，最後一次 X 前`。
- 沒有記憶（facts 為空）但有互動紀錄的人也會出現這一句；沒有 facts 時用「天」當去重鍵，同一會話 30 分鐘內不重複帶。
- 文字用「回過他 N 回合」而非「聊過 N 次」，因為 `noteTrigger` 只在 bot 真的送出時記。

相關：[[discord-mention-names]]、[[discord-channel-notes]]、[[discord-trigger-stats]]。