---
name: discord-tts-singing
description: 語音合成與唱歌的界線，以及暫緩的唱歌方案
---

- Qwen3-TTS 的文字輸入不含可控旋律；照譜唱要 SVS（歌詞加 MIDI／音高／時值），把已唱音檔換成目標音色則是 SVC（如 RVC）。TTS 朗讀歌詞或事後拉高音高不等於唱歌。
- 截至 2026-11-12，唱歌功能暫緩；只有在有人明確要求且有乾淨、授權可用的音源時再評估。可行方向是 OpenUtau／Score2ConVec 產生照譜演唱，再用 RVC 做音色轉換；VoiceDesign 產生的語音不能當作可直接訓練 RVC 的乾淨音源。
- 設計細節記在本機忽略的 `docs/design/PLAN_TTS.md` 附錄，未納入版本控制。

相關：[[discord-tts-model-selection]]、[[discord-voice-tts]]。
