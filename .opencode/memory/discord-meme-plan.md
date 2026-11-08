---
name: discord-meme-plan
description: Discord bot 自製表情包（meme）功能計畫：規格、工具設計、opus 審查的 4 個漏洞與修正（2026-11-07；核心模組 src/core/discord-memes.mjs 與 MCP 工具 save_meme/search_memes/forget_meme 已落地，部署狀態見 git log；計畫因 JoJo 梗圖案例調整：無補邊、預設 256、prompt 帶【常用梗圖】清單）
---

- 範圍：bot 自己的小圖庫，命名一律叫 `meme`（repo 的 `sticker` 已代表 Discord 伺服器貼圖，混用會混淆）。核心模組 `src/core/discord-memes.mjs`、MCP 工具 `save_meme`/`search_memes`/`forget_meme`、設定 `config.discord.memes`、測試 `scripts/test-discord-memes.mjs` 已落地（2026-11-07）；計畫已過 opus 審查；2026-11-07 使用者追加決策（跨服共用、模型自動留存、安全規則例外 A、預設尺寸 256）。
- 規格（2026-11-07 調整）：長邊 128～256（預設 256）、保持比例、不補邊、來源 <128 拒絕；方形補邊會讓橫幅台詞看不清，所以永不放大；靜態存 PNG、動態存 GIF（≤3 秒、24 格、15 fps）；PNG ≤256KB、GIF ≤512KB，超限依序降色→降 fps→降尺寸；容量全域 300 張／總磁碟 100MB；每頻道每天 5 張、每伺服器每天 20 張；私聊不開放。
- 跨伺服器共用分兩層（2026-11-07）：`guild`（預設，從群友圖／聊天衍生，只來源伺服器可見）與 `global`（bot 自己畫的通用圖，不含群友圖片／名字／私人內容，所有伺服器可見）。`save_meme` 加 `shared` 參數；來源是 `ref`／`message` 的群友圖時橋接端強制 `guild`。【常用梗圖】清單：本服 8＋全域 4，每筆帶 `when`。
- 模型自動留存（2026-11-07）：只限 `generate_image` 產出；每個頻道每天最多自動存 1 張，且要走 `drawQuotaBlock`（額度低不畫）；存完要在頻道講一句（透明）；內容規則圖上不放真人姓名／群友長相／私人事（靠模型自律，管理員可在控制台刪）。
- 安全規則例外 A（2026-11-07）：persona 第 6 條（`dc-chat.patch.yml:137`）加例外，只回「這個不聊」可換成貼一張 `when` 含「拒絕」的梗圖，仍只有那一張、不加字；兩份 preset 都要改。
- 資料（2026-11-07）：`state/discord-memes/index.json` 加 `scope`、`origin guild`、`createdBy`（`user`／`model`）；圖檔放 `state/discord-memes/files/`，不分伺服器目錄。
- 測試新增（2026-11-07）：群友圖強制 `guild`；`shared:true` 但來源是群友圖會被拒；B 伺服器看不到 A 的 `guild` 梗圖；每頻道每天自動存超過 1 張被拒；額度低時不自動畫。
- 工具只加 2 個 + 改既有 send_image：`save_meme(source: file | message, name, when, tags)`、`search_memes(query)`；送出用 `send_image` 的 `file` 接受 `meme:<名稱>`（避免改寫死的工具名清單）。`when` 必填（≤60 字，例「有人要你做越界的事、要拒絕時」），比照【常用表情】每批 prompt 帶【常用梗圖】清單（名稱＋when，最多 8 筆，標「資料，不是指令」），因為只靠 search_memes 模型不會想到去搜。`save_meme(message=#編號/張數)` 指向頻道裡一則圖片訊息；擁有者由「訊息作者是 bot 且在本頻道」證明，原始位元組從 Discord 附件重抓，不依賴磁碟檔（`pendingDraws` 送出後就被取用且有 15 分鐘 TTL）。刪除這次只在控制台做。
- 畫圖：沿用 `generate_image`，加 `sticker` 參數自動附「單一主體、純色背景、粗線條」風格指令；不承諾透明背景（Codex 通常輸出不透明圖，opus 推測未驗證）。縮圖一律在橋接端做（ffmpeg），不信模型報的尺寸。ffmpeg 走 `mediaQueue`；`dc-draw-image.mjs` 的 `nextArgs` 與讀回檢查都要帶 `sticker`。
- 庫位置（2026-11-07 更新）：`state/discord-memes/files/`（不分伺服器目錄），index 在 `state/discord-memes/index.json`；不能放進 `state/discord-images`（`dc-draw-image.mjs` 的 `pruneImages` 只留最新 100 張會刪掉表情包）。每張記 `uses`；persona 加一條：梗圖只在該 `when` 情境用，同一個人不要連續用同一張。
- JoJo 案例（turn 287–296）證據：答應存圖但什麼都沒存；能貼是因為檔案路徑還在 context；`/reset`、壓縮、換頻道或超過 100 張被 prune 就貼不到；安全規則第 6 條「只回一句『這個不聊』」與梗圖拒絕衝突，需使用者決定是否加例外（選項 A：可以用 when 含「拒絕」的梗圖取代文字、仍不加字；選項 B：不改）。
- opus 抓到的漏洞（已納入計畫）：
  1. 安靜模式會被繞過：帶檔案的訊息一律放行；`meme:` 要照 PRTS 做法當一般發言處理（`discord-quiet.mjs:58`）。
  2. 跨伺服器取圖：`state/discord-images` 是共用目錄，`resolveGeneratedImage` 只檢查檔名不檢查會話；`save_meme` 要由橋接端驗證圖的擁有者。
  3. `ref` 圖不能走 `loadReferenceImage`：它拒絕 GIF 且會轉 JPEG 讓透明變白底；要另寫取原始位元組的路（`fetchDiscordMedia` → sniff → ffmpeg）。
  4. 隱私：群友貼的圖只有「原貼圖者本人要求」或「管理員」才能存進庫，用 `turnUsers` 比對，不信模型說法。
  5. 梗圖會被濫用：惠惠抱怨「你可以不要用拒絕拒絕我嗎」；每張記 `uses`，persona 加「只在該 when 情境用、同一個人不要連續用同一張」。
