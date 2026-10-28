# AGENTS.md

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

1. 工作目錄必須乾淨，而且 HEAD 已經在 `origin/main`（還沒推就先 push 或跑 `/ship`）。
2. 伺服器 `git fetch --prune` → `git checkout --detach <HEAD>`，再確認 HEAD 與 tracked 檔案都一致。
   伺服器上的 tracked 檔案被手改過時 `git checkout` 會拒絕，部署就停在這裡。
3. 本機跑 `build-agent-preset-patches.mjs --check` 與 `npm run test:discord`。
4. 遠端跑 `build-agent-preset-patches.mjs --check` 與所有 `scripts/test-discord-*.mjs`。
5. 動到 preset／plugin／`scripts/setup-dsh.mjs`，或動到任何 MCP server 會 import 的檔案
   （`src/mcp-*.js` 的遞迴 import）時：先 `npm run setup:discord`，然後
   `pm2 stop dc-bridge` → `pm2 restart dsh` → `sleep 5` → `pm2 start dc-bridge`；
   其他情況只 `pm2 restart dc-bridge`；只改文件就不重啟。
6. 健康檢查：`dc-bridge`（必要時 `dsh`）是 `online`、180 秒內真的重啟過、error log 沒有變長、
   重啟後的新 log 看得到 `已登入：`（沒有就當失敗）。

參數：`--dry-run`、`--sha <sha>`、`--skip-tests`、`--host <user@host>`、`--dir <遠端路徑>`。
`--skip-tests` 同時跳過本機與遠端測試。

### 回退

```bash
node scripts/deploy-discord.mjs --sha <上一個 commit>
```

跟正常部署走同一條路：checkout、遠端測試、必要時 `setup:discord`、重啟、健康檢查。
失敗時腳本會直接印出這一行。

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

## 目前的程序

| pm2 名稱 | 內容 | 工作目錄 |
| --- | --- | --- |
| `dc-bridge` | `src/discord-bridge.js` | `/home/jun/dc-bridge` |
| `dsh` | `npx @deepseek-ai/dsh web --port 2815 ...` | `/home/jun/dsh` |
