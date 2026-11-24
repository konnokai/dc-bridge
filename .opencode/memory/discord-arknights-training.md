---
name: discord-arknights-training
description: 明日方舟玩家練度統計 MCP、名稱比對、資料驗證與推薦語意
---

`mcp__arknights__get_operator_training` 用一圖流公開統計，回報幹員的專精分布、精二人數、模組階段 3 率與開啟率。這是玩家實際練度，不是官方建議；回覆應說「大家通常……」。PRTS 的技能資料與劇情查詢見 [[discord-prts-mcp]]。

截至 2026-11-22，新接入應用 UserCenterV1 的 V2 結果端點 `/open/ak-operator-statistics/v2/result`；V2 的模組欄位是 `equipA/X/Y/D/B`。不要沿用 BackEndV3 舊的 `/survey/operator/result/v2`。幹員表取自一圖流前端 repo 的 `character_table_simple.v2.json`，不是穩定 API。

- 技能分布只使用 0–3；忽略上游偶爾出現的 4–10 髒 key。M1／M2／M3 率以 `own`（持有者）為分母。
- `elite["2"]` 是精二人數。模組階段 3 率以持有者為分母；開啟率計算階段 1、2、3 人數總和。有人開模組但沒升到階段 3 時仍列出，不能說「沒人開」。
- A 類模組是集成戰略的特限證章；模組名稱與技能名稱照幹員表資料呈現。
- 名稱先做繁簡、Unicode 全半形、括號／間隔號／空白與大小寫正規化。優先用幹員名包含查詢字串；單字名可能造成反向誤配，遇到多個候選要列出候選，不可猜一位回統計。`charId` 可直接查。
- 快取只收通過格式驗證的非空統計陣列與有效幹員表；壞回應不能蓋掉好快取。上游失敗時可沿用舊快取，並以 60 秒重試間隔避免每次查詢都等完整逾時。記憶體快取 TTL：統計 6 小時、幹員表 24 小時。
- 2026-11-24：統計第一次請求約 10.6 秒失敗，立即再試約 0.5 秒成功；採用同一 stats URL 重試一次，而非只拉長 timeout。兩次失敗且沒有舊快取時會明確回「一圖流練度統計讀取失敗」；有舊快取時仍沿用舊資料並延後 60 秒再試。重試目前也會涵蓋 4xx、空統計或格式錯誤。使用者選擇不限制模型改用 PRTS；只改統計重試與錯誤訊息。
- 工具是獨立 stdio MCP，直接讀公開資料，不經橋接也不需 token。`dc-tool-restrict.mjs` 把它和 PRTS 放在同一開關下，只允許 `dc-chat`／`dc-chat-open`；learner、trader 不應看到或呼叫它。
- 測試入口是 `scripts/test-discord-arknights.mjs`；涵蓋名稱歧義、異格／括號、髒 key、無模組與只開低階模組、快取格式、preset 白名單，以及統計重試成功／失敗兩種情況。註冊同步到 `scripts/setup-dsh.mjs` 和 `scripts/test-mcp-servers-stdio.mjs`。

2026-11-22 的測試伺服器實測能天使輸出正常；當時 `npm run test:discord` 為 41/41，MCP stdio 清單與 preset patch check 通過。
2026-11-24 重試改動通過 code review；`npm run test:discord` 為 42/42，preset patch check 通過。
2026-11-24 部署 `33501d5` 後，MCP stdio 實查 `get_operator_training`（但書）成功；部署檢查與健康檢查均通過。部署流程見 [[discord-deploy]]。

## 幹員別名解析

截至 2026-11-22，首次實際抓取約 18 秒；MCP 啟動暖機可避免第一個工具呼叫等待。當日部署後確認持久檔有 1,070 條別名，數量會隨 PRTS 更新。功能操作規則見 `docs/guides/DISCORD.md`「幹員別名」。

- `matchAlias` 的包含比對忽略少於 2 字的別名；巢狀命中取最長項目，多個不相含的幹員則回候選，不猜。例：`飛天貓` 包含 `天猫`，能對到異格凱爾希。
- 自動補記只收無空白、原始查詢比命中別名多不超過 1 字的情況，避免把 `42专三` 這類技能問題存成永久雜訊。
- 別名表永久保存，抓取須完整成功才可寫：處理 `cmcontinue`／`rdcontinue`，並把 HTTP 200 的 MediaWiki `error` 當失敗。任何批次失敗都不應存部分表。
- 暖機先檢查別名檔：檔案有效就不抓幹員表或 PRTS；檔案損毀時不重建，以免抹掉管理員資料。每個 MCP 程序共用暖機 promise；抓取完成寫入前再檢查檔案，若另一個程序或管理員已建立有效檔案，就保留現有內容。
- 控制台手動新增會用幹員表解析名稱或 `charId`，只寫入正規幹員名稱與 `charId`；查無或多重符合會拒絕，別名正規化後也不能等於正式名稱。伺服器驗證兩欄都是字串且各不超過 40 字。別名檔不存在或損毀時不允許新增，避免手動建立不完整檔案而跳過 PRTS 暖機。
- 控制台不把別名清單放進 5 秒輪詢：登入時載入一次，使用者手動重新整理或新增／拒絕／恢復／刪除後才重抓；登出會清除載入狀態，讀取錯誤會顯示在分頁。
- 測試用 `ARKNIGHTS_ALIAS_FILE` 隔離永久 state；MCP 工具清單測試設 `DC_ARKNIGHTS_NO_WARMUP=1`，避免測試時連外。
- 2026-11-22 部署驗證：控制台別名 API 的讀取、新增、拒絕、恢復、刪除都成功，臨時新增資料已清除；MCP 工具可用別名查詢。當次 `npm run test:discord` 為 41/41、控制台 UI 為 17/17，MCP server 接入檢查通過。

別名資料源與查詢詞庫的差異見 [[discord-slang-mcp]]；PRTS 工具見 [[discord-prts-mcp]]。
