---
name: discord-console-table-layout
description: 控制台黑話／頻道風格表固定版面（table-layout: fixed、84px 列高）
---

`public/discord-console.html` 的黑話表與頻道風格表改用固定版面，避免內容變動時操作按鈕位移。

- 兩張表加 `class="entry-table"` + `<colgroup>`；CSS `table-layout: fixed; min-width: 560px`、`tbody td { height: 84px }`、`.cell-clamp` 3 行省略號 + `title` 全文。
- 欄寬：詞 16%；頻道 20%、標籤 12%；狀態 64px；次數 64px（由 56px 放寬）；操作 112px；其餘文字欄平分。
- `entryActions` 固定四格（確認／拒絕／編輯／刪除），缺的動作留 `span.action-slot`。
- Playwright 測試（`scripts/test-console-ui.mjs`）比對三種狀態、兩張表的編輯按鈕 x 與列高；內容改長重畫後再比一次。
- HTML 每次請求重讀，不用重啟 bridge；已部署到測試伺服器。
- 兩個 QQ 控制台測試（baseline payload、花費趨勢圖）為既有失敗，與此變更無關。

相關：[[discord-dev-feedback-console]]。