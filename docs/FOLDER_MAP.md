# 目錄地圖

> 只描述現況，不是改動指令。文件索引見 [README.md](README.md)。最後核對：2026-10-28。

## 一、兩條線

| 線 | 狀態 | 入口 |
| --- | --- | --- |
| Discord | 主要產品，線上只跑這條 | `src/discord-bridge.js`（`npm start`） |
| QQ（SnowLuma／OneBot） | 只作功能對照，不再部署 | `src/bridge.js`（`npm run start:qq`） |

Discord 不 import `src/bridge.js`。

## 二、`src/` 分線

### Discord 專用

| 檔案 | 作用 |
| --- | --- |
| `discord-bridge.js` | 入口：Gateway、批次、`agentHandlers`、控制台 |
| `mcp-discord.js` | Discord 工具（發訊、看訊息、表情、投票） |
| `mcp-slang.js` | 黑話工具 |
| `core/discord-core.mjs` | 設定正規化、長文切段、會話映射 |
| `core/discord-agent.mjs` | token 解析、每輪額度、`send` 守衛 |
| `core/discord-batch.mjs` | 批次 prompt 組裝 |
| `core/discord-context.mjs` | 頻道上下文 |
| `core/discord-activity.mjs` | 發言頻率 |
| `core/discord-quiet.mjs` | 安靜模式 |
| `core/discord-feedback.mjs` | 自己訊息收到的 reaction |
| `core/discord-followup.mjs` | 回訪排程 |
| `core/discord-notes.mjs` | 頻道筆記與每日摘要 |
| `core/discord-memory.mjs` | 群友記憶 |
| `core/discord-slang.mjs` | 黑話收集與注入 |
| `core/discord-emoji.mjs` | 表情目錄與使用次數 |
| `core/discord-media.mjs` | 圖片與連結預覽、`send_image` 的本機生圖檔案解析 |
| `core/discord-security.mjs` | 白名單、敏感詞 |
| `core/discord-usage.mjs` | 用量統計 |
| `core/discord-trigger-stats.mjs` | 觸發統計 |
| `core/discord-console.mjs` | 控制台 API 的純邏輯 |

### QQ 專用

`bridge.js`（主程式，約 11.7k 行）、`snowluma-conn.js`、`mcp-snowluma-safe.js`、`mcp-host-server.js`、
`preset-prompt.js`、`role-card.js`、`v2-wait.js`、`forward.js`、`sticker-lib.js`、`send-voice-lib.js`。

### 共用

| 檔案 | 作用 |
| --- | --- |
| `dsh-client.js` | DSH Web API 客戶端（Cookie 鑄造、RPC、事件流） |
| `model-view.js` | 把訊息壓成模型看到的樣子（欄位是 QQ 的） |
| `md-to-plain.js` | Markdown → 純文字、長文切段、代理對安全截斷 |
| `model-prices.js` | 價目表 |
| `web-search.js` | 聯網搜尋 |
| `safe-fetch.js` | 有 SSRF 防護的抓取 |
| `core/fetch-verdict.mjs` | 抓取結果判斷（驗證頁／HTTP 錯誤） |
| `sensitive.js` | 敏感詞 |
| `media-normalize.js` | 圖片正規化 |
| `token-ledger.js` | token 帳本 |
| `slang-learner.js` | 黑話抽取 |
| `state-acl.mjs` | `state/` 與 `config.json` 的權限 |
| `voice-core.js` | 語音核心；repo 外的 `voice-tool/` 也用這一份 |
| `self-test.js` | DSH 連線自測 |

## 三、其他目錄

| 路徑 | 內容 | 線 |
| --- | --- | --- |
| `dsh/agent-presets/` | preset 的權威源：`dc-chat`、`dc-learner`、`qq-chat`、`qq-chat-v2` | 兩條 |
| `plugins/` | DSH 插件：`dc-agent-presets`（Discord 的 patch、工具守衛與畫圖路徑鎖）、`qq-agent-presets`、`qq-mode-console` | 兩條 |
| `public/` | `discord-console.html`（Discord 控制台，預設 3110）、`console.html`（QQ 控制台，3100） | 兩條 |
| `roles/` | 人格卡（QQ 控制台用） | QQ |
| `assets/` | 圖片等資源；`ai-chan-sheets/` 是 11 個 AI 娘的三視圖與設定圖（畫圖參考，外部作品，授權見該目錄 README） | — |
| `docs/` | 全部文件，見 [README.md](README.md) | 兩條 |
| `state/` | 執行時資料（會話映射、筆記、帳本、鎖、`discord-images/` 生圖輸出）。`.gitignore` 排除，**不要刪** | 兩條 |
| `config.json` | 真實設定，不入庫；模板是 `config.example.json` | 兩條 |

## 四、`scripts/` 命名

| 前綴 | 用途 |
| --- | --- |
| `test-*.mjs` | 自動化測試。`test-audit.mjs` 的 `tests[]` 是總清單 |
| `test-discord-*.mjs` | Discord 測試；`npm run test:discord` 會跑全部，新增檔案會被自動納入 |
| `deploy-discord.mjs` | 部署到測試伺服器（見 [AGENTS.md](../AGENTS.md)） |
| `setup-dsh.mjs` | 把 preset 與 MCP 寫進目標設備的 DSH；`--discord` 只裝 Discord 那套 |
| `build-agent-preset-patches.mjs` | 從 `dsh/agent-presets/` 產生 `plugins/*/presets/*.patch.yml`。改 preset 後要重跑，`--check` 確認同步 |
| `build-discord-emojis.mjs` | 建表情目錄 |
| `probe-*.mjs` | 問 DSH／SnowLuma「實際支援什麼」的探針，按需重跑 |
| `verify-*.mjs` | 一致性檢查（DSH 適配、人格設定） |
| `send-*.mjs` | 真的會發訊息的手動小工具 |
| `patch-snowluma-sdk.mjs` | `postinstall` 依賴，不能刪 |
| `harden-state-acl.mjs` / `diagnose-acl.mjs` | Windows ACL 工具。專案不在 Windows 上跑，只在需要檢查舊機器時用 |
| `voice-tool-locator.mjs` | 找 repo 外的 `voice-tool/`，不在就跳過 |

## 五、repo 外的 `voice-tool/`

語音工具在 repo 上一層（`../voice-tool/`）：`voice-cli.mjs`、`voice-gui.mjs`、`public/voice.html`。
它直接引用本 repo 的 `src/voice-core.js` 與 `src/snowluma-conn.js`，所以這兩個檔案不能搬。
