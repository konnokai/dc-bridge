# Discord ↔ DeepSeek Harness 橋接（聊天模式）

把 Discord 的訊息接進本機 DSH：使用者在 Discord 傳訊息 → 橋接建立／沿用一個 DSH 會話 → agent 的回覆、
提問與工具審批送回同一個頻道。

只做聊天。沒有語音、黑名單學習、主動開話題、QQ 版那種十頁控制台；表情包、reactions、群友記憶、黑話學習與小型控制台見下文。

## 架構

```
Discord 訊息 ──► src/discord-bridge.js ──► DSH Web API（127.0.0.1:3080/api）
                        ▲                              │
                        └──── turn/end、提問、審批 ────┘
```

- Discord 側：`discord.js` 14（Gateway，`messageCreate`）。
- DSH 側：直接使用 `src/dsh-client.js`（Cookie 鑄造、斜線 RPC、`/api/remote.mux` 事件流）。
- 沒有一行 QQ / SnowLuma 程式碼參與。QQ 那套（`src/bridge.js` 等）留在原處，兩邊可並存，但**不要同時
  對同一個 Discord 頻道跑兩個實例**（橋接有單一實例鎖，第二個會直接退出）。

## 前置條件

1. 執行中的 DSH Web（預設 `http://127.0.0.1:3080`），而且**跟橋接同一台機器**——橋接要用
   `~/.dsh/.credentials.yaml` 的簽名金鑰在本機鑄造 Cookie。DSH 用 `--host <LAN IP>` 啟動、只監聽
   那個網卡時，`dsh.baseUrl` 直接寫那個 IP 也可以：本機網卡 IP 同樣算「本機」。
2. Node.js ≥ 22.13。
3. 一個 Discord 應用程式與 bot token。
4. （選用）`ffmpeg`：解析度／體積太大的圖片要靠它在本地縮小。沒裝也能跑，只是大圖會被跳過並說明原因。
5. Discord Developer Portal → Bot → **Message Content Intent**。不開也能跑（見下方
   `discord.messageContentIntent`），但頻道裡只有 @bot 的訊息看得到內容。

## 安裝

```powershell
npm install

# 1) 建立 Discord 應用程式
#    https://discord.com/developers/applications → New Application → Bot → Reset Token
#    Privileged Gateway Intents → 勾 Message Content Intent（不想開就跳過，改設定見下）
#    OAuth2 → URL Generator → scopes: bot + applications.commands
#    （slash command 需要 applications.commands；只勾 bot 的話指令叫不出來）
#    bot permissions：見下方「邀請機器人」的 8 個權限（啟動後用 /invite 或控制台產生的連結最省事）
#    用產生的網址把 bot 邀進伺服器

# 2) 填 config.json（沒有就從 config.example.json 複製）
Copy-Item config.example.json config.json
#    把 config.json 的 discord.token 填成 bot token；
#    discord.ownerIds 填你自己的 Discord user id（開啟開發者模式 → 右鍵自己的名字 → 複製使用者 ID）。

# 3) 安裝 DSH 端的 dc-chat preset，然後重啟 DSH
node scripts/setup-dsh.mjs --discord

# 4) 啟動橋接
npm run start:discord
```

想在 Linux 上常駐（DSH 自己也是 pm2 管的話）：

```bash
pm2 start src/discord-bridge.js --name dc-bridge --time
pm2 logs dc-bridge
```

> `DISCORD_TOKEN` 要給**子程序**看到，`.bashrc` 裡必須是 `export DISCORD_TOKEN=...`；
> 只寫 `DISCORD_TOKEN=...` 的話互動 shell 自己看得到、node 看不到。
> pm2 會記住啟動當下的環境；改了 token 用 `pm2 restart dc-bridge --update-env`。

看到 `[discord] 已登入：<bot 名稱>` 就是成功了。

> `--discord` 只安裝 Discord 那套：`dc-chat` / `dc-learner` preset（`plugins/dc-agent-presets`）與
> `mcp-web-search-safe` / `mcp-discord` / `mcp-slang` 三個 MCP。它不會改 QQ 的 preset / 設定檔，也不會刪掉
> profile 裡你自己加的其它 MCP。

## 設定（`config.json` 的 `discord` 段）

| 欄位 | 說明 |
| --- | --- |
| `token` | Bot token。留空時讀環境變數 `DISCORD_TOKEN`。**不要提交進 git** |
| `agentPreset` | 會話使用的 DSH preset，預設 `dc-chat`。找不到就直接拒絕建會話（見「安全邊界」） |
| `workspaceTitle` | DSH 介面裡的會話歸組名稱，預設 `Discord 聊天` |
| `ownerIds` | 管理員的 Discord user id（**字串**陣列）。管理命令（含 slash command）與工具審批只認這些人 |
| `allow.guilds` | 允許的伺服器 id |
| `allow.channels` | 允許的頻道 id（討論串用自己的 id，不是母頻道） |
| `allow.users` | 允許私聊的 user id。**不影響伺服器頻道** |
| `deny.guilds` / `deny.channels` / `deny.users` | 黑名單，優先於白名單。`deny.channels` 也擋掉這個頻道底下的討論串。`deny.users` 是**管理員封鎖**（控制台或 `config.json` 編輯）：bot 完全不處理他的訊息，@bot 也一樣 |
| `deny.self` | 使用者自己用 `/blacklist` 退出的名單。同樣不處理他的訊息，**唯一例外**是他 @bot 或回覆 bot 的那一則照常處理。管理員封鎖的人不能用 `/blacklist` 自己解除。控制台「白名單與媒體」卡片可以直接改這份名單 |
| `allowAllWhenEmpty` | 對應的白名單為空時是否放行，預設 `false`（全擋）。伺服器頻道只看 `guilds` / `channels`，私聊只看 `users` |
| `requireMentionInGuild` | `true`（預設）：頻道裡只有 @bot 或回覆 bot 的訊息送進模型。`false`：頻道裡所有訊息都送進模型，由模型決定要不要說話（見「自由參與」） |
| `batch.debounceMs` | 同一個會話收到訊息後再等多久才送出，期間的新訊息合成一批，預設 3000（500~30000） |
| `batch.maxWaitMs` | 一批從第一則算起最多等多久，預設 15000（1000~120000）；訊息一直進來也不會無限延後 |
| `batch.maxMessages` | 一批最多幾則，滿了立刻送出，預設 20（1~50） |
| `messageContentIntent` | 是否申請 Message Content 特權意圖，預設 `true`。設 `false` 時會強制 `requireMentionInGuild: true`（不然收不到內容） |
| `ackMessage` | 收到訊息後的立即回覆，預設空字串（關閉） |
| `maxMessageChars` | 單則訊息上限，200 ~ 2000，預設 2000 |
| `questionTimeoutMs` | 等提問／審批回答的時間，預設 300000（5 分鐘） |
| `autoCompactTokens` | 一輪結束時 context（上一次請求的 totalTokens）超過這個數，橋接就替會話送 `/compact`，預設 80000；`0` = 關閉。同一會話 10 分鐘內最多送一次 |
| `ttftTimeoutMs` | 模型多久沒吐出第一個 token 就取消這一輪，預設 30000（5~120 秒）；`0` = 關閉。已經開始呼叫工具就不受這個限制 |
| `typing` | 送出「正在輸入」提示，預設 `true` |
| `sendDelayMs` | 連續送出的間隔，預設 300 毫秒 |
| `sessionDir` | 會話工作目錄，預設 `<repo>/state/discord-agents` |
| `media.enabled` | 是否把 Discord 圖片與影片（附件、貼圖、連結預覽圖）送進模型，預設 `true` |
| `media.maxBytes` | 單一附件下載上限，預設 20MB（Discord 免費帳號 2026-08 起的上傳額度）。boost 伺服器可以傳到 50／100MB，要收更大的再往上調（上限 64MB）；超過就不抓 |
| `media.maxModelBytes` | 送進模型的單張上限，預設 1MB；超過用 ffmpeg 縮圖 |
| `media.maxLongEdge` | 縮圖後的長邊上限，預設 1280（256 ~ 2048） |
| `media.maxCount` | 一則訊息與整批各最多處理幾張，預設 4（1 ~ 8）；影片抽格後算 1 張 |
| `media.timeoutMs` | 單張縮圖／影片抽格的 ffmpeg 逾時，預設 25000 |
| `media.maxVideoSeconds` | 影片只看前面幾秒，預設 60（5 ~ 120；6 格抽樣的上限就是 120 秒） |
| `videoLinks.enabled` | 群友貼 YouTube 這類連結時，`view_message` 用 yt-dlp 抽幾格畫面，預設 `false` |
| `videoLinks.ytDlpPath` | yt-dlp 的位置；留空就用 `YTDLP_PATH` 環境變數或 PATH 裡的 `yt-dlp` |
| `context.enabled` | 抓最近幾則頻道訊息一起送進 prompt，預設 `true`。自由參與時只在會話的第一批帶（之後模型本來就看得到每一則） |
| `context.messages` | 抓幾則，預設 12（0 = 關閉，上限 50） |
| `context.maxChars` | 上下文區塊的字數上限，預設 3000 |
| `security.blockSensitive` | 回覆含本機路徑／憑證／已知令牌時整條攔截，預設 `true` |
| `queue.max` | DSH 連不上時每個會話最多排幾批，預設 50 |
| `queue.retryMs` | 恢復後的重試間隔，預設 10000 |
| `emoji.enabled` | `search_emojis`、每批【常用表情】與 `:名稱:` 代換的總開關，預設 `true` |
| `emoji.dir` | 表情目錄位置，預設 `state/discord-emoji/` |
| `emoji.maxCandidates` | `search_emojis` 一次最多回幾個表情，預設 12（3~30） |
| `emoji.maxChars` | `search_emojis` 結果與【常用表情】的字數上限，預設 600 |
| `reactions.enabled` | 對「沒叫 bot」的頻道訊息偶爾加 reaction，預設 `false` |
| `reactions.probability` | 命中後實際加 reaction 的機率，預設 0.15 |
| `reactions.cooldownMs` | 同一頻道兩次 reaction 的最短間隔，預設 10 分鐘 |
| `reactions.maxPerHour` | 全域每小時上限，預設 10 |
| `reactions.minKeywordScore` | 訊息與表情目錄的最低關鍵字分數，預設 2（1 = 更積極） |
| `memory.enabled` | 群友記憶開關，預設 `false`（要在 `config.json` 明確打開） |
| `memory.maxFacts` | 每個人最多記幾條，滿了丟最舊的，預設 20（5~50） |
| `memory.maxChars` | 注入區塊的字數上限，預設 800（200~3000） |
| `notes.enabled` | 頻道筆記開關，預設 `false`（會保存頻道文字；每天摘要會另外花 token） |
| `notes.injectMax` | 每批最多注入幾條筆記，預設 5（1~20） |
| `notes.maxChars` | 筆記注入區塊的字數上限，預設 600（100~3000） |
| `notes.dailySummary.enabled` | 每天自動產生頻道摘要，預設 `false`（另開背景模型會話） |
| `notes.dailySummary.hour` | 幾點之後才做當天摘要，預設 4（bridge 主機時區，0~23） |
| `followup.enabled` | 回訪開關，預設 `false`（時間到了會多一個模型回合） |
| `slang.enabled` | 黑話學習開關，預設 `false`（會把頻道文字送去模型） |
| `slang.extractMinMessages` | 同一頻道累積幾則才抽一次，預設 20（5~200） |
| `slang.extractCooldownMs` | 兩次抽取的最短間隔，預設 10 分鐘 |
| `slang.maxPerDay` | 每天最多抽幾次，預設 40 |
| `slang.injectMax` | 每則 prompt 最多注入幾條已確認詞（這批訊息講到的優先），預設 8 |
| `slang.maxChars` | 注入區塊的字數上限，預設 1500 |
| `slang.maxCandidates` / `slang.maxConfirmed` | 詞庫上限，預設 200 / 500 |
| `slang.learnerPreset` | 學習會話用的 preset，預設 `dc-learner`（沒有工具、短 prompt） |
| `slang.timeoutMs` | 學習回合逾時，預設 90000 |
| `console.enabled` | 是否啟動控制台，預設 `true` |
| `console.host` | 綁定位址，預設 `127.0.0.1`。填 LAN IP（例如 `192.168.1.1`）或 `0.0.0.0` 才能從別台開 |
| `console.port` | 控制台埠，預設 `3110` |
| `console.token` | 控制台 token；留空時自動產生並寫到 `state/discord-console-token` |

