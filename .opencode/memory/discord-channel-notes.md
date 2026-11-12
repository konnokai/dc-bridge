---
name: discord-channel-notes
description: 頻道筆記（discord-notes）與頻道標籤（style）兩套記憶的收斂與資料處理
---

頻道有兩套記憶：頻道筆記（`src/core/discord-notes.mjs`，`state/discord-notes.json`）與頻道標籤／風格（`kind: 'style'`，`src/core/discord-slang.mjs` 管的 `state/discord-slang.json`）。

- 頻道筆記：`note_event` 記「群裡發生的事」＋`search_notes`／`forget_note` 查刪；每日 04:00 自動摘要（`by: 'summary'`），每條有 TTL（預設 30 天、摘要 7 天），`notes.enabled` 開就直接注入。控制台有 `/api/notes` 與 `/api/notes/delete`。
- 注入（commit 45b7d16）：摘要與事件分兩個池、各自預算。摘要固定只帶最新 1 條（`summaryMaxChars = Infinity`，摘要長度已由寫入端限制）；事件池預設 `injectMax: 8`、`maxChars: 600`。`injectMax` 預設 5→8（`discord-core.mjs`）。同一會話 30 分鐘內不重複帶入（shown Map 依 `note.id`+`note.at`）。區塊最後若還有沒列出的筆記，附加「更早的 N 條沒列出；聽不懂的舊話題先用 search_notes 查，不要猜」（`omitted = all.length - summaries.covered - events.covered`，shown 剛帶過的不算「沒列出」）。`summaryTried` 在記憶體，重啟後同一天可能再試。
- 摘要 token 計入 `internal:頻道摘要`，控制台「花費」可見，不算入頻道用量。
- 頻道標籤：學習會話抽候選 + 模型用 `mcp__slang__record_channel_tag` 收錄，管理員在控制台確認才注入；無 TTL，每頻道最多 5 條（候選與已確認合計，已拒絕不算）、300 字。滿了學習與 `record_channel_tag` 都不再收，回 409，要換先在控制台刪一條。
- 線上觀察：`note_event` 從未被模型用過（全部 `by: 'summary'`）；已確認標籤 115 條、`seen` 全為 1，一次性事件被存成永久標籤。
- 收斂方向：抽取 prompt 只收不隨話題變的穩定習慣（回覆長短、語氣、常用語尾、表情貼圖、互動節奏），一次性的話題或事件不算（由頻道筆記每日摘要記）；`recordChannelTag` 對已存在的標籤原樣回傳、不復活 rejected，滿額回 `{full:true,max}`。
- 清理線上資料要用控制台刪除，不能用「拒絕」（拒絕的標籤會一直留在 `styleLabels`，學習 prompt 只列最近 20 個）；`slangStore` 在記憶體，直接改檔下次存檔會覆蓋，需先 `pm2 stop dc-bridge` 或走控制台。
- `pruneSlang` 在每次存檔跑，只裁候選；已確認與已拒絕不裁剪。
- 搜尋是字面比對（`matchesTerms`，NFKC 正規化 + `includes`，每個詞都要出現），所以 `note_event` 與每日摘要 prompt 都要求「遊戲、作品、人物寫原名，後面用括號補群裡的叫法（例如 NIKKE（妮姬））」；preset 也加「群裡講到你沒跟上的舊事件：先 search_notes 查群裡的叫法，一次只查一個詞（作品名或人名）；查不到就換英文名、原名再查一次，還是沒有就用 search_history 翻頻道訊息，不要憑印象猜」。舊筆記不回填別名（30 天過期自然換掉；真的查不到的群內私有綽號落到 search_history）。線上別名回填分兩輪：第一輪 3 條（瓦羅蘭→打瓦、星鐵→崩鐵、Valorant→打瓦），備份 `state/discord-notes.json.bak-20261108-135145`；第二輪 19 條（見本檔下方），備份 `state/discord-notes.json.bak-20261108-140042`。`search_notes` 不自動展開黑話別名，新筆記仍靠 `note_event`／摘要 prompt 寫別名，沒寫的照樣查不到。
- `notes-search` handler 記一行 log：`MCP 查頻道筆記 <key>（query=…，days=…，命中 N 條）`（query 截 40 字），放在過濾之後、空結果 return 之前，所以「查了沒命中」也會記。注意 handler 解構必須是 `const { key, channel } = await agentSender.resolve(body.token)`，只解 `channel` 會在 log 那行丟 `ReferenceError: key is not defined`（B' 的核心會整個廢掉）。
- `buildSummaryPrompt` 也要加同一條別名規則（自動寫筆記的另一來源，search_notes 也查得到摘要）。
- 摘要上限實際是 **301 字**（300 + `…`），不是 300；`src/core/discord-notes.mjs:242`。7 條摘要都卡在 301，再補別名時要先刪冗字（例如 `n_mvzp67x2d745d2` 290→299）。
- 2026-11-08 線上別名回填：共改 19 條（高信心 OW→鬥陣特攻、棕2→棕二、nomoto 三寫法互補；中信心 Threads↔脆 9 條；低信心 Zutomayo、少女樂團→BGD/BanG、星趴→Astral Party、阿泰爾→Artale、粥）。備份 `state/discord-notes.json.bak-20261108-140042`。搜尋實測：鬥陣特攻 2、棕二 1、のむと 2、nomoto 3、脆 9、Threads 9、ずとまよ 2、BGD 1、Astral Party 1、Artale 1、粥 5。3 條沒改：`n_mw6uqwk191ba14`、`n_mw3z8j603d4b14` 已 301 字、`n_mvya6ocd5e229b` 大小寫不敏感已可查。明河：`n_mw2k8beke09483` 的「有人詢問當天是否有明河開台」整句刪掉（明河指劇情角色，不是實況主），另一條「明河劇情好看」保留。Girl's Band Cry = BGD，不是ガルクラ。
- 測試 `scripts/test-discord-notes.mjs` 3b 區塊用突變測試確認保護力：截斷測試要送低於 150 字的輸入（寫入端才不先截）並檢查該行 `endsWith('…') && length <= maxChars`；「摘要吃事件字數」主因要加 3 條比妮姬更新的 ~136 字長事件，讓共用預算把妮姬擠掉。另補 `prompt.includes('NIKKE（妮姬）')` 斷言。

相關：[[discord-slang-mcp]]。