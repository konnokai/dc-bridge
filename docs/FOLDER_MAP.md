# 目錄地圖

> 只描述現況，不是改動指令。文件索引見 [README.md](README.md)。

## 一、入口

只有 Discord：`src/discord-bridge.js`（`npm start`）。QQ／SnowLuma／OneBot 的程式與測試已移除。

## 二、`src/`

### 入口與 MCP

| 檔案 | 作用 |
| --- | --- |
| `discord-bridge.js` | 入口：client 建立、基礎 store／狀態、各層 factory 接線、Gateway 註冊、啟動與 shutdown |
| `dsh-client.js` | DSH Web API 客戶端（Cookie 鑄造、RPC、事件流） |
| `mcp-discord.js` | Discord 工具（發訊、看訊息、表情、投票） |
| `mcp-slang.js` | 黑話工具 |
| `mcp-trade.js` | 模擬股票工具（商品清單、查價、下單、持股、排行榜） |
| `mcp-arknights.js` | 明日方舟練度統計工具（專精／模組建議、PRTS 別名） |
| `mcp-web-search-safe.js` | 只讀搜尋與抓取工具 |
| `self-test.js` | DSH 連線自測 |

### `src/core/`

| 檔案 | 作用 |
| --- | --- |
| `discord-core.mjs` | 設定正規化、長文切段、會話映射 |
| `discord-agent.mjs` | token 解析、每輪額度、`send` 守衛 |
| `discord-batch.mjs` | 批次器、回合佇列（含指令排隊與 hold/rebase）與 batch prompt 組裝 |
| `discord-typing.mjs` | @ 模式的補句窗口 |
| `discord-context.mjs` | 頻道上下文，以及共用的文字整形（`flat`／`authorName`／`withStickers`／`embedPreview`） |
| `discord-time.mjs` | 相對時間字串（3s／18m／2h／3d） |
| `discord-activity.mjs` | 發言頻率 |
| `discord-quiet.mjs` | 安靜模式 |
| `discord-sandbox.mjs` | `run_script` 的 Docker 沙箱 |
| `discord-ignore.mjs` | 模型自己的不理名單與重複拒絕偵測 |
| `discord-feedback.mjs` | 自己訊息收到的 reaction |
| `discord-dev-feedback.mjs` | 模型送給開發者的功能申請與意見 |
| `discord-followup.mjs` | 回訪排程 |
| `discord-ask.mjs` | 後台提問（`/ask`）的回合、逾時與取消 |
| `discord-ceobe.mjs` | 小刻食堂（餅）輪詢、分派與已讀水位 |
| `discord-notes.mjs` | 頻道筆記與每日摘要 |
| `discord-knowledge.mjs` | 群知識候選、確認與注入格式 |
| `discord-status.mjs` | 自訂狀態的清洗與檔案讀寫 |
| `discord-memes.mjs` | 梗圖庫 |
| `discord-reload.mjs` | `/reload-system-prompt` 的交接摘要 |
| `discord-memory.mjs` | 群友記憶與側寫 |
| `discord-profiles.mjs` | 群友側寫的 prompt 與輸出解析 |
| `discord-history-archive.mjs` | 歷史歸檔（Qdrant + embedding） |
| `discord-history.mjs` | 歷史掃描、搜尋分頁與 guild 搜尋參數 |
| `discord-slang.mjs` | 黑話收集與注入 |
| `jev.mjs` | Jev 對話閘門、黑話候選分流與成本判斷 |
| `discord-json.mjs` | 從模型輸出抓 JSON 陣列 |
| `discord-emoji.mjs` | 表情目錄與使用次數 |
| `discord-media.mjs` | 圖片與連結預覽、`send_image` 的本機生圖檔案解析 |
| `twitter-post.mjs` | X／Twitter 貼文解析（FxEmbed）、正文與圖片 |
| `discord-video-link.mjs` | 影片連結的 yt-dlp 字幕、章節與抽格 |
| `prts-artwork.mjs` | PRTS 立繪解析 |
| `arknights-training.mjs` | 一圖流練度統計：專精／模組排行與幹員名稱比對 |
| `arknights-aliases.mjs` | 幹員別名表：PRTS redirect、自動補寫與控制台狀態 |
| `discord-gif.mjs` | GIPHY 搜尋 |
| `discord-security.mjs` | 白名單、敏感詞 |
| `discord-usage.mjs` | 用量統計 |
| `discord-turns.mjs` | 回合決策紀錄（`state/discord-turns.jsonl`） |
| `discord-codex-quota.mjs` | Codex 額度查詢與重置 ping |
| `codex-models.mjs` | Codex 模型清單查詢與預設模型 |
| `discord-trigger-stats.mjs` | 觸發統計 |
| `discord-send-handler.mjs` | MCP `/send` 的送出統計 |
| `discord-image-jobs.mjs` | 背景生圖工作 |
| `discord-voice-jobs.mjs` | 背景語音工作 |
| `discord-tts.mjs` | TTS 合成、轉檔、語音閘門與 `send_voice` 的降級 |
| `discord-console.mjs` | 控制台 API 的純邏輯 |
| `discord-trade.mjs` | 模擬股票交易規則 |
| `discord-trade-db.mjs` | 交易域 SQLite |
| `quote-provider.mjs` | 台股盤後報價 |
| `institutional-provider.mjs` | 三大法人買賣超日報 |
| `material-provider.mjs` | 每日重大訊息 |
| `trade-symbols.mjs` | 模擬股票商品主檔 |
| `bot-trader.mjs` | Bot 交易員的排程判斷與 prompt |
| `discord-bridge-runtime-state.mjs` | 橋接執行期的 per-key 狀態（`forgetKey`／`forgetSession`），會話重置時不漏清 |
| `discord-bridge-stores.mjs` | 有 dirty 旗標與延遲存檔的檔案 store（記憶、筆記、知識、梗圖、開發回饋） |
| `discord-bridge-turns.mjs` | 回合層：提問與審批、事件流、訊息入口（離線佇列與投遞）、自動壓縮、TTFT 計時器 |
| `discord-bridge-usage.mjs` | Token 帳本、回合紀錄（`writeTurn`）與三個 provider 的訂閱額度查詢 |
| `discord-bridge-dsh-sessions.mjs` | DSH 會話層：preset 檢查、`ensureSession`、退役（`retireSession`）與交接摘要 |
| `discord-bridge-output.mjs` | Discord 送出：會話改名、頻道解析（`resolveChannel`）與分條發送（`sendLong`） |
| `discord-bridge-agent-tools.mjs` | 智能體工具的中控：送出、記憶、筆記、知識、梗圖、回饋等 handler、`apiHandlers` 包裝與生圖工作；讀取與交易由下面兩個模組提供 |
| `discord-bridge-agent-read.mjs` | 讀取工具：`read_history`／`search_history`／`recall_history`／`view_message`／`user_info`／`server_info`／`daily_stats` 與它們的排版 |
| `discord-bridge-agent-trade.mjs` | 模擬股票工具：`trade-quote`／`trade-symbols`／`trade-order`／`trade-portfolio`／`trade-leaderboard` 與 bot 下單 |
| `discord-bridge-background.mjs` | 背景工作：黑話學習、小刻食堂輪詢、回訪排程、每日摘要與群友側寫、後台提問與背景會話 |
| `discord-bridge-trade.mjs` | 模擬股票：服務建立、結算、Bot 交易員與復盤排程；控制台改設定走 `applyTradeConfig` |
| `discord-bridge-inbound.mjs` | Discord 入口事件：訊息、reaction、typing 與 slash 命令的准入分派 |
| `discord-bridge-console.mjs` | 控制台：HTTP API、供應商設定（hedge）、`updateConfig`；`createConsoleLayer` 是 async |

