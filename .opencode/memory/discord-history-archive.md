---
name: discord-history-archive
description: Qdrant 語意歷史歸檔的資料範圍、設定、查詢與安全邊界
---

2026-11-17 使用者選擇把原始頻道訊息而非只存摘要歸檔到 Qdrant，保留 360 天。功能以 `4597d80` 推送並部署到 Discord 測試伺服器；實機確認 collection 建立，以及狀態、瀏覽、搜尋、頻道端點可用。這是獨立功能，不是採用 Hindsight（見 [[discord-hindsight-evaluation]]）。

- `discord.historyArchive.enabled` 預設關閉。開啟前需填 `embedUrl`；預設 collection 是 `dc_history`，拒絕使用現有服務的 `personal_memory_v2`。oMLX 模型為 `bge-m3-mlx-fp16`，已驗證輸出 1024 維。
- Qdrant collection 使用 1024 維 Cosine、int8 scalar quantization，原始向量與 HNSW 放磁碟；既有 collection 會檢查維度與距離。訊息 snowflake 超過 JavaScript 安全整數範圍，point id 用訊息 id 雜湊成穩定 UUID，重送／編輯可覆寫同一點。
- 只收 guild 頻道的訊息；`//` 訊息、自己 `/blacklist` 退出者與其他 bot 不收，bot 自己的訊息另行收錄。短於 4 個有效字元的內容（從原文移除 mention、emoji、標點、連結後）不做 embedding；歸檔文字則先把 mention 換成名字，三條寫入路徑一致。編輯用 upsert；刪除與批次刪除移除對應點。
- `recall_history` 是語意搜尋，和關鍵字 `search_history` 分開；只查目前頻道，查詢時再用 `canReadMessage` 過濾目前的封鎖／不理名單。部署版最低相似度是 0.55，取代初期設計的 0.62；結果帶 `#編號`，可交給 `view_message` 看完整訊息。它與 `read_history`、`search_history` 共用每回合 3 次配額，詳見 [[discord-history-quota]]。
- `/forget` 會清除該使用者尚未送出的佇列項目、等待正在進行的 flush，再刪掉其本人發出的歸檔訊息。它不會刪除其他人提到他的訊息或 bot 回覆；刪除失敗須在回覆中明說。
- 控制台「設定」只開放歸檔開關與保留天數。`editableConfig()` 必須回傳 `historyArchive.enabled` 與 `retentionDays`；漏掉欄位會讓表單顯示預設關閉，下一次存其他設定時可能把歸檔關掉。Qdrant／embedding endpoint、模型、collection 與 `apiKey` 留在 `config.json`，避免瀏覽器可改連線目標或接觸憑證。客戶端在啟動時建立，變更需重啟才生效。狀態卡顯示集合、近似點數（30 秒快取）、佇列、最後成功 flush、累計寫入與最近錯誤。
- 控制台「記憶」頁的歸檔卡可看最新訊息、按頻道篩選、語意搜尋及刪除；瀏覽每頁 20 則，頻道清單用 Qdrant facet，名稱從 Discord channel cache 補上。搜尋由 Enter／按鈕送出，未選頻道時可跨頻道；模型共用的 `search()` 預設仍限制目前頻道，只有控制台明確傳 `anyChannel` 才放寬。控制台搜尋取前 20 筆，不設相似度門檻。
- 控制台會顯示所有歸檔頻道的原文；權限只有控制台 bearer token，沒有額外的頻道授權。畫面有明確提示。Qdrant 本身仍是所有介面可達且無認證，直接呼叫 Qdrant 不受控制台 token 保護。
- Qdrant 1.19.1 的 scroll `order_by` 要用單一物件，且不能靠 `offset` 分頁（`next_page_offset` 為 null）。瀏覽游標使用 `{ before, skip }`：`start_from` 包含時間邊界，`must_not.has_id` 排除該時間已回傳的點；額外抓一筆判斷是否還有下一頁。`skip` 最多 500 個點；同一毫秒超過 500 筆時可能無法完整翻頁。每次 `ensure()` 都補送 `channelId`、`authorId`、`at` payload index；索引失敗不擋寫入，但瀏覽可能失敗。
- 控制台刪除以 17–20 位數字字串的 Discord message snowflake 為 ID，不是 Qdrant UUID，避免 JavaScript 數字精度損失。刪除前先從待送佇列移除、等待目前 flush 完成，再刪點；沒有 tombstone，訊息之後被編輯仍可能重新歸檔。確認框提醒刪除無法復原且編輯後會再收錄。
- 佇列在記憶體中，上限 500；預設 32 則或 120 秒送一批。超量會丟最舊項目，失敗批次也會丟棄。2026-11-17 的程式片段未見關機時 drain archive queue；重啟遺失尚未 flush 的項目是已知風險，先核對目前 shutdown 程式。
- 安全阻擋：截至 2026-11-17 部署後，Qdrant 仍對所有網路介面開放且無認證。歸檔含 360 天的頻道原文，需限制 Qdrant 網路可達範圍或加認證；API key 不記憶。Qdrant snapshots／備份不會因 retention 或 `/forget` 自動清除。
- 離線測試是 `node scripts/test-discord-history-archive.mjs`，不用連 Qdrant／oMLX。fake fetch 對已存在 collection 的 GET 必須回傳 `result.config.params.vectors` 中的 size 與 distance，否則 `ensure()` 會按設計拒絕。2026-11-17 歸檔測試、控制台靜態檢查、`node --check` 與 `npm run test:discord` 均通過；測試伺服器也實測狀態、list、search、channels API。

相關：[[discord-hindsight-evaluation]]、[[discord-history-quota]]、[[discord-memory]]、[[discord-skip-marker]]。
