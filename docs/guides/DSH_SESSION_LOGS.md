# 解析 DSH 會話日誌

> 模型看到什麼、為什麼回或為什麼拒絕，都在 DSH 的 session log；橋接的 log 只記投遞與送出。
> 先找會話，再解壓，最後只看需要的 turn。

## 1. 找 session id

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

## 2. 找日誌檔

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

## 3. 先看事件類型

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

## 4. 把一個 turn 印成人看得懂的樣子

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

## 5. 什麼時候看哪裡

- 模型回錯、拒絕、沒說話：先看 `assistant/message` 的 `reasoning`，再看 `tool/call` 有沒有真的送。
- 模型根本沒收到訊息：看橋接的 `pm2 logs dc-bridge`（投遞、回合閘門、安靜、黑名單），
  session log 只記送進模型之後的事。
- 工具壞掉：看 `tool/call` 的參數與 `tool/result` 的錯誤；MCP server 的 log 在 DSH 的 log 裡。
- 人格／規則問題：看 `system/message`，裡面是這一輪實際用的 system prompt。
- 成本：`state/discord-usage.jsonl` 與控制台「花費」是橋接的帳；session log 的
  `assistant/message.usage` 是模型回報的原始數字。

## 6. 注意

- session log 有完整頻道內容、群友記憶與 persona；不要貼到公開頻道或 commit。
- `~/.dsh` 與 `state/` 都是 0600／0700；用 `jun` 身分讀。
- `session.v4` 是 DSH 0.2.1 的格式，DSH 升級後欄位可能變；不確定就先印事件類型。
- 伺服器非互動 shell 的 `node`／`pm2` 不在 PATH；解析用 `python3` 就好。
