# 計畫：補話問題（urgent 8 秒 ＋ 送出前檢查新訊息）

- 日期：2026-11-05
- 狀態：**已實作（2026-11-05）**
- 前情與案例：[HANDOFF_FOLLOWUP_BATCHING.md](HANDOFF_FOLLOWUP_BATCHING.md)

## 決定

1. **A：`urgentMs` 4 秒 → 8 秒。**（使用者 2026-11-05 決定）
2. **F：模型呼叫 `send_message` 時，先檢查同一個人有沒有還沒送進模型的新訊息。有就這次不送，把新訊息回給模型，讓它在同一個回合重新決定。**

不做：加長到 18~20 秒、發送端節流（C）、取消回合重送（B）、DSH `steer`。理由在下面。

## 為什麼是這個組合

實測 DSH session `49b374cd`（191 個回合，102 個有呼叫 `send`）：

| 指標 | 回合開始到第一次 `send` |
| --- | --- |
| 最短 | 2.7 秒 |
| 中位數 | 5.2 秒 |
| 第 90 百分位 | 6.5 秒 |
| 最長 | 49.9 秒 |
| 11 秒內送出 | 99 / 102 |

- 模型通常 5 秒就送出，所以 F 單獨用，窗口只有「4 + 5 ≈ 9 秒」，抓不到案例的 15 秒補句。
- A + F 的窗口是「8 + 5 ≈ 13 秒」。案例那種 15 秒的補句仍然抓不到；要抓到 urgent 得到 10 秒以上，使用者選擇不付這個延遲。
- 不用 DSH `steer`：`steer` 是在下一個 step 邊界才讀到，而模型第一個 step 就呼叫 `send_message`，補句進來時第一則已經送出。
  DSH 側的實作見 `dsh-api-session-controller/lib/types/commands.js:325`、`dsh-agent-loop/lib/index.js:809`。
- 不用 B（取消回合）：浪費已生成的內容，也要處理取消與重送的競態。
- 樣本只有一個 session、不含橋接投遞延遲，數字是粗估。

## 改動

### 1. A：`urgentMs` 改 8 秒

- `src/core/discord-batch.mjs:95`：預設值 `4_000` → `8_000`，同檔 `:83` 的註解一起改。
- `src/discord-bridge.js:4466` 的註解「urgentMs，4 秒」改成 8 秒。
- `scripts/test-discord-bridge.mjs:2425` 的訊息「預設 4 秒」改成 8 秒；順便看 `## 7d3` 其他用到時間的斷言是不是寫死 4 秒（`:2423`~`:2506`）。
- `urgentMs` 目前不是設定檔欄位，維持不是。

### 2. F：`send_message` 送出前檢查

**batcher 新增 `take(key, userIds)`**（`src/core/discord-batch.mjs`，`createBatcher`，目前只匯出 `add`、`extend`、`drop`、`flush`）：
- 把這個 key 目前還沒 flush 的項目裡、`userId` 在 `userIds` 內的取出並移除，回傳陣列。
- 取完批次空了就 `drop`（清 timer）；沒空就依剩下的項目重新排程，不要留著舊的送出時間。
- 不取有圖片或其他媒體的項目：工具回覆只能帶文字，圖片留給正常批次送，避免模型看不到圖。

**`send` 工具加檢查**（`src/discord-bridge.js:1801` 的 `async send(body)`）：
- 位置：安靜檢查（`quietSendBlocked`）之後、`prepareRefusal` 之前。只處理純文字訊息；帶 `file` 或 `sticker` 的不攔。
- 觸發者：`turnDirectMessages.get(key)` 裡的 `userId`（這一輪叫 bot 的人，`prepareRefusal` 已經這樣用，`:1670`）。沒有觸發者就不攔。
- 每個回合最多攔一次：用一個 `Set<key>`，`turn/start` 時重置（`:3059` 附近，跟 `turnDirect` 同一處）。
- 攔到的同一個 step 裡，其他 `send_message` 也先不送（hold 到 `step/start`）：模型把一句話拆成兩則時，
  不能只送出後半句。
- 攔到時：用 `batcher.take()` 取出補句，用 `formatBatch` 格式化，回傳類似 `prepareRefusal` 的 `replaced` 結果，內容是
  「剛剛有新訊息，這則先沒送出。請看完後重新決定要不要回、怎麼回：」＋ 補句。**不送出**，也不要算進發言額度。
