---
name: discord-social-post-fetch
description: web_fetch 的 ebfix 社群貼文抓取與可選 Firecrawl shell fallback
---

- 2026-11-20 起，`web_fetch`（`src/mcp-web-search-safe.js`）對 Threads／Instagram／Facebook 貼文先用自架 ebfix 取得作者與正文；拿不到貼文時才考慮 Firecrawl。一般頁面只有標題或殼層、沒有正文時也可走 Firecrawl。X／Twitter 仍走 FxEmbed，見 [[discord-twitter-post]]。
- Firecrawl 由 `config.json` 的 `webSearch.firecrawlURL` 控制；空值時不呼叫。測試伺服器曾設為 `http://127.0.0.1:3002`。Compose 位於 `deploy/firecrawl/`，只綁 loopback，映像固定 digest；部署說明在該目錄 README。
- Firecrawl 是另一條網路抓取路徑。回傳內容仍是不可信資料；保留 `untrustedData` 包裝與內網目標阻擋測試。2026-11-20 實測 Firecrawl 拒絕抓取內網控制台位址；不要因此省略 MCP 的安全測試。
- 驗證：`scripts/test-discord-embed-fix.mjs`、`scripts/test-discord-firecrawl.mjs`，以及當日 Discord suite 39/39、Audit suite 19/19；伺服器 MCP 實測 ebfix 回傳 Threads 作者／正文，Firecrawl shell fallback 有標示來源。
- Firecrawl 渲染曾連續兩次回空、第三次成功；失敗時保留「只有標題／沒有正文」結果。需要登入的頁面仍可能只回導覽內容。當日沒有在 Discord 頻道送測試訊息。
- 測試伺服器於 2026-11-20 啟用 Firecrawl Compose，並在 `config.json` 設定上述 URL；停用整合可清空 `webSearch.firecrawlURL`，停服務用 `docker compose down`。MCP 程式部署需依 [[discord-deploy]] 流程重啟 DSH。

相關：[[discord-web-fetch]]、[[discord-security-baseline]]。
