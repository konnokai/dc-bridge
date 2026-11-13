---
name: discord-console-settings
description: Discord 控制台功能設定分區方式與響應式排版
---

`public/discord-console.html` 的「功能設定」依設定路徑第一段分區。無前綴欄位放「對話行為」；未列在名稱表的前綴直接顯示前綴，避免新欄位消失。2026-11-13 有 15 區、50 個欄位。

- 採用分區而不再包卡片；共用一個表單與儲存按鈕，避免視覺雜訊和讓人誤以為分區各自儲存。
- 每區用左側 160px 區名、右側欄位 grid，區間以細線分隔；欄位最小寬 220px，`auto-fill` 避免少欄位時輸入框被拉太寬。
- 大於 720px 時左右排；720px 以下區名在上、欄位在下。bool 欄位佔滿一列；`wide` 欄位排在區末並跨欄。`align-items: end` 對齊同列輸入框。
- 依 `FEATURE_FIELDS.path` 分組，不需另加 `group` 欄位；欄位 DOM 重排不影響 `featurePatch`，因為讀取仍依欄位 path/id。
- 測試避免寫死區數：確認每個區名不是未翻譯的設定前綴，並檢查欄位總數、TTS 與 `videoLinks` 歸區。

相關：[[discord-console-table-layout]]、[[discord-console-config]]。
