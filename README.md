# dc-bridge：Discord ↔ DeepSeek Harness 橋接

把 Discord 頻道接進本機 DSH：頻道訊息變成 agent 的 prompt，回覆、提問與工具審批回到同一個頻道。

- **Discord 是主要產品**：入口 `src/discord-bridge.js`（`npm start`）。
- **QQ（SnowLuma／OneBot）只作功能對照**：入口 `src/bridge.js`（`npm run start:qq`），不再部署。
  說明見 [docs/guides/QQ.md](docs/guides/QQ.md)。
- 兩條線不共用入口：Discord 不 import `src/bridge.js`，只有 `dsh-client.js` 與純函式是同一份。
  哪個檔案屬於哪條線見 [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)。

## 快速開始

需要 Node.js ≥ 22.13、一個執行中的 DSH Web（預設 `http://127.0.0.1:3080`）、一個 Discord bot token。

```bash
npm install
cp config.example.json config.json     # 填 discord.token 與 discord.ownerIds
node scripts/setup-dsh.mjs --discord   # 安裝 dc-chat / dc-learner preset 與三個 MCP
npm start                              # 只啟動 Discord 橋接
```

看到 `[discord] 已登入：<bot 名稱>` 就是成功。權限、設定、指令、控制台與各項功能見
**[docs/guides/DISCORD.md](docs/guides/DISCORD.md)**。

## 文件

| 文件 | 內容 |
| --- | --- |
| [docs/README.md](docs/README.md) | 全部文件索引 |
| [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md) | 目錄、腳本命名、檔案屬於哪條線 |
| [docs/guides/DISCORD.md](docs/guides/DISCORD.md) | Discord 版設定、指令、控制台、各項功能 |
| [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) | DSH 端安裝與 preset |
| [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md) | 安全基線與威脅模型 |
| [docs/guides/QQ.md](docs/guides/QQ.md) | QQ 版說明（只作對照） |
| [RULES.md](RULES.md) | QQ 版的權限邊界 |

## 部署

線上跑在 Linux（pm2）。伺服器是這個 repo 的 checkout（detached HEAD），`config.json`、`state/`、
`node_modules/` 是未追蹤檔，`checkout` 不會碰。部署＝推到 `origin/main` → 伺服器 fetch + checkout：

```bash
node scripts/deploy-discord.mjs --dry-run   # 先看這次會換掉哪些檔案
node scripts/deploy-discord.mjs             # 真的部署
```

腳本會在遠端跑測試、必要時重跑 `setup:discord`、依序重啟，再看 log 確認 `已登入：`。
回退用 `--sha <上一個 commit>`。細節與一次性設定見 [AGENTS.md](AGENTS.md)。

## 授權

MIT，見 [LICENSE](LICENSE)。
