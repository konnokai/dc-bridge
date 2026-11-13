# 計畫：TTS 語音回覆（Discord 版）

> 狀態：**已實作**（2026-11-12）。程式在 `src/core/discord-tts.mjs`、`send_voice` 工具與橋接的
> `agentHandlers.sendVoice`；離線測試 `scripts/test-discord-tts.mjs`。後端只用本機 mlx_audio。
> 目標：模型能自己決定把一句話「說出來」；合成失敗或送出失敗時，一律退回文字或普通附件，不能讓回覆消失。

## 已完成的實測

用測試伺服器的 bot token 實打，不是推測。

| 項目 | 值 |
| --- | --- |
| guild | `506083124015398932` |
| channel | `1565262900124196895`（大肥魚對話測試） |
| 訊息 id | `1570294659253543053` |
| flags | `8192`（`MessageFlags.IsVoiceMessage`） |
| attachment | `audio/ogg`、`waveform` 有值、`duration` 2.02 秒 |
| 音檔 | 2 秒正弦波、OGG/Opus 32k、9,886 bytes |
| waveform | 256 bytes，base64 後 344 字元 |

送法（discord.js 14.27）：

```js
const att = new AttachmentBuilder(oggBuffer, { name: 'voice-message.ogg' });
att.setWaveform(waveformBase64);   // 256 bytes 峰值，0–255
att.duration = 2;                  // 秒，可帶小數
await channel.send({ flags: MessageFlags.IsVoiceMessage, files: [att] });
```

結論：**voice message 可以直接用，不需要先退回附件。** fallback 仍然要做，原因見下面「失敗處理」。

## 設計界線

**TTS 是工具，不是自動裝飾。** 橋接的架構是模型自己呼叫 `send_message`；自動把每則回覆轉語音會多送一則、延遲不可控，也違反「不呼叫就不會發出東西」的既有規則。

- 後端只負責合成，不管人格、不管文字清洗。
- 文字清洗、長度、安靜期間、補句、拒絕，全部沿用 `agentHandlers.send` 那條路。
- QQ 的 `voice-core.js` 是語音庫（檔案播放），不沿用；QQ 平台的 `send_group_ai_record` 在 Discord 沒有對應。

## 對外介面

新 MCP 工具 `send_voice`（`src/mcp-discord.js`），跟 `send_image` 並列：

| 參數 | 必填 | 說明 |
| --- | --- | --- |
| `text` | ✅ | 要說的話，上限 `tts.maxChars`（預設 150） |
| `instruct` | | 語氣描述，例如「溫柔、帶點笑意」；上限 200 字 |
| `language` | | `zh` / `en` / `ja` / `ko`；預設 `auto` |
| `voice` | | CustomVoice 的預設聲（Vivian、Serena、Ryan…）；不給就走 VoiceDesign |
| `reply_to` | | 同 `send_message` |

回傳跟 `send_message` 一樣的 `#編號`，讓模型後續可以改、收回。

**不新增「自動 TTS」開關。** 要常駐語音就把規則寫進人格，讓模型每輪自己呼叫。

## 後端呼叫

```
POST http://<mac-mini>:8100/v1/audio/speech
{
  "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16",
  "input": "<text>",
  "instruct": "<instruct>",
  "lang_code": "Chinese | English | Japanese | Korean",
  "response_format": "wav",
  "speed": 1.0
}
```

- `response_format` 用 `wav`：Discord 一定要 OGG/Opus，交給橋接的 ffmpeg 轉比較可控；
  mlx_audio 的 `ogg` 輸出沒有實測過。
- `lang_code` 要帶**全名**（`"Japanese"`），不是 `"ja"`。mlx_audio.server 的預設值是 `"a"`
  （Kokoro 的美式英文碼），Qwen 認不得，會走「無語言提示」的路徑。
- 逾時 60 秒；失敗直接回 tool error，模型可以改用 `send_message`。

## 橋接改動（檔案級）

| 檔案 | 改動 |
| --- | --- |
| `src/core/discord-core.mjs` | 新增 `tts` 設定區塊與範圍驗證（照 `media` 的寫法） |
| `src/core/discord-tts.mjs` | **新檔**：`synthesizeSpeech()`、`toVoiceOgg()`、`makeWaveform()`、`probeDuration()` |
| `src/mcp-discord.js` | 新增 `send_voice` 工具（timeout 120 秒） |
| `src/discord-bridge.js` | `agentHandlers.sendVoice`；`deliverAgentMessage` 加 `voice` 參數；`sendLong` 的 `channel.send` 加 flags 與 waveform |
| `config.example.json` | 補 `discord.tts` 範例 |
| `docs/guides/DISCORD.md` | 補設定與權限說明 |

`sendLong` 的落點在 `src/discord-bridge.js:1431`：

```js
...(index === 0 && file ? { files: [{ attachment: file.buffer, name: file.name }] } : {}),
```

語音版本要多帶 `flags: MessageFlags.IsVoiceMessage`，並把 `file` 換成
`{ attachment, name, waveform, duration }`。只掛第一段。

## 設定

```json
"tts": {
  "enabled": false,
  "baseUrl": "http://192.168.98.105:8100",
  "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16",
  "accent": "標準台灣華語，咬字清楚，不要用粵語",
  "refAudio": "",
  "refText": "",
  "timeoutMs": 60000,
  "maxChars": 150,
  "cooldownSec": 30,
  "maxPerTurn": 1,
  "channels": []
}
```

- `enabled` 預設 `false`：跟 QQ 的 `socialV2.voice.enabled` 同一個原則，先放行才生效。
- `channels` 留空 = 全部頻道；有值 = 只開這些頻道。
- `maxPerTurn` 暫定 1，避免模型每句都發語音洗版。
- `accent` 每次合成接在 `instruct` 後面。VoiceDesign 只給「溫柔」這類描述時可能挑到粵語腔，預設補「標準台灣華語，咬字清楚，不要用粵語」；留空 = 不補。
- **2026-11-12 追加實測**：繁體會被唸成粵語，橋接先轉簡體才變普通話；但 mlx 的 Qwen3-TTS 只有中國腔，
  accent 調不出台灣腔。
- **2026-11-13 移除 ElevenLabs**：免費 key 拿不到原本的自訂聲音，Voice Design API 也要付費；
  只留本機 mlx。設定裡的 `provider`、`apiKey`、`voiceId`、`elevenModel`、`warnPercent` 一起刪掉。

## 固定聲音（Base + reference）

VoiceDesign 每次呼叫都會重新抽聲線。要固定聲音，把 `model` 換成 Base，再給 `refAudio`／`refText`：

```json
{
  "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
  "refAudio": "/Users/konnokai/tts-server/refs/voice.wav",
  "refText": "參考音檔裡實際唸的文字"
}
```

- mlx_audio 的 `/v1/audio/speech` 吃 `ref_audio`（**伺服器本機絕對路徑**，不是上傳）與 `ref_text`；
  Base 模型兩者都有才會進 ICL 模式（`mlx_audio/tts/models/qwen3_tts/qwen3_tts.py` 的 `generate()`）。
- `refText` 跟要合成的文字一樣會先轉簡體，繁簡混用不會讓參考音被唸成粵語。
- 載入設定時就擋掉只填一邊、相對路徑，以及「Base 模型但沒有 refAudio」；不默默退回每次亂抽的聲音。
- 走複製時不送 `instruct`、`accent`、`voice`：Base 沒有預設聲，instruct 也不參與。
  模型若仍填了 `instruct`，工具回覆會註明這一輪沒有用到。
- 參考音建議 5～15 秒、單一說話者、乾淨人聲；太長會拖慢每次合成。
- VoiceDesign 產生的音檔可以拿來當參考音，但音色會繼承生成時的缺點；要最乾淨就錄真人或使用有授權的音源。

## 語音訊息規格

| 項目 | 值 |
| --- | --- |
| 容器 / 編碼 | OGG / Opus |
| 聲道 / 位元率 | 單聲道 / 32k |
| 檔案上限 | 10MB（Discord 免費帳號） |
| waveform | 256 bytes，每 byte 是 0–255 的峰值，base64 |
| duration | ffprobe 秒數，可帶小數 |
| flags | `MessageFlags.IsVoiceMessage`（8192） |
| 最短長度 | 1.2 秒（太短客戶端可能不顯示，未實測） |

ffmpeg 參數：

```
ffmpeg -y -i in.wav -c:a libopus -b:a 32k -ac 1 -ar 48000 out.ogg
```

## 失敗處理

| 情況 | 行為 |
| --- | --- |
| 後端逾時 / 5xx | tool error，模型改用 `send_message` |
| ffmpeg 轉檔失敗 | 同上 |
| voice message 被 Discord 拒絕 | 自動改送普通附件（同一份 OGG），回報已降級 |
| 頻道沒有「附加檔案」權限 | 403，訊息跟 `send_image` 一致 |
| 文字超過 `maxChars` | 截斷並在回報裡講 |
| 安靜期間 / 補句 / 拒絕 | 跟 `agentHandlers.send` 完全一樣 |

## 測試

