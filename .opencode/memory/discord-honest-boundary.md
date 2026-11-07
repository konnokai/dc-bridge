---
name: discord-honest-boundary
description: 幻覺歸屬根因、compaction 摘要丟失發言者、persona 誠實邊界規則、debounce maxWait 維持 15 秒、COMPACT_NOTICE 白飯梗
---

DSH 會話 `session-2bf9e444-...`（402 回合、約 13.5 小時）出現「把 A 的請求記到 B 頭上」的幻覺：
模型對「👉💜🧊（璃不開）」說「原來要貓娘的就是波斯貓本人」，把 `のもと(not oo)` 的貓娘語氣請求記到璃不開。
raw 歷史裡 #g83knb 有請求與模型自己的 reply_to，但壓縮摘要（seq 3015）只寫
「のもと and 拿OO諾 said 晚安」，沒記誰要求貓娘語氣；模型只憑摘要模糊印象指名，手上沒有 #編號證據。

## 根因

1. 直接原因：模型把「有人要求貓娘語氣」pattern-match 到當下正在互動的 ★ 發言者，沒有先確認作者。
2. 遠因：DSH 自動壓縮把「誰說的」弄丟；`dsh-compaction-basic` 只支援 `retainRatio`／`retainTokens`，
   **不能自訂摘要指令**，所以修法只能放在 persona，不能靠 compaction 套件。
3. 機車模式在不符合條件的情況下打開（對方沒有講離譜的話）。
4. persona 舊規則「認錯要快」讓模型先認錯，掩蓋了真正的歸屬錯誤；實際 seq 3410 是硬拗、seq 3423 認錯且歸屬講對，規則有生效。

## persona 誠實邊界（2026-11-07，opus review）

不要放寬「認錯」，改成「指名要有證據」：

- 只提真的聊過的事。要說「某人說過／要過什麼」之前，那則 `#編號` 要在眼前
  （這輪的訊息裡，或用 `search_history` 查到）；看不到就不指名，或先查再說。
- 對方說你記錯：能查就先用 `search_history` 查一次。查到是別人說的，就講清楚是誰
  （「啊我記錯人了 那是 X 說的」）；查不到或真的錯了，就爽快認錯，不要硬拗。
- 【機車】補一句：機車不拿別人以前說過的話當梗。
- 範例：被指出記錯 → ✗「可是明明是你說的欸」（沒查就硬拗）
  ✓ 查到是別人：「啊我記錯人了 那是 NOMOTO 說的」；查不到：「啊我記錯了」。
- `search_history` 用掉每輪 3 次額度中的 1 次，只在被質疑時才查，額度夠用。

## Debounce（2026-11-07 診斷）

- `maxWaitMs` 維持 15 秒。連續講話超過 15 秒還是會先送一批，這跟「直到安靜為止」不一樣；
  移除上限的話熱絡頻道會一直等、等不到回覆。
- 3→5 秒的實際效果：好處是有人連打 2–3 行時比較少被拆成兩個回合；代價是每則 ★ 回覆慢 2 秒。
- **這個改動對幻覺沒有幫助**，回報時不要說成有幫助。
- `createTurnGate` 會把回合進行中收到的訊息全部合併（`mergeJobs`，`HELD_MAX = 50`），
  熱絡時批次本來就大；debounce 只影響「閒置後的第一批」。
- 部署前要確認 ★ 訊息會不會跳過 debounce 直接送出（看 `src/discord-bridge.js` 約 2366 行附近）。

## COMPACT_NOTICE（commit 835741b，2026-11-07 部署）

壓縮提示從「🗜️ 聊天紀錄太長，正在壓縮，稍等一下…」改成
「🍚 吃太多白飯，正在減肥，稍等一下…」：

- `src/core/discord-core.mjs`：`COMPACT_NOTICE` 改成白飯減肥梗，保留「稍等一下」的意思。
- `scripts/test-discord-bridge.mjs`：斷言改成檢查「白飯」「減肥」。
- `docs/guides/DISCORD.md`：兩處舊提示文字同步更新。
- 只重啟 `dc-bridge`；pm2 online，log 有 `已登入：大肥魚#6391`。測試 14/14 scripts passed。
- 回退：`node scripts/deploy-discord.mjs --sha 27104c4`。

## 已知取捨

- prompt 規則只會降低出錯機率，不能保證不出錯；真正的修法在壓縮摘要，但 compaction 套件不支援自訂指令。
- 不要調高 `retainTokens`（檔案註解：調高會造成延遲，也會一直壓縮失敗）。

相關：[[discord-persona]]、[[discord-batch-debounce]]、[[discord-history-quota]]。