---
name: discord-tts-model-selection
description: 本地多語 TTS 模型比較與 Apple Silicon 選型限制
---

- 2026-11-12 的需求是 Mac mini M4 16GB 本地合成中、日、英、韓語，並希望能設計音色與控制語氣。當時提供的 Artificial Analysis 連結是 ASR（語音轉文字），TTS 應看 [TTS leaderboard](https://artificialanalysis.ai/text-to-speech/leaderboard)。
- 當時首選 Qwen3-TTS 1.7B VoiceDesign：涵蓋四種目標語言，支援 voice design 與自然語言語氣指令，`mlx-audio` 有 MLX 版本。6-bit 約 3.9GB、1.66× 即時的數字來自當時參考資料，未在 M4 實測；Qwen 未列在 Artificial Analysis 榜上，不代表表現差，只是當時沒有 provider 提交測試。
- Ming-3.0-TTS 0.5B 是較小的替代方案：MIT 授權，提供 emotion／speed／pitch 控制與 inline tags；當時找到 MLX port，但沒有速度資料，需自行測速。
- VoxCPM2 有多語、voice design 與 Apache-2.0 授權，但當時 MLX 比較資料報告約 0.48× 即時。Fish Audio Drama 3 雖在當時榜上領先開放權重，約 41.5GB 權重不適合 16GB 機器。
- 2026-11-12 比較後，Discord 後端選 `mlx_audio.server` 的 OpenAI 相容 `/v1/audio/speech`；Voicebox 留作試音與調音。Voicebox backend 也能 headless 執行，不必開桌面 app；它多了 voice profiles、歷史、分段 crossfade、效果器等工作流，橋接目前不需要。兩者的 API 當時都沒有認證，只能放 LAN 或 VPN。
- Voicebox 在 macOS 的 Qwen VoiceDesign／CustomVoice 路徑使用 PyTorch（MPS 不支援時可能退 CPU）；只有 Base 克隆路徑使用 MLX。固定音色目前採 Qwen3-TTS Base 加參考音，詳見 [[discord-voice-tts]]；音色實驗見 [[discord-voice-design-experiments]]。
- `mlx_audio.server` 的 `lang_code` 預設值 `"a"` 是 Kokoro 用碼，不能直接當 Qwen 語言值；2026-11-12 查到 Qwen 要傳 `Chinese`、`English`、`Japanese`、`Korean` 等名稱。API 行為可能隨版本變動。

參考：[Qwen3-TTS](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign)、[MLX Audio](https://github.com/Blaizzy/mlx-audio)、[Ming-3.0-TTS](https://huggingface.co/inclusionAI/Ming-3.0-tts-0.5B)、[Artificial Analysis TTS](https://artificialanalysis.ai/text-to-speech/leaderboard)（資料快照：2026-11-12）。
