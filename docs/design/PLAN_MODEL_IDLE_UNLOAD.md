# 計畫：模型閒置自動卸載（Mac 端）

> 狀態：**已實作**（2026-11-24）。Mac mini 已裝 ffmpeg、`~/tts-server/server.py` wrapper 已上線；
> 實測兩個模型閒置 310 秒後卸載。
> 目標：TTS／ASR 模型閒置 5 分鐘就卸載，把 RAM 還給 macOS；下次要用再自動載回來。
> 範圍：`mlx_audio.server`（Mac mini，8100 埠）。`omlx-server`（8000，bge-m3 嵌入）不在這次範圍。

## 實測：目前吃多少

2026-11-24，M4 16GB，macOS 27.0.1，開機 50 天：

| 項目 | 數值 |
| --- | --- |
| 清理前 | 15 GB used、353 MB unused；swap 4.64 GB／5 GB |
| TTS 程序 footprint | 9.16 GB（VoiceDesign + Base 兩個 1.7B bf16） |
| 卸載沒用的 VoiceDesign 後 | 4.65 GB；swap 1.74 GB |
| 重啟＋只載 Base | 4.64 GB；服務 8 秒、冷載入 5.2 秒 |
| 再合成一句後 | **6.88 GB**（MLX 把 buffer 留在 process） |
| 另一台常駐 | `omlx-server` 1.6 GB（`historyArchive` 的 bge-m3） |

`config.json` 的 `tts.model` 是 Base。VoiceDesign 是 11/13 換模型後留在記憶體裡的，沒有在用。

結論：16 GB 的機器，**一個** 1.7B bf16 模型活躍時約 6.9 GB；兩個就 9.2 GB，直接吃 swap。
閒置時要降回 100 MB 附近。

## 關鍵限制：DELETE 不會馬上還 RAM

實測 `mlx_audio` 0.6.5（上游 main 也一樣）：

- `DELETE /v1/models` 只把模型從 `model_provider.models` 移除，沒有呼叫 `mx.clear_cache()`。
- 移除後等 10 秒，footprint 完全不變。
- 獨立程序實測：`mx.clear_cache()` 可以把 MLX 的 buffer 還給 OS（512 MB → 0）。
- 用 wrapper 在 8101 埠實測（Kokoro 82M）：載入後 401 MB，DELETE 後 **89 MB**。
- 正常合成也會留下 cache：預載 Base 4.64 GB，合成一句變 6.88 GB。沒有卸載就不會降。

所以「只打 DELETE」不夠，還缺一個 in-process 的 `clear_cache()`。

## 設計：卸載放在 Mac 端

橋接端計時器有這些問題：橋接重啟就消失、漏一次 `done` 就永遠不卸載、
從 GET 到 DELETE 之間可能有新請求、看不到其他用戶端、設定放在 `tts` 卻也管 `stt`。

改成 Mac 端一個 wrapper 管完：記錄每個模型最後使用時間、計算進行中的請求、
每 30 秒檢查一次，閒置超過 5 分鐘就卸載。橋接不用改任何程式。

### `~/tts-server/server.py`（新檔）

```python
import asyncio
import gc
import os
import time

import mlx.core as mx
import mlx_audio.server as s

IDLE_SEC = int(os.getenv("MLX_IDLE_UNLOAD_SEC", "300"))
CHECK_SEC = int(os.getenv("MLX_IDLE_CHECK_SEC", "30"))
VERBOSE = os.getenv("MLX_IDLE_UNLOAD_VERBOSE") == "1"

_last_used = {}
_inflight = 0
_sweeper_task = None
_provider = None


def _log(message):
    print(f"[idle-unload] {message}", flush=True)


def _patch_provider():
    provider = s.model_provider
    original_load = provider.load_model
    original_remove = provider.remove_model

    def load_model(name):
        model = original_load(name)
        _last_used[name] = time.monotonic()
        return model

    async def remove_model(name):
        removed = await original_remove(name)
        _last_used.pop(name, None)
        gc.collect()
        mx.clear_cache()
        return removed

    provider.load_model = load_model
    provider.remove_model = remove_model
    return provider


class ActivityMiddleware:
    """算進行中的 HTTP 請求；推理請求結束後更新最後使用時間。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        global _inflight
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        _inflight += 1
        _ensure_sweeper()
        try:
            return await self.app(scope, receive, send)
        finally:
            _inflight -= 1
            path = scope.get("path", "")
            if path.startswith(("/v1/audio/speech", "/v1/audio/transcriptions", "/v1/audio/separations")):
                now = time.monotonic()
                for name in list(_last_used):
                    _last_used[name] = now


async def _sweeper():
    while True:
        await asyncio.sleep(CHECK_SEC)
        if IDLE_SEC <= 0 or _inflight > 0:
            continue
        now = time.monotonic()
        for name in list(_provider.models):
            _last_used.setdefault(name, now)
            idle = now - _last_used[name]
            if idle < IDLE_SEC:
                continue
            if VERBOSE:
                _log(f"unload {name}（idle {idle:.0f}s）")
            try:
                await _provider.remove_model(name)
            except Exception as error:
                _log(f"unload failed {name}: {error}")


def _ensure_sweeper():
    global _sweeper_task
    if _sweeper_task is None and IDLE_SEC > 0:
        _sweeper_task = asyncio.create_task(_sweeper())


def _install():
    global _provider
    _provider = _patch_provider()
    s.app.add_middleware(ActivityMiddleware)


if __name__ == "__main__":
    try:
        _install()
    except Exception as error:
        # 內部介面改了也不要讓 TTS 全掛：記 log，用沒 patch 的版本照常跑。
        _log(f"disabled: {error}")
    s.main()
```