- 補句要登記訊息編號（`messageRefs.register`），模型才能用 `reply_to=#編號` 回覆。要確認 `formatBatch` 有沒有已經做這件事，沒有就在這裡補。
- 補句視為已投遞：不能再由 batcher 送進下一個回合，否則模型會看到兩次。

**不處理**：
- 補句已經 flush 進 `turnGate` 的待處理佇列（`createTurnGate`，`:209`）。這在模型 5 秒送出的情況下很少見（要 8 秒 urgent 後才會 flush）；log 會記，之後再決定。
- 補句在 `send_message` 之後才到。這是任何方案都解不了的。

### 3. 觀察用 log

新增兩行，上線後用來決定要不要把 urgent 再加長：
- 攔到補句：`send 前攔到補句 ${key}（${n} 則，user=…，距回合開始 ${s} 秒）`。
- 沒攔到但太晚：`send_message` 之後 30 秒內同一個人又有新批次時記一行（可以先省略，用 `pm2 logs` 事後比對時間也行）。

## 測試（先寫、先看它失敗）

加在 `scripts/test-discord-bridge.mjs`，`## 7d3. 批次` 之後新增小節：

1. `take` 只取指定 `userId` 的項目，別人的留著；取完後批次的送出時間以剩下的項目為準；全取光就不會再 flush。
2. `take` 不取有媒體的項目。
3. `urgentMs` 預設 8 秒：@ 之後 7.9 秒沒送，8 秒送。
4. 橋接層（若現有測試能模擬 `send`）：觸發者在 batcher 裡有補句時，第一次 `send` 回傳補句且沒送出；下一個 step 的 `send` 照常送出；下一個回合又會重新檢查。
5. 沒有觸發者、補句是別人、或訊息帶 `file`／`sticker` 時，不攔。

驗證指令：

```bash
npm run test:discord
```

## 文件

- `docs/guides/DISCORD.md`「批次與自由參與」段：改 `urgentMs` 8 秒；新增一段說明「send 前會檢查同一個人的補句」。
- `HANDOFF_FOLLOWUP_BATCHING.md`：狀態改成「已決定，見 PLAN_FOLLOWUP_BATCHING.md」，不要留兩份互相矛盾的敘述。
- 目前 `HANDOFF_FOLLOWUP_BATCHING.md` 還是未追蹤檔，實作時一併 commit。

## 部署與驗證

```bash
node scripts/deploy-discord.mjs --dry-run
node scripts/deploy-discord.mjs
```

只改 `src/discord-bridge.js` 與 `src/core/*`，沒有動到 MCP server 會 import 的檔案，所以只需要 `pm2 restart dc-bridge`（腳本會判斷）。
改了之後確認 `send` 工具的 MCP 介面沒變（工具清單不變，不用跑 `setup:discord`）。

實測：
1. 在自由參與頻道叫 bot（回覆它）後，8~10 秒內補一句。預期 log 出現「send 前攔到補句」，頻道只有一則 bot 回覆。
2. 補句晚於 13 秒才打。預期仍然兩則（已知限制）。
3. 別人在同一時間講別的話。預期不被攔，也不被併進這次回覆。

## 風險與還沒查的

- **工具回傳文字被模型當成錯誤。** `replaced` 的措辭要讓模型知道「沒送出，請重新決定」，不是「失敗了重試同一句」。上線後看 DSH session 確認模型的反應（解析方法見 `AGENTS.md`）。
- **批次裡其他人也被取走？** 只取觸發者的訊息，別人的留在 batcher，照原本時間送出。
- **`formatBatch` 與 `messageRefs` 的行為沒細讀**，上面「補句要登記訊息編號」是待確認項。
- **`turnGate` 佇列裡的補句沒處理**（見上）。
- 時間分布只有單一 session 的樣本。上線後用 log 再看。
- 補話的定義沒再問使用者：群裡的吐槽有沒有包含 bot 平常太愛接話（handoff 決策點 4）。這份計畫不處理 persona（方向 D）。

## 刪除與清理

這個改動不會讓現有程式碼變成沒用。實作時若發現 `HANDOFF_FOLLOWUP_BATCHING.md` 的「可選方向」段已經過時，改成連結到這份，不要整份重寫。
