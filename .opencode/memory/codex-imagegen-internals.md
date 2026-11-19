---
name: codex-imagegen-internals
description: Codex image_gen 的參數與 GIF 選項、輸出檔位置，以及怎麼判斷目前 CLI 有沒有 GIF feature
---

橋接的 `generate_image` 最後是 Codex 的 `image_gen.imagegen` 工具在做事。要查它支援什麼，
看上游原始碼 `openai/codex` 的 `codex-rs/ext/image-generation/`（`tool.rs`、`artifact.rs`、
`imagegen_description.md`、`imagegen_gif_description.md`）；`dsh-generate-image` 只是 adapter。

## 工具介面（2026-11 讀 main）

- `referenced_image_paths` 與 `num_last_images_to_include` 只能二選一；後者上限 5 張。
- `output_dir` 是存檔根目錄；`transparent_background` 預設 false。
- `gif: {}` 要求動畫，預設 9 格 × 200 ms；可另外給 `frame_count`、`frame_duration_ms`。
  guidelines 寫 2~16 格，API 文件另有 2~64 的說法，一律取 16 以下。
- 改一張 GIF 不能把 GIF 當 edit 輸入：先攤成等格 spritesheet，走 `referenced_image_paths`
  再要 GIF。

## 輸出位置

`$CODEX_HOME/generated_images/<session_id>/<call_id>.<png|gif>`。格式靠 base64 開頭判斷：
`R0lGODdh`／`R0lGODlh` 是 GIF，其餘當 PNG。所以硬碟上真的 `.gif` 就是動畫，
不是改了副檔名。

## feature 開關

GIF 在 `codex-rs/features` 叫 `image_generation_animation`（under development，預設關）。
`codex exec --enable image_generation_animation` 等於 `-c features.image_generation_animation=true`。

實測 2026-11-07（伺服器 `main-server-test-account`）：

| CLI | 有沒有這個 feature |
| --- | --- |
| 0.166.0 | 沒有；`--enable` 回 `Unknown feature flag` |
| 0.167.0 | `codex features list` 沒有 |
| 0.168.0-alpha.7 | 有，under development，false |
| 0.170.0（伺服器 2026-11-19 升級） | 有，under development，false |

判斷支援與否用 `codex features list`（非互動 shell 要先 `export PATH="$HOME/.nvm/versions/node/v26.12.1/bin:$PATH"`）。
**不要用 `grep` 二進位字串下結論**：0.166.0 的 binary 裡就看得到 `.gif`、`image/gif` 的處理痕跡，
`codex features list` 卻沒有 `image_generation_animation`，兩邊會互相矛盾。

不是 CLI 參數的另一種失敗：feature 有了，生圖回 `GIF output is not enabled for this request`，
那是這條路沒開 GIF preview。2026-11-19 用伺服器 0.170.0 實測（`--enable image_generation_animation`、
一樣的 wrapper 與 permission profile），後端仍回這一句。伺服器 `codex login status` 是
`Logged in using ChatGPT`（Codex OAuth）；官方 Images API 文件寫 `output_format: gif` 需要該模型的
GIF preview 權限，Codex OAuth 這條路目前沒開（openai/codex#59890、CLIProxyAPI #7269、sub2api #195 同結論）。
現在 `codexUsesChatGptAuth()` 會讀 `codex login status`（結果在 stderr），ChatGPT 登入時 `animated:true` 直接拒絕、
不 spawn Codex。要 GIF 得改走 API key 的 Images API。

替代方案曾實測可行但未接入：用靜態 2×2 spritesheet，裁成四格後以 ffmpeg 的 `palettegen`／`paletteuse`
編成 4 幀、5 fps GIF。這是近似動圖，效果取決於模型分鏡是否對齊；目前依決定維持 OAuth GIF 直接拒絕（2026-11-19）。

## 模型與額度

`dc-draw-image` 傳 `--ignore-user-config`，`~/.codex/config.toml` 的 `model` 被忽略；沒指定模型時
Codex 用預設值，2026-11-19 實測 0.167.0 與 0.170.0 的預設都是 `gpt-6.2-sol`，所以之前的生圖額度
全記在 Sol、不是 config 裡的 `gpt-6-luna`。

現在 `latestLunaModel()` 從 `$CODEX_HOME/models_cache.json` 挑版本號最大的 Luna（6.10 > 6.9 > 6，
只收 `visibility: list`，hide／none 跳過），`codexOptions()` 用 `-c model=` 指定；讀不到清單才退回 `gpt-6-luna`。
`--ephemeral` 讓這些 session 不進 history，用量看板只看得到模型名稱。

## API 端（橋接目前沒直接呼叫）

Images 2.6 在 2026-11-04 上線，兩個模型 `gpt-image-2.6-flare`、`gpt-image-2.6-sunburst`。
GIF 是 `output_format: "gif"` 加 `frame_count`、`frame_duration_ms`。真要走 API 再回來核對欄位名。

相關：[[gh-read-remote-file]]、[[dc-bridge-tests]]
