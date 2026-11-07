---
name: discord-media-handling
description: Discord 媒體處理：語音訊息分類、行程級媒體佇列、view_message 預算、影片抽格時間戳、PNG sBIT 修復與 alpha 保留策略
---

- 語音／音訊附件：`src/core/discord-media.mjs` 把 `audio/*` 或副檔名在 `AUDIO_EXT`（mp3/ogg/oga/opus/wav/m4a/aac/flac/weba）的附件分類為 skipped，kind `audio`，reason「語音或音訊（聽不到）」，不進模型。橋接在 `src/discord-bridge.js` 只有音訊附件時回人話「這則是語音或音訊，我聽不到；打字告訴我內容好嗎」；混其他附件時仍用技術原因。測試：`test-discord-bridge.mjs` 4 條。
- 行程級媒體佇列：`createMediaQueue(2)` 包住 `prepareMediaBlock` 與 `prepareVideoUrlBlock`，多頻道同時丟影片時 ffmpeg 最多 2 個，避免 heartbeat 與回合回應變慢。佇列 FIFO、名額直接交給下一個、同步丟例外也會釋放；每個任務內部仍有 ffmpeg 逾時，不會永久卡住。測試：peak===2、排隊任務全跑、例外後名額釋放。
- 媒體預算：佇列任務開始時檢查剩餘預算，少於 10 秒就跳過（避免排隊等完才跑、一定逾時）。`view_message` 傳 `deadline = viewStart + 55_000` 給 prepare 呼叫；影片連結 yt-dlp 上限 20 秒、ffmpeg 共用剩下的預算，少於 12 秒就放棄連結、保住前面的文字結果。`media.enabled` 關掉時不跑影片連結；yt-dlp URL 解析會剝掉尾端 ASCII `)`，並拒絕 `userinfo` 偽裝 host（回歸測試已釘住）。
- 影片抽格時間戳：`src/media-normalize.js` 的 `frameTimesLabel` 在 note 補「約 X/Ys」，例如「抽 6 格拼成 3×2（約 0/12/…s，左上→右下）」，讓模型能說「0:30 那裡」。真畫時間碼（drawtext）未做。
- 影片附件：mp4／webm／mov 用 ffmpeg 抽 6 格拼成 3×2，只看前 `media.maxVideoSeconds` 秒（預設 60，max 120）；note 格式 `[圖N：影片 Xs，抽 6 格拼成 3×2 左上→右下，只有畫面沒有聲音]`。抽不出畫面回一句原因，不炸整批。Discord 免費上傳額度 2026-08 起 20MB，所以 `media.maxBytes` 預設 20MB（伺服器 config 要自己設 20971520，舊 8MB 會擋大檔）；ffmpeg 加 `-nostdin` 避免非 tty 卡死。影片連結（YouTube 白名單）走 yt-dlp，見 [[discord-view-message]]。測試：`test-media-normalize.mjs`、`test-discord-bridge.mjs`。
- 已知：`normalizeImageForModel` 的壓縮迴圈可能在同一個名額內跑多次 ffmpeg（審查推測，未驗證）；多張附件仍 Promise.all 並行下載，但縮圖/抽格受佇列管。
- PNG 修復：`repairPng(buf)`（`src/media-normalize.js`）走訪 PNG 區塊，把所有 `sBIT` 區塊一律丟掉（不分長度對錯、值是否為 0／大於位深、或放在 IDAT 後面），因為伺服器 ffmpeg 7.1 遇到壞的 `sBIT` 會把整張判成壞檔（exit 69）；只在寫入 ffmpeg 輸入檔時套用，回 null 就照原檔走。測試：`scripts/test-discord-media-normalize.mjs` 的 `repairPng` 單元測試（拿掉所有 sBIT，沒有 sBIT 回 null）與 1920×1080 RGBA 整合測試。
- Alpha 保留策略：壓縮迴圈第一輪留 PNG（保 alpha），壓不進上限時改 JPEG 並在透明區鋪白底（避免深色字掉進黑底）；切換編碼時不降低長邊，避免截圖文字糊掉。有 alpha 的 1080p RGBA 截圖在 1280 長邊仍約 2.1MB PNG，但 JPEG 約 100KB，能進 1MB 上限。白底測試做過變異檢查（拿掉鋪白底就失敗）；伺服器 ffmpeg 7.1 實測 2.48MB RGBA -> 1280×720 JPEG 98,930 bytes，字幕清楚（2026-11-07）。相關回饋 df_mw65pyem53b0b6（2026-11-07）。
- GIF 解析：`parseGif()`（`src/media-normalize.js`）直接掃描 GIF 區塊鏈，不呼叫 ffprobe；回傳 frames/durationMs/alpha。`planAnimation()` 固定取 6 格、版面查表（6→3×2），時間均勻重取樣，輸出 JPEG 單幀並附「动图 N 帧」說明。delay 全 0 的 GIF 以「幀數 × 100ms」估算時長。Discord 路徑的 `gifFrames` 固定寫 6（`src/core/discord-media.mjs`），不跟 config。
- 連結預覽圖：`embedImages()`（`src/core/discord-media.mjs`）把訊息 embed 的 `image`／`thumbnail`（走 `proxyURL`）收成附件形狀交給 `collectImageAttachments`；Tenor／Giphy 的 GIF 就是這種。同一 embed 的 thumbnail 常是 image 的縮小版，只取一張避免重複下載。代理網址常無副檔名，先標成圖，下載後再認格式。批次與 `view_message` 都納入；批次在 flush 時讀 `entry.message.embeds`（Discord 後補 embed，messageCreate 當下常為空），不必拖慢批次。`media.maxCount` 對「一則訊息」與「整批」各算一次（不是只整批）。`view_message` 也讀 embed 圖。
- component embed／Components V2 的 media、敏感 flags、type 11 fallback、attachment alt 與 spoiler 見 [[discord-message-preview]]。

相關：[[discord-video-subtitles]]、[[discord-message-preview]]。