### 共用工具

| 檔案 | 作用 |
| --- | --- |
| `md-to-plain.js` | Markdown → 純文字、長文切段、代理對安全截斷 |
| `model-prices.js` | 價目表 |
| `web-search.js` | 聯網搜尋 |
| `safe-fetch.js` | 有 SSRF 防護的抓取 |
| `core/fetch-verdict.mjs` | 抓取結果判斷（驗證頁／HTTP 錯誤） |
| `core/web-content.mjs` | Google export 改寫、HTML 標題／og／正文抽取 |
| `core/embed-fix.mjs` | Threads／Instagram／Facebook 貼文改打 ebfix，取作者與正文 |
| `core/firecrawl.mjs` | 只有框架的頁面交給自架 Firecrawl 渲染 |
| `sensitive.js` | 敏感詞 |
| `media-normalize.js` | 圖片正規化 |
| `token-ledger.js` | token 帳本 |
| `state-acl.mjs` | `state/` 與 `config.json` 的權限 |
| `voice-core.js` | ffmpeg／ffprobe 共用工具 |

## 三、其他目錄

| 路徑 | 內容 |
| --- | --- |
| `dsh/agent-presets/` | preset 的權威源：`dc-chat`、`dc-chat-open`、`dc-learner`、`dc-trader` |
| `plugins/` | DSH 插件：`dc-agent-presets`、`dsh-llm-hedge` |
| `public/` | `discord-console.html`（控制台產物，預設 3110；由 `console/` 建置，不要手改） |
| `console/` | 控制台前端原始碼（Vite + Vue）：`npm run build:console` 產出單一檔案 |
| `assets/` | 圖片等資源；`ai-chan-sheets/` 是 AI 娘三視圖與設定圖 |
| `docs/` | 全部文件，見 [README.md](README.md) |
| `deploy/alloy/` | Loki 收集器（Alloy）的獨立 compose、設定與操作說明 |
| `deploy/firecrawl/` | 自架 Firecrawl 的獨立 compose（只綁 127.0.0.1）與操作說明 |
| `deploy/grafana/` | `dc-bridge 營運` dashboard 的 import JSON 與說明 |
| `state/` | 執行時資料（會話映射、會話 preset 映射、筆記、回訪、回饋、帳本、餅的已讀、鎖、生圖與股票資料）。`.gitignore` 排除，**不要刪** |
| `config.json` | 真實設定，不入庫；模板是 `config.example.json` |

## 四、`scripts/` 命名

| 前綴 | 用途 |
| --- | --- |
| `test-*.mjs` | 自動化測試。`test-audit.mjs` 的 `tests[]` 是總清單 |
| `test-discord-*.mjs` | Discord 測試；`npm run test:discord` 會跑全部 |
| `deploy-discord.mjs` | 部署到測試伺服器（見 [AGENTS.md](../AGENTS.md)） |
| `setup-dsh.mjs` | 把 preset 與 MCP 寫進目標設備的 DSH |
| `build-agent-preset-patches.mjs` | 從 `dsh/agent-presets/` 產生 `plugins/dc-agent-presets/presets/*.patch.yml` |
| `build-discord-emojis.mjs` | 建表情目錄 |
| `probe-*.mjs` | 問 DSH「實際支援什麼」的探針，按需重跑 |
| `harden-state-acl.mjs` / `diagnose-acl.mjs` | Windows ACL 工具 |
