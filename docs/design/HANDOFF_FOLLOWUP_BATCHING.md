# Handoff：補話問題（同一個話題被拆成多個回合）

- 日期：2026-11-05
- 狀態：**已決定，見 [PLAN_FOLLOWUP_BATCHING.md](PLAN_FOLLOWUP_BATCHING.md)**
- 目前部署版本：`5d98bad`（debounce 20 秒、urgent 4 秒、typing 延長、@ 模式 60 秒補句窗口）
- 案例：DSH session `session-0fc54a24-dbf0-4722-bca1-1b3a30c08c19`，Discord 頻道 `#雜談交流大廳`（`ch:739040035571236905`）

## 一句話

★ 訊息的 `urgentMs` 只有 4 秒，比使用者補下一句的間隔（這次 15 秒）短。第一批先送進 DSH，補句只能開第二個回合，bot 就變成連送兩則，群裡直接吐槽「怎麼還是有補話問題」。

## 實際案例（2026/11/05，Asia/Taipei）

| 時間 | 事件 |
| --- | --- |
| 00:23:14 | 我是帕魯回覆 bot：「我沒改名字，konnokai 是指 @皎朧孤 這貨」→ ★ |
| 00:23:18 | 這批送進 DSH（★ 的 4 秒 urgent） |
| 00:23:29 | 我是帕魯補一句：「剛剛只是講表符內的文字」→ 沒 @、沒回覆 |
| 00:23:32 | bot 回第一則：「啊我記錯了 那還是 Will 就好」 |
| 00:23:49 | 補句那批送進 DSH（一般 20 秒） |
| 00:23:55 | bot 回第二則：「喔喔 原來是在講表符裡那行字 我整個誤會」 |
| 00:24:09 | konnokai：「…你娘怎麼還是有補話問題」 |

模型後來也送了 feedback（`df_mw2bv738201d76`）：

> 同一個誤會我連著送了三則（記錯名字→認錯→再補一句解釋），群裡有人直接吐槽「怎麼還是有補話問題」。

## 現在的機制（`5d98bad`）

- 一般批次：`debounceMs` 20 秒（從最後一則算），`maxWaitMs` 30 秒（從第一則算），滿 `maxMessages` 20 則立刻送。`src/core/discord-core.mjs`。
- 頻道裡有人 @ 或回覆 bot、且不是「只 @ 不說話」：整批改用 `urgentMs` 4 秒。`src/discord-bridge.js` 的 `urgent: addressedToBot && !emptyDirect`。
- 同一批裡同一個人先前有 direct 訊息，他再補的那則也會把整批升成 urgent（`src/core/discord-batch.mjs` 的 `followsDirect`，只限 guild）。
- 這批裡已經有訊息的人打字：把送出時間往後延 10 秒，最多到第一則後 30 秒。`createBatcher.extend`。
- @ 模式頻道（只能 @bot）的補句窗口：叫過 bot 的人 60 秒內沒 @ 也收，打字再延，硬上限 2 分鐘。`src/core/discord-typing.mjs`。**這個案例的頻道是自由參與，這條路徑沒有觸發。**
- 同一個會話一次只跑一個回合；回合進行中的批次會壓住、合併，但一定是下一個回合。

## 根因

1. 00:23:14 那則是回覆 bot，走 4 秒 urgent，00:23:18 就送進 DSH。
2. 補句 00:23:29 才到，晚了 11 秒。第一批已經在生成回覆，不可能再合併。
3. 補句自己開一批，照 20 秒等到 00:23:49；bot 00:23:55 回第二則。
4. 如果第一則不是 ★，用一般 20 秒，這批會等到 00:23:34，兩則一起送，只會回一次。
5. typing 延長救不到：批次 00:23:18 就送出了，`extend` 已經找不到批次。而且依 2026-11-05 的實測，`TYPING_START` 通常在送出一則後 3~8 秒才到；4 秒的窗口最多只吃得到 3 秒多前的那次打字，延長到 +13~14 秒，還是追不上 +15 秒的補句。**4 秒 + 10 秒的組合註定抓不到 15 秒的補句。**
6. 第一則回覆花了 14 秒生成（00:23:18 → 00:23:32），補句在生成期間到達。DSH 的 queue 模式一次只接一則排隊訊息，沒辦法把補句插進正在跑的回合。

## 可選方向（已決定）

A（`urgentMs` 4 → 8 秒）＋ F（`send_message` 送出前檢查同一個人的補句）已決定，做法與理由見
[PLAN_FOLLOWUP_BATCHING.md](PLAN_FOLLOWUP_BATCHING.md)。其他方向（B/C/D/E）沒有採用。

## 檔案與測試

- `src/core/discord-batch.mjs`：`createBatcher`、`add`、`schedule`、`extend`、`followsDirect`。
- `src/core/discord-core.mjs`：`batch` 的預設值與 clamp。
- `src/discord-bridge.js`：batcher 建立（約 :2585）、`urgent`（約 :4444）、`handleTyping`（約 :4460）、`handleMessage` 的 `!direct` 分支。
- `src/core/discord-typing.mjs`：@ 模式補句窗口，這次沒觸發。
- `scripts/test-discord-bridge.mjs`：`## 7d3. 批次`、`## 7d4. @ 模式的補句窗口`。
- `docs/guides/DISCORD.md`：「批次與自由參與」段。

