---
name: discord-elevenlabs-tts
description: 已移除的 ElevenLabs 支援之歷史音色、API 權限與自訂音色資訊
---

- 2026-11-13 已移除專案中的 ElevenLabs 支援與相關設定。以下內容是舊版調查紀錄，不代表目前可用的 provider 或設定；不要按此設定專案。
- 移除前曾提到測試伺服器 `config.json` 可能留有未使用的 ElevenLabs API key；截取的紀錄沒有確認它是否已清除。只按 key 名稱確認，不記錄或複製其值。
- Voice Design 的聲音方向：自然的台灣華語年輕女性聲線，清亮、柔和圓潤但不幼；溫暖、俏皮、略帶 deadpan，語速放鬆、短句自然。避免客服腔、動漫腔、誇張情緒、氣音與戲劇旁白。重建時可用這段英文描述：

  > A natural, conversational Taiwanese Mandarin voice of a young woman in her early twenties, chatting casually with friends on Discord. Light, clear timbre, slightly soft and rounded rather than high-pitched or childlike. Standard Taiwanese Mandarin pronunciation with a gentle Taiwan accent, not a mainland Chinese accent, not a news anchor, not anime. Warm, playful and a little deadpan: a subtle smile in the voice, quick small reactions, relaxed pacing, short sentences. Avoid customer-service politeness, exaggerated emotion, whispering, breathiness and theatrical narration. She should sound like a real person talking, with natural micro-pauses and a friendly, slightly cheeky tone.
- `GET /v1/user/subscription` 需要 API key 的 `user_read` 權限；voice list/detail API 需要 `voices_read`。缺權限會回 HTTP 401，這不代表 TTS 本身不可用。
- 自訂 Voice ID 屬於建立它的 ElevenLabs 帳號。2026-11-12 換成另一帳號的 key 後，額度查詢與預置聲音 TTS 可用，但原自訂音色回 `voice_not_found`。換 key 前要用該 key 查 `/v1/voices/{voice_id}`，並以該音色實際合成測試；否則應改用擁有該音色的帳號，或分享／重建音色。當時測試伺服器的自訂音色仍不可用，先不要部署。
- 2026-11-12 使用者選 `eleven_v4_turbo`：成本較低且品質足夠。相同約 31 秒語音實測 v4 約 10.7 秒生成、v4 Turbo 約 3.1 秒。
- 2026-11-12 Voice Design API 用免費方案回 `403 feature_not_available`；當時 API 建立音色需付費方案。此為當時帳號方案實測，方案條件可能變動。
- ElevenLabs 官方說明不允許建立聽起來像兒童的聲音，也涵蓋成人刻意模仿童聲；不要用改寫提示詞的方式繞過。若要「屁孩態度」而非童聲，可描述成年女性的俏皮、挑釁語氣、快節奏、輕鼻音與微沙啞，同時保持成人音色。政策來源：[兒童或童聲是否可加入 Voice Library](https://help.elevenlabs.io/hc/en-us/articles/30183901911313-Can-Children-s-or-Child-Like-Voices-Be-Added-to-the-Voice-Library)、[Prohibited Use Policy](https://elevenlabs.io/use-policy)（查閱於 2026-11-12）。

相關：[[discord-voice-tts]]、[[discord-voice-design-experiments]]。
