# AGENTS.md

## 寫新功能前

先讀 [docs/guides/FEATURE_LAYERING.md](docs/guides/FEATURE_LAYERING.md)：
邏輯寫進 `src/core/` 的 `createXxx(deps)`，入口 `src/discord-bridge.js` 只留 deps 接線。

## 控制台前端

原始碼在 `console/src/`（Vite + Vue），`public/discord-console.html` 是 `npm run build:console` 的產物，
伺服器只讀這一個檔案（`src/core/discord-console.mjs`）。改完前端要重建再 commit；
`scripts/test-console-static.mjs` 會跑 `build-console.mjs --check` 抓忘記重建。
看畫面用 `npm run dev:console`（`/api` 轉給 127.0.0.1:3110），或照
[docs/guides/CONSOLE-UI-TESTING.md](docs/guides/CONSOLE-UI-TESTING.md) 起 mock。

## Lessons

- 拆模組時晚宣告的依賴接「轉發箭頭」（`fn: (...args) => fn(...args)`），不要用 getter（`getFn: () => fn`）：getter 的呼叫端要寫兩層括號，`getEnsureSession(key)` 這種單層呼叫會靜靜拿回函式本體，工作沒做、測試也全綠。
- 連伺服器時用 `ssh-mcp-server`（`connectionName`），不要用 shell 的 `ssh`。
- 查這個專案的程式碼前，先跑 `graphify query`／`graphify explain`；`graphify-out/graph.json` 已經存在，不要直接從 grep 開始。要逐行確認再用 Read／Grep。
- 改完程式碼、部署前一定先跑 `engineering-code-reviewer` 看完整 diff；review 沒過不要部署，也不要先部署再說。
- 跑 `scripts/test-console-ui.mjs` 時，若 Playwright 或 Chromium 不在環境裡會直接中止，這不算失敗；其他檢查失敗才要查。
- preset 結構至少跑 `node scripts/build-agent-preset-patches.mjs --check`；需要 DSH 模組的腳本用 `DSH_INSTALL_MODULES` 指向 npx 快取裡 `@deepseek-ai/dsh` 的上一層 `node_modules`。
- 看 Discord 控制台 UI 時先用 `openchamber_web`（照 docs/guides/CONSOLE-UI-TESTING.md 起 `startConsole` mock），不要只用 Playwright 截圖代替。
- 同一個人在不同批次出現不同名字時，先查 bridge 有沒有重啟、成員快取是不是空的，不要直接說群友改名。
- QQ／SnowLuma／OneBot 的程式與測試已移除；不要為了 QQ 相容把檔案或測試加回來，除非使用者明講。

## 部署到 Discord 測試伺服器

伺服器：`jun@192.168.98.21`（SSH MCP 的 `main-server-test-account`）。
遠端目錄 `/home/jun/dc-bridge` 是這個 repo 的 checkout（detached HEAD），不是靠上傳檔案。
`config.json`、`state/`、`node_modules/`、`audio/` 都是 gitignore 的未追蹤檔，`git checkout` 不會碰它們。

### 用腳本（固定做法）

```bash
node scripts/deploy-discord.mjs --dry-run   # 看這次會換掉哪些檔案
node scripts/deploy-discord.mjs             # 真的部署
```

腳本依序做，任何一步失敗就停：

1. 工作目錄必須乾淨（`.opencode/memory` 與 `.agents` 的改動不算），而且 HEAD 已經在 `origin/main`（還沒推就先 push 或跑 `/ship`）。
2. 伺服器 `git fetch --prune` → `git checkout --detach <HEAD>`，再確認 HEAD 與 tracked 檔案都一致。
   伺服器上的 tracked 檔案被手改過時 `git checkout` 會拒絕，部署就停在這裡。
3. 本機跑 `build-agent-preset-patches.mjs --check` 與 `npm run test:discord`。
4. 伺服器 `npm ci`（依 package-lock 補依賴），再確認 tracked 檔案沒被改動；然後遠端跑
   `build-agent-preset-patches.mjs --check` 與所有 `scripts/test-discord-*.mjs`。
5. 動到 preset／plugin／`scripts/setup-dsh.mjs`，或動到任何 MCP server 或 DSH 外掛會 import 的檔案
   （`src/mcp-*.js` 與 `plugins/**/*.mjs` 的遞迴 import）時：先 `npm run setup:discord`，然後
   `pm2 stop dc-bridge` → `pm2 restart dsh` → `sleep 5` → `pm2 start dc-bridge`；
   其他情況只 `pm2 restart dc-bridge`；只改文件就不重啟。
   伺服器 HEAD 已經在目標 commit、或上次部署留下的 `state/.deployed-sha` 與 HEAD 不一致時，
   一律當成修復流程，照跑 setup、重啟與健康檢查。
6. 健康檢查：`dc-bridge`（必要時 `dsh`）是 `online`、180 秒內真的重啟過、error log 沒有變長、
   重啟後的新 log 看得到 `已登入：`（沒有就當失敗）。通過後才把 commit 寫進 `state/.deployed-sha`。

參數：`--dry-run`、`--sha <sha>`、`--skip-tests`、`--host <user@host>`、`--dir <遠端路徑>`。
`--skip-tests` 同時跳過本機與遠端測試。

改了 persona／preset 不用 `/reload-system-prompt`：DSH 重啟後會把新的 system prompt 帶進已經開著的會話
（2026-11-10 實測）。

### 回退

```bash
node scripts/deploy-discord.mjs --sha <上一個 commit>
```

跟正常部署走同一條路：checkout、遠端測試、必要時 `setup:discord`、重啟、健康檢查。
失敗時腳本會直接印出這一行。

**跨過 2026-11-07 幣別變更（CNY→USD）回退時**：先還原部署前的 `state/discord-usage.jsonl` 備份。
新版 `compact()` 會在 `evict` 行寫 `cur`；舊版會把 `cur` 丟掉，再升回新版時那批金額會被再乘一次 0.15。

### 一次性設定（換機器時）

伺服器先要有 repo。repo 是公開可讀，不需要金鑰：

```bash
cd /home/jun/dc-bridge
git init
git remote add origin https://github.com/konnokai/dc-bridge.git
git fetch origin
git reset --hard origin/main
```

`reset --hard` 只覆蓋 tracked 檔案；`config.json`、`state/`、`node_modules/`、`audio/` 不受影響。
**不要跑 `git clean`**：那些未追蹤檔（含 `config.json` 與 `state/`）會被刪掉。
repo 若轉為 private，要另外放 deploy key。

要用 `run_script` 的話，先拉沙箱 image（沒有要用就跳過）：

```bash
docker pull python:3.12-alpine
docker pull node:24-alpine
```

伺服器的 node 與 pm2 不在非互動 shell 的 PATH，手動下指令時要先
`export PATH="$HOME/.nvm/versions/node/v26.12.1/bin:$PATH"`。

### 改了 MCP 工具時

DSH 重啟後，用暫時的 stdio client 列出工具，確認新工具真的註冊：

```bash
export PATH="$HOME/.nvm/versions/node/v26.12.1/bin:$PATH"
node -e "import('/home/jun/dc-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js').then(async ({Client})=>{const {StdioClientTransport}=await import('/home/jun/dc-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');const t=new StdioClientTransport({command:process.execPath,args:['/home/jun/dc-bridge/src/mcp-discord.js'],cwd:'/home/jun/dc-bridge',stderr:'ignore'});const c=new Client({name:'check',version:'0'});await c.connect(t);console.log((await c.listTools()).tools.map(x=>x.name).sort().join('\n'));await c.close();})"
```

完成條件：清單裡看得到這次新增的工具名。

`setup:discord` 最後出現 `auto-install failed to start/complete（ENOENT）` 是已知訊息；
只要 exit 0、前面的 MCP 條目與 preset patch 都同步成功就繼續。

## 解析 DSH 會話日誌

見 [docs/guides/DSH_SESSION_LOGS.md](docs/guides/DSH_SESSION_LOGS.md)：找 session、解 zstd、
看事件類型、把 turn 印成可讀格式，以及「什麼時候看哪裡」。

## 上游對比基準

見 [docs/guides/UPSTREAM_SYNC.md](docs/guides/UPSTREAM_SYNC.md)。要比對上游前先讀那份，
裡面有基準 commit、已搬與不搬的清單，只跑基準之後的新 commit。

## 目前的程序

| pm2 名稱 | 內容 | 工作目錄 |
| --- | --- | --- |
| `dc-bridge` | `src/discord-bridge.js` | `/home/jun/dc-bridge` |
| `dsh` | `npx -y @deepseek-ai/dsh@0.2.2-rc.3 web --no-open --port 2815 ...`（版本鎖在 `/home/jun/dsh/run.sh`） | `/home/jun/dsh` |

觀測：Alloy 由 `deploy/alloy/compose.yaml` 獨立管理（不是 pm2），收 pm2 log 到 Loki；
見 `docs/design/ADR_DEPLOYMENT.md`。Dashboard 匯入檔在 `deploy/grafana/dc-bridge-ops.json`。
