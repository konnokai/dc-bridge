# AGENTS.md

## Lessons

- 改完程式碼、部署前一定先跑 `engineering-code-reviewer` 看完整 diff；review 沒過不要部署，也不要先部署再說。
- 跑 `scripts/test-console-ui.mjs` 時，「All submitted payloads exactly match the pre-redesign console baseline」與「Token usage trend chart renders bars, tiers and range/metric switching」這兩個檢查本來就掛著（結果 29/31），不要花時間追；其他檢查失敗才要查。
- `node scripts/verify-persona-config.mjs` 在本機一定跑不了（找不到 DSH 安裝目錄的 `node_modules`），這不是回歸失敗、不用修。要驗 persona 就改跑 `node scripts/test-preset-prompt.mjs` 和 `node scripts/build-agent-preset-patches.mjs --check`。
- 看 Discord 控制台 UI 時先用 `openchamber_web`（照 docs/guides/CONSOLE-UI-TESTING.md 起離線 fixture），不要只用 Playwright 截圖代替。
- 同一個人在不同批次出現不同名字時，先查 bridge 有沒有重啟、成員快取是不是空的，不要直接說群友改名。
- 改這個 repo 的功能時，QQ 端只是實作參考，不是同步維護對象；不要為了 QQ 相容或 QQ 測試而限制 Discord 的改動，除非使用者明講。

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
5. 動到 preset／plugin／`scripts/setup-dsh.mjs`，或動到任何 MCP server 會 import 的檔案
   （`src/mcp-*.js` 的遞迴 import）時：先 `npm run setup:discord`，然後
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

模型看到什麼、為什麼回或為什麼拒絕，都在 DSH 的 session log；橋接的 log 只記投遞與送出。
先找會話，再解壓，最後只看需要的 turn。

### 1. 找 session id

橋接的 `state/discord-sessions.json` 是權威對照：key（`ch:<頻道ID>`／`dm:<使用者ID>`）→ session id。

```bash
cd /home/jun/dc-bridge
python3 -c "import json; d=json.load(open('state/discord-sessions.json')); print(d.get('ch:739040035571236905'))"
```

或從控制台拿現在活著的會話（含頻道名稱）：

```bash
TOKEN=$(cat state/discord-console-token)   # config.json 有填 console.token 時改用那個
curl -s "http://192.168.98.21:3110/api/sessions?token=$TOKEN" \
  | python3 -c "import json,sys; [print(s['key'], s['sessionId'], s['label']) for s in json.load(sys.stdin)['sessions']]"
```

### 2. 找日誌檔

DSH 把 session 放在 `~/.dsh/sessions/<工作目錄編碼>/<session id>/session.v4.jsonl.zstd`。
橋接的工作目錄是 `/home/jun/dc-bridge/state/discord-agents`，所以編碼是
`--home-jun-dc-bridge-state-discord-agents--`。

```bash
D=~/.dsh/sessions/--home-jun-dc-bridge-state-discord-agents--/session-<id>
ls -la "$D"
zstdcat "$D/session.v4.jsonl.zstd" > /tmp/session.jsonl
wc -l /tmp/session.jsonl
```

`session.lock` 只代表會話還開著；檔案是 append-only，會話進行中讀到的內容可能還在長。
要固定一份就 `cp` 出來再解。

### 3. 先看事件類型

```bash
python3 - <<'PY'
import json
for i, line in enumerate(open('/tmp/session.jsonl')):
    e = json.loads(line)
    d = e.get('data') or {}
    print(i, e.get('type'), str(d)[:140].replace('\n', ' '))
PY
```

常看的類型：

