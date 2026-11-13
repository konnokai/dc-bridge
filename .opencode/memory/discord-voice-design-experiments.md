---
name: discord-voice-design-experiments
description: 菲比啾比與 Gura 風格參考、本地 Qwen VoiceDesign 的能力與限制
---

- 「菲比啾比」是《鳴潮》周年團子活動中的梗語音，不是菲比平常的角色聲線。常見特徵是圓潤黏連的母音、些微鼻音與唸唱節奏；不同二創版本沒有單一標準母帶。角色原音與迷因音要分開處理。
- Gura 風格可拆成明亮前置共鳴、輕鼻音或微沙啞、快而短的句子、得意調侃與假生氣快速切換。可借用這些表演特徵，不需要仿製真人聲音或使用其錄音。
- 2026-11-13 使用者選了 VoiceDesign 候選 A（年輕女聲、偏高音、清亮、帶點撒嬌）；將其生成檔作為 Qwen3-TTS Base 的參考音後，固定聲線測試成功。Mac mini 上的參考檔為 `~/tts-server/refs/voice.wav`，測試伺服器設定使用 `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16`；這是合成參考音，不是真人錄音。更換音色可替換參考檔或調整 `tts.refAudio`，詳見 [[discord-voice-tts]]。
- 2026-11-12，使用者接受這類測試採用中國腔普通話，不堅持台灣腔。Mac mini 的 MLX 服務以 LaunchAgent `com.konnokai.tts-server` 常駐；plist 在 `~/Library/LaunchAgents/com.konnokai.tts-server.plist`。檢查可用 `launchctl print gui/501/com.konnokai.tts-server` 與 TTS 服務的 `/v1/models`。
- 當時 Mac mini 已快取 `mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16`。VoiceDesign 每次呼叫會重新抽聲線，無法用參考音檔固定音色；若需要固定，需使用支援參考音檔的 Base 模型，並以自己生成或有權使用的音檔作參考。這是 2026-11-12 的機器狀態，後續可能已變。
- 2026-11-12 已生成並送出 A（高音活潑）、B（微沙啞）、C（黏音撒嬌）三則原創風格測試；當時尚未記錄使用者選擇，這項狀態於 2026-11-13 選定 A 後已更新。ElevenLabs 歷史限制見 [[discord-elevenlabs-tts]]；語音工作流程見 [[discord-voice-tts]]。
- 2026-11-12 本地 Qwen 又生成三則「屁孩」風格普通話樣本（原配方、小新型、小埋型，約 21.84–22.96 秒）；2026-11-13 生成兩則派蒙風格普通話樣本（標準碎嘴、更兇更急，約 27.44–27.84 秒）。這些是 VoiceDesign 風格測試，不是角色原聲或固定聲線；目前沒有記錄使用者選擇。社群派蒙模型另見 [[discord-paimon-tts]]。
