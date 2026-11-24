---
name: discord-mlx-idle-unload
description: Mac mini mlx_audio 的 TTS／ASR 閒置卸載與記憶體回收
---

- 截至 2026-11-24，Mac mini 的 `mlx_audio.server` 已改由 `~/tts-server/server.py` wrapper 啟動；TTS 與 ASR 閒置 5 分鐘後會卸載模型。實測兩個模型閒置 310 秒後卸載。
- M4 16GB 的當日觀測：兩個 1.7B bf16 TTS 模型使程序 footprint 約 9.16 GB、swap 約 4.64 GB；卸掉未使用模型後約 4.65 GB。單一模型冷載入約 5.2 秒。這是 2026-11-24 的快照，不代表目前使用量。
- `mlx_audio` 0.6.5 的 `DELETE /v1/models` 只移除模型參照，不一定把記憶體還給 OS。Wrapper 在移除後呼叫 `gc.collect()` 和 `mx.clear_cache()`；只有沒有 HTTP 請求進行時才清理。
- Wrapper 在載入模型時記錄使用時間，追蹤進行中的請求，每 30 秒檢查一次；只卸載閒置模型，不卸載仍有請求的模型。卸載後由下個請求自動載回。
- 2026-11-24 實測 wrapper 時，註冊 FastAPI `startup` 回呼沒有啟動 sweeper；改由第一個 HTTP 請求呼叫 `_ensure_sweeper()`。服務沒有請求時也不需要卸載。
- 卸載計時器放在 Mac 端，不放橋接：橋接重啟不會重置計時，也能涵蓋其他用戶端。`omlx-server`（8000 埠）不在範圍內；mlx-audio 使用 8100 埠。
- Wrapper 依賴 `mlx_audio.server` 的內部 `model_provider` 介面；升級 mlx-audio 後要重新驗證卸載。服務需單一 worker 且關閉 reload。可用 `MLX_IDLE_UNLOAD_SEC=0` 停用自動卸載；完整細節見 `docs/design/PLAN_MODEL_IDLE_UNLOAD.md`。
- 連結：[[discord-asr]]、[[discord-voice-tts]]
