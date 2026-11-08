---
name: discord-console-memory-pagination
description: 控制台「記憶」分頁：群友記憶、頻道筆記、梗圖三張表的分頁與搜尋
---

- 三張表共用 `LIST_PAGE_SIZE = 20` 與 `renderPagedList(kind, all, …)`；狀態保存在 `pagedLists = { memory, note, meme }`（含 `query`、`page`、`data`），5 秒 refresh 不重設頁碼與搜尋字。
- DOM id：`memory-search` / `memory-pager`、`note-search` / `note-pager`、`meme-search` / `meme-pager`；rows id 為 `memory-rows`、`note-rows`、`meme-rows`。
- 搜尋欄位：群友記憶比對 `name`/`userId`；頻道筆記比對 `channelName`/`channelId`；梗圖比對 `name`/`id`。換頁與搜尋只重畫該表。
- 梗圖縮圖仍走 `memeThumbs` Map，render 時對已刪除的 id 呼叫 `URL.revokeObjectURL`，避免 blob 累積。
- 已部署到測試伺服器（commit `82aa822`）。

相關：[[discord-console-table-layout]]、[[discord-meme-plan]]。