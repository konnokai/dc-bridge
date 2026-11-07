---
name: discord-prts-mcp
description: PRTS MCP 外部 npx stdio MCP、釘版本 3.2.3、工具白名單同步
---

PRTS（明日方舟資料）走外部 npm 套件 `prts-mcp@3.2.3`，由 DSH 的 MCP 客戶端透過 npx stdio 拉起，不是橋接自己起的行程。

- DSH 端：`scripts/setup-dsh.mjs` 註冊 `mcp-prts`，`serverName: 'prts'`，
  `command: 'npx'`、`args: ['-y', '--package=prts-mcp@3.2.3', 'prts-mcp']`，
  `env: { PRTS_TRANSPORT: 'stdio', IMAGES_ENABLED: 'false' }`。
  釘版本避免每次啟動被 latest 換掉；DSH 0.2.1-rc.2 的 env 會 scrub credential-shaped 與 `DSH_*` 名稱，
  但 configured env 會 merge on top，所以 explicit overrides 生效。
- `IMAGES_ENABLED=false` 關掉 `operator_artwork`（23 個查詢工具就夠用，base64 圖片不該進模型 context）。
- `prts-mcp` 第一次跑會下載約 600MB（原生 binary＋離線資料）；DSH 的 60 秒初始化逾時會讓它這次沒有工具，
  所以部署前先跑一次 `PRTS_TRANSPORT=stdio npx -y --package=prts-mcp@3.2.3 prts-mcp --help` 預熱。
- 幹員名要填遊戲內的簡體中文（`阿米娅`、`凯尔希`），填繁體會回「未找到干员」並提示正確名稱；
  回話仍照平常繁體。
- `dc-tool-restrict.mjs` 的 `PRTS_TOOLS` 必須列齊所有 `mcp__prts__*` 工具（目前 23 個）；
  prts-mcp 升版新增工具時要同步這份清單（IMAGES_ENABLED 開啟時還多 `operator_artwork`）。
- `dc-chat` preset 放行 PRTS（`allowPrts: true`）；`dc-learner` 與 `dc-trader` 在註冊期隱藏、執行期再擋一次。
- `dc-session-token.mjs` 的 `TOKEN_TOOLS` 不含 prts（公開資料，不需會話令牌）。
- persona（`dsh/agent-presets/dc-chat/agent.cordis.yml`）加了【明日方舟資料（PRTS）】段落，
  並把安全邊界第 1 條的「不算本機工具」括號補上 PRTS 資料查詢。
- docs 同步：`docs/guides/DISCORD.md`（工具清單、setup 說明、MCP 來源）。
- 測試：`scripts/test-discord-prts.mjs`（dc-chat 放行、其他 preset 隱藏並擋）。

superseded：舊做法是 HTTP MCP（`http://127.0.0.1:3011/mcp`）＋Docker container `ghcr.io/3akhp/prts-mcp:3.2.3`，
`IMAGES_ENABLED=true` 由 container 決定、`GITHUB_TOKEN` 放 container 環境、HTTP MCP 無認證綁 0.0.0.0:3011。
2026-11-07 起改為 npx stdio transport，不再用 Docker container。

相關：[[discord-web-fetch]]。