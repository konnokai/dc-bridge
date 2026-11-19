# 計畫：從 Miyoria 挑出的六個改善

> 狀態：**設計完成，未實作**（2026-11-19）。
> 來源：[Miyoria](https://github.com/owenliu0924/Miyoria) 的 `docs/ARCHITECTURE.md`（v0.2）與 `docs/DECISIONS.md`。只挑適合 dc-bridge 的部分，
> 沒有要照搬它的節點、hostd 或 module supervisor。
> 執行方式：一次只做一個工作包。做完、測試、部署、量測，再開下一個。
> 每個工作包都照 `AGENTS.md` 的順序：文件 → 測試 → 最小實作 → 清理。

### 完成度

| 工作包 | 狀態 | 開始條件 | 備註 |
| --- | --- | --- | --- |
| M1 歷史回想分數 | ⏸️ 暫緩 | 有 recall 使用量 | 線上 0 次呼叫 |
| M2 回合決策紀錄 | ⬜ 未開始 | — | M2c 已完成（Alloy + dashboard） |
| M3 背景便宜模型 | ⏸️ 暫緩 | 背景佔比變高 | 目前約 0.25% |
| M6 資料清冊 | ⬜ 未開始 | 可與 M2 並行 | 只改文件 |
| M5 MCP 安全清單 | ⬜ 未開始 | 可與 M6 並行 | 目前只有自建 MCP |
| M4 滾動前情提要 | 🔍 先驗 | 找到遺忘案例 | 壓縮很頻繁 |

## 0. 共同規則

- 一次一個工作包。M6／M5 只改文件，可以跟程式工作包並行，但不要跟同一個檔案的其他改動撞在一起。
- 動到程式碼的工作包，都要先補測試再看它失敗，實作完跑 `npm run test:discord`。
  部署前照 `AGENTS.md` 的 Lessons 跑 `engineering-code-reviewer`。
- 不改行為的工作包（M2）不要順手加新的判斷或閘門。先量測，再決定。
- 每個工作包的「不做」跟「要做」一樣重要。沒有列進去的，不要順手做。

## 0.1 線上先驗（2026-11-19）

先看線上資料，再決定順序。以下都是唯讀查詢，沒有改動程式或資料。

| 工作包 | 先驗結果 | 對計畫的影響 |
| --- | --- | --- |
| M1 | 7 天內 566 個 DSH 會話，`recall_history` 實際 tool call 0 次；`search_history` 7 次、`read_history` 2 次，集中在 4 個會話。Qdrant `dc_history` 3,480 點。 | 目前沒有使用量。先不做，除非要主動叫她用 recall。 |
| M2 | 11/12–11/19 的 pm2 log：收到 18,916、已投遞 9,947、MCP 送出 1,978、未送出回合 6,246、黑名單略過 3,624。未送出原因全是自由文字，例如「（跳過）」1,371、「不接。」718、「（不回應。）」682。 | 直接做。現有 log 能算粗略比例，但不能穩定分類。 |
| M3 | 14 天內有 title 的 1,199 個會話：黑話學習 984、頻道摘要 113、群友側寫 1、模擬交易 20、其他 81。`turn` token：其他 1.348B、黑話 2.76M、摘要 0.31M、交易 0.24M、側寫 0.003M。背景合計約 0.25%。 | 省不到錢。暫緩，除非主對話以外的用量變大。 |
| M4 | 7 天內 566 個會話、440 次 compaction，集中在 15 個會話；最多的一個 209 次、4,469 回合。橋接 log 在 11/18–11/19 有 10+ 次「自動壓縮」，每次丟 200–388 則、約 44k–61k token。 | 壓縮很頻繁；先確認「忘記」的實際症狀，再決定要不要做。 |
| M5 | MCP 只有自建的 discord／slang／trade／web-search-safe 與 HTTP 的 prts，沒有第三方 stdio。 | 目前風險低；清單照寫，但不用急。 |
| M6 | `state/`：usage 6.7MB、slang 908KB、notes 76KB、memory 23KB、triggers 39KB、trade DB WAL 1.4MB；Qdrant 2 個 collection。 | 直接做，資料都在。 |

資料來源：`~/.pm2/logs/dc-bridge-out*.log`、`~/.dsh/sessions/.../session.v4.jsonl.zstd`、
`state/discord-usage.jsonl`、Qdrant `/metrics`。

## M1 歷史回想的分數校正

### 現況

- `src/core/discord-history-archive.mjs:204` 的 `search()` 直接照 Qdrant 的 cosine 分數排序。
- `src/discord-bridge.js:1794` 把 `RECALL_MIN_SCORE` 寫死成 0.55，沒有跟著 embedding 模型調整。
- 回想結果沒有時間因素。三個月前和昨天同分。
- `append()` 的 payload（同檔 `:162`）沒有記 `embedModel`。

**線上先驗**：7 天內 `recall_history` 實際呼叫 0 次；`search_history` 7 次、`read_history` 2 次。
先確認有沒有人要用，再決定要不要改排序。

Miyoria §5.3 的重點：好模型的 cosine 常擠在 0.35–0.65。直接拿絕對分數乘權重，
共同字最多的那筆會贏。它把分數攤開在候選之間，再加新近度、重要性等權重。
dc-bridge 只需要前兩項。

### 如果要做（M1a）

等 `recall_history` 真的有使用量再開始。新增兩個設定，放在 `discord.historyArchive`：

```
recallMinScore: 0.55        // 原本的 RECALL_MIN_SCORE，改成可調
recallRecencyWeight: 0.15   // 0 = 完全照語意，1 = 完全照新舊
```

`search()` 多一個可選的 `rerank` 步驟：

1. 先照原本的 `minScore` 篩掉不合格的點。
2. 令 `floor = minScore`、`top = 候選裡最高的原始分數`。
3. `norm = clamp((score - floor) / max(top - floor, 1e-6), 0, 1)`。
   如果 `top - floor` 太小（所有候選同分），跳過 rerank，照原本順序回傳。
4. `recency = 0.5 ** (ageDays / 180)`（半衰期固定 180 天，先不開放設定）。
5. `final = (1 - w) * norm + w * recency`，`w = recallRecencyWeight`。
6. 照 `final` 由高到低取 `limit`。

預設值維持 0.55，先不改行為；上線後再用真實查詢調。
`rerank` 只在 `recall_history` 用，控制台搜尋（`src/discord-bridge.js:7711`）保持原樣。

設定正規化在 `src/core/discord-core.mjs:281`；`config.example.json` 與 `docs/guides/DISCORD.md` 要同步。

### 不做

- 不加 BM25。關鍵字查詢已經有 `search_history`，`recall_history` 是語意查詢，兩者混算要另一份設計。
- 不加入重要性、好感、頻道熱度。這些在 dc-bridge 沒有現成的數值，先不要造。
- 不改 Qdrant schema。`embedModel` 指紋留到 M1b。

### 測試

- `scripts/test-discord-history-archive.mjs` 加離線案例：固定分數與時間，斷言排序會把
  「語意稍低但很新」的訊息排到前面，且 `w = 0` 時完全照原始分數。
- 邊界：`top === floor`、只有一筆、`limit` 大於候選數、`minScore` 設 0。
- 控制台搜尋不受影響。

### 驗收

- 用 20 個手寫查詢（從真實頻道挑，不進 repo）比較改前改後的前 5 名，
  至少 12 個查詢的第一名不變或更好。
- `npm run test:discord` 通過。
- 部署後 `recall_history` 沒有出現新的錯誤 log。

### 回退

只改排序，不改資料。把 `recallRecencyWeight` 設 0 就回到原本的順序（但仍有 `minScore`）。
要完全回退就 revert。

### M1b（等真的要換 embedding 模型）

- 在 payload 記 `embedModel`；搜尋命中的點沒有這個欄位或值不同時，記一次警告。
- 提供 `scripts/reindex-history.mjs`：`--dry-run` 預設，`--apply` 才重算向量。換模型時先跑它。
- 現在不做，因為預設的 `bge-m3-mlx-fp16` 沒換過；先把風險寫在這裡。

## M2 回合決策紀錄

### 現況

- `src/discord-bridge.js:399` 的 `LOG_RING` 只留最近的文字 log。
- 觸發統計只記「誰叫了 bot」，token ledger 只記花費，dev feedback 是另一本帳。
- 沒有辦法回答「這批為什麼沒有回」「哪個閘門最常擋」「chatty 頻道回了幾成」。

### 要做（M2a，2026-11-19 已完成）

新增 `state/discord-turns.jsonl`，每次批次有結果時 append 一行。欄位固定，之後只加不改：

```json
{
  "at": "2026-11-19T12:00:00.000Z",
  "key": "ch:123",
  "turn": 12,
  "decision": "sent",
  "reason": "",
  "direct": true,
  "named": false,
  "chatty": true,
  "mediaOnly": false,
  "yielded": false,
  "merged": 0,
  "users": ["123"],
  "sent": 2,
  "tools": ["send_message"],
  "tokens": 1234,
  "ttftMs": 820,
  "model": "deepseek-chat"
}
```

- `decision`：`sent`（有送出）、`silent`（模型有回，但沒送訊息）、`skipped`（被閘門擋下）。
  還在排隊的批次不寫，等它有結果再寫。
- `reason`：`yield`、`media-only`、`quiet`、`ignored`、`denied`、`empty`、`gate`、`ask`、`system`。
  只在 `skipped` 時填。
- `turn` 用 DSH 的回合編號；沒有就 `null`。`tokens` 用 `sessionId` 和 `turn` 對上 `token-ledger`，
  取不到就 `null`。`ttftMs` 也一樣，取不到就 `null`。
- `merged` 是這批合併了幾則之前壓住的訊息。
- 寫入點：批次真的送出時、模型回完時、被閘門擋下時。同一個 key 同一輪只寫一次。
- 檔案上限 20 MB；超過就改名成 `.1`，只留一份舊檔。寫入用 append，不重寫整檔。

**實作（2026-11-19）**

- 寫入器在 `src/core/discord-turns.mjs`：`turnRecord()` 組紀錄、`normalizeTurnRecord()` 驗證、
  `createTurnLog()` append 與 20 MB 輪替。不合法的 `decision`／`reason` 不寫，只留 log。
- 掛點：
  - 投遞前：`quiet`、`yield`、`media-only`、會話重置與 DSH 拒收（`gate`）。
  - 回合完成：有送訊息 `sent`；只有 reaction 或沒送訊息 `silent`。
  - 背景、提醒、回訪等內部提示記 `skipped/system`，不混進頻道回覆率。
  - 進批次前就被擋掉的單則訊息：`ignored`、`denied`、`empty`、`quiet`。
  - 回答掛起提問記 `skipped/ask`；回答審批記 `skipped/gate`。
  - `tokens`／`model` 由 `token-ledger.turnUsage(sessionId, turn)` 加總同一輪所有 step；
    `ttftMs` 是第一個 token 的實測值。`merged` 由 `mergeJobs` 記「之前壓在佇列裡的訊息數」。
- 不寫：`error`／`aborted` 回合（原因在 log），以及 DSH Web GUI 直接開的回合（不是橋接排的批次）。
- `sent` 只算真的送出訊息；只按 reaction 的回合算 `silent`。
- 極端情況（prompt 已受理、連線在 `turn/start` 後才斷）可能同時留下一筆 `gate` 與該回合的
  `sent`／`silent`；機率低。分析時用 `turn` 是否有值區分批次列與單則訊息列。

### 不做

- 不改任何判斷。`decision` 只是記錄，不拿來擋。
- 不記訊息原文、不記名字，只記 user id。
- 不做即時事件流。控制台頁面留到 M2b。

### 測試

- `scripts/test-discord-turn-log.mjs` 測 schema、`reason` 的允許值、檔案輪替。
- 同一個測試檔涵蓋整合案例：被 `yield` 擋下的批次寫 `skipped/yield`；只有圖片的 chatty 批次寫
  `skipped/media-only`；正常回覆寫 `sent`，而且 `tokens` 對得上 ledger。

### 驗收

一週後能用一條查詢回答：

- 各 `decision` 的比例。
- `chatty` 頻道的回覆率。
- 平均 `ttftMs`，依 model 分組。
- 最常擋下批次的 `reason`。

### M2b（有在用才做）

控制台加一個唯讀「回合」分頁，顯示最近 200 筆，可依 key／decision 篩選。
沒有要查就別做。

### M2c（可選，等 M2a 有資料）

**2026-11-19 已完成（Alloy + dashboard）**：

- `alloy` 容器由 [deploy/alloy/compose.yaml](../../deploy/alloy/compose.yaml) 管理：
  `grafana/alloy:v1.22.0`、`network_mode: host`、以 `jun`（1000:1000）執行，
  掛 `/home/jun/.pm2/logs` 唯讀，收 `dc-bridge-out.log` / `dc-bridge-error.log`，
  標籤 `job=dc-bridge`、`stream`、`service`、`host`，推 `http://127.0.0.1:3100`。
- 頻道筆記與梗圖的 log 用 `stage.drop` 丟掉，不進 Loki。
- Grafana dashboard `dc-bridge-ops`（https://grafana.konnokai.me/d/dc-bridge-ops）：
  log 量、已投遞／MCP 送出、未送出回合、錯誤、未送出原因 top 10、各頻道 top 10、
  自動壓縮、最近未送出、Qdrant 點數／query rate／平均延遲。
  匯入檔：[deploy/grafana/dc-bridge-ops.json](../../deploy/grafana/dc-bridge-ops.json)。
- 設定在 [deploy/alloy/config.alloy](../../deploy/alloy/config.alloy)；
  啟動：`docker compose -f deploy/alloy/compose.yaml up -d`。不進 `/root/docker-monitoring`。
  操作說明：[deploy/alloy/README.md](../../deploy/alloy/README.md)。

- 驗證：`{job="dc-bridge"}` 查得到 log；`MCP 記頻道筆記` 與 `MCP 存梗圖` 查不到（被 drop）。
  Qdrant 的 `collection_vectors`、`rest_responses_*` 面板有資料；query rate 目前是 0（recall 沒人用）。

以下保留原設計：

- **Loki**：Alloy 收 `dc-bridge-out.log` / `dc-bridge-error.log`，標籤 `job="dc-bridge"`、`stream`。
  LogQL 查決策、自動壓縮、錯誤。已經上線。
- **Prometheus**：bridge 目前沒有 `/metrics`。要加就讓它跟 M2a 共用同一組計數：
  `dc_bridge_turns_total{decision,reason}`、`dc_bridge_sends_total`、
  `dc_bridge_tokens_total{kind,model}`、`dc_bridge_ttft_seconds`、`dc_bridge_batch_size`、
  `dc_bridge_queue_depth`、`dc_bridge_dsh_up`。建議綁 127.0.0.1 的獨立埠，不要跟控制台同一個對外埠。
- **Grafana**：三個面板就夠——營運（送出、跳過原因、錯誤、重啟）、成本（`/api/usage` 或 exporter）、
  壓縮（`自動壓縮` 次數與丟掉的字數）。Qdrant 的 `collection_vectors`、`rest_responses_*` 已經有 scrape，可直接用。
- **不要做**：不要把 DSH session log 送進 Loki（zstd、檔案大、含完整頻道內容）；不要把 channel id
  或人名當 Prometheus label。

## M3 背景工作改用便宜模型

### 現況

`src/discord-bridge.js:5784` 的 `runBackgroundPrompt` 固定用 `cfg.dsh.provider` / `cfg.dsh.model`，
只把 reasoning 設 `low`。頻道摘要、群友側寫、黑話抽取、Bot 交易都走這裡。

**線上先驗**：14 天內背景工作約 3.3M token，主對話約 1.348B，背景只佔約 0.25%。
省不到錢，暫緩；除非背景工作的用量變大，或主對話模型漲價。

### 如果要做

等背景工作佔比變高再開始。

- `config.json` 的 `dsh` 加兩個可選欄位：`backgroundProvider` 與 `backgroundModel`，
  跟現有的 `provider`／`model` 一致。兩個都沒填或只填一個，就用主模型，行為不變。
- `src/core/discord-core.mjs` 正規化這兩個欄位；空字串或型別不對就當沒填，記警告。
- `runBackgroundPrompt` 選模型時用它；`selectModel` 失敗就沿用預設，記一行 log（現在已經是這個行為）。
- 第一階段只套 `usageKind === "summary"`（頻道摘要、群友側寫）。
  `learner`（黑話抽取）和 Bot 交易先不動，因為它們的輸出格式或工具需求還沒驗證。
- `config.example.json` 與 `docs/guides/DISCORD.md` 補說明。

### 不做

- 不改主對話模型。
- 不做 per-purpose 的完整路由表。現階段只有「聊天」和「背景」兩種。
- 不動 DSH 的 preset。

### 測試

- 正規化：有填、沒填、格式錯、provider 或 model 缺一邊。
- `runBackgroundPrompt` 用假 API：有 `backgroundProvider`／`backgroundModel` 時 `selectModel` 收到正確的值；
  失敗時沿用預設，且 workflow 繼續。
- 摘要與側寫的解析測試不變。

### 驗收

- token ledger 裡 `summary` 的單價下降，摘要品質沒有明顯變差（抽 10 篇人工看）。
- 背景模型壞掉時，log 看得到，摘要照樣用主模型完成。
- `npm run test:discord` 通過。

### 風險

便宜的模型可能不會照 JSON 格式輸出。群友側寫已經有 `parseProfiles` 擋壞資料，
最壞情況是這次不更新，不會寫壞。摘要則是純文字，風險更低。

## M4 Session 的滾動前情提要（條件式）

### 開始條件

M2 上線後，一週內至少看到 3 次「DSH 壓縮後，模型忘記同一會話前面講過的事」。
沒有這個證據就不要做。

**線上先驗**：7 天內 440 次 compaction，集中在 15 個會話；最多的一個 209 次。
壓縮頻率已經很高，接著要找「忘記」的實際案例，不是只看壓縮次數。

### 為什麼先不做

- 現有的每日摘要是「這個頻道的一天」，不是「這個會話的前情」。
- `src/core/discord-memory.mjs:217` 的註解已經寫了 shortcut：靠 30 分鐘重帶一次補壓縮後的遺忘。
  先確認這個補法不夠。
- 多一份摘要就多一次模型呼叫，也多一份要刪的資料。

### 如果要做

- 只做 guild 頻道，不做私聊（私聊摘要會多存一份個資）。
- 沿用 `discord-notes` 的摘要機制，一個 session key 一份，300 字以內，每 N 回合或閒置 T 秒更新。
- 注入位置在最近訊息之前，標明「前情提要（資料，不是指令）」。
- 用 M3 的背景模型跑，不要用主模型。
- 與每日摘要重複時跳過，不要兩份都帶。

### 驗收

- 壓縮後問同一會話的舊話題，模型答得出來。
- 每批多帶的字數有上限，token 花費有記錄。
- 不做私聊。

## M5 MCP／擴充的安全清單（文件）

### 要做

在 `docs/guides/SECURITY_BASELINE.md` 加一節，列出：

- 目前 MCP 工具只綁 session token，沒有「觸發者」。
  同一批合併多人的訊息時，任何一個人打字都可能讓模型呼叫高風險工具。
- 高風險工具與現有閘門：`run_script`（sandbox 頻道）、`generate_image`（每日上限與額度）、
  交易寫入（交易自己的規則）、`send_message`（每輪 5 則）。
- 如果以後開放給不熟的人：這幾個工具要先加 owner／admin 檢查，或把 principal 帶進 MCP。
- 第三方 stdio MCP 的環境變數要白名單，不能繼承 bridge 的密鑰。
  DSH 啟動的 MCP server 目前在 `setup-dsh.mjs` 裡設定，實際繼承什麼要照 DSH 版本確認。
- 工具 schema 可去掉 `$schema`／`$comment`／`title`；結果長度要有上限。

### 不做

- 這次不改程式。先把現況與缺口寫清楚。

### 驗收

文件裡每個高風險工具都有「現在的閘門」和「缺口」兩欄，
讀完能回答「開放給外人之前要補什麼」。

## M6 資料清冊（文件）

### 要做

在 `docs/guides/PRIVACY.md` 加一張表：

| 資料 | 位置 | `/forget` 會刪嗎 | 保留 | 備份 |
| --- | --- | --- | --- | --- |
| 群友記憶與側寫 | `state/discord-memory.json` | 會 | 直到刪除 | 有 |
| 頻道筆記與每日摘要 | `state/discord-notes.json` | **不會**（已知缺口） | 30～180 天 | 有 |
| ... | ... | ... | ... | ... |

涵蓋：記憶、筆記、知識、黑話、梗圖、回訪、開發回饋、用量帳本、token 帳本、
交易 DB、Qdrant `dc_history`、會話映射、log。

### 不做

- 這次不改 `/forget`。先把「現在刪了什麼、沒刪什麼」寫清楚。
  要不要補刪是另一個決定。

### 驗收

- 表格裡的每個路徑都存在，或明確標成「選用」。
- `PLAN_AGENT_GAPS.md` 提到的「`/forget` 不刪筆記」在表裡看得到。

## 執行順序（依 0.1 調整）

1. M2：決策紀錄。先只寫 JSONL，跑一週。它是其他量測的基礎。
2. M6：資料清冊。文件，跟 M2 不衝突。
3. M5：MCP 清單。文件，等 M6 的路徑表完成再寫，避免兩份資料對不上。
4. M4：先找「壓縮後忘記」的實際案例；有 3 次才開始做。
5. M1：等 `recall_history` 真的有使用量再做。
6. M3：等背景工作佔比變高再做。

原本的順序是 M1 → M2 → M3 → M6 → M5 → M4；線上資料顯示 recall 幾乎沒用、背景只佔 0.25%，
所以把 M1／M3 暫緩，M2 先做。

每個工作包完成後，把上表的狀態改成 ✅，並在下面加一行「完成日期、commit、部署結果」。

## 待決定

- M1 的 `recallRecencyWeight` 預設 0.15 是先驗值。要不要先跑一輪離線比較再定？
- M3 要用哪個 provider/model？需要一個支援 JSON 輸出、價格比主模型低的選項。
- M5 的「開放給不熟的人」目前沒有計畫。如果沒有，清單只寫現況，不加限制。
