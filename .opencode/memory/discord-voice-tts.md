---
name: discord-voice-tts
description: Discord 語音背景工作、送出流程、限制與狀態查詢
---

- 截至 2026-11-13，`mcp__discord__send_voice` 先完成開關、頻道、冷卻、每輪上限、安靜與補句等檢查，再由橋接貼生成提示並啟動背景合成；工具很快返回，不再等 TTS 完成。完成後橋接排入 `【語音完成】`，模型再用 `mcp__discord__send_voice_file` 送出音檔。失敗時會提示模型改用文字。
- 2026-11-13 加入 Qwen3-TTS Base 聲音複製設定：`tts.refAudio` 是 **TTS 主機可讀的 POSIX 絕對路徑**，`tts.refText` 必須一起填且要對應參考音逐字稿；設定載入時就拒絕只填一邊、相對路徑，或模型名稱符合 `/-base(-|$)/i` 卻沒參考音，避免 Base 沒有預設聲音時默默亂抽。參考音檔不會從橋接上傳。
- Base 模型用 `ref_audio`／`ref_text`，不送 `instruct`、`accent` 或 `voice`；工具會告知 `instruct` 沒有作用。`refText` 和合成文字一樣會自動轉簡體，不必手動轉。VoiceDesign payload 必須省略空的 `ref_audio`／`ref_text`，不能送空字串。
- 目前 Base 保護依賴模型名稱模式 `/-base(-|$)/i`；名稱不符合此模式的其他 Base 模型不一定會在載入時被攔下。測試覆蓋設定 round-trip、錯誤設定、clone payload、繁轉簡與 VoiceDesign 不帶 ref 欄位。
- 背景化取代了先前同步等待的方案，避免長時間合成佔住 MCP 工具呼叫；`tts.timeoutMs` 仍限制後端合成，不代表合成不會逾時。
- 同一個會話 key 同時只允許一個 `working` 語音工作；再呼叫會回 409。橋接沒有跨會話全域 TTS 佇列；不同 key 的請求由安裝版本的 mlx_audio 決定排隊或合批，可能受 `refAudio` 影響。
- 語音工作只存在記憶體，TTL 為 10 分鐘；橋接重啟、會話重設或輪替會清掉工作，合成結果不會在重啟後復原。
- `mcp__discord__job_status` 只列目前會話 key 的生圖與語音工作。語音顯示合成中或已合成待送出；生圖只能顯示「排隊或生成中」、開始時間與最後回報時間，沒有百分比或排隊位置（見 [[discord-image-jobs]]）。
- `send_voice_file` 只在回覆目標回 404（訊息已刪或 `#編號` 無效）時移除回覆目標再試；403 可能代表對方退出、被封鎖或在不理名單，必須照原錯誤拒絕。其他送出錯誤不重試，因逾時可能已送達；每條失敗路徑都要刪除預告。
- 過期工作由 `pruneVoiceJobs` 統一實際刪除，並一併刪預告；`voiceJobFor`／`listVoiceJobs` 只把過期工作視為不存在，不要先刪掉它。
- `jobStatus` 的 `listVoiceJobs`／`listImageJobs` 參數 `now` 是函式；固定時間測試要傳 `now: () => now`。截至 2026-11-13，橋接 handler 本身沒有直接測試。
- `hasWorkingVoiceJob` 在送預告前檢查，工作在預告送完後才登記；只有 `cooldownSec=0` 且 `maxPerTurn>1` 時，並行呼叫可能同時通過。預設冷卻設定會擋住此情況。
- 2026-11-13 部署到測試伺服器 `175eca3`：本機與遠端 Discord 測試皆 31/31，`dc-bridge`／`dsh` online，MCP 工具清單含 `send_voice_file`、`job_status`；TTS `/v1/models` 回 HTTP 200 並列出兩個 Qwen3-TTS 模型。該部署當時尚未驗證橋接的完整 TTS 流程；Discord 語音訊息格式另有合成音測試，實際 Qwen 音檔則於同日手動送出成功。
- 2026-11-13 較早的測試伺服器檢查使用 VoiceDesign 模型，`/v1/models` 與 `/v1/audio/speech` 均回 HTTP 200；這項設定後來已被 Base 模型與參考音設定取代。當日用本機程式合成後手動送出 Discord 語音成功（6.64 秒），但不代表新橋接版本已部署或完成端到端驗證。派蒙社群 TTS 因使用者認為效果不如 Qwen3-TTS 而放棄，見 [[discord-paimon-tts]]。
- 2026-11-12 用 Discord.js 14.27.0 做過獨立送訊息測試：OGG/Opus 音檔需搭配 `AttachmentBuilder.setWaveform()`（256 bytes waveform 的 base64）與秒數 `duration`，並以 `MessageFlags.IsVoiceMessage` 送出；回讀確認 flags `8192`、`isVoice`、`audio/ogg`、waveform 與 duration。測試音是 2 秒合成正弦波，只驗證 Discord 語音訊息投遞，不代表 TTS 或橋接端到端測試。
- `mlx_audio.server` 沒有 API 認證；只可放在可信 LAN 或 VPN，不要直接暴露公網。模型端選型與 Voicebox 差異見 [[discord-tts-model-selection]]。

已取代（2026-11-13）：早期同步方案由 persona 先貼預告，並可能碰到 MCP 工具逾時；目前改由橋接自動提示並以背景工作完成語音。

相關：[[discord-image-jobs]]、[[discord-persona]]、[[discord-media-handling]]、[[discord-elevenlabs-tts]]。
