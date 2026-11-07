---
name: discord-media-handling
description: Discord 媒體處理：語音訊息分類、行程級媒體佇列、view_message 預算、影片抽格時間戳、PNG sBIT 修復與 alpha 保留策略
---

- 語音／音訊附件：`src/core/discord-media.mjs` 把 `audio/*` 或副檔名在 `AUDIO_EXT`（mp3/ogg/oga/opus/wav/m4a/aac/flac/weba）的附件分類為 skipped，kind `audio`，reason「語音或音訊（聽不到）」，不進模型。橋接在 `src/discord-bridge.js` 只有音訊附件時回人話「這則是語音或音訊，我聽不到；打字告訴我內容好嗎」；混其他附件時仍用技術原因。測試：`test-discord-bridge.mjs` 4 條。
- 行程級媒體佇列：`createMediaQueue(2)` 包住 `prepareMediaBlock` 與 `prepareVideoUrlBlock`，多頻道同時丟影片時 ffmpeg 最多 2 個，避免 heartbeat 與回合回應變慢。佇列 FIFO、名額直接交給下一個、同步丟例外也會釋放；每個任務內部仍有 ffmpeg 逾時，不會永久卡住。測試：peak===2、排隊任務全跑、例外後名額釋放。
- 媒體預算：佇列任務開始時檢查剩餘預算，少於 10 秒就跳過（避免排隊等完才跑、一定逾時）。`view_message` 傳 `deadline = viewStart + 55_000` 給 prepare 呼叫；影片連結 yt-dlp/ffmpeg 共用剩下的預算，少於 12 秒就放棄連結、保住前面的文字結果。
- 影片抽格時間戳：`src/media-normalize.js` 的 `frameTimesLabel` 在 note 補「約 X/Ys」，例如「抽 6 格拼成 3×2（約 0/12/…s，左上→右下）」，讓模型能說「0:30 那裡」。真畫時間碼（drawtext）未做。
- 已知：`normalizeImageForModel` 的壓縮迴圈可能在同一個名額內跑多次 ffmpeg（審查推測，未驗證）；多張附件仍 Promise.all 並行下載，但縮圖/抽格受佇列管。
- PNG 修復：`repairPng(buf)`（`src/media-normalize.js`）走訪 PNG 區塊，丟掉色彩類型要求長度不符的 `sBIT`（例如 RGBA 圖上 3 位元組），因為 ffmpeg 7.1 會把這種檔判成壞檔（exit 69）；只在寫入 ffmpeg 輸入檔時套用，回 null 就照原檔走。測試：`test-media-normalize.mjs` 的 `repairPng` 單元測試與 1920×1080 RGBA 壞 sBIT 整合測試。
- Alpha 保留策略：壓縮迴圈第一輪留 PNG（保 alpha），從第二輪起改 JPEG；切換編碼時不降低長邊，避免截圖文字糊掉。有 alpha 的 1080p RGBA 截圖在 1280 長邊仍約 2.1MB PNG，但 JPEG 約 100KB，能進 1MB 上限。相關回饋 df_mw65pyem53b0b6（2026-11-07）。

相關：[[discord-video-subtitles]]、[[discord-message-preview]]。