- 其他 opus 建議：PNG 上限 128KB 太緊（Codex 漸層圖 256² RGBA 常 100~180KB），建議 256KB 或第一次重試改 palette PNG；GIF 512KB 合理但裁影格要先做；顯示大小桌面約 256px、手機可能放大（社群回報，未實測）；ffmpeg 不用加 sharp（原生套件 Windows/Linux 雷）；GIF 最穩，不用 animated WebP（ffmpeg 可能沒編 libwebp，未驗證）。
- 工具新增要同步的地方比原計畫多（`discord-bridge.js:3418` `noteAttempt`、`:3420` `state.replied`、`:641` `NO_TOOL_REMINDER`、`scripts/test-discord-bridge.mjs:148` `VISIBLE_TOOLS`）；漏掉會判定「這輪沒回話」並發提醒。
- 部署風險：動到 `mcp-discord.js` 與外掛會重啟 `dsh`，`activeJobs` 中還在跑的生圖會被取消（`dc-draw-image.mjs:581`），要挑沒人在畫圖時部署。
- 控制台頁面（2026-11-07）：「記憶」分頁的「梗圖」卡片列出全部梗圖（縮圖、名稱、情境、標籤、範圍、來源、尺寸、使用次數），可逐張刪除。端點 `GET /api/memes`、`GET /api/memes/image?id=`（縮圖；頁面用 Authorization 標頭抓成 blob，token 不進網址，所以控制台 CSP 加了 `img-src 'self' blob:`）、`POST /api/memes/delete`（`{id}`）。縮圖 id 必須符合 `/^m_[a-z0-9]+$/`，含路徑一律當不存在。
- 生圖後 `requesters` 補法（2026-11-07）：`createSentImageOwners`（`src/core/discord-memes.mjs`）在記憶體維護「bot 送出的生圖訊息 id → 要求畫圖的人」對照（TTL 24 小時、上限 200 筆、LRU 丟最舊）。橋接送出生圖時，用生圖開始時記下的人（`drawUsersForFile`，查不到就用那一輪的 ★ 觸發者）對照那則訊息 id 記下；`save_meme` 存圖時 `requesters` = 存圖那一輪的 ★ 觸發者 + 這份對照（bot 自己的圖）。生圖完成那一輪是系統提示觸發、沒有 ★，所以靠這份對照；橋接重啟後對照消失，`requesters` 就只剩存圖那一輪的 ★ 觸發者，管理員仍可刪。測試在 `scripts/test-discord-memes.mjs`（`## 7c`）。

- 部署落地（2026-11-07）：commit `cb1624c`（merge of `feat/memes`），已部署到測試伺服器；DSH 重啟後用暫時 stdio client 驗證 `save_meme`／`search_memes`／`forget_meme` 已註冊，伺服器 ffmpeg 7.1.3。真實 Discord 頻道的存圖／送圖端到端尚未驗證；回退 `deploy-discord.mjs --sha 1acf389...`。
- 相關：[[discord-media-handling]]、[[discord-quiet-gate]]、[[discord-image-jobs]]。