`~/tts-server/run.sh` 最後一行改成：

```bash
exec .venv/bin/python "$HOME/tts-server/server.py" \
  --host 0.0.0.0 --port 8100 --log-dir "$HOME/tts-server/logs"
```

- 環境變數：`MLX_IDLE_UNLOAD_SEC=300`（0＝關閉）、`MLX_IDLE_CHECK_SEC=30`。
- 一定要用 `workers=1`、`reload=False`（現在就是）；uvicorn 會用同一個 `sys.modules` 裡的 app，
  patch 才有效。
- `on_event("startup")` 在 0.6.5 + FastAPI 0.162 不會觸發（2026-11-24 實測），所以 sweeper
  改由第一個 HTTP 請求啟動。沒有請求時也不需要卸載。
- 只依賴 `model_provider.load_model`／`remove_model` 這兩個既有介面。
  改名時啟動會記 `disabled`，TTS 照常，只是不卸載。

### 行為

- 模型載入時記時間；每次 `/v1/audio/*` 請求結束再更新。
- 第一個請求進來時啟動 sweeper；之後每 30 秒檢查。
- 有請求在跑就不卸載（`_inflight > 0`）。
- 閒置 ≥ 5 分鐘且沒有請求：逐一 `remove_model` → `gc.collect()` → `mx.clear_cache()`。
- 分模型卸載：只有 TTS 在用時，ASR 先被卸載；反過來也一樣。
- 卸載後第一個請求會重新載入；Base 冷載入實測 5.2 秒，`tts.timeoutMs` 60 秒夠。

## 驗證

1. 重啟服務，`curl /v1/models` 應該只有實際載入的模型。
2. 合成一次，確認 `top` 的 footprint 上升。
3. 等 5 分鐘（或把 `MLX_IDLE_UNLOAD_SEC=30` 暫時調短）：
   - `curl /v1/models` 要是空的。
   - `top -pid <pid>` 要掉到 100 MB 附近。
4. **用真的 Qwen3-TTS Base 和 Qwen3-ASR 各量一次**，不要只量 Kokoro：
   - TTS 6.88 GB → 100 MB？
   - ASR 載入後 → 卸載後？
5. 量 ASR 推論中呼叫卸載（`_inflight > 0`）不會發生，log 沒有 unload。

## 風險

- `mx.clear_cache()` 與推論同時跑的安全性沒有官方保證；我們只在 `_inflight === 0` 時呼叫。
  真機驗證要包含「剛卸載完立刻再請求」與「TTS／ASR 交替」。
- 依賴 mlx-audio 內部介面（`model_provider.models`／`load_model`／`remove_model`）。
  升級後要跑一次第 3 步。
- uvicorn `--reload` 或 `workers > 1` 會讓 patch 失效；run.sh 不要開。
- 卸載後第一次語音回覆多約 5 秒；可接受。

## 回退

1. `MLX_IDLE_UNLOAD_SEC=0`：wrapper 還在，但不卸載。
2. `run.sh` 改回 `.venv/bin/mlx_audio.server`：完全回到原狀。
3. 刪掉 `~/tts-server/server.py`。

## 橋接端不用改

- 不需要 `discord-model-idle.mjs`、`tts.idleUnloadSec`、控制台欄位或測試檔。
- ASR 的長工作期間 `_inflight > 0`，不會被卸載。
- 橋接重啟不影響卸載計時，因為計時在 Mac 程序裡。
