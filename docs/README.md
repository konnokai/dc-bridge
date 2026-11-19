# 文件索引

> 根目錄只留 `README.md`，其餘文件都在本目錄。
> 狀態標記：✅ 照它做就對 · ⚠️ 部分過時（看備註） · 🗄️ 只作背景。

## guides/ — 給使用者與維運

| 文件 | 一句話 | 狀態 |
| --- | --- | --- |
| [guides/DISCORD.md](guides/DISCORD.md) | **Discord 版唯一說明**：安裝、設定、權限、指令、控制台、花費、記憶、筆記、回訪、黑話 | ✅ |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | 把 preset 與 MCP 掛到 DSH：`setup-dsh.mjs` 的流程 | ✅ |
| [guides/DSH_022_ADAPTATION.md](guides/DSH_022_ADAPTATION.md) | DSH 0.2.2 適配：projection 幀改 `changes`、工具名補洞、實測與回退 | ✅ 升級 DSH 前先看 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 安全基線與威脅模型、發布前檢查、改動檢查單 | ✅ 動安全相關程式前必讀 |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 資料會送到哪裡、哪些檔案含個資、`privacy-scan` 怎麼用 | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台離線預覽與瀏覽器回歸怎麼跑 | ✅ |
| [guides/UPSTREAM_SYNC.md](guides/UPSTREAM_SYNC.md) | 上游對比基準：已對到哪個 commit、什麼要搬、什麼不搬 | ✅ 比對上游前先看 |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 目錄、腳本命名與檔案作用 | ✅ |

## design/ — 設計與計畫（進版控）

直接看目錄。新增的計畫：
[design/PLAN_MIYORIA_ADOPTION.md](design/PLAN_MIYORIA_ADOPTION.md)（從 Miyoria 挑出的六個改善，依序執行）。
部署決定：[design/ADR_DEPLOYMENT.md](design/ADR_DEPLOYMENT.md)（bridge／DSH 留在 pm2，Alloy 用獨立 compose）。

可觀測性資產：[deploy/alloy/](../deploy/alloy/)（log 收集）、
[deploy/grafana/](../deploy/grafana/)（dashboard import JSON）。

## 只在本機、不進 git

`.gitignore` 排除了 `research/`、`audits/`、`legacy/`，以及 `guides/PROJECT_GUIDE.md`、
`guides/VOICE.md`（理由：裡面有真實帳號與本機路徑，見 [guides/PRIVACY.md](guides/PRIVACY.md)）。

| 目錄 | 內容 |
| --- | --- |
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
| 看花了多少錢 | [guides/DISCORD.md](guides/DISCORD.md) 的「花費」段 |
| 升級 DSH | [guides/DSH_022_ADAPTATION.md](guides/DSH_022_ADAPTATION.md) |
| 比對上游新 commit | [guides/UPSTREAM_SYNC.md](guides/UPSTREAM_SYNC.md) |
