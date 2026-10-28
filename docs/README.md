# 文件索引

> 根目錄只留 `README.md` 與 `RULES.md` 兩個文件，其餘都在本目錄。
> 狀態標記：✅ 照它做就對 · ⚠️ 部分過時（看備註） · 🗄️ 只作背景。

## guides/ — 給使用者與維運

| 文件 | 一句話 | 狀態 |
| --- | --- | --- |
| [guides/DISCORD.md](guides/DISCORD.md) | **Discord 版唯一說明**：安裝、設定、權限、指令、控制台、花費、記憶、筆記、回訪、黑話 | ✅ |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | 把 preset 與 MCP 掛到 DSH：`setup-dsh.mjs` 與 `--discord` 的差別 | ✅ |
| [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | DSH 0.2.1 適配：`{{cwd}}` 被刪導致每回合 error、`working_directory` 進全域層 | ✅ 升級 DSH 前先看 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | DSH 0.2.0 適配：逐條改動與「判定不用改」的部分 | ✅ |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 安全基線與威脅模型、發布前檢查、改動檢查單 | ✅ 動安全相關程式前必讀 |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 資料會送到哪裡、哪些檔案含個資、`privacy-scan` 怎麼用 | ✅ |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「花費」看板：資料來源、計價口徑、API | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台離線預覽與瀏覽器回歸怎麼跑 | ✅ |
| [guides/QQ.md](guides/QQ.md) | QQ（SnowLuma／OneBot）版說明 | 🗄️ 只作功能對照，不再部署 |
| [../RULES.md](../RULES.md) | QQ 版權限邊界與安全承諾 | 🗄️ QQ 用 |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 目錄、腳本命名、檔案屬於哪條線 | ✅ |

## 只在本機、不進 git

`.gitignore` 排除了 `design/`、`research/`、`audits/`、`legacy/`，以及 `guides/PROJECT_GUIDE.md`、
`guides/VOICE.md`（理由：裡面有真實帳號與本機路徑，見 [guides/PRIVACY.md](guides/PRIVACY.md)）。

| 目錄 | 內容 |
| --- | --- |
| `design/` | Discord 線的計畫與設計：`PLAN_AGENT_GAPS.md`、`PLAN_SLANG.md`、`PLAN_EMOJI.md`、`PLAN_TOKEN_DASHBOARD.md`，另有 QQ 時代的設計文件 |
| `research/` | 調研記錄（SnowLuma、免打擾、表情包、本地模型選型） |
| `audits/` | 審查與體檢報告，最新的在 `AUDIT_FIXES_2026-09-20.md` |
| `legacy/` | 已被取代的舊報告，**不要照著做** |

## 想找什麼 → 去哪看

| 我想…… | 看這個 |
| --- | --- |
| 把 bot 接起來 | [guides/DISCORD.md](guides/DISCORD.md) |
| 知道某個目錄或腳本在做什麼 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 部署到測試伺服器 | [../AGENTS.md](../AGENTS.md)、`node scripts/deploy-discord.mjs` |
| 改設定或加功能前先知道有哪些坑 | [guides/DISCORD.md](guides/DISCORD.md)、`design/`（本機） |
| 動安全相關程式 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 看花了多少錢 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 升級 DSH | [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) |
| QQ 版怎麼運作 | [guides/QQ.md](guides/QQ.md) |
