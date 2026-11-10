---
name: discord-prts-mcp
description: PRTS MCP Docker HTTP container 3.2.4、IMAGES_ENABLED=true、operator_artwork 白名單、send_prts_artwork 與 generate_image prts: 參考
---

PRTS（明日方舟資料）走 Docker container `ghcr.io/3akhp/prts-mcp:3.2.4` 提供的 HTTP MCP（DSH 連 `http://127.0.0.1:3011/mcp`），不是橋接自己起的行程；舊做法是 npx stdio `prts-mcp@3.2.3`（已 superseded，見下方）。

- DSH 端：`scripts/setup-dsh.mjs` 註冊 `mcp-prts`，`serverName: 'prts'`，
  `url: 'http://127.0.0.1:3011/mcp'`（streamable-http），不再用 npx stdio args。
  立繪工具（24 個）由 container 的 `IMAGES_ENABLED=true` 決定，橋接這邊只寫 URL。
- `IMAGES_ENABLED=true` 開啟 `operator_artwork`（共 24 個工具）：`action=list` 只回檔名（純文字，便宜），
  `action=get` 才會把圖送進模型（`preview` 256px 約 41KB、`large` 1024px 約 276KB）。
  貼圖用 `mcp__discord__send_prts_artwork`，生圖參考用 `generate_image` 的 `inputImage: prts:<幹員>/<檔名>`。
- Docker image `ghcr.io/3akhp/prts-mcp:3.2.4` 首次 pull 約 600MB；DSH 的 60 秒初始化逾時會讓它這次沒有工具，
  所以部署前先 `docker pull` 預熱，DSH 啟動後 `curl http://127.0.0.1:3011/health` 確認 `{"status":"ok"}`。
- 幹員名要填遊戲內的簡體中文（`阿米娅`、`凯尔希`），填繁體會回「未找到干员」並提示正確名稱；
  回話仍照平常繁體。
- `dc-tool-restrict.mjs` 的 `PRTS_TOOLS` 必須列齊所有 `mcp__prts__*` 工具（目前 24 個，含 `operator_artwork`）；
  prts-mcp 升版新增工具時要同步這份清單。
- `dc-chat` preset 放行 PRTS（`allowPrts: true`）；`dc-learner` 與 `dc-trader` 在註冊期隱藏、執行期再擋一次。
- `dc-session-token.mjs` 的 `TOKEN_TOOLS` 不含 prts（公開資料，不需會話令牌）。
- persona（`dsh/agent-presets/dc-chat/agent.cordis.yml`）加了【明日方舟資料（PRTS）】段落，
  並把安全邊界第 1 條的「不算本機工具」括號補上 PRTS 資料查詢。
- 新增 Discord 工具 `send_prts_artwork`（artwork_id、variant preview/large、content/reply_to 可省略）；
  圖由橋接從 prts.wiki 抓、暫存到 `state/discord-images` 後送出，抓不到或沒 Attach Files 權限時回直連網址。
  佔「一輪 5 則」名額，不計入畫圖次數；`src/core/discord-core.mjs` 的 `PROGRESS_LABELS` 加了 `🖼️ 送立繪`。
- `generate_image` 的 `inputImage` 新增 `prts:<幹員>/<立繪檔名>`（最多 2 張 PRTS 立繪，檔名先用 list 拿；
  參考固定抓 large 1024px）；`dc-draw-image.mjs` 加 `PRTS_TOKEN` 與 `fetchPrtsReference`（橋接 `/prtsImage`）；
  `dc-tool-restrict.mjs` 同步放行。
- persona（`dsh/agent-presets/dc-chat/agent.cordis.yml`）加「要看或貼官方立繪」「要拿立繪當生圖參考」兩條。
- docs 同步：`docs/guides/DISCORD.md`（工具清單、setup 說明、MCP 來源、generate_image 說明）；
  `docs/FOLDER_MAP.md` 加 `core/prts-artwork.mjs`。
- 測試：`scripts/test-discord-prts.mjs`（operator_artwork 放行、名單外拒絕）；
  `scripts/test-discord-prts-artwork.mjs`（新增）；`scripts/test-discord-bridge.mjs` 的 DISCORD_TOOL_NAMES 含 send_prts_artwork（31 個）。
- DISCORD 工具數從 29 → 31。
- prts-mcp 的 SQLite 遊戲資料同步靠 GitHub Releases（`3aKHP/arknights-data-pipeline`）；未認證每小時 60 次會被限流，容器 log 會出現 `SQLite release discovery failed` 並退回內建資料，設定 `GITHUB_TOKEN` env 可提高。資料同步與 release discovery 走外部 repo 的 `src/sync/discovery.rs`／`database.rs`。
- Transport（2026-11-07）：改為 Docker HTTP。container `ghcr.io/3akhp/prts-mcp:3.2.4` 跑 HTTP 模式，DSH 以 `transport: streamable-http` 連 `http://127.0.0.1:3011/mcp`；`scripts/setup-dsh.mjs` 已同步產生此條目。npx stdio 為舊做法，npx 快取（~600MB）可清。
- `operator_artwork action=get` 的 large 變體：prts-mcp 3.2.4 起圖上限是 8 MiB（`PRTS_MAX_IMAGE_BYTES` 可覆蓋），但原圖不經縮圖直接進模型；橋接 `get_prts_artwork`（`/prtsImage`，`src/core/prts-artwork.mjs`，`MAX_IMAGE_BYTES=8MB`）會先縮到 `media.maxModelBytes`，模型看圖應走橋接路徑，生圖參考仍拿 large 原檔。
- 已知不穩定：`prts.wiki` DNS 回 8 個 A record，`safe-fetch` 最多嘗試前 4 個，其中部分可能不可達，造成 `請求超時：prts.wiki（已嘗試 4 個地址）`（約 20s）。橋接 `resolvePrtsArtwork` 受此影響。
- 2026-11-09 升到 3.2.4（commit `5bfae9a`）：Wiki 立繪上限 1MB→8MB（`PRTS_MAX_IMAGE_BYTES` 可覆蓋）。
  舊的「large 會被上游擋」理由不再成立，但規則仍留，因為原圖不經縮圖直接進模型；
  模型看圖走橋接 `get_prts_artwork`（`/prtsImage`，先縮到 `media.maxModelBytes`），
  生圖參考仍拿 `large` 原檔。docs 同步 6 處、`dc-tool-restrict.mjs` 擋法理由、persona 一句、preset patch 重產。

superseded：舊做法是 npx stdio transport（`prts-mcp@3.2.3` 由 DSH 用 npx 拉起）；
2026-11-07 起改為 Docker HTTP transport（container `ghcr.io/3akhp/prts-mcp:3.2.4`，DSH 連 `http://127.0.0.1:3011/mcp`），npx 快取可清。

相關：[[discord-web-fetch]]。