| type | 內容 |
| --- | --- |
| `system/message` | persona 與規則；找「安全邊界」這類段落就在這裡 |
| `user/message` | 送進模型的使用者訊息（`data.content`） |
| `assistant/message` | 模型輸出；`data.message.content` 裡 `type: reasoning` 是思考，`type: text` 是沒送出的文字 |
| `tool/call` | 呼叫哪個工具、參數（`data.name`、`data.arguments`，arguments 是 JSON 字串） |
| `tool/result` | 工具回傳（`data.message.content`；`isError` 在同一個 message） |
| `turn/start`、`turn/end` | 回合邊界；`turn/end.reason` 看是完成、取消還是失敗 |
| `step/start`、`step/end` | 一個回合裡的一次模型呼叫 |
| `agent/inbox/spliced` | 排進來的批次；看橋接壓了哪些訊息 |
| `request/header` | 當時的 provider／model 與工具清單 |
| `model/selection` | 這個會話選的模型與 reasoning effort |

### 4. 把一個 turn 印成人看得懂的樣子

```python
import json
TURN = 5
current = None
for line in open('/tmp/session.jsonl'):
    e = json.loads(line)
    d = e.get('data') or {}
    t = e.get('type')
    if t == 'turn/start':
        current = d.get('turn')
        if current == TURN:
            print('--- turn', current, 'start ---')
        continue
    if current != TURN:
        continue
    if t == 'turn/end':
        print('--- turn', current, 'end', d.get('reason'))
        current = None
        continue
    if t == 'user/message':
        for c in d.get('content', []):
            if c.get('type') == 'text':
                print('USER:', c['text'])
    elif t == 'assistant/message':
        for c in d.get('message', {}).get('content', []):
            if c.get('type') == 'reasoning':
                print('THINK:', c['text'])
            elif c.get('type') == 'text':
                print('TEXT:', c['text'])
    elif t == 'tool/call':
        print('CALL:', d.get('name'), d.get('arguments'))
    elif t == 'tool/result':
        for c in d.get('message', {}).get('content', []):
            print('RESULT:', str(c.get('text', ''))[:1000])
    elif t in ('step/start', 'step/end'):
        print(t, d)
```

`user/message` 本身沒有 `turn` 欄位，所以要先從 `turn/start` 記住目前回合，再用 `turn/end` 收尾。
另外：`user/message` 的內文在 `data.content`；`assistant/message` 與 `tool/result` 在
`data.message.content`。兩者不一樣，別共用同一個取值路徑。

### 5. 什麼時候看哪裡

- 模型回錯、拒絕、沒說話：先看 `assistant/message` 的 `reasoning`，再看 `tool/call` 有沒有真的送。
- 模型根本沒收到訊息：看橋接的 `pm2 logs dc-bridge`（投遞、回合閘門、安靜、黑名單），
  session log 只記送進模型之後的事。
- 工具壞掉：看 `tool/call` 的參數與 `tool/result` 的錯誤；MCP server 的 log 在 DSH 的 log 裡。
- 人格／規則問題：看 `system/message`，裡面是這一輪實際用的 system prompt。
- 成本：`state/discord-usage.jsonl` 與控制台「花費」是橋接的帳；session log 的
  `assistant/message.usage` 是模型回報的原始數字。

### 6. 注意

- session log 有完整頻道內容、群友記憶與 persona；不要貼到公開頻道或 commit。
- `~/.dsh` 與 `state/` 都是 0600／0700；用 `jun` 身分讀。
- `session.v4` 是 DSH 0.2.1 的格式，DSH 升級後欄位可能變；不確定就先印事件類型。
- 伺服器非互動 shell 的 `node`／`pm2` 不在 PATH；解析用 `python3` 就好。

## 上游對比基準

見 [docs/guides/UPSTREAM_SYNC.md](docs/guides/UPSTREAM_SYNC.md)。要比對上游前先讀那份，
裡面有基準 commit、已搬與不搬的清單，只跑基準之後的新 commit。

## 目前的程序

| pm2 名稱 | 內容 | 工作目錄 |
| --- | --- | --- |
| `dc-bridge` | `src/discord-bridge.js` | `/home/jun/dc-bridge` |
| `dsh` | `npx -y @deepseek-ai/dsh@0.2.1-rc.2 web --no-open --port 2815 ...`（版本鎖在 `/home/jun/dsh/run.sh`） | `/home/jun/dsh` |
