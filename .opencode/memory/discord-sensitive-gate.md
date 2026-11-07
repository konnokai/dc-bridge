---
name: discord-sensitive-gate
description: 敏感閘門擋下時回報命中種類與片段；已知令牌只說「已知令牌」；繁中關鍵字與表情目錄比對修正
---

敏感閘門（`src/sensitive.js`、`src/core/discord-security.mjs`）現在不只擋，也把命中原因寫進錯誤訊息，模型不用再猜是哪個詞。

- `formatSensitiveHit()` 產出一句：憑證樣式「…」／本機路徑「…」／已知令牌；片段經 `clip` 截到 60 字。已知令牌只說「已知令牌」，不回報原文。
- `describeSensitive()` 先比對已知令牌再跑正則，避免令牌原文出現在 match 片段裡；emoji 代號只拿掉目錄裡真的有的（catalog-based），不是 regex lookbehind。
- `describeSensitive()` 用於 `remember_user`、`record_slang`、`record_channel_tag`（`src/discord-bridge.js`），錯誤變成 `這條命中敏感資訊閘門：憑證樣式「token=abc」，不能記`（黑話／標籤是「這段…不能收」）。三處也一併傳入表情目錄，和 `send_message` 的判斷一致。
- `src/core/discord-agent.mjs` 改用同一個 `formatSensitiveHit()`，訊息文字不變。
- 繁中關鍵字（密碼、密鑰、為）補上，原本只認簡體。
- 只有表情目錄裡真的有的 `:名稱:` 才不算憑證值，修掉把任意 `:xxx:` 當憑證的誤擋。
- 只改 log 或只擋進站語料的四處（`discord-bridge.js:1142`、`:3018`、`:3771`、`:4222`）仍用 `findSensitive()`，因為模型看不到那些訊息。
- `note_event`（頻道筆記）仍沒有敏感閘門，只有每天摘要會擋；這是原本就有的差異。
- 測試：`scripts/test-discord-sensitive.mjs` 6 passed；bridge 測試補命中說明四種情況；`npm run test:discord` 18/18 scripts passed；QQ 端四支 audit 測試 exit 0。
- Commit `6c5f981`（2026-11-07）。

相關：[[discord-security-baseline]]、[[discord-memory]]。