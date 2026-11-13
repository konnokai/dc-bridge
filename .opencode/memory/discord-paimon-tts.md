---
name: discord-paimon-tts
description: 派蒙社群 TTS 模型評估、授權與已放棄狀態
---

- 2026-11-13 查閱 `xianglun918/paimon-tts`：GPT-SoVITS v2 有中文 PM 權重（約 162 MB、6.5 秒中文 reference）和日文 TN 權重（約 202 MB、3 秒日文 reference），並宣稱支援跨語言合成。當時 GitHub Release 提供權重與 reference 音檔，沒有預先生成的 demo；推理腳本才會產生語音。
- 同日把 `wesjos/spark-tts-genshin-charactors` 附的 `paimon.wav` demo 發到 Discord 試聽。這是模型作者提供的範例，不是本地生成；該 Hugging Face 模型卡列有 paimon 模型、Spark-TTS 0.5B 與 Apache-2.0。推理環境和 Mac 上的速度沒有實測。
- `paimon-tts` 專案標示 MIT，但其模型權重限個人研究與非商業用途；角色和配音權利仍屬原權利人。不要把專案程式碼授權誤當成權重或角色聲音可任意商用。
- 2026-11-13 已在 Mac mini 實際安裝並推理 PM 權重，成功生成中文樣本；再以原廠唐詩設定、按句切分及調高 `top_p`／`temperature` 生成對照。使用者聽後認為派蒙 TTS 音質與語調比 Qwen3-TTS 差，決定放棄，回到 Qwen3-TTS。
- 測試時 `xianglun918/paimon-tts` 的 `GPT_SoVITS` 是 gitlink，但 checkout 沒有 `.gitmodules`，`git clone --recurse-submodules` 會失敗。當時的可行作法是獨立 clone `RVC-Boss/GPT-SoVITS`，再 checkout gitlink 指向的 `08d627c3338173c3229286d8787060d6559fe0f8`；上游 repo 當時的 HEAD 為 `548c6fc`。這是 2026-11-13 的復現方式，之後 repo 結構可能已變。
- 測試完成後刪除 Mac mini 上的 `~/paimon-tts`，釋出約 4.2 GB；沒有接入橋接，也沒有留下可直接使用的生成音檔。不要把先前分享的 reference／demo 誤認成本機生成結果。
- 之前的 Qwen 派蒙風格提示詞測試不是派蒙角色配音，見 [[discord-voice-design-experiments]]；測試伺服器的 Qwen3-TTS 回復設定與語音流程見 [[discord-voice-tts]]。
