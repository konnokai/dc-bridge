---
name: discord-batch-debounce
description: 批次去抖：預設 20 秒、maxWait 30 秒、@ 後改用 4 秒短等待（不立刻送）、私聊不設 urgent
---

一般批次（沒人 @）的去抖從 5 秒改到 20 秒，maxWait 從 15 秒改到 30 秒；有人 @ 或回覆 bot 的那批不等滿 20 秒，改用 4 秒的短等待（`urgentMs`），後面補的句子照樣併進同一批。私聊沒有 @，一律照 debounce 合批。

## 實作

- `src/core/discord-core.mjs`：`debounceMs` 預設 `20_000`、`maxWaitMs` 預設 `30_000`；clamp 範圍不變。
- `config.example.json`：同步 `20000`／`30000`。
- `src/core/discord-batch.mjs`：`createBatcher` 新增 `urgentMs = 4_000`；批次帶 `urgent` 時整批改用 `Math.min(debounceMs, urgentMs)` 的短等待，而且 urgent 一但出現，後續每一則 add 都用短值重設 timer，不會又變回 20 秒。`item.urgent` 本身不再立刻 flush。
- `src/discord-bridge.js`：`batcher.add(..., { urgent: addressedToBot })`；`addressedToBot` 是頻道裡真的 @ 或回覆 bot（`shouldHandleGuildMessage(..., requireMention=true)`），私聊 `Boolean(guildId)` 為 false，刻意不設 urgent，避免私聊每則訊息都獨立成回合、拆散分句。
- 連結預覽圖註解改成「批次至少等過幾秒（有人 @ 時 4 秒）」，不再說等過 debounce。

## 修正歷史

第一版把 `item.urgent` 寫成立刻 flush，reviewer（engineering-code-reviewer）指出：
- 單獨一則「@bot」立刻送出，畫面只有「[沒有文字，只有叫你]」；後面補的句子一定變第二個回合。
- @ 模式頻道（預設 `requireMentionInGuild=true`）每則都算 @，20 秒合批等於失效。

所以改成「短等待 4 秒」而不是「立刻送」，並補測試 5 項（`scripts/test-discord-bridge.mjs`）。

## ★ 標頭與幻覺防護

- `formatBatch`（`src/core/discord-batch.mjs`）標頭：有 @／回覆 bot 的訊息時寫「★ = 在叫你：@你或回覆你」；**沒有任何 direct 訊息時改寫「這批沒有 ★，沒有人在叫你」**，防止模型自己補出 ★、把別人互相回覆的閒聊當成在叫它（實際遇過）。
- reviewer 指出：標頭只應寫橋接知道的事實（@／回覆），叫名字算不算在叫它留給 persona；「沒有人在叫你」可能跟 persona「話題提到你可接」衝突。目前程式碼仍用較強的「沒有人在叫你」版本。

## 已知取捨

- 私聊從 5 秒變成 20 秒，每一則「在嗎」都要等 20 秒；不是 bug，是延遲變慢，要使用者決定能不能接受。
- urgent 訊息在 Discord 補上連結預覽（`messageUpdate`）前就送出了，那批可能只剩網址；文件本來就有這個 fallback（`view_message` 再看）。

## 部署

改動尚未 commit／部署（transcript 結尾停在未 commit 狀態）。伺服器 `config.json` 沒有 `discord.batch` 這個鍵，部署後預設值就會生效。

測試：`npm run test:discord` → 18/18 scripts passed。

相關：[[discord-followup-batching]]、[[discord-blacklist-stale]]。