---
name: discord-dev-feedback-console
description: 控制台回饋分頁的「複製 prompt」按鈕與欄寬調整；HTML 是每次請求重讀，不用重啟 bridge
---

控制台（`public/discord-console.html`）回饋分頁在「刪除」旁新增「複製 prompt」按鈕，
把模型的回饋（原因／需求／預期結果）組成可直接處理的 prompt，含 clipboard fallback。

- 欄寬從 180px 改 220px，按鈕列加 `flex-wrap:nowrap`，讓「複製 prompt」與「刪除」排同一行。
- HTML 是每次請求重新讀檔，不用重啟 bridge，但伺服器 repo 要先更新。
- 已部署到測試伺服器（commit `2950350`）。

相關：[[discord-message-preview]]。