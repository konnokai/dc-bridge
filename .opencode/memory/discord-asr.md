---
name: discord-asr
description: Discord 語音與影音轉錄：mlx-audio 接線、批次與背景工作、來源限制及安全處理
---

- 截至 2026-11-24，ASR 已實作，當日 `npm run test:discord` 全綠；設計與驗證記錄在 `docs/design/PLAN_ASR.md`。後端共用 Mac mini 上的 `mlx_audio.server`，不另開服務。
- `discord.stt` 只設 `enabled`、`baseUrl`、`model`、`maxMediaSeconds`；預設關閉，`baseUrl` 空值沿用 `discord.tts.baseUrl`。模型預設 `mlx-community/Qwen3-ASR-1.7B-8bit`；可改用 Qwen3-ASR 0.6B 或 Whisper large-v3-turbo。模型選型依中、英、日、韓多語需求，中文優先 Qwen。
- `/v1/audio/transcriptions` 使用 multipart 上傳原始媒體。必須指定 `response_format=json`（預設是串流 `ndjson`），長音檔帶 `max_tokens: 16384`。Mac 上的 ffmpeg 解 OGG/Opus、M4A、MP4、WebM；橋接不轉檔。20 分鐘音訊可能受 token 上限影響，需用真實多語音檔驗證。
- 批次只自動處理明確 @bot 的音檔：120 秒內同步轉錄，每批最多 2 則；更長的音檔改背景工作。沒 @bot 的音檔不自動轉，模型可用 `view_message` 的 `transcribe: true` 按需處理。`view_message` 預設不轉錄。
- `maxMediaSeconds` 預設 1200 秒。YouTube 只處理前段且不支援直播；Discord 附件與 SNS 超過上限就拒絕。`view_message` 的短音檔可同步處理；長音檔、影片、沒有字幕的 YouTube 與 SNS 影片走背景工作，完成後用 `enqueuePrompt` 喚醒原會話。YouTube 受白名單與 `videoLinks.enabled` 限制；SNS 先找 Discord 修復 bot 的代理影片，再用無 cookie 的 yt-dlp best-effort。白名單為 X、Instagram、Threads、Facebook；IG 等來源可能因登入限制失敗，不提供 cookie 登入。
- 背景工作全域同時一件、每頻道最多排三件、總排隊上限八件；同一來源快取一小時。工作記在 `state/discord-transcript-jobs.json`；橋接重啟不續跑，舊工作回報失敗。`/reset` 取消排隊及本機下載，已送到 Mac 的推論無法中止，結果會丟棄。ASR 忙碌時 `send_voice` 立即回 409，避免 TTS 與 ASR 長時間互卡。
- 逐字稿是外部內容：進 prompt 前 `defang`、逐行縮排並加開始／結束標記；不做簡繁轉換，也不先用小模型摘要。超過 `MAX_TRANSCRIPT_CHARS`（12,000 字）截斷並標明只取前段。2026-11-24 已確認逐字稿不寫入歷史歸檔。
- 2026-11-24 實測：測試伺服器已啟用 STT；一則 4.57 秒 Discord OGG 經 `view_message(transcribe: true)` 正確轉出中文，逐字稿保留模型原輸出字形。這只驗證單一短中文樣本；人類送出的 inbound 語音批次路徑仍未驗證。
- 同日一則約 40 秒 X 影片走了背景工作，約 4–5 秒完成；log 沒記來源，無法判定使用 Discord 代理影片或 yt-dlp 原站下載。
- 工作生命週期的回歸防線：同步轉錄要有硬逾時（批次 45 秒；`view_message` 使用剩餘預算），背景工作不可在同步轉錄仍忙時啟動；`finish` 必須具冪等保護，取消中的工作要從工作表移除，避免 cache-key 去重命中舊工作。設定每次從 `cfg.discord.stt` 讀取；`baseUrl` 空值保留在設定，使用時才 fallback。
- 2026-11-24 驗證快照：`scripts/test-discord-stt.mjs` 17/17、Discord suite 42/42、控制台靜態檢查通過；部署到測試伺服器的版本為 `4b1702c`。
- 2026-11-24 從 SSH MCP 在 Mac 安裝 ffmpeg 時，非互動 shell 找不到 `brew`；同一指令先加 `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` 再執行 `HOMEBREW_NO_AUTO_UPDATE=1 brew install ffmpeg` 成功。不要假設遠端 shell 已載入 Homebrew PATH。
- 連結：[[discord-media-handling]]、[[discord-video-subtitles]]、[[discord-voice-tts]]、[[discord-image-jobs]]、[[discord-mlx-idle-unload]]
