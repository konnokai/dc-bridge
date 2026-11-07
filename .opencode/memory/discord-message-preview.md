---
name: discord-message-preview
description: view_message/batch 讀取 Discord component embed、embed.author/provider/footer、完整 URL 與 component media，敏感 embed 不自動按 reaction
---

模型原本看不到群友貼的 component embed（type 10 文字、type 12 圖片）、`embed.author`、
以及完整網址，batch 也只有縮圖。修正集中在 `src/core/discord-context.mjs` 與
`src/core/discord-media.mjs`。

- `componentParts`：走訪 Components V2 的容器，抽出文字、檔案、媒體。
- `embedLines`／`embedImages`：補齊 `embed.author`、`provider`、`footer`、完整 URL。
- `viewMediaItems`：component media、gallery 圖優先於 thumbnail、V2 File 的 cdn/proxy 只送一次、
  敏感 embed（`embed.flags`）不自動按 reaction。
- `visibleAttachments`：V2 File 隱藏的附件過濾成共用函式（`src/core/discord-context.mjs`）。
- batch 加一行 `[連結預覽：…]`，讓模型不只看到縮圖。
- 媒體去重依 URL pathname；沒有 content-length 時會先讀完整 body 才檢查大小（已知限制）。

測試：`scripts/test-discord-bridge.mjs` 新增 component media、V2 File 去重案例。
相關：[[discord-blacklist-stale]]、[[discord-quiet-gate]]、[[discord-web-fetch]]。