**離線（不需要網路）**

- `makeWaveform()`：長度 256、值域 0–255、靜音全 0、滿幅接近 255。
- `probeDuration()`：解析 ffprobe JSON，缺檔不炸。
- 設定驗證：`baseUrl` 必須 http(s)、`maxChars` 範圍、`enabled` 預設 false。
- fallback 決策：voice 失敗時只重送一次附件。
- `voiceGate()`：開關、頻道、長度、每輪上限、冷卻。

**live（`QQ_BRIDGE_TEST_LIVE=1`）**

- 送一則到測試頻道，回讀 `flags`、`attachments[0].contentType`、`waveform`。
- 故意給錯 `baseUrl`，確認回 tool error 且頻道沒有半則訊息。

**回歸**

- `npm run test:discord` 全綠；`send_message` / `send_image` 不受影響。

## 部署

1. Mac mini 先跑 `mlx_audio.server --host 0.0.0.0 --port 8100`（只開 LAN；8000 是 omlx-server 在用）。
2. 橋接設 `discord.tts.baseUrl`，`enabled` 先開在測試頻道。
3. 量延遲：1.7B VoiceDesign 約 1.1~1.2x 即時，10 秒語音大約 12 秒生成。
4. 確認手機與網頁版都看得到語音訊息。

## 未決

- **要不要雙輸出（文字 + 語音）？** 預設不要：模型已經有 `send_message`，要兩個就呼叫兩次。
- **每回合上限 1 則夠不夠？** 先做 1，被抱怨再放寬。
- **voice design 的描述要不要存成 profile？** 第一版不存，每次帶 `instruct`；之後如果發現聲音不穩定再說。
- **STT（聽語音）** 不在這份計畫；QQ 端目前也只顯示 `[語音]` 佔位。

## 風險

- mlx_audio.server 沒有認證，只能放 LAN 或 VPN；跟 Voicebox 一樣。
- Discord 語音訊息在舊版客戶端或某些第三方客戶端可能顯示成普通音檔。
- Mac mini 16GB 同時跑其他模型會擠；建議只留 Qwen3-TTS。
- 中文以外的語言品質只有 model card 宣稱，日韓要實聽再定案。
- 社群模型仍受角色與配音授權限制。

## 附錄：唱歌（SVS / SVC）— 擱置，不是這份計畫的範圍

> 2026-11-12 記下來，等有人真的要求再做。

**為什麼 TTS 不能唱**：TTS 的輸入只有文字，缺「旋律」這個條件。把歌詞丟進 Qwen3-TTS，
它只會用朗讀的節奏念完；硬拉 pitch 只會變成念歌，不是唱。

| 任務 | 輸入 | 輸出 | 代表 |
| --- | --- | --- | --- |
| TTS | 文字 | 說話 | Qwen3-TTS |
| SVS | 歌詞 + 音符（MIDI / pitch / duration） | 照譜唱 | DiffSinger、OpenUtau |
| SVC | 一段「有人唱」的音檔 + 目標音色 | 換音色唱 | RVC、so-vits-svc |

**做得到的管線**

1. 用 OpenUtau（或 Score2ConVec）把歌詞與旋律編成「有人唱」的音檔。
2. RVC / so-vits-svc 換成角色音色。目標音色需要 10–15 分鐘乾淨乾聲，不用標音素。
3. 橋接端多一個 `sing` 工具：吃「歌詞 + 簡譜/MIDI」，回音檔，走跟 `send_voice` 一樣的送出流程。

**前置條件（也是先不做的主因）**

- 需要一份乾淨的目標音色錄音，或現成的開源音源庫；voice design 產生的聲音不能直接拿去訓 RVC。
- 現成音源庫的授權要自己確認。
- 用 TTS 輸出當訓練資料不行：會把 TTS 的缺點一起學進去。

**成本**：RVC 在 M4 約 1GB 記憶體，OpenUtau 走 CPU/ONNX，16GB 夠。貴的是準備音源，不是算力。

**2026 的折衷方案**（要撿起來時先看這幾個）

- Score2ConVec：樂譜 → ContentVec → RVC/so-vits-svc，讓 SVC 音色直接照譜唱。
- RVC-Packer for OpenUTAU：把 RVC 的 `.pth` 包成 OpenUtau 音源庫。
- UniVoice（0.3B，研究階段）：melody 給 MIDI、音色給 audio prompt，說話與唱歌共用一個聲音。
- Ming-omni-tts 可以生成音樂，但不是照譜唱指定歌詞，別當 SVS 用。

**何時再撿起來**：有人明確要求角色唱歌，而且手上有一份可用的音源。
