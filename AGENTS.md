# AGENTS.md

## 部署到 Discord 測試伺服器

伺服器：SSH MCP 的 `main-server-test-account`（`jun@192.168.98.21`）。
遠端目錄 `/home/jun/dc-bridge` **不是 git repo**：部署就是上傳檔案，不是 `git pull`。
`config.json`、`state/`、`node_modules/` 只在伺服器上有，**永遠不要上傳或覆蓋**。

### 1. 本機先過

在本機 repo 根目錄跑：

```powershell
npm run test:discord
node scripts/build-agent-preset-patches.mjs --check
```

兩個都 exit 0 才能部署。有改 persona／preset／MCP 時，第二個一定要跑。

完成條件：兩個指令都 exit 0。

### 2. 備份遠端要覆蓋的檔案

用 SSH MCP 的 `execute-command`：

```bash
ts=$(date +%Y%m%d-%H%M%S)
tar czf ~/dc-bridge-backups/deploy-$ts.tgz -C ~/dc-bridge <這次要上傳的相對路徑...>
```

完成條件：`ls -l ~/dc-bridge-backups/deploy-$ts.tgz` 看得到檔案。

### 3. 上傳並核對

用 SSH MCP 的 `upload`，一個檔案一次，遠端路徑保持相同相對結構。
只傳這次改到的檔案，不要把整個資料夾蓋上去。

上傳後在本機與伺服器各跑一次 SHA256：

```powershell
Get-FileHash <本機檔案...> -Algorithm SHA256
```

```bash
cd ~/dc-bridge && sha256sum <相對路徑...>
```

完成條件：每個檔案的 hash 兩邊一致。

### 4. 伺服器上再驗一次

```bash
export PATH="$HOME/.nvm/versions/node/v26.12.1/bin:$PATH"
cd ~/dc-bridge
node scripts/build-agent-preset-patches.mjs --check
node scripts/test-discord-bridge.mjs
```

完成條件：兩個都 exit 0。

### 5. 同步 preset 與重啟

有改 persona／preset／MCP 時先跑：

```bash
npm run setup:discord
```

`setup:discord` 最後出現 `auto-install failed to start/complete（ENOENT）` 是已知訊息；只要 exit 0、
前面的 MCP 條目與 preset patch 都同步成功就繼續。

照這個順序重啟（先停 bridge，再重啟 DSH，最後開 bridge）：

```bash
pm2 stop dc-bridge
pm2 restart dsh
sleep 5
pm2 start dc-bridge
```

只改 bridge、沒有動 DSH 或 preset 時，只重啟 `dc-bridge` 就夠。

完成條件：

```bash
pm2 list
tail -20 ~/.pm2/logs/dc-bridge-error.log
pm2 logs dc-bridge --lines 15 --nostream
```

`dc-bridge` 與 `dsh` 都是 `online`，error log 沒有新的錯誤，bridge log 看得到
`已登入：` 和 `已註冊全域 slash command`。

### 6. 改了 MCP 工具時

DSH 重啟後，用一個暫時的 stdio client 列出 `mcp-discord` 的工具，確認新工具真的註冊：

```bash
export PATH="$HOME/.nvm/versions/node/v26.12.1/bin:$PATH"
node -e "import('/home/jun/dc-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js').then(async ({Client})=>{const {StdioClientTransport}=await import('/home/jun/dc-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');const t=new StdioClientTransport({command:process.execPath,args:['/home/jun/dc-bridge/src/mcp-discord.js'],cwd:'/home/jun/dc-bridge',stderr:'ignore'});const c=new Client({name:'check',version:'0'});await c.connect(t);console.log((await c.listTools()).tools.map(x=>x.name).sort().join('\n'));await c.close();})"
```

完成條件：清單裡看得到這次新增的工具名。

### 回退

```bash
tar xzf ~/dc-bridge-backups/deploy-<時間>.tgz -C ~/dc-bridge
pm2 stop dc-bridge
pm2 restart dsh
pm2 start dc-bridge
```

回退只還原這次上傳的檔案；`config.json` 與 `state/` 不受影響。

## 目前的程序

| pm2 名稱 | 內容 | 工作目錄 |
| --- | --- | --- |
| `dc-bridge` | `src/discord-bridge.js` | `/home/jun/dc-bridge` |
| `dsh` | `npx @deepseek-ai/dsh web --port 2815 ...` | `/home/jun/dsh` |

Node 與 pm2 不在非互動 shell 的 PATH，每個 SSH 指令都要先
`export PATH="$HOME/.nvm/versions/node/v26.12.1/bin:$PATH"`。