驗證與部署：

```bash
npm run test:discord          # 18/18
node scripts/deploy-discord.mjs
node scripts/deploy-discord.mjs --sha 5d98bad   # 以後改壞了，回到這次的版本
```

注意：目前 checkout 在 `fix/dc-chat-blacklist-star-priority`，工作目錄有其他未 commit 的改動（`docs/guides/DISCORD.md`、`dsh/agent-presets/...`、`plugins/...`、測試、`src/core/discord-context.mjs`、`src/discord-bridge.js`）。不要跟補話的修改混在一起。

## 怎麼重現／查證

```bash
# 1. 頻道對應的 session（state/discord-sessions.json 的 sessions 底下）
cd /home/jun/dc-bridge
python3 -c "import json;d=json.load(open('state/discord-sessions.json'));print(d['sessions'].get('ch:739040035571236905'))"

# 2. 解會話日誌
D=~/.dsh/sessions/--home-jun-dc-bridge-state-discord-agents--/session-0fc54a24-dbf0-4722-bca1-1b3a30c08c19
cp "$D/session.v4.jsonl.zstd" /tmp/sess.zst
zstdcat /tmp/sess.zst > /tmp/sess.jsonl
```

把 turn 13、14 印出來（`user/message` 的內文在 `data.content`，`assistant/message` 在 `data.message.content`）：

```bash
python3 - <<'PY'
import json, datetime
cur = 0
for line in open('/tmp/sess.jsonl'):
    e = json.loads(line); t = e.get('type'); d = e.get('data') or {}
    ms = e.get('time')
    ts = datetime.datetime.fromtimestamp(ms / 1000).strftime('%H:%M:%S') if ms else '--:--:--'
    if t == 'turn/start': cur = d.get('turn') or 0
    if cur not in (13, 14): continue
    if t == 'user/message':
        txt = '\n'.join(c.get('text', '') for c in d.get('content', []) if c.get('type') == 'text')
        i = txt.find('【新訊息】')
        print(f'USER {ts}:', txt[i:i+400])
    elif t == 'tool/call':
        print('CALL', d.get('name'), str(d.get('arguments'))[:300])
    elif t == 'turn/end':
        print('END', ts, d.get('reason'))
PY
```

橋接端的收發時間：

```bash
python3 - <<'PY'
import re
for line in open('/home/jun/.pm2/logs/dc-bridge-out.log', errors='replace'):
    if '00:23:' in line or '00:24:' in line:
        print(line.rstrip())
PY
```

頻道原始訊息（token 只從 config 讀，不要印出來）：用 Discord REST `GET /channels/739040035571236905/messages?limit=50`，把 `timestamp` 轉成 +08:00。重點看 00:23:14、00:23:29、00:23:32、00:23:55 四則。

```bash
cd /home/jun/dc-bridge
python3 - <<'PY'
import json, urllib.request, datetime
tok = json.load(open('config.json'))['discord']['token']
req = urllib.request.Request(
    'https://discord.com/api/v10/channels/739040035571236905/messages?limit=50',
    headers={'Authorization': 'Bot ' + tok, 'User-Agent': 'DiscordBot (https://example.com, 0)'})
for m in reversed(json.load(urllib.request.urlopen(req))):
    ts = datetime.datetime.fromisoformat(m['timestamp'].replace('Z', '+00:00'))
    ts = ts.astimezone(datetime.timezone(datetime.timedelta(hours=8)))
    print(ts.strftime('%H:%M:%S'), m['author']['username'], '|', (m.get('content') or '').replace('\n', ' ')[:80])
PY
```

## 已驗證／未驗證

- 已驗證：四則訊息與兩次投遞的時間、`urgentMs` 造成 4 秒送出、補句走 20 秒、兩則 bot 回覆的內容。
- 未驗證：這次事件當下有沒有收到 typing 事件（橋接沒有記錄）；群裡的「補話」是否只指這一組。`scripts/probe-typing.mjs` 已刪除，要再量 typing 延遲得重寫一支小探測。

## 另外兩個發現（不是補話，別混進同一個修改）

1. **同一個梗圖被送兩次到 DSH**：其實是兩則不同的 Discord 訊息，各投遞一次。第一則 00:28:34 收到、00:28:54 投遞（`#7nrk9p`，227×175、17,264 bytes），第二則 00:29:00 收到、00:29:20 投遞（`#qqcb37`，288×175、20,331 bytes）；兩張的 sha256 不同，第一則後來被刪掉，所以頻道只剩一張。不是橋接重送。
2. **呼叫 `send_message` 之後又說「先不回」**：turn 16 的模型先送出「我比較丟臉吧…」（00:26:57，頻道有收到），之後輸出文字「先不回。」。assistant 文字橋接不會送出，所以頻道沒有多一則；這只是模型在 DSH 裡的收尾註記，屬 persona 層，不是投遞錯誤。
