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
| 0.166.0（伺服器安裝的版本） | 沒有；`--enable` 回 `Unknown feature flag` |
| 0.167.0 | `codex features list` 沒有 |
| 0.168.0-alpha.7 | 有，under development，false |

判斷支援與否用 `codex features list`（非互動 shell 要先 `export PATH="$HOME/.nvm/versions/node/v26.12.1/bin:$PATH"`）。
**不要用 `grep` 二進位字串下結論**：0.166.0 的 binary 裡就看得到 `.gif`、`image/gif` 的處理痕跡，
`codex features list` 卻沒有 `image_generation_animation`，兩邊會互相矛盾。

不是 CLI 參數的另一種失敗：feature 有了，生圖回 `GIF output is not enabled for this request`，
那是帳號沒開 GIF preview。

## API 端（橋接目前沒直接呼叫）

Images 2.6 在 2026-11-04 上線，兩個模型 `gpt-image-2.6-flare`、`gpt-image-2.6-sunburst`。
GIF 是 `output_format: "gif"` 加 `frame_count`、`frame_duration_ms`。真要走 API 再回來核對欄位名。

相關：[[gh-read-remote-file]]、[[dc-bridge-tests]]
