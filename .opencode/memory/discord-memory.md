---
name: discord-memory
description: 群友記憶（remember_user）的名稱欄位與 keying
---

群友記憶掛在 `author.id`（userId）上，所有伺服器共用；名字只是附帶顯示。

- 名字取 `visibleName`（`src/core/discord-batch.mjs:31`）依序第一個有效的：伺服器暱稱 → Discord 全域顯示名稱 → 帳號本名。呼叫路徑：`authorName`（`src/discord-bridge.js:1477`）→ `memoryTarget` 產生 `shown` → `rememberFact` 寫進 `entry.name`（`src/core/discord-memory.mjs`）。
- 模型呼叫時傳的 `name` 參數**不會被記下來**，只拿來核對「這則訊息是不是這個人說的」（`src/discord-bridge.js:1657`）；#編號 指錯人時不能記到別人身上。
- REST 抓回來的訊息沒帶 `member` 時，`src/discord-bridge.js:1655` 會另外抓一次；抓失敗就掉到全域名稱，這時記下的名字可能跟你在頻道看到的不一樣（與重啟後的成員快取問題同源）。

相關：[[discord-mention-names]]、[[discord-channel-notes]]。