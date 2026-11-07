---
name: discord-view-message
description: view_message 找修復 bot、連結路徑比對、bot 訊息可見性與每日摘要
---

- 修復連結比對：`src/core/discord-context.mjs` 新增 `linkPaths`，只看網址路徑（至少兩段），所以只換網域的修復連結（`fxtwitter`/`fixupx`/`ddinstagram`）認成同一條。`view_message` 找修復 bot 的條件：回覆 target 或路徑相同；排除自己、取最近 3 則。`b23` 這類整個換路徑的短連結只能靠回覆關係（`shortcut:` 註解）。
- bot 訊息可見性：`view_message`／`read_history`／`search_history` 不排除 bot，bot 訊息會出現在結果並拿到 `#編號`。新訊息批次 `messageCreate` 看到 bot 直接 return，修復 bot 回覆不會主動進 prompt；`view_message` 看原訊息時自動帶附近「回覆它」或「同路徑連結」的 bot 訊息。不建議批次也讀 bot（迴圈、噪音、token、injection）。
- 每日頻道摘要：fetch 最近 `SUMMARY_MAX_MESSAGES`，過濾 `deny.users`、過濾 bot 或非 skip、since 24h、>= `SUMMARY_MIN_MESSAGES` 才生成；包含 bot 訊息。
- 引文帶編號：`formatQuote`（`src/core/discord-context.mjs`）多收 `ref`，輸出 `[引用 #k7f3ab 阿華：…]`；`buildBatchPrompt` 把被引用那則登記進編號表，模型可直接 `view_message` 看全文／附件。`【新訊息】` 標頭改成「#編號 用來指定要回覆、查看或按 reaction 的訊息」；dc-chat persona 加一句：看到 `[引用 #編號 …]` 要看全文、圖片或附件就用 `view_message`。已知缺口：`【最近頻道訊息】` 的 `↪回覆 X` 仍只有名字沒有編號。
- `view_message` 附圖：`src/core/discord-media.mjs` 新增 `viewMediaItems()`，圖片來源加上**被回覆那則的附件**（本則＋引文＋貼圖＋兩邊連結預覽＋修復 bot 預覽）；`src/discord-bridge.js` 的 `/view` 改用它。工具說明與文件同步。測試 +3 斷言。已知缺口：文字沒標「哪張圖來自被回覆那則」，本則與引文都有圖時模型可能分不出來源。
- 引用抓取：`referencedMessage()`（`src/core/discord-context.mjs`）只認同一頻道 type 0 回覆；快取命中且非 partial 才用快取，否則 `channel.messages.fetch(id)`。不依賴 `direct`／`fetchReference`，避免跨頻道抓取與 partial 訊息。