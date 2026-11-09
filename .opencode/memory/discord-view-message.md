---
name: discord-view-message
description: view_message 找修復 bot、連結路徑比對、bot 訊息可見性與每日摘要
---

- 修復 bot 完整網址：`view_message` 除了 embed，也列出修復 bot 的訊息本文（換過網域的完整 URL）；embed title/description 仍只寫網域（commit e5d6326）。
- 影片連結（yt-dlp）：`view_message` 遇到白名單 YouTube 連結（`youtube.com`、`youtu.be`、`m.youtube.com`、`music.youtube.com`、`youtube-nocookie.com`）且 `videoLinks.enabled` 且還有圖片名額時，用 `yt-dlp -g` 取直連串流（360p）再 ffmpeg 抽 6 格；失敗只多一行「影片連結看不了：…」。白名單防 SSRF。預設關閉；`videoLinks.ytDlpPath` 留空用 `YTDLP_PATH` 或 PATH。伺服器實測 yt-dlp 2026.10.21、ffmpeg 7.1.3，部署後已開 `videoLinks.enabled`（commit 0daf66e / b6376a6）。
- 修復連結比對：`src/core/discord-context.mjs` 新增 `linkPaths`，只看網址路徑（至少兩段），所以只換網域的修復連結（`fxtwitter`/`fixupx`/`ddinstagram`）認成同一條。`view_message` 找修復 bot 的條件：回覆 target 或路徑相同；排除自己、取最近 3 則。`b23` 這類整個換路徑的短連結只能靠回覆關係（`shortcut:` 註解）。
- bot 訊息可見性：`view_message`／`read_history`／`search_history` 不排除 bot，bot 訊息會出現在結果並拿到 `#編號`。新訊息批次 `messageCreate` 看到 bot 直接 return，修復 bot 回覆不會主動進 prompt；`view_message` 看原訊息時自動帶附近「回覆它」或「同路徑連結」的 bot 訊息。不建議批次也讀 bot（迴圈、噪音、token、injection）。
- 每日頻道摘要：fetch 最近 `SUMMARY_MAX_MESSAGES`，過濾 `deny.users`、過濾 bot 或非 skip、since 24h、>= `SUMMARY_MIN_MESSAGES` 才生成；包含 bot 訊息。
- 引文帶編號：`formatQuote`（`src/core/discord-context.mjs`）多收 `ref`，輸出 `[引用 #k7f3ab 阿華：…]`；`buildBatchPrompt` 把被引用那則登記進編號表，模型可直接 `view_message` 看全文／附件。`【新訊息】` 標頭改成「#編號 用來指定要回覆、查看或按 reaction 的訊息」；dc-chat persona 加一句：看到 `[引用 #編號 …]` 要看全文、圖片或附件就用 `view_message`。已知缺口：`【最近頻道訊息】` 的 `↪回覆 X` 仍只有名字沒有編號。
- `view_message` 附圖：`src/core/discord-media.mjs` 新增 `viewMediaItems()`，圖片來源加上**被回覆那則的附件**（本則＋引文＋貼圖＋兩邊連結預覽＋修復 bot 預覽）；`src/discord-bridge.js` 的 `/view` 改用它。工具說明與文件同步。測試 +3 斷言。已知缺口：文字沒標「哪張圖來自被回覆那則」，本則與引文都有圖時模型可能分不出來源。
- X／Twitter 連結：`firstTwitterPost` 照本文→被回覆→修復 bot 順序找第一條；用 FxEmbed 公開 API 取作者、正文、媒體，與 Discord 附件並行；預算 12 秒放棄、圖片去重；詳見 [[discord-twitter-post]]。
- 引用抓取：`referencedMessage()`（`src/core/discord-context.mjs`）只認同一頻道 type 0 回覆；快取命中且非 partial 才用快取，否則 `channel.messages.fetch(id)`。不依賴 `direct`／`fetchReference`，避免跨頻道抓取與 partial 訊息。
- preset dc-chat 規則：群友丟 URL 問內容時先用 `view_message`（連結修復 bot 的完整網址與正文），預覽沒正文才 `web_fetch`（commit 696d78c；避免模型自己去抓原網址）。`view_message` 工具說明同步寫明。
- Components V2 已修（2026-11-07）：`componentParts` 走訪容器抽文字／檔案／媒體；`embedLines`／`embedImages` 補 `embed.author`、`provider`、`footer`、完整 URL 與 component media；`viewMediaItems` 加 component media、gallery 優先 thumbnail、敏感 embed（`embed.flags`）不按 reaction；`searchableText` 擴充；batch 加 `[連結預覽：…]`。詳見 [[discord-message-preview]]。
- 讀取權限（`src/core/discord-core.mjs:394` `canReadMessage`）：模型自己 ignore 的人一律不行；其餘（含 `deny.users`／`deny.self`）一律可讀（2026-11-07 放寬，commit 42a565b）。被回覆的那則：作者在 `deny.users`／`deny.self` 照樣帶（公開內容），例外是 ignore 的人不帶。編號表每頻道各一張只留最近 500 個（`src/core/discord-agent.mjs:57`）；本文 1500 字（`VIEW_TEXT_MAX`）、引文 300 字；次數無限制（不像 read_history/search_history 一輪合計 3 次）。
- 跨頻道直讀（2026-11-07，commit 42a565b）：`view_message` 新增 `channel` 參數（頻道 ID 或 `<#id>`），可讀同一伺服器的其他頻道；讀別的頻道時 `#編號` 不查目前會話的表，只收原始訊息 ID；讀不讀得到看 bot 的頻道權限。私聊不能跨頻道。`src/core/discord-core.mjs` 新增 `viewChannelId`、`viewMessageTarget` 支援 `#` 前綴。已知缺口：跨伺服器與私聊路徑只有靜態測試，沒有 integration harness。