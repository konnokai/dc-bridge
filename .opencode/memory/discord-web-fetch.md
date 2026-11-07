---
name: discord-web-fetch
description: web_fetch 的 Google Docs/Slides/Sheets export 改寫、HTML og/title/正文抽取、normalizeWebFetchUrl 回 {url, expectText}
---

`web_fetch`（`src/mcp-web-search-safe.js`）的 URL 正規化搬到 `src/core/web-content.mjs`。

- `normalizeWebFetchUrl(input)` 回 `{ url, expectText }`，不再是字串。
  - Google Docs/Slides 改成 `export?format=txt`；Sheets 改成 `export?format=csv` 並保留 `gid`。
  - `/d/e/...` 已發佈文件不改寫；一般網址不改寫。
  - 只有真的改寫 Google 文件才 `expectText=true`，避免 `https://example.com` 這種沒結尾斜線
    的網址被誤判成 Google export（Opus review blocker，已補測試並 live 驗證）。
- HTML：讀 og:title、og:description、site_name、image，正文優先 `main`/`article`，最多 50000 字；
  純文字回 `text` 欄位；抓不到正文時明講「只拿到標題/登入頁」。
- `fetchVerdict`（`src/core/fetch-verdict.mjs`）依 `expectText` 判斷登入頁。
- `src/safe-fetch.js` 會按 `Content-Encoding` 解壓正文（gzip/x-gzip/deflate/br）；
  不支援的編碼回 `null`，呼叫端必須明確回「無法解析」，不能把壓縮過的字節當正文。
  - bilibili 即使不送 `Accept-Encoding` 也會回 `content-encoding: gzip`，是這次修復的觸發案例。
  - 多層編碼（如 `gzip, gzip`）改 fail-closed：中間解壓器壞掉會變 uncaught exception 弄掛 MCP server，所以直接當不支援。
  - 解壓失敗時一起 destroy `res` 與解壓器，避免 socket 卡住。
  - 空正文／204／尾端截斷用 `finishFlush: Z_SYNC_FLUSH` 寬鬆處理，不會整個失敗。
  - 錯誤訊息只放白名單編碼名稱（gzip/x-gzip/deflate/br/zstd/compress/identity）或「未知」，
    去重、最多 3 個，關掉 header prompt injection。
  - deflate 只支援 zlib 包裝，不支援 raw deflate；zstd 不支援（伺服器很少回）。
- `src/core/fetch-verdict.mjs` 新增 `looksBinary()`，二進位內容回 `isError`「無法解析正文」。
- 文件同步：`docs/guides/DISCORD.md`。
- preset dc-chat 規則：群友丟 URL 問內容先 `view_message`，預覽沒正文才 `web_fetch`（commit 696d78c）。避免模型看到 URL 就直接 web_fetch 原網址。

測試：`scripts/test-discord-web-content.mjs`（離線）、`scripts/test-audit-security-mcp.mjs`。
相關：[[discord-message-preview]]。