> **id 一律寫字串。** Discord 的 snowflake 是 19 位數字，寫成 JSON 數字會在 `JSON.parse` 就先掉精度，
> 橋接會直接報錯而不是幫你轉。

> 另外，模型自己可以用 `ignore_user` 設一份「暫時不理」名單（`state/discord-ignore.json`，1~1440 分鐘）。
> 這份名單 @bot 也不處理，跟 `deny.users`（管理員封鎖）、`deny.self`（本人用 `/blacklist`）分開；控制台看得到。

### 模型想太久（TTFT）

- 從 `turn/start` 開始計時；`ttftTimeoutMs` 內沒收到模型的第一個串流 chunk、完整訊息或 `tool/call`，
  橋接就送 `session/cancel` 取消這一輪。直接叫 bot 的頻道會收到「想太久，先取消」的提示。
- 只要模型開始輸出或呼叫工具，計時器就停：工具跑多久都不會被這個機制取消，讓它把該輪做完。
- 自動壓縮的 `/compact` 不計時。

`dsh` 段沿用 QQ 版的欄位（`baseUrl`、`provider`、`model`、`reasoningEffort`、`authToken`、`allowRemote`）。
預設是 `opencode-go` / `deepseek-v4.1-flash`（橋接的內建預設）。實際可用的 provider/model 以 DSH 的
`session/modelCatalog` 為準——不在 `routableProviders` 裡的組合會讓每個回合在送出訊息前就失敗。
`dsh.authToken` 通常留空，讓橋接用 `~/.dsh/.credentials.yaml` 離線鑄造 Cookie。

聯網搜尋走 `webSearch` 段（`setup-dsh.mjs --discord` 會把 `mcp-web-search-safe` 掛進 profile）：

| 欄位 | 說明 |
| --- | --- |
| `webSearch.provider` | `searxng`（自架）/ `deepseek` / `bing` / `auto`（DeepSeek 優先、Bing 後備） |
| `webSearch.searxngURL` | SearXNG 的 `/search` 端點，例如 `http://192.168.1.1:58918/search` |
| `webSearch.allowPrivate` | 允許 http / 私有位址（自架實例要開，預設 `false`） |
| `webSearch.maxResults` | 單次回傳幾條，預設 8 |

SearXNG 實例必須在 `settings.yml` 的 `search.formats` 裡開啟 `json`，否則只會回 HTML（工具會明確報錯）。

## 用法

- **私聊**：直接把 bot 加好友，訊息全部處理（使用者要在 `allow.users` 裡，或白名單全空且
  `allowAllWhenEmpty: true`）。Discord 要求 bot 與物件至少同一個伺服器才收得到私聊，
  所以先把 bot 邀進你自己的伺服器。
- **頻道**：預設要 @bot 或回覆 bot 的訊息。`requireMentionInGuild: false` 是「自由參與」，見下一節。
  執行中可用 `/mention` 或控制台切換，不用重啟。
- 只 @bot 或只回覆 bot、沒有其他文字或附件也會送進批次（prompt 會標成「[沒有文字，只有叫你]」），不會被當成空訊息丟掉。
- **討論串**：視為獨立會話（用自己的 channel id），不會跟母頻道共用上下文。白名單看討論串自己的 id；
  黑名單也看母頻道，母頻道在 `deny.channels` 裡時，底下的討論串一律擋掉。

### 批次與自由參與

同一個會話的訊息不是一則一則送進模型，而是**合成一批**：收到訊息後等 `batch.debounceMs`，
期間的新訊息併進同一批；從第一則算起最多等 `batch.maxWaitMs`，滿 `batch.maxMessages` 則立刻送出。
一批只開一個 DSH 回合。

同一個會話**一次只有一批在 DSH 裡**：模型的回合還沒結束，新送出的批次先壓在橋接，
回合結束（`turn/end`）再送。原因是 DSH 的 queue 模式一個回合只接一則排隊訊息；頻道聊得比模型回得快時
（回合常要 10~35 秒），不壓住的話 DSH 的佇列只會越排越長。

普通批次會合成一筆；`/ask`、`/reload-system-prompt` 這種指令獨佔一輪，照到達順序排在普通批次之間，
不會被合併，也不會因為前面還有回合就直接拒絕。

- 壓住的訊息最多 50 則，超過時丟最舊的閒聊；★ 的訊息一定留著。丟過訊息時，prompt 會多一行
  「略過了較早的 N 則」，日誌的 `已投遞` 也會寫 `略過 N 則`。模型可以用 `read_history` 自己去翻。
- 等了 5 分鐘還沒收到 `turn/end`（事件漏了、回合卡住）就直接放行；DSH 事件流斷線也會放行，`/reset` 則直接清掉。

批次在 prompt 裡長這樣（頻道）：

```
【新訊息】（★ = 在叫你：@你或回覆你；#編號 用來指定要回覆、查看或按 reaction 的訊息）
#f3ab7c 阿華：今天好熱
#9qp2xm ★小明：@大肥魚 你覺得呢 [引用 #f3ab7c 阿華：今天好熱]
小美 ↪回覆 阿華：+1
```

- 新會話（剛建立、`/reset`、`/reload-system-prompt` 之後）的第一批 prompt 會在【發送】前多一行【開場】，要求先用文字接一句；沒有這一行時，模型常在第一批只按 reaction、過幾批才開始說話。
- 訊息裡的 `<@id>`、`<@!id>`、`<#id>`、`<@&id>` 會換成 `@暱稱`、`#頻道名`、`@身分組名`
  （名字只從這則訊息的 mention 與快取取，不打 API；查不到寫「未知」，不把數字 id 給模型。
  頻道只換同一個伺服器、而且群友看得到的名字，避免洩漏別服或私密頻道）。
  沒有引用內容的回覆會顯示 `↪回覆 X`；有引用內容時顯示 `[引用 #編號 X：…]`，
  `#編號` 是被引用那則的編號，模型可以拿它呼叫 `view_message` 看全文與附件。
  【最近頻道訊息】、`read_history`、`search_history`、`view_message` 用同一套換法。

- 每批的【現在】後面會多一行發言頻率：「你最近 10 分鐘送了 N 則；這段時間頻道共 M 則」。
  M 少於 3 時不顯示，免得「頻道共 1 則」變噪音。
- 模型上一次送出的訊息收到 reaction 時，下一批 prompt 開頭會出現 `【你的訊息收到的反應】#編號 😂×2、:kekw:×1`。
  只出現一次，reaction 本身不會觸發模型回合。需要 `GuildMessageReactions`、`DirectMessageReactions` intent
  （非特權，程式啟動時申請）和 `Message`、`Reaction` partial。

- **`requireMentionInGuild: true`（預設）**：只有 @bot 或回覆 bot 的訊息會進批次，所以每一行都有 ★，
  模型照 persona 的規則一定會回。
- **`requireMentionInGuild: false`（自由參與）**：頻道裡允許的訊息全部進批次。沒有 ★ 的是大家在聊，
  persona 規定預設不說話，只有真的有話想接才呼叫發送工具；有 ★ 的照樣要回。
  - 只有批次裡有 ★ 時才會亮「正在輸入」，也只有這時才送 `ackMessage`。
  - 提問的回答、非管理員 `/` 的拒絕訊息只認 ★ 的訊息；其餘文字（含 `!xxx`）就是一般聊天。
  - 沒有 ★ 的那批出錯（模型不可用、DSH 拒收、回合被中止）只記日誌，不在頻道貼錯誤訊息。
  - 暱稱或內文裡的 `★`、`【管理員】` 會被改寫成 `☆`、`[管理員]`，多行訊息的續行會縮排，群友沒辦法偽造標記。
  - 每一批都是一個模型回合，**頻道越熱鬧花費越高**；聊得比模型回得快時，上限是「模型連續跑回合」
    （見上面的回合閘門）。先在小頻道試，搭配 `batch.debounceMs` 調整。
- **私聊**：每一則都算在叫 bot，同樣會合批。

### 指令

| 指令 | 誰能用 | 作用 |
| --- | --- | --- |
| `/reset` | bot 擁有者，或該伺服器裡有 Administrator 權限的人 | 停掉 DSH 佇列、歸檔舊會話，下一則訊息開新上下文。伺服器管理員只能重置自己伺服器裡、在白名單上的頻道；私聊只有擁有者能用 |
| `/reload-system-prompt` | bot 擁有者，或該伺服器裡有 Administrator 權限的人 | 排進這個頻道的同一條會話佇列，等目前回合結束後用那個 DSH 會話產生一段對話總結，存進 `state/discord-reload-summaries.json`，再重置會話。排隊期間的新訊息會留在 bridge，重載完成後進新會話；總結會放在新會話第一則 prompt 的開頭。**不會重啟 DSH**，新的 preset 要先由 DSH 重新載入 |
| `/status` | 管理員 | 顯示目前的 session id、preset、通道種類；provider 是 `opencode-go` 時再加一行 OpenCode Go 額度；生圖 preset 開著時再加一行 Codex 額度 |
| `/invite` | 管理員 | 產生機器人邀請連結（含目前功能所需權限），回覆只有自己看得到 |
| `/console` | 管理員 | 回兩個連結按鈕：DSH 後台（`dsh.baseUrl`）和 bridge 控制台（含控制台 token，點了直接登入；控制台關閉時不列）。回覆只有自己看得到。連結是 `config.json` 裡的位址，通常只有區網或 `--trusted-host` 的電腦打得開；token 會經過 Discord，不要轉貼 |
| `/mention` | 管理員 | 切換 `requireMentionInGuild`（每次都 toggle：要 @bot ↔ 自由參與），立即生效並寫回 `config.json`。**所有伺服器共用**。沒開 Message Content 意圖時不能切換（一定得 @bot） |
| `/ask text:...` | 管理員 | 把一句話送進這個頻道對應的 DSH 會話，讓模型用它目前的上下文回答，回覆只有自己看得到。前面還有回合時會排進同一條會話佇列，不會直接拒絕；等待期間這個頻道的一般訊息排到問完才送。問題會留在會話上下文裡，之後的對話仍可能提到，這點只能靠提示詞約束。模型這一輪所有 Discord 工具都會被擋下（含讀歷史），這一輪的回答不會公開。額度與一般對話共用 |
| `/memory` | 所有人 | 列出 bot 記下的關於自己的事（群友記憶，所有伺服器共用），回覆只有自己看得到 |
| `/forget` | 所有人 | 刪除 bot 記下的關於自己的全部事（群友記憶與觸發統計，所有伺服器一起刪）；不影響目前頻道的對話上下文 |
| `/blacklist` | 所有人 | 切換自己的 `deny.self`：每次執行都會切換（不在名單 → 加入，已在名單 → 移出），立即生效並寫回 `config.json`，所有伺服器共用。加入後 bot 不再處理你的訊息：沒在叫 bot 的不回、不進批次、不學黑話，也不進頻道上下文與每日摘要，讀歷史、搜尋也看不到；別人引用你的訊息時，引用內文照常附上。唯一例外是 @bot 或回覆 bot 的那一則（那一則照正常流程處理，`view_message`、`user_info`、讀歷史與搜尋都看得到，跟一般訊息一樣；伺服器頻道的搜尋 API 認不出回覆對象，那邊只有 @bot 的一則認得）。在 `deny.users`（管理員封鎖）裡的人不能自己解除，會回一句請找管理員。私聊仍然全擋。只能改自己，回覆只有自己看得到。別人把你的訊息轉發出去時，轉發的內容不受這份名單影響 |
| 其他 `/` 開頭 | 管理員 | 文字原樣送給 DSH（例如 `/model`）。Discord 客戶端可能不讓你送未註冊的 `/` 指令，送不出去就改用 DSH WebUI |

`/reset`、`/reload-system-prompt`、`/status`、`/invite`、`/console`、`/mention`、`/ask`、`/memory`、`/forget`、`/blacklist`
都是**已註冊的 Discord slash command**（回覆只有自己看得到）。
只用**全域指令**（不做 per-guild 註冊，否則 `/` 選單會同時出現兩份）；代價是 Discord 端最多要等一小時才生效。
橋接**沒有訊息指令**：`!reset`、`!forget` 這類文字一律當一般聊天送進模型。

- **誰看得到選單**：管理指令（`/reset`、`/reload-system-prompt`、`/status`、`/invite`、`/console`、`/mention`、`/ask`）
  都是 `default_member_permissions: Administrator`（有 Administrator 權限的人看得到）。
  Discord 沒辦法把指令選單只開給某一個人，所以用權限縮小範圍。
  這個欄位**只在伺服器裡生效**；私聊的選單每個人看得到 `/reset`、`/reload-system-prompt`、`/status`、`/forget`，能不能執行還是看下一條。
- **誰能執行**：`/reset`、`/reload-system-prompt` 認 `ownerIds`，或那個伺服器裡有 Administrator 權限的人。
  bot 開放給別人管的伺服器時，那邊的 Administrator 可以自己清掉 bot 在自己頻道的上下文，不用找 bot 擁有者。
  其他管理指令執行時只認 `ownerIds`：它們會動到所有伺服器共用的設定（`/mention`）、
  露出擁有者的後台與 token（`/console`）或額度（`/status`），伺服器管理員看得到選單也會被拒絕。

> 私聊只有 `/reset`、`/reload-system-prompt`、`/status`、`/forget` 會出現；`/reset`、`/reload-system-prompt`、`/status` 只認 `ownerIds`，其他指令只在伺服器頻道。
> DSH 的斜線命令（`/model` 等）沒有 slash command 版本，只能由管理員當文字打給 bot。

非管理員對 bot 打 `/` 開頭會被拒絕，不會送進模型。

### 重載 system prompt

改過 `dsh/agent-presets/dc-chat/agent.cordis.yml` 的 persona（或任何會影響 system prompt 的 preset 內容）之後，
新的 preset 要等 DSH 重新載入 profile 或重啟才會生效。`/reload-system-prompt` **不會**自己重啟 DSH；
它會排進這個頻道的同一條會話佇列，不會因為前面還有回合就直接拒絕：

1. 等前面的回合結束，用目前的 DSH 會話產生一段對話總結（這是後台回合，不會貼到頻道，也不會公開）。
2. 把總結存進 `state/discord-reload-summaries.json`。摘要以 600 字為目標，硬上限 1200 字；真的超過才會截斷。
3. 停掉並歸檔舊會話（跟 `/reset` 一樣）。
4. 排隊中的頻道訊息會留在 bridge，重載完成後送進新會話；新會話的第一則一般 prompt 開頭會帶上總結，當成「最近對話的記憶」；同一份只用一次。

排隊期間送來的訊息不會被丟掉。摘要會先寫進檔案，成功後才退役；摘要失敗（模型沒回話、等不到空閒的會話、
事件流斷線、摘要檔寫入失敗）時不會清掉舊會話，排隊的訊息照舊會話處理，可以等一會兒再試。
`/reset` 是立即重置，排隊中的訊息、待用的交接摘要與排隊中的指令會直接丟棄。
清摘要時如果檔案寫入失敗，`/reset` 會回報失敗並保留會話，避免重啟後舊摘要又復活。
控制台「會話」分頁每一列的「重載提示詞」按鈕等於這個指令。

### 忽略某一則訊息

在訊息開頭打 `\//`（畫面上會顯示成 `//`），橋接就整則跳過：不送進模型、不進頻道上下文、不算觸發統計、
不學黑話、不回表情，也不能當提問的答案。

- Discord 客戶端會攔截 `/` 開頭的訊息並跳出指令選單，所以要打 `\//`，不能只打 `//`。
- 開頭的 `//` 也接受，方便舊訊息或從其他管道送出的內容。
- `\o/`、`\(^o^)/` 這類顏文字不會被跳過：反斜線後面一定要接 `//`。
- 只有附件、沒有文字的訊息沒有地方放標記，照常處理。
- 已經送進會話的內容，事後補標記也收不回。

### 模型自己不理的人（`ignore_user`）

模型遇到有人一直騷擾、洗頻、針對它罵，講不聽時，可以自己把那個人設進「暫時不理」名單，1~1440 分鐘
（最多一天）。跟另外兩份名單分開：

| 名單 | 誰設定 | 存在哪 | @bot 會不會處理 |
| --- | --- | --- | --- |
| `deny.users` | 管理員 | `config.json` | 不會 |
| `deny.self` | 本人用 `/blacklist` | `config.json` | 會（唯一例外） |
| 模型的不理名單 | 模型用 `ignore_user` | `state/discord-ignore.json` | 不會 |

- 生效期間那個人的新訊息不進來：不進批次、不進頻道上下文、不進每日摘要、不學黑話；
  讀歷史、搜尋、`view_message` 也看不到。@bot 或回覆 bot 一樣不處理，私聊也一樣。
- 已經排進佇列、還沒投遞的那一批不會中途抽掉（入口才判斷）；要完全立即生效就等那批跑完。
- 名單依 user id、所有伺服器共用，跟 `/blacklist` 一樣；最多 200 人，滿了工具回錯誤。
- 只有模型能設，`ownerIds` 裡的管理員不能被設（工具會回錯誤）。控制台「會話」分頁看得到名單、原因與到期時間，
  也可以直接按「解除」。
- 時間到自動失效；模型也可以在名單裡那個人的訊息上用 `minutes=0` 提早解除。
- 檔案壞掉會備份成 `.corrupt-<timestamp>` 再從空的重建；重啟後名單仍然有效。

### 提問與審批

- agent 用 `ask_user_question` 提問 → 問題與選項送到頻道，**這個頻道下一則叫 bot 的訊息就是答案**
  （頻道要 @bot 或回覆 bot，私聊直接打；回選項文字，或直接打自己的答案）。任何人都能回答提問。
- agent 請求工具審批 → 只有 `ownerIds` 能回「通過 / 同意 / 允許 / 批准 / yes / y / approve / ok」或
  「拒絕 / 不同意 / 不允許 / 駁回 / no / n / reject / deny」。其他人在審批掛著時照常聊天，不會被吃掉。
- 等到 `questionTimeoutMs` 沒人回 → 橋接代替使用者取消，並在頻道說明。

## 邀請機器人

用 `/invite`（管理員）或控制台的「邀請機器人」卡片產生連結。兩邊用的是同一份權限清單：

| 權限 | 用途 |
| --- | --- |
| 查看頻道 | 讀取允許的頻道 |
| 傳送訊息 | 回覆 |
| 在討論串傳送訊息 | 在討論串裡回覆 |
| 讀取訊息歷史 | 頻道上下文、reaction 的語料 |
| 新增反應 | 偶爾加 reaction |
| 使用外部表情 | 送其他伺服器的自訂表情 |
| 建立投票 | `create_poll` |
| 附加檔案 | `send_image` 把生圖上傳到頻道 |

- scope 是 `bot applications.commands`。**`applications.commands` 不能省**，少了它 slash command 不會註冊。
- bitfield 是 `563224831691840`；不含 Administrator、Manage Guild、Manage Messages。
- 2026-10-27 加了「建立投票」，2026-10-30 加了「附加檔案」。之前邀請的 bot 沒有重開連結也通常能發投票（@everyone 預設有這個權限），
  但「附加檔案」不一定有；舊 bot 要重開一次 `/invite` 連結，或由管理員手動給權限。
- 已經在伺服器裡的 bot 再開一次連結，Discord 會用新權限更新它的身分組，不會重複邀請。
- 頻道層級的權限覆蓋仍可能擋掉；邀請連結只給伺服器層級。

## 控制台

橋接啟動時會印一行：

```
控制台：http://127.0.0.1:3110/?token=<自動產生的 token>
```

頁面分成 8 個分頁。目前在哪一頁記在網址的 `#`（例如 `#usage`），重新整理會停在同一頁；
可以用滑鼠點，也可以在分頁列上用左右方向鍵切換。

- **總覽**（`#overview`）
  - **狀態**：Discord 登入、DSH 位址、preset/模型、事件流最後一幀、會話數、等待中的提問/審批，
    以及觸發對話人數（今天／總計／次數、畫圖次數與最常觸發的人）
  - **OpenCode Go 額度**：5 小時 / 每週 / 每月三個額度的剩餘百分比與重置時間（見「OpenCode Go 額度」）
  - **Codex 額度**：生圖 preset 有開 `allowImageGen` 時，顯示 5 小時 / 每週剩餘百分比、重置時間與重置券（見「Codex 額度」）
- **花費**（`#usage`）：token 用量與折算金額；24 小時 / 3 天 / 7 天 / 30 天走勢，點會話列展開逐輪明細
- **黑話**（`#slang`）：「黑話詞庫」和「頻道風格」兩張卡片分開列。各自可以按狀態（全部／待確認／已確認／已拒絕）過濾，
  每頁 20 筆、可換頁；每筆可確認、拒絕、編輯、刪除。「頻道風格」多一個頻道下拉選單（預設「全部頻道」），
  選項顯示 `#頻道名（筆數）`，橋接查不到頻道名稱時退回頻道 id，有同名頻道時後面補 id；
  頻道和狀態兩個過濾一起作用，換頻道會回到第 1 頁
- **對話**（`#triggers`）：誰觸發過對話、各自幾次、畫圖幾次、最後在哪個頻道、最後／第一次時間；可搜尋名稱或 user id，每頁 20 人
- **記憶**（`#memory`）：記了誰、記了哪些事、最後更新時間（唯讀；要刪請當事人用 `/forget`）
- **會話**（`#sessions`）：`dm:` / `ch:` 列表、session id、最後活動時間；每列有「重載提示詞」（等於 `/reload-system-prompt`）和「重置」（等於 `/reset`）
- **設定**（`#settings`）
  - **白名單與媒體**：`allow.*` / `deny.*` / `ownerIds` / `media.*` / `requireMentionInGuild`（勾選框）直接編輯，
    存檔後**立即生效**並寫回 `config.json`。沒開 `messageContentIntent` 時勾選框鎖住（一律要 @bot）
  - **表情目錄**：每個伺服器的表情條目數，可手動更新
  - **邀請機器人**：產生含目前功能權限的邀請連結，可開啟或複製
- **日誌**（`#logs`）：最近 200 行（記憶體 ring buffer，重啟就清空）

不做的事（跟 QQ 版控制台不同）：人格編輯、QQ 版那種模式切換、語音。那些在 Discord 版沒有對應概念，
或需要重啟 DSH 才有意義。

> token 留空時會自動產生，存在 `state/discord-console-token`（重啟沿用）。要換 token 就刪掉那個檔，或直接在
> `config.json` 填 `console.token`。

**從別台開**：把 `console.host` 改成那台機器的 LAN IP（例如 `192.168.1.1`）或 `0.0.0.0`，重啟橋接。

> ⚠️ 綁非 loopback 等於把管理介面放到網路上，token 是唯一的門。請確認防火牆只開放給你的網段，
> 而且 token 夠長（自動產生的有 32 字元）。只用本機的話建議維持 `127.0.0.1`，再用
> `ssh -L 3110:127.0.0.1:3110 192.168.1.1` 轉進去。

## 花費看板

控制台「花費」卡片與 QQ 版共用同一份帳本程式（`src/token-ledger.js`、`src/model-prices.js`），
資料存在 `state/discord-usage.jsonl`。

- **總計是權威值**：來自 DSH `session/follow` 快照的 `tokenUsage` 投影（整條會話日誌，含橋接
  啟動前的歷史），加上基線之後的逐條增量。事件重連重送不會翻倍。
- **逐輪明細**：由 `assistant/message` 的 `usage` 折疊而來；點表格中的會話列可展開。
- **走勢圖**：24 小時 / 3 天 / 7 天 / 30 天。柱子顏色代表當時是高峰（金色，單價 ×2）或
  空閒（藍色）；圖上只畫所選時間窗，視窗外的歷史會另外列出金額。
- **歸屬**：`ch:` / `dm:` 會話按頻道分組；黑話學習會話歸 `internal:黑話學習`。歸屬第一次確定後就記在
  帳本裡：`/reset` 掉的舊會話、橋接重啟後的學習會話都留在原本的分組。從沒歸屬過的 session
  （不是橋接建的）各自顯示成 `未归属:<session 前 8 碼>`（帳本與 QQ 版共用，所以是簡體），不會混進頻道。
- **精度邊界**：投影基線只有累計值、沒有逐時明細，只能整體按快照時刻的峰谷計價；橋接
  執行期間的逐條取樣是精確的。
- **空狀態**：還沒有可歸屬的回合時會明講，不會顯示 NaN。

價目表內建 DeepSeek 官方價（元 / 百萬 token；高峰為空閒的 2 倍，中國法定節假日除外）。
要覆蓋時在 `config.json` 加 `pricing`（格式與 QQ 版相同，見 `docs/guides/TOKEN_USAGE_CONSOLE.md`），
改完重啟橋接。金額是讀取時才折算，所以改價目表**不需要重算歷史**。

控制台端點（都要 console token）：`GET /api/usage?range=24h|3d|7d|30d`、
`GET /api/usage/turns?key=ch:<id>`、`POST /api/usage/reset`（清空帳本，不可恢復）。

## OpenCode Go 額度

`dsh.provider` 是 `opencode-go` 時，控制台的「OpenCode Go 額度」卡片和 `/status` 會顯示訂閱額度：
5 小時、每週、每月三個額度各剩幾 %、多久後重置，跟 Codex 額度一樣從 100% 往下扣。
上面的「花費」是橋接自己按價目表估算的；這裡是 OpenCode 伺服器算的，用完會被擋的是這個數字。

- **資料來源**：`GET https://opencode.ai/zen/go/v1/usage`（跟 opencode.ai 後台的額度頁同一份資料）。
- **API key**：先看環境變數 `OPENCODE_GO_API_KEY`，沒有就讀 DSH 的 `~/.dsh/.credentials.yaml` →
  `refs.OPENCODE_GO_API_KEY`（DSH 的 Models 頁存的那把）。key 只送到上面這個固定網址，不跟隨重新導向，
  不寫日誌、不進錯誤訊息。
- **快取 60 秒**：控制台每 5 秒刷新，但 60 秒內只會真的查一次；查詢失敗也快取 60 秒，不會一直重打。
- **失敗時**：卡片和 `/status` 會寫原因（沒有 key、HTTP 狀態碼、逾時），不影響聊天。

控制台端點：`GET /api/quota`。

## Codex 額度

生圖的 preset（`dc-chat`）有開 `generate_image`（`dc-tool-restrict.config.allowImageGen: true`）時，
控制台的「Codex 額度」卡片和 `/status` 會顯示 5 小時與每週剩餘百分比、重置時間、重置券張數。
沒有開生圖的 preset 不查額度，也不排重置 ping；沒有另外的 `config.json` 開關。

- **資料來源**：`codex app-server` 的 `account/rateLimits/read`。app-server 會自己刷新 Codex 的登入 token，
  橋接不讀 `~/.codex/auth.json`，也不跟 Codex CLI 搶刷新。
- **快取 5 分鐘**：控制台每 5 秒刷新，但 5 分鐘內只會真的開一次 app-server；查詢失敗快取 60 秒。
- **5 小時窗口**：OpenAI 的規則是「前一窗口結束後的第一則訊息」才開始新窗口。橋接在
  `primary.resetsAt + 30 秒` 送一則 `codex exec` 的 `test`（模型 `gpt-6-luna`、low reasoning、
  ephemeral、關掉 shell／檔案工具）把新窗口打開。只寫 log，不發 Discord。
- **重啟與失敗**：狀態存 `state/discord-codex-reset.json`，同一個重置時間不會重送；失敗 15 分鐘後再試。
  每週額度已滿時跳過，等每週恢復後再處理。
- **失敗時**：卡片和 `/status` 會寫原因（app-server 起不來、逾時、Codex 回錯誤），不影響聊天。
- **額度太低時暫停生圖**：5 小時剩不到 15% 或每週剩不到 5% 時，`generate_image` 直接回錯誤，
  不再開 Codex；額度恢復後（橋接下一次查到）自動再開。判斷結果寫在
  `state/discord-codex-quota.json`，畫圖外掛只認 10 分鐘內的快照；快照過期或不存在就放行。

控制台端點：`GET /api/codex-usage`。

## 表情目錄

自訂表情不是全部塞進 prompt（3~4 個伺服器、幾百個表情會吃掉幾千 token）。做法是：

1. **建目錄**（一次性／有新表情時重跑）：

   ```bash
   npm run build:emojis                    # 所有 bot 所在的伺服器
   node scripts/build-discord-emojis.mjs --guild <id> --force
   node scripts/build-discord-emojis.mjs --limit 3   # 先試 3 個
   ```

   腳本會抓每個 emoji 的圖（Discord CDN）、一次 4~5 張丟給視覺模型，讓它寫
   「外觀、情緒、使用時機、tags」，存到 `state/discord-emoji/<guildId>.json`。
   只重做新的或換圖的（sha256 比對）。

   平時不用手動跑：橋接會監聽 `emojiCreate` / `emojiUpdate` / `emojiDelete`，
   15 秒去抖後自動重掃（hash 快取只會索引變動的那幾個）。控制台「表情目錄」卡片也有
   「更新目錄」按鈕，輸出寫在 `state/emoji-build.log`。

   建置期間卡片會顯示「更新中…（已完成/總數）」與日誌尾巴，子程序的輸出一併進
   控制台「日誌」與 pm2 log，不用等建置結束才看得到進度。

2. **常用表情提示**：prompt 只附**所有伺服器**加起來使用次數前 8 個（名稱＋使用時機；
   當前伺服器 +6 分）。同一個會話 30 分鐘最多帶一次，沒用過的不列，內容沒變就不重複帶。
   其他表情用 `mcp__discord__search_emojis` 查：當前伺服器 +6 分、名稱命中 +4、
   中文 bigram 關鍵字命中 +2，只回命中關鍵字的，最多 `emoji.maxCandidates` 個、
   受 `emoji.maxChars` 限制；query 留空就列當前伺服器的，並按群友實際使用的次數排序
   （次數存在 `state/discord-emoji-usage.json`，只計伺服器頻道裡出現過的自訂表情、
   同一則訊息同一個表情只算一次）。
   貼圖另外用 `mcp__discord__search_stickers` 查：比對名稱、說明、tags，最多 30 張；
   query 留空或沒有符合的就列出全部（一個伺服器的貼圖不多，列全部比回「沒找到」好）。
   以前兩種混在同一個工具裡，模型想找貼圖卻常只看到表情。

3. **模型輸出 `:名稱:`**，橋接在送出前換成 `<:名稱:id>`（動畫用 `<a:…>`）。目錄裡有的名稱
   都能用，不限當前伺服器；同名時當前伺服器優先。找不到就保留原文，`:名稱:` 會原樣送出，
   不會變成表情。這樣 prompt 不用塞長長的 ID，也不會抄錯。

4. **進來的表情**：群友訊息裡的 `<:名稱:id>`／`<a:名稱:id>` 會換成
   `[表情：名稱（目錄描述）]`，動畫表情會標成 `[表情：名稱（動圖；描述）]`；模型不用先查
   就看得到外觀。目錄沒有的只寫 `[表情：名稱]`。同一則訊息同一個表情只描述一次，描述裡的
   換行與括號會清掉。Unicode emoji 不動，也不另外送圖。

跨伺服器的自訂表情：bot 只要有 `USE_EXTERNAL_EMOJIS` 權限、而且是 emoji 所屬伺服器的成員，
就能送；**觀眾端不需要 Nitro 也看得到**（Nitro 限制的是使用者自己打字）。
用 `/invite` 或控制台產生的連結已包含這個權限（bitfield `563224831691840`）。
貼圖（guild sticker）才是綁伺服器的：`send_sticker` 只送當前伺服器的貼圖，私聊與別服的送不了。

### 表情反應（reaction）

有兩條路：

- **模型自己按**：`mcp__discord__add_reaction`，一輪最多 3 個；按錯或想換一個時用 `mcp__discord__remove_reaction`
  收回同一個表情，一輪最多 3 個（跟按的分開算，只能收回自己按的）。
  persona 規定戰績圖／遊戲結算／抽卡結果／排行榜截圖不要按、也不要回，被 @ 問才簡短回一句。
- **橋接自動按**（下面這段）：不呼叫模型。

自動 reaction 只看「沒有 @ bot、也沒有回覆 bot」的**頻道訊息**；
被叫到的訊息會正常回覆，不會再多加 reaction。

- 條件：訊息與目錄的關鍵字分數 ≥ `reactions.minKeywordScore`、通過 `reactions.probability`、
  該頻道距上次 reaction ≥ `reactions.cooldownMs`、全域每小時 ≤ `reactions.maxPerHour`。
- 指令、bot 自己、非允許頻道、私聊都不觸發。
- **看得到圖片的訊息不自動按**：收到當下就有圖片附件或連結預覽圖的訊息（戰績圖、截圖、梗圖）先交給模型判斷，
  避免只憑旁邊的文字亂按。連結預覽常常晚一點才補上，那一種仍可能在補上之前就按了。
- 用的是 bridge 端的關鍵字分數，**不額外呼叫模型**，所以不會燒 token。
- 需要 **Add Reactions** 權限（`1<<6 = 64`）；`/invite` 的連結已包含。
- 只加 reaction，不回訊息；失敗（多半是權限）只記 log，不會吵使用者。

## 畫圖（選用）

大肥魚可以真的生圖，不是用文字形容畫面。這條路要另外裝兩樣東西：

1. DSH profile 裝 [`dsh-generate-image`](https://github.com/zemul/dsh-generate-image)：它把本機 Codex CLI 的 `image_gen` 包成 `generate_image` 工具。
   ```sh
   dsh plugin --profile web add github:zemul/dsh-generate-image
   ```
   `node scripts/setup-dsh.mjs --discord` 會檢查 profile；沒裝就印一行警告，不會自動連網安裝。
2. 本機 Codex CLI 已登入（`codex` 跑一次）。生圖走 Codex 額度，不用另外的 API key。

流程：

- 有人說「畫一張…」「幫我畫…」，persona 叫模型呼叫 `generate_image`。呼叫後工具立刻回「已開始」，
  生圖在背景跑，不佔用會話；同一個會話的其他訊息照常處理。畫自己（「畫一張你的圖」）時 `inputImage` 填 `"self"`；
  畫別的 AI 娘時填角色代號（`glm`、`gpt`、`ernie`、`qwen`、`kimi`、`doubao`、`minimax`、`grok`、`gemini`、`claude`），
  打中文名也可以。一張圖有多個角色時用逗號串起來（`self,claude`），最多 4 個。畫一般插畫時不要填。
- `plugins/dc-agent-presets/dc-draw-image.mjs` 在執行前改寫參數：角色代號換成對應的
  `assets/ai-chan-sheets/<角色>/便于查看/横版完整设定图_01_三视图_查看用.jpg`（多個角色就換成多張），`outputDir` 固定 `state/discord-images`。
  模型填路徑或亂填角色名一律拒絕；有指定角色時再補一句英文，要求維持每張設定圖的臉、髮色、服裝與配件。
  11 個角色的代號、中文名與資料夾對照在 [assets/ai-chan-sheets/README.md](../../assets/ai-chan-sheets/README.md)。
- 生圖用的 Codex 是受限版本：關掉 `shell_tool`、`unified_exec` 與 `view_image`，工作目錄在 `state/discord-imagegen-work`。
  `codex-imagegen-wrapper.mjs` 拿掉 adapter 的 `-s`，改用 permission profile：`:root=read`、`/mnt=deny`（沒有 write 規則）；
  所以 `/mnt` 底下的掛載讀不到，其他本機路徑也一樣是唯讀。
  prompt 裡有 URL、絕對路徑、`../`、`.dsh`、`credentials.yaml`、`discord-agent.json` 或明顯的指令字樣會被拒絕；
  這是第二層，真正的邊界是 shell/exec/view_image 關閉與 permission profile。
- 畫好後外掛會把一則【生圖完成】提示（含圖片路徑）送回同一個會話，模型再用 `mcp__discord__send_image` 送圖：
  `file` 填提示裡的 `path`，`content` 可以帶一句話。
  橋接只認 `state/discord-images` 裡的檔名，會檢查是不是真的圖片、有沒有超過 10MB；不是就回錯誤，不會把主機其他檔案送出去。
- 這個目錄只留最近 100 張，舊的會自動刪掉。bot 需要 **Attach Files** 權限（`/invite` 的連結已包含）。
- 額度太低時暫停：5 小時剩不到 15% 或每週剩不到 5% 時，`generate_image` 會直接拒絕並說明原因；
  額度恢復後自動再開（見「Codex 額度」）。

限制：

- 一張要 1~3 分鐘，背景進行。persona 會先送一句「等我一下」再畫；不要主動畫，也不要一次畫好幾張。
  生圖引擎同一時間只跑一張（Codex 的 `generated_images` 共用），其他排隊，但排隊不會卡住會話。
- `/reset` 會取消這個會話還在跑或排隊的生圖工作（背景工作每 15 秒問橋接一次，最多 15 秒內停掉）。
  DSH 或橋接重啟時，還沒畫完的工作會消失，不會補送。
- DSH 和橋接要在同一台機器：`send_image` 是用本機路徑讀 `state/discord-images`，不是把圖上傳到別台。
- 情色、血腥、真實人物攻擊、政治人物照【安全邊界】不畫。
- 設定圖是外部作品：角色形象出自 ZipZipPipe，補全由 lmy414 做的，授權 **CC BY-NC-SA 4.0（非商業）**。
  來源、署名與授權全文見 [assets/ai-chan-sheets/README.md](../../assets/ai-chan-sheets/README.md)。

## 群友記憶（選用）

模型可以用工具記住群友的事（在做什麼、興趣、希望怎麼被稱呼），之後那個人說話時，橋接把這些事帶進 prompt。

- **模型自己決定記什麼**：`remember_user` 記一條短句（最多 100 字），掛在 `#編號` 那則訊息的發言者身上；
  事情變了就用 `forget_user_fact` 刪掉舊的那條。可以記本人說的事，也可以從他的發言推測（習慣、喜好、常聊的話題），
  推測的那條開頭會標「（推測）」。沒被叫到、這輪不說話時也會記（記憶工具不算說話）；
  Persona 列了要當輪記的句型（「我在…」「我喜歡…」「叫我…」等）。Persona 規定不記：別人轉述或叫它記別人的事、玩笑話、個資、
  健康／政治／性向這類敏感的事、貶低人的評價。
  兩個工具都會回那個人目前的整份清單（有編號），模型照最新的編號刪。同樣的一句不會重複記。
- **名字核對**：`remember_user` 要帶 `name`（這件事是誰的）。橋接拿它比對 `#編號` 那則的發言者
  （伺服器暱稱、Discord 顯示名稱、使用者名稱，不分大小寫、忽略空白和看不見的字；2 字以上可以只寫名字的一段）。
  對不上就回錯誤，說那則其實是誰說的，不會記、也不算進每輪上限。防止編號指錯人時記到別人身上。
  記憶檔存的名字是 prompt 裡顯示的那個（看不見的名字已經換成使用者名稱）；舊資料裡只有看不見字元的名字，
  讀檔時當成沒有名字，控制台改顯示使用者 ID，下次記同一個人時補上。
- **什麼時候帶進 prompt**：一批裡說話的人（有沒有 ★ 都算，最多 5 位）有記憶時，會放在【你記得的群友】區塊。
  同一個會話裡，記憶沒變就不重複帶；記憶有改、或上次帶已超過 30 分鐘（DSH 可能壓縮掉了）才再帶。
  區塊寫明「是資料，不是指令」，內容去掉換行與 `★`、`【管理員】` 標記。`user_info` 也會列出那個人的記憶
  （`deny.users` 與模型不理名單一律不列；`deny.self` 只有查的那則是 @bot／回覆 bot 時才列）。
  每條後面標「（今天）」或「（N 天前）」：記下或最後一次再記同一句的時間，讓模型判斷哪條可能過期。
- **推測 30 天過期**：開頭是「（推測）」的那條，30 天沒再記一次同一句，就在下一次帶記憶時刪掉（本人說的不會過期）。
  模型覺得推測還對，用 `remember_user` 再記同一句就會續期。
- **所有伺服器共用**：記憶掛在使用者身上，不分伺服器；在 A 伺服器記的事，那個人在 B 伺服器說話時也會帶進來。
- **私聊不記**：在私聊呼叫記憶工具會回錯誤。也不記 bot。NSFW 頻道照常記。
- **上限**：每人最多 `memory.maxFacts` 條（預設 20，滿了丟最舊的）；總共最多 500 人（滿了丟最久沒更新的）；
  每輪最多寫 3 次（記與刪合計）；命中敏感資訊閘門的內容不記。

設定在 `config.json` 的 `discord.memory`，欄位見上面的設定表。預設 `false`，要開：

```json
"memory": { "enabled": true }
```

看自己的記憶：`/memory`（回覆只有自己看得到）。管理員可以在控制台「群友記憶」卡片看全部
（端點 `GET /api/memory`）。

刪除自己的記憶：

- `/forget`（slash command，結果只有自己看得到；私聊也能用）

只刪群友記憶；目前這個頻道的 DSH 會話上下文不受影響。要保留話題換 prompt 用 `/reload-system-prompt`；
要全部清掉用 `/reset`（管理員）。

> 記憶檔在 `state/discord-memory.json`，`state/` 已被 `.gitignore` 排除。檔案壞掉時會改名為
> `.corrupt-<timestamp>` 並從空的重建，日誌會留一行錯誤。格式是第 3 版（`users` 以 user id 為鍵）；
> 其他版本的檔案會被當成不支援的版本，改名備份後從空的重建。

## 頻道筆記（選用）

記「群裡發生過什麼」：約定、決定、反覆被提起的事件、梗的由來。跟群友記憶分開，關於某個人的事還是用
`remember_user`。

- **工具**：`note_event`（一句最多 150 字，`days` 預設 30、最多 180）、`search_notes`（`query`／`days` 可省略）、
  `forget_note`（用 `search_notes` 回傳的編號）。私聊不能記，一輪最多寫 2 條。
- **注入**：開啟後，每批 prompt 會帶這個頻道最近 `injectMax` 條（受 `maxChars` 限制），
  放在群友記憶之前；同一會話帶過、沒變的筆記不重複帶（30 分鐘後或筆記更新才會再帶）。
- **上限**：每個頻道 100 條，滿了丟最舊的；過期的筆記不注入也查不到。
- **敏感資訊**：跟其他工具一樣過閘門（本機路徑、憑證、已知令牌）；命中就不記。
- **控制台**：「記憶」分頁的「頻道筆記」卡片會列出全部筆記（頻道、種類、記下時間、過期日），可以逐條刪除
  （端點 `GET /api/notes`、`POST /api/notes/delete`）。
- **每天摘要（v2）**：`notes.dailySummary.enabled` 打開後，每天 `hour` 點之後（bridge 主機時區），對每個有活動的頻道
  讀最近 24 小時（最多 100 則），用 `dc-learner` 背景會話寫一條 300 字以內的摘要筆記，7 天後過期。
  少於 10 則不做；每天每個頻道只試一次，失敗不會當天重試（bridge 重啟後記憶體重來，同一天可能再試一次）。
  `deny.users` / `deny.self` / 模型不理名單的人的訊息不進摘要（@bot 的那一則也不進：摘要是背景掃描）。
  摘要會花一次模型會話的 token，預設關閉；命中敏感資訊閘門的摘要不記。
- **檔案**：`state/discord-notes.json`，壞檔備份成 `.corrupt-<timestamp>` 後從空的重建。

```json
"notes": {
  "enabled": true,
  "injectMax": 5,
  "maxChars": 600,
  "dailySummary": { "enabled": false, "hour": 4 }
}
```

## 回訪（選用）

模型自己排「N 分鐘後回來看」（`schedule_followup`，5~180 分鐘）。時間到了 bridge 送一個只有
`【回訪】你 N 分鐘前說要回來看：…` 的回合，模型再決定要不要說話；沒有預先寫好、時間到就直接送出的訊息。

- **限制**：一個會話同時最多 2 個、每天 6 個；`/reset` 取消；安靜期間（`set_quiet`）延後到安靜結束。
- **不進頻道**：回訪本身不是訊息，模型不說話就什麼都不會出現。
- **狀態只在記憶體**：bridge 重啟就清掉，所以不支援以天計的提醒。
- **預設關閉**：`followup.enabled` 打開後 `schedule_followup` 才有作用；關著時呼叫會回錯誤，也不會有排程。

```json
"followup": { "enabled": true }
```

## 黑話學習（選用）

從允許的頻道收集語料 → 學習會話抽候選 → 管理員在控制台確認 → 下一則 prompt 才看得到。

- **收哪些訊息**：`allow.guilds` / `allow.channels` 內 bot 讀得到的伺服器頻道都收，包含不給 `@everyone` 看的頻道、
  私密討論串、NSFW 頻道（很多伺服器把頻道只開給某個身分組，用 `@everyone` 判斷會什麼都收不到）。
  不收：私聊、bot 的訊息、`!`／`/` 開頭的指令、含本機路徑／憑證特徵的訊息。
  因為每個詞都要管理員確認才會注入，私密頻道的內容不會自己流到別的頻道或別的伺服器。
- **不會自動轉正**：候選只存在 `state/discord-slang.json`，控制台按「確認」才會注入。
- **全部伺服器共用**：網路用語不太分哪一服，A 服確認的詞 B 服也會用到。同一個詞不管在哪一服學到，
  都只存一筆、累加出現次數；詞條的 `guildId` 只記第一次在哪一服學到。
  改成共用之前各服各自學過的同一個詞會留著重複的幾筆，注入只帶出現次數最高的那筆，其餘可以在控制台刪掉。
- **成本控制**：同一頻道累積 `extractMinMessages` 則、距上次 ≥ `extractCooldownMs`、
  每天 ≤ `maxPerDay` 才抽一次；失敗也吃冷卻，不會每則訊息重試。
- **學習會話隔離**：獨立 DSH 會話、不進 `reverse`、不回 Discord；提問／審批自動取消、結束就歸檔。
- **注入**：只有 `confirmed`，格式 `【群裡的黑話】- 詞：意思（用法：…）`，最多 `injectMax` 條。
  先挑這一批訊息（含引用的訊息）裡出現的詞，不分大小寫和全半形；剩下的名額照出現次數補。
  一個字的詞不算命中（太容易撞到）；英文詞要整個字對上（`gg` 不會撞到 `eggs`）。
  同一個會話逐條記：帶過的那條 30 分鐘內不再帶，之後只補帶新命中的詞；詞條改過、或超過 30 分鐘才再帶。
  沒命中時只帶出現次數前幾名，帶過就停，不會一批一批往下把整個詞庫帶進會話。
  私聊不注入。
- **prompt injection**：頻道訊息會轉義後包進 `<chat>`，prompt 明講只當語料。學習會話用
  `dc-learner`（短 prompt），並在註冊期把 profile 掛的唯讀 web-search MCP 一起移除；
  `request/header` 的 `tools` 是 0 個，模型沒有工具可呼叫。
- **模型自己查與收錄**：`dc-chat` 另外掛了 `mcp-slang`。模型看到不懂的詞可以用 `lookup_slang` 查詞庫
  （狀態、出現次數、意思、用法都回），不用等下一批注入；確定意思後用 `record_slang` 收成候選。
  查詞時已確認的詞全部伺服器共用；候選與已拒絕只回同一個伺服器的（私聊只看得到已確認）。
  同一個詞已經有就只回「已收錄過」，不改意思、不累加次數，也不會復活已拒絕的詞。
  頻道風格用 `record_channel_tag` 記，同頻道同名標籤也一樣只回報。一輪最多呼叫 3 次（重送也算），私聊不給寫。
  這條路不用等 `extractMinMessages`，少見的詞看到就能收；學習會話照舊跑，兩邊寫到同一個詞會合併。

開啟：

```json
"slang": { "enabled": true }
```

控制台「黑話詞庫」卡片可以確認／拒絕／編輯／刪除，候選排在最前面。詞庫檔在
`state/discord-slang.json`（`state/` 已被 gitignore）；壞檔會備份成 `.corrupt-<timestamp>`
再重建，上限 200 候選 / 500 已確認，超過先丟出現次數少的候選。

### 頻道風格

同一次抽取順便看「這個頻道怎麼聊天」，最多產出 2 條風格候選（例如「回覆長度：大家都一兩句話」）。

- **只記風格，不記事件**：收的是不隨話題變的習慣（回覆長短、語氣、常用語尾、表情貼圖、互動節奏）。
  某段時間在聊什麼、一次性的話題或事件不算，那些由頻道筆記的每日摘要處理。
- **按頻道存**：詞條是 `kind: "style"`、帶 `channelId`，跟黑話放在同一個詞庫檔、共用上限。
  討論串算自己的頻道，不會套用母頻道的風格。
- **每頻道最多 5 條**：候選和已確認一起算（已拒絕不算）；滿了學習和 `record_channel_tag` 都不再收，
  要換得先在控制台刪一條。注入上限本來就是 5 條，存更多也看不到。
- **不重複提**：prompt 會列出這個頻道已有的風格標籤（含已拒絕的），模型只補新的觀察；
  標籤相同的候選只累加次數，已拒絕的不會復活。
- **確認後才注入**：控制台「頻道風格」卡片按頻道列出，可以用頻道下拉選單只看一個頻道；確認、拒絕、編輯、刪除跟黑話一樣。
- **注入**：只有已確認的，每個頻道最多 5 條、300 字，格式
  `【這個頻道的風格】- 標籤：描述`。同一個會話裡整塊內容沒變、又沒超過 30 分鐘就不重複帶。
- 沒有另外的開關：跟著 `slang.enabled`。

> `dc-learner` 由 `node scripts/setup-dsh.mjs --discord` 安裝（跟 `dc-chat` 同一個 bundle）。
> 如果 DSH 的 preset 清單沒有它，學習會記一行錯誤並跳過，聊天不受影響；重跑安裝再重啟 DSH 即可。

### 觸發對話統計

- 只有模型真的送出訊息（`send_message`／`send_image`／`send_sticker`／`create_poll`）才記一次；
  同一個回合送好幾則只算一次，避免模型連發把數字洗高。
- 另外記「繪圖次數」：`send_image` 每成功送出一張就加一次，歸給這個回合叫 bot 的人；
  不影響對話次數與最後觸發時間。
- 這批訊息有 ★ 就只記叫 bot 的人；沒有 ★（自由參與）記整批的發言者；同一個人只算一次。
- 存在 `state/discord-triggers.json`（`state/` 已被 gitignore）。控制台總覽顯示今天人數、總人數、
  總次數、畫圖次數與最常觸發的 3 人；「對話」分頁列出全部人（含每個人的畫圖次數），
  可搜尋名稱／user id、每頁 20 人。
- 只記使用者 id、顯示名稱、對話次數、畫圖次數與最後觸發時間，不記聊天內容；超過 5000 人丟最久沒觸發的。
- 當事人用 `/forget` 會把記憶和觸發統計一起刪掉，私聊也一樣。
- 模型可以呼叫 `mcp__discord__conversation_stats` 自己撈同一份統計（全部伺服器加總的今天／總計／總次數／畫圖次數；前 5 名只列同一個伺服器的人，私聊只回數字）。

## 誰決定要不要發訊息（MCP）

回合結束時橋接**不會**自動把模型文字貼到頻道。模型要說話或動作，就呼叫 `mcp__discord__*` 工具。

模型能用的工具就是下面這些（2026-10-30 以 `src/mcp-discord.js` 與 preset 現況為準）。
`dc-chat` 的 `dc-tool-restrict` 會藏掉 DSH 其他內建工具（讀寫檔、shell 等）。
`mcp__discord__*` 與 `mcp__slang__*` 的 `token` 由 DSH 外掛 `dc-session-token` 自動帶入
（模型看不到令牌，也不用填）；下面只列其他參數：

- `mcp__discord__send_message`（`content`、`reply_to` 可省略）：送一則訊息（Discord Markdown；`:名稱:` 會換成伺服器表情）。
  沒有 `message` 參數：正文只放 `content`，要接的那則 `#編號` 只放 `reply_to`；`content` 只有一個查得到的 `#編號` 會被擋（400）。
  有 `reply_to` 就用 Discord 的「回覆」接那則（不額外 ping 對方）。回傳
  `已送出到 #頻道名。這則的訊息編號是 #xxxx（之後改、收回、看反應用這個）`；太長切成好幾則時列出每個編號
- `mcp__discord__send_image`（`file`、`content`／`reply_to` 可省略）：把 `generate_image` 畫好的圖送進頻道。
  `file` 填【生圖完成】提示裡的 `path`（完整路徑或檔名都行），橋接只認 `state/discord-images` 裡的圖；
  可以順便帶一句話，佔「一輪 5 則」的名額。沒有 `content` 也可以只送圖。回傳格式跟 `send_message` 一樣
- `mcp__discord__send_sticker`（`sticker`、`content`／`reply_to` 可省略）：送一張當前伺服器的貼圖，回傳格式跟 `send_message` 一樣
- `mcp__discord__edit_message`（`message`、`content`）：改自己送出的一則訊息。只認**這個模型自己用工具送出**的訊息
  （送出時橋接記下的，每個頻道最近 200 則，橋接重啟就清空）；進度、壓縮提示、審批、提問、錯誤、指令回覆這些橋接自己發的不能改。
  改完要一則放得下（`maxMessageChars`），投票不能改。內容一樣過敏感資訊閘門，佔「一輪 5 則」的名額。改之前橋接把舊內容記進日誌
- `mcp__discord__delete_message`（`message`）：收回自己送出的一則訊息，範圍跟 `edit_message` 一樣，一輪最多 2 則。刪之前舊內容記進日誌
- `mcp__discord__view_message`（`message`）：看這個頻道一則訊息的完整內容：發言者、時間、有沒有編輯過、全文（最多 1500 字）、
  貼圖、附件清單、連結預覽（embed 的標題、說明、網域、欄位）、投票（題目、選項、票數）、回覆的是哪一則、reaction 統計，
  再附上圖片（本則與被回覆那則的附件、貼圖、連結預覽的圖，最多 `media.maxCount` 張，走同一套下載與縮圖）。
  被回覆那則的附件也要看得到：引文只留 300 字，原圖只有 `view_message` 會附上。
  回覆的對象只讀同一個頻道的一般回覆；轉發只顯示轉發的文字，不讀別的頻道。連結預覽的圖只抓 Discord 代理過的網址。
  作者在 `deny.users` 的人一律不給讀；在 `deny.self` 的人只有 @bot／回覆 bot 的那一則讀得到（那一則本來就照正常流程處理）；
  在模型不理名單的人一律不給讀。
  訊息裡有連結時，也會讀後面幾則由機器人補上的同一個連結預覽（X、Facebook、Threads、bilibili、IG 這類修復 bot；
  只換網域的改寫連結也算同一條，例如 fxtwitter、fixupx、ddinstagram），
  因為批次 prompt 不讀 bot 訊息，這些預覽只有在 `view_message` 看得到；
  修復 bot 的訊息本文（換過網域的完整網址）也會一起列出
- `view_message` 的影片連結：訊息文字裡有白名單連結（YouTube、`m.youtube.com`、`youtu.be`、`music.youtube.com`、`youtube-nocookie.com`）
  且 `videoLinks.enabled`（而且 `media.enabled` 沒關）時，橋接用 `yt-dlp -g` 取**直連串流網址**（360p，拼圖一格才 240px 寬），再用同一套 ffmpeg 抽 6 格拼圖，
  不會把整支影片下載下來。抽格窗口跟影片附件一樣（`media.maxVideoSeconds`）。
  yt-dlp 失敗（私人影片、會員限定、地區鎖、直播、沒裝）只多一行「影片連結看不了：原因」，其它內容照回。
  白名單是防 SSRF：yt-dlp 會連原站，不能讓群友丟任何網址就讓伺服器去抓。抓 YouTube 違反其服務條款，要不要開由管理員決定；
  預設關閉，而且 yt-dlp 要自己定期更新，沒更新就會整條失效。
- `mcp__discord__search_history`（`query`、`from`、`date`、`limit` 都可省略，但 `query`／`from` 至少給一個）：在這個頻道找訊息。
  伺服器頻道走 Discord 的訊息搜尋 API（`/guilds/{guild}/messages/search`），不用從最新一則一則往回翻；
  一次最多比對 75 個符合（3 頁 × 25），更早的符合要再給 `date` 縮小範圍。
  沒給 `date` 取最新的一批，給了 `date`（`YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`，bridge 主機時區）就取那之後最舊的一批。
  `query` 用空白分開的每個詞都要出現（不分大小寫），比對訊息文字與連結預覽的內容；
  `from` 給某人說過的一則 #編號，只找他的。最多回 20 則，結果一律舊→新。
  討論串、語音和私聊沒有這條搜尋 API，維持往回掃最近 300 則（每頁 100 則、最多 3 頁）。
  和 `read_history` 合計一輪最多 3 次，超過回 429；沒開 Message Content 意圖時，別人的訊息沒有文字，結果會註明
- `mcp__discord__create_poll`（`question`、`answers`、`hours`／`multi` 可省略）：在這個頻道發一個 Discord 投票。
  題目最多 300 字、選項 2~10 個（每個最多 55 字，重複的與空的會拿掉）、`hours` 1~168（預設 24）、`multi` 是否可複選。
  文字過敏感資訊閘門，佔「一輪 5 則」的名額。bot 沒有「建立投票」權限時回錯誤
- `mcp__discord__add_reaction`（`message`、`emoji`）：對那則訊息按表情；`emoji` 是伺服器表情名稱或一個 Unicode emoji
- `mcp__discord__remove_reaction`（`message`、`emoji`）：收回你在那則訊息按過的同一個表情。
  只能收回自己按的；沒按過或已經收回時回 404，一輪最多 3 次（跟 `add_reaction` 分開算）
- `mcp__discord__set_quiet`（`minutes`、`reason` 可省略）：讓自己安靜 1~120 分鐘。這段時間**沒叫 bot** 的頻道訊息
  不送進模型（省 token），叫 bot 的照常；黑話語料照收。`minutes=0` 提早結束。
  安靜結束後的下一批會重新帶一次頻道上下文。狀態只在記憶體，bridge 重啟就清掉
- `mcp__discord__ignore_user`（`message`、`minutes`、`reason` 可省略）：把那則訊息的發言者設進模型自己的不理名單，
  `minutes` 1~1440；`minutes=0` 解除。這段時間他的訊息（包括 @bot）不送進模型，讀歷史／搜尋／摘要也看不到。
  管理員不能設；控制台「會話」分頁看得到。跟 `deny.users`、`deny.self` 分開（見「模型自己不理的人」）
- `mcp__discord__schedule_followup`（`minutes`、`note`）：排一個回訪，`minutes` 5~180。
  時間到了 bridge 送一個只有【回訪】提示的回合，模型再決定要不要說話（不是預先寫好直接送出）。
  一個會話同時最多 2 個、每天 6 次；`/reset` 取消；安靜期間延後到安靜結束。狀態只在記憶體，
  bridge 重啟就清掉
- `mcp__discord__search_emojis`（`query` 可省略）：查可用的自訂表情（見「表情目錄」）
- `mcp__discord__search_stickers`（`query` 可省略）：查當前伺服器的貼圖（`send_sticker` 用的名稱）
- `mcp__discord__read_history`（`before`、`date`、`limit` 都可省略）：讀這個頻道的訊息，預設 20 則、最多 50 則、總長 6000 字。
  沒給時間就從最新往前讀；`before` 從那則往前；`date`（`YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`）從那個時間往後讀，兩個不能一起給。
  未來的時間回「還沒有訊息」；和 `search_history` 合計一輪最多 3 次
- `mcp__discord__user_info`（`message`）：查那則訊息發言者的顯示名稱、全域名稱、使用者名稱、身分組（含最高身分組顏色）、
  加入時間、帳號建立時間、加成起始日、禁言到期時間，以及記憶；另外附上頭像圖片（有伺服器專屬頭像就用那張，128px，
  經 `media` 設定的縮圖流程）。頭像抓不到時只少圖，文字照回。個人簡介、代名詞 Discord 不給 bot 讀；線上狀態要 Presence 特權 intent，沒開
- `mcp__discord__server_info`（沒有其他參數）：查目前這個伺服器與頻道：伺服器名稱、簡介、建立日期、擁有者、成員數、
  加成等級、頻道與身分組數量、自訂表情與貼圖數量、bot 在這裡的暱稱，以及目前頻道的名稱、主題、是否 NSFW。私聊回錯誤
- `mcp__discord__conversation_stats`（沒有其他參數）：查對話次數統計：全部伺服器加總的今天人數／總人數／總次數／畫圖次數，
  以及這個伺服器最常找 bot 的前 5 人（私聊只回數字，不列名字）
- `mcp__discord__remember_user`（`message`、`name`、`fact`）：記住那則訊息發言者的一件事；`name` 對不上發言者就回錯誤（見「群友記憶」）
- `mcp__discord__forget_user_fact`（`message`、`number`）：刪掉那個人記憶裡的第 `number` 條
- `mcp__discord__note_event`（`text`、`days` 可省略）：記一條這個頻道發生的事（約定、決定、反覆被提起的事件、梗的由來），
  最多 150 字；`days` 幾天後過期，預設 30、最多 180。一輪最多 2 條，私聊不能記
- `mcp__discord__search_notes`（`query`／`days` 可省略）：查這個頻道的筆記；`query` 的每個詞都要出現，
  `days` 只看最近幾天。回傳的編號給 `forget_note` 用
- `mcp__discord__forget_note`（`number`）：刪掉這個頻道第 `number` 條筆記（舊→新的編號）
- `mcp__slang__lookup_slang`（`term`）：查黑話詞庫；`term` 也可以是一小句，只要包含那個詞就查得到。
  回每個詞的狀態（候選／已確認／已拒絕）、出現次數、意思與用法；沒收錄就回沒有
- `mcp__slang__record_slang`（`term`、`meaning`，`usage`／`examples` 可省略）：收成候選。已經有同一個詞就回「已收錄過」，
  不改意思、不累加次數，也不復活已拒絕的詞；一輪最多呼叫 3 次（重送也算），私聊不給寫
- `mcp__slang__record_channel_tag`（`tag`、`description`）：把這個頻道的風格記成候選；同頻道同名標籤同樣只回「已收錄過」。
  只收不隨話題變的習慣，一次性的話題或事件不算；一個頻道最多 5 條，滿了回錯誤
- `mcp__web-search-safe__web_search`（`query`）：只讀聯網搜尋，走 `webSearch.provider`（SearXNG／DeepSeek／Bing）
- `mcp__web-search-safe__web_fetch`（`url`）：只讀抓網頁正文，最多 50000 字，擋內網與本機位址。
  有驗證頁特徵（任何狀態碼）就回 `isError`「機器人驗證」；其他 403／503 說網站拒絕訪問，其他 4xx／5xx 帶狀態碼；不會把驗證頁 HTML 當正文
- `generate_image`（`dsh-generate-image` 外掛，只有 `dc-chat` 放行）：生圖或拿設定圖改圖。
  `prompt` 必填；畫指定角色時 `inputImage` 填 `"self"` 或角色代號（`gpt`、`qwen`…），
  多個角色用逗號串起來（`self,claude`，最多 4 個）；不指定角色就不要填。參數由 `dc-draw-image` 鎖死（見「畫圖」）
- `ask_user_question`（DSH 內建）：向使用者提問，橋接轉成 Discord 訊息（見「提問與審批」）
- `todo_write`（DSH 內建）：模型自己的待辦清單，不會送到 Discord

`mcp__discord__*` 來自 `src/mcp-discord.js`，`mcp__slang__*` 來自 `src/mcp-slang.js`，
`mcp__web-search-safe__*` 來自 `src/mcp-web-search-safe.js`，三個都由
`node scripts/setup-dsh.mjs --discord` 寫進 DSH profile 的 `cordis.patch.yml`。

`message`、`reply_to`、`before` 都是 **#編號**：prompt 裡每則訊息（【新訊息】與【最近頻道訊息】）
前面都有一個 `#k7f3ab` 這種 6 字代號，引用裡的 `#編號` 是被引用那則的編號，`read_history` 的結果也有。

- 編號由 Discord 訊息 id 雜湊出來：同一則訊息永遠同一個編號，橋接重啟後也一樣。
  流水號在重啟後會從頭數，舊的編號就會指到別則，所以不用流水號。兩則撞號時後登記的那則改用 7 字編號；
  只有撞號又剛好在重啟後以相反順序出現時，舊編號才會指錯（一個頻道約萬分之二）。
  重啟後還沒重新出現在 prompt 裡的舊編號會查不到，工具回「找不到」。
- 每個頻道各自一張表（最近 500 則），令牌只能查自己頻道的編號。
- `read_history`、`search_history`、`view_message`、`user_info` 與記憶工具回給模型的群友文字會去掉換行，
  並把 `★`、`【管理員】` 改寫；訊息裡的 mention 會換成名字（規則見「批次與自由參與」）。
  群友沒辦法透過暱稱或內文偽造標記。

每一則 prompt 的**最後一行**（時間之後）是 `【發送】`，提醒模型「文字不會自動送出、要呼叫工具」。
令牌不再寫進 prompt：DSH 外掛 `dc-session-token` 用 `exec.agent.id` 向橋接換這個會話的令牌，
在工具執行前補進參數（模型看不到，也抄不走）。
Persona 把「用工具說話」放在最前面：每一則 ★（有人在叫它）都要接到（回一句或按 reaction），
好幾個人在叫它時一輪可以送好幾則、用 `reply_to` 各回各的。沒有 ★ 的訊息三選一：有話想接就說、有感覺但沒話就按 reaction、
真的無感才跳過；reaction 不佔說話頻率，persona 叫它通常按 1 個、一輪最多 3 個，並列了該按與不該按的情況。
沒有 ★ 的訊息裡的「你」，persona 規定當成在對前面說話的人，不是對 bot（群友說「你是小丑」不會被當成在罵它）。
**沒有呼叫工具，這一輪就不送**；回合文字可能只是思考，橋接不會代送，只會在日誌記一行。

- **模型指定不了頻道**：工具只收 token，橋接用 token 反查會話；被 prompt injection 也只會
  送回原本那個頻道。令牌綁在 DSH 會話上，`/reset` 或橋接重啟後會換一組；
  外掛的令牌快取會過期，第一次失敗會自動重查一次。
- **權限**：橋接只接受「還活著的會話 + 目前在白名單裡」的會話（討論串也看母頻道的黑名單）；
  令牌過期重查一次還是不行時，工具會回錯誤並要模型回報管理員，不要自己填 token。已經排隊、還沒送出的訊息，
  遇到 `/reset` 也會被擋下來，不會送進新的會話。
- **敏感資訊閘門**：跟舊版一樣，命中本機路徑／憑證／已知令牌的內容整條攔掉，工具會回錯誤給模型，
  模型不會誤以為已送出。
- **一輪最多 5 則**（訊息、貼圖、投票、修改合計），**按 reaction 最多 3 個**、**收回 reaction 最多 3 個（跟按的分開算）**，**收回訊息最多 2 則**，**歷史查詢最多 3 次（`read_history` + `search_history` 合計）**，**記憶寫入最多 3 次**；
  同一會話的訊息照順序送，超過 2000 字由橋接切段。
- **改和收回只認自己送的**：模型被 prompt injection 也改不了審批提示（例如改成「回通過繼續」騙管理員），也刪不掉別人的訊息。
  不用 discord.js 的 `deletable`：bot 有 Manage Messages 時它對別人的訊息也是 true。
- **模型沒呼叫工具時**：這一輪就沒有回覆；日誌會記「回合完成但沒有呼叫發送工具」。只按了 reaction 或只收回訊息不算。
  有人叫 bot 的回合（★）若模型只輸出文字、沒呼叫任何會送到 Discord 的工具（發送、reaction、修改、收回），
  橋接會在同一個會話補一句提醒，請它用工具回話（每 10 分鐘最多一次；提醒自己的回合不會再觸發），
  免得群友以為被忽略。模型收到提醒後仍然可以不說話。
  先確認 DSH 有掛 `mcp-discord`、persona 是最新版（重跑 `setup-dsh --discord` 並重啟 DSH）。

工具端點是橋接自己開的 loopback HTTP：`127.0.0.1` 隨機埠，只有 `POST /hello`（MCP 報到）與
`POST /sessionToken`（DSH 外掛換會話令牌；這個路徑不要求會話令牌，只要端點 secret）、
`POST /imageJob`（DSH 外掛回報背景生圖開始／完成／失敗；帶 `sessionId`，也不要求會話令牌）與
`/send`（`send_message` 與 `send_image` 共用）、`/react`、`/edit`、`/delete`、`/poll`、`/quiet`、`/ignore`、`/followup`、`/emojis`、`/stickers`、`/history`、`/search`、`/view`、`/user`、`/server`、`/remember`、`/forget-fact`，網址與令牌寫在 `state/discord-agent.json`
（橋接重啟就換一組）。MCP server 是 `src/mcp-discord.js`，由 DSH 以 stdio 拉起。
**新增或修改工具要重啟 DSH**（MCP server 由 DSH 拉起），只重啟橋接不會生效。

## 行為細節

- 回覆只在模型呼叫 `mcp__discord__send_message`／`send_image`／`send_sticker`／`create_poll` 時送出；回合文字不會自動貼出。不做逐字串流。
- **進度訊息**：模型在一個回合裡第一次用工具時（不管有沒有人叫 bot），橋接會在頻道貼一則灰色小字（`-#`）的進度，
  回合結束就刪掉。每呼叫一個工具加一行，例如「🔍 搜尋：關鍵字」、「🌐 讀取網頁：網域」、「📜 翻聊天紀錄」、「🔎 搜尋聊天紀錄：關鍵字」、「🎨 畫圖」。
  只在思考、沒用工具時不貼（「正在輸入」就夠了）。發訊息、貼圖、送圖、reaction、投票、修改、收回不列（那本身就看得到）。
  模型已經回覆後不再新貼進度。不顯示模型的思考原文（可能有群友記憶、人設）；
  每行一樣過敏感資訊閘門，命中就只寫「🔧 使用工具」。訊息是靜音的、不解析 @，不會吵到人。
  橋接在回合中途掛掉時，那則進度會留在頻道裡，要手動刪。
- **壓縮提示**：DSH 壓縮上下文（`compaction/start` → `compaction/end`）要十幾秒，期間只有「正在輸入」看不出在做什麼。
  所以收到 `compaction/start` 就在頻道貼一則靜音小字「🗜️ 聊天紀錄太長，正在壓縮，稍等一下…」，收到 `compaction/end` 就刪。
  DSH 自己觸發的壓縮和橋接送的 `/compact` 都會貼，不分有沒有人叫 bot。壓縮失敗時 `compaction/end` 帶的錯誤會記進日誌。
  事件流斷線或會話重置時一起刪；橋接在壓縮中途掛掉時，那則提示會留在頻道裡，要手動刪。
- **引用**：訊息回覆了某則訊息時，被引用的編號、作者與原文會以 `[引用 #編號 某人：原文]` 接在那一行後面。
  引文只留 300 字、不帶圖片；要看全文或原圖就讓模型 `view_message` 那個編號，
  `view_message` 會連被回覆那則的附件圖片一起附上。
  被引用的那則先從 discord.js 的訊息快取找（bot 開著時收到的訊息都在裡面，不打 API）；
  快取沒有就抓那一則，抓不到（被刪、rate limit）才只寫 `↪回覆 某人`。
  原作者在 `deny.users` / `deny.self` 裡也照樣帶：引用是群友自己貼進來的公開內容。
  模型不理名單裡的人例外：他的話不帶，只留 `↪回覆 某人`。
  只認同一個頻道的一般回覆：轉發和別頻道的引用不帶（那個頻道可能不在白名單裡）。
- **頻道上下文**：會用 `channel.messages.fetch` 抓這一批第一則之前的 `context.messages` 則訊息放進
  prompt。預設模式每一批都帶（模型看不到沒叫它的訊息）；自由參與只在會話的第一批帶（橋接重啟或
  `/reset` 後再帶一次）。這需要 bot 的 **Read Message History** 權限；不需要 Message Content 意圖。
  抓回來的歷史訊息裡，`deny.users` / `deny.self` / 模型不理名單的人不會進上下文，也不會被收進黑話語料。
  引用不算在內：被引用的原文照上面的規則附上（模型不理名單的人例外）。
  私聊不加，DSH 會話本身就有上下文。
- **圖片**：批次裡每則訊息的圖片依序編號，那一行會標 `[圖1]`、`[圖2]`，圖片本體跟著送進模型；
  一則訊息最多 `media.maxCount` 張、整批也是。來源是附件、貼圖、連結預覽的圖
  （Tenor／Giphy 的 GIF 就是這種），以及**影片附件**，都只用 Discord 代理過的網址，不直接連原站。
  預覽圖是批次送出時才讀訊息上的 embed：Discord 先用 `messageCreate` 送訊息、稍後才用 `messageUpdate` 補上預覽，
  趕不上的那批就只剩網址，模型可以用 `view_message` 再看。沒開 Message Content 意圖時 `embeds` 一律是空的，只有網址。
- **影片**：mp4／webm／mov 會用 ffmpeg 抽 6 格拼成一張圖（3×2，只看前 `media.maxVideoSeconds` 秒，預設 60），
  算 1 張圖、一樣受 `media.maxCount` 限制。那一行會寫成 `[圖1：影片 12.3s，抽 6 格拼成 3×2 左上→右下，只有畫面沒有聲音]`，
  模型才知道這是格子圖、只看過前面那段。抽不出畫面（沒裝 ffmpeg、解碼失敗、壞檔）會回一句原因，不會讓整批失敗。
- **貼圖**：群友送的貼圖寫成 `[貼圖：名稱]`；png/apng/gif 貼圖的圖也當成圖片送進模型（跟附件一起算 `[圖N]`、
  一起受 `media.maxCount` 限制）。Lottie 貼圖是向量動畫，模型看不了，只給名稱。
  頻道上下文、引用、`read_history` 裡的貼圖也寫成 `[貼圖：名稱]`（只有名稱，不送圖）。
- **時間感**：每次 prompt 在【發送】行之前是現在時間（含星期與時區）；這一批第一則超過 15 分鐘時會標
  「這則是 X 前發的」，模型才不會把排隊很久的舊訊息當成剛發生。
- **群友記憶**：開啟 `memory.enabled` 後，這一批說話的人（最多 5 位）被記下的事，會放在黑話與頻道風格之後、
  【新訊息】之前（什麼時候帶見「群友記憶」）。
- **頻道筆記**：開啟 `notes.enabled` 後，最近幾條筆記放在群友記憶之前（見「頻道筆記」）。
- **黑話**：開啟 `slang.enabled` 後，管理員確認過的詞會放在頻道上下文之後；只有候選時不會注入。
  確認過的頻道風格接在黑話之後（見「頻道風格」）。
- **DSH 斷線**：連不上時每個會話最多排 `queue.max` 批（記憶體，重啟消失；`/reset` 會清掉），每 `queue.retryMs`
  探活一次，恢復後自動補投；排隊的批次裡有 ★ 時，第一次排隊會在頻道提示一次。
- **出站閘門**：模型用工具送出的內容若命中本機路徑／憑證特徵或已知令牌（Discord/DSH/控制台/會話令牌），
  整條攔截，不會把原文送出去。
- 超過 `maxMessageChars` 會先在換行邊界切段，沒有換行才硬切（不會切開 emoji）。
- Discord 顯示 Markdown，所以**不**轉純文字（QQ 版會轉）。
- 每個會話的批次依序投遞（同一會話同時只跑一個 prompt 佇列），避免上下文順序錯亂。
- 頻道訊息會帶上發言者名稱（`暱稱：內容`），依序用伺服器暱稱、Discord 顯示名稱、使用者名稱，取第一個看得到的。
  只有看不見字元的名字（例如 `U+17B5`、`U+3164`、點字空白 `U+2800`、`U+1CBC`、只有組合符號）會跳過，改用下一個；
  模型讀歷史、引用、記憶、黑話學習看到的名字都照這個規則。管理員訊息加 `【管理員】` 前綴，
  但頻道裡只有叫 bot（★）的那則才加：管理員跟朋友聊天時不標，模型才不會以為是在對它說話。私聊一律加。
- 送出時 `allowedMentions: { parse: [], repliedUser: false }`，模型輸出不會不小心 @everyone，回覆也不 ping 對方。
- DSH 重啟後事件流會自動重連，並重新 follow `state/discord-sessions.json` 裡的會話。
- **會話標題**：新會話建好、送第一批之前，橋接用 `session/rename` 把標題設成
  `Discord #頻道名｜伺服器名` 或 `Discord 私聊｜使用者名`（名字查不到就用 ID）；黑話學習的會話是 `Discord 黑話學習`，
  每日頻道摘要的會話是 `Discord #頻道名｜頻道摘要`。
  使用者設的標題會鎖住，DSH 不會再用模型生摘要標題，每個新會話也少一次模型請求。
  改名失敗只記日誌，不影響投遞。之前建的會話不會自動改名。
- **上下文壓縮**：context 越長，首字回應越慢（實測 8k 約 2.5 秒、64k 約 14 秒、166k 約 22 秒；
  prefix cache 有命中，慢在長 context 本身）。所以壓在約 8 萬：
  - dc-chat preset 把 `compaction-basic` 設成 `thresholdRatio: 0.08`（100 萬窗口 × 0.08 ≈ 8 萬）、
    `retainTokens: 10000`（壓完保留最近一段原文，其餘換成摘要）。不設 `retainTokens` 時預設保留約 16 萬，比門檻還大，壓了也不會變小。
  - `retainTokens` 是 DSH 的估算值，中文聊天的實際 token 大約是 2.5 倍。曾設 30000：壓完實際還有 8.1 萬，
    卡在門檻上面，每一輪都觸發一次「summary is not smaller」的失敗壓縮（每次多約 10 秒）。所以要留足空間。
  - 橋接另外補一層：一輪結束時，`assistant/message` 的 `usage.totalTokens` 超過 `autoCompactTokens`（預設 80000），
    就先壓住下一批，替會話送 `/compact`，壓完再放行。日誌會記「自動壓縮」那一行與 DSH 回的結果。
    2026-10-27 改成 0.08 後，DSH 自己的自動壓縮有觸發（之前 0.2 時沒看到），這層是 DSH 沒壓時的備援。
  - 兩種壓縮在頻道都會有「正在壓縮」的提示（見「行為細節」的壓縮提示）。
  - 人格規則在 system prompt，不會被壓縮掉；群友記憶與最近頻道訊息每批都會重新帶，壓掉的是較舊的聊天細節。

## 安全邊界

1. **沒有本地工具**：`dc-chat` preset 不掛 bash / 檔案讀寫 / 子代理 / 工作流。`dc-tool-restrict` 會把它們
   從工具清單隱藏，執行期再用白名單擋一次。畫圖是唯一的例外：`generate_image` 由 `dc-draw-image`
   鎖成「只拿專案內的角色設定圖當參考（或不帶參考圖）、只能寫 `state/discord-images`」，
   `send_image` 也只讀這個目錄；`/mnt` 以外的其他本機路徑仍可能被 Codex 唯讀存取（`jun` 帳號自己的資料）。
2. **fail-closed preset**：啟動時向 DSH 要 preset 清單；`agentPreset` 不在清單裡就拒絕建立會話，並在頻道
   回報安裝提示。**絕不**回退到 DSH 預設 preset（那通常有完整本地工具）。
3. **白名單**：預設全擋。`deny` 優先於 `allow`；`deny.channels` 也擋母頻道底下的討論串。
   `deny.users` 是管理員封鎖，完全擋。`deny.self` 是自己用 `/blacklist` 退出的名單，只擋「沒在叫 bot」的訊息：
   @bot 或回覆 bot 時照常處理。模型自己用 `ignore_user` 設的名單也完全擋，@bot 一樣不處理；
   三份名單分開，控制台看得到模型那份。私聊三種名單都全擋（私聊每則都算叫 bot，例外不適用）。
4. **審批只有 `ownerIds` 能回**；管理命令同理（slash command 選單只給伺服器管理員看，執行時再驗 `ownerIds`）。
5. **單一實例**：`state/discord-bridge.lock` 有活著的 PID 就拒絕啟動。
6. **發送端點只在本機**：`mcp-discord` 與 `mcp-slang` 走 `127.0.0.1` 的隨機埠，要 `x-agent-token`
   （`state/discord-agent.json`，0600）加會話令牌；沒帶令牌的請求一律 401，不會因為漏帶而
   升級成別的身分。端點只開 `POST /hello`、`POST /sessionToken`、`POST /imageJob` 與上面列的工具路徑；
   每個工具都先過同一個令牌檢查（會話還活著、頻道在白名單內），唯讀工具也一樣，
   而且只能讀令牌自己的頻道。
7. **`/sessionToken` 的權限代價**：它讓持有端點 secret 的呼叫方用任何活著的 `sessionId` 換令牌。
   `sessionId` 不是秘密（`state/discord-sessions.json`、日誌、DSH 介面都看得到），所以實際效果是
   **有 secret 就等於有所有活著會話的發送權**。這是 `dc-session-token` 自動帶令牌的必要代價；
   端點只回還活著的會話，不提供「列出全部」。`/imageJob` 同樣只認端點 secret，持有人可以往活著的
   會話塞一段提示，信任層級跟 `/sessionToken` 一樣。`dc-chat` 沒有任何檔案／shell 工具，
   模型讀不到 `state/discord-agent.json`。
8. **重複拒絕改按 ❌**：同一個人在同一個頻道 10 分鐘內第 2 次收到罐頭拒絕時，橋接不再送出那句話，
   改成對他的訊息按 ❌（第 1 次仍會回一句）。次數算在回覆對象上：有 `reply_to` 就用那一則的作者，
   沒有就算這一輪直接叫 bot 的最新一則。❌ 走模型自己的 reaction 額度（一輪 3 個），用完就照常送文字。
   判斷的是 persona 的固定拒絕句
   （「這題我不碰，換一個」「這個不聊」「我只會當大肥魚」）；改 persona 時要同步
   `src/core/discord-ignore.mjs` 的 `REFUSAL_LINES`。

## 已知限制

- 圖片附件（png/jpeg/webp/gif）與影片（mp4/webm/mov）會轉成 base64 送進模型；圖片超過
  `media.maxLongEdge` 或 `media.maxModelBytes` 時先用 ffmpeg 縮小，縮不動才跳過並告訴模型「附件未提供」。
  下載只認 `cdn.discordapp.com` / `media.discordapp.net` / `images-ext-*`，不跟隨轉址。
- **影片只看前 60 秒、只有畫面沒有聲音**：超過 `media.maxVideoSeconds` 的部分不看；要描述對話內容做不到。
  長影片、大檔案（超過 `media.maxBytes`，預設 20MB）會被跳過並回一句原因。
- **訊息文字裡貼的圖片網址不會直接抓**：只抓 Discord 自己做好的連結預覽圖（`images-ext-*` 等代理網址）
  和上傳的附件。沒有預覽的普通網址仍然只是一段文字。
- 動圖（GIF）太大時會抽帧拼成一張靜態圖（沿用 QQ 版的正規化），不是原動圖。
- 模型側工具有 `ask_user_question`、`todo_write`、`mcp__discord__*` 工具（目前 24 個，唯一能碰 Discord 與群友記憶的路徑；
  `dc-tool-restrict` 逐一列名放行，mcp-discord 新增工具時要同步加進去）、3 個 `mcp__slang__*` 工具
  （只查／收黑話與頻道標籤，收進去的都是候選，管理員確認後才注入），加上只讀的
  `mcp__web-search-safe__web_search` / `web_fetch`。`dc-learner` 把這些 Discord 與黑話工具全部拿掉。
- 沒有定時主動發言：模型只在收到訊息後才有機會說話；要不要送、送幾則，由它呼叫工具決定。
- **畫圖要 1~3 分鐘**，而且吃 Codex 額度；生圖在背景跑，不卡會話，但 DSH 重啟時還沒完成的工作會消失。
  DSH profile 沒裝 `dsh-generate-image` 或 Codex 沒登入時，`generate_image` 不存在或直接失敗。
  生成檔只留最近 100 張，上傳上限 10MB。
- 沒有語音、沒有 QQ 版那種十頁控制台。表情包、reactions、群友記憶見上文。
- DSH 離線佇列存在記憶體：橋接重啟就消失（跟 QQ 版一樣）。還在等待合批的訊息（最多 `batch.maxWaitMs`）和回合進行中壓住的訊息也一樣。
- 頻道上下文需要 bot 的 **Read Message History** 權限；沒有權限時會跳過上下文並記一行 log。
- 對話映射只存在本機 `state/discord-sessions.json`；刪掉它等於所有頻道都開新會話（DSH 舊會話仍在）。

## 疑難排解

| 症狀 | 先看 |
| --- | --- |
| 啟動就報 `Used disallowed intents` | Developer Portal 沒開 Message Content Intent。開了重啟，或把 `messageContentIntent` 設 `false` |
| 頻道裡 @bot 沒反應 | bot 有 `Read Message History` / `Send Messages` 權限？頻道在 `allow.channels` 或伺服器在 `allow.guilds`？ |
| 回「找不到 preset」 | 跑 `node scripts/setup-dsh.mjs --discord`，然後**重啟 DSH** |
| `DSH 鉴权不可用` | `~/.dsh/.credentials.yaml` 讀不到，或 DSH 不在本機。確認 `DSH_HOME` |
| 有輸入提示但沒有回覆 | 日誌有沒有「回合完成但沒有呼叫發送工具」？DSH 沒掛 `mcp-discord` 時模型沒有發送工具：重跑 `node scripts/setup-dsh.mjs --discord` 並**重啟 DSH** |
| 日誌出現「工具呼叫失敗」 | 模型抄到舊 token（橋接重啟過）。下一則訊息會帶新 token，不用手動處理 |
| 叫它畫圖卻只回文字 | DSH profile 沒裝 `dsh-generate-image`，或 Codex CLI 沒登入。跑 `dsh plugin --profile web add github:zemul/dsh-generate-image`，終端機跑一次 `codex` 登入，再重啟 DSH |
| 圖畫好了但送不出去 | bot 有沒有 **Attach Files** 權限？檔案有沒有超過 10MB？日誌看 `MCP 送出 ... 圖片` 那一行 |
| 回合直接失敗 `session/model-unavailable` | `dsh.provider` / `dsh.model` 不在 DSH 的 `routableProviders`。用 `session/modelCatalog` 查可用組合，改 `config.json` |
