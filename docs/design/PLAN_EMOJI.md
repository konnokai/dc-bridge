# 計畫：Discord 表情 / 貼圖

> 狀態：**v1、v3、v4 已實作**。v1：目錄 + 關鍵字檢索 + `:名稱:` 代換。
> v3：表情改由 MCP 工具 `search_emojis` 查，加上 `send_sticker`、
> `add_reaction`（用 `#編號` 指訊息）。v4：prompt 帶跨伺服器常用前 8 個
> （名稱＋使用時機），同會話 30 分鐘去重；`search_emojis` 退成找更貼的補充手段。
> v2（語意檢索 / omlx embedding）還沒做：要先有 embedding 位址，
> 而且照下面的條件，先觀察 v4 的實際使用再決定。

## 為什麼不是全部塞進 prompt

3~4 個伺服器、每個 50~150 個 emoji，全注入約 12,000 字（≈8k token）/回合。
v1 只注入 top 12（約 400~600 字），其餘靠目錄與檢索。v4 改成跨伺服器使用次數前 8 個、
每個會話 30 分鐘最多帶一次（約 200 字），解決「要先查一次才知道名字」的摩擦。

## v1（已完成）

- **目錄**：`state/discord-emoji/<guildId>.json`
  ```json
  { "version": 1, "guildId": "…", "guildName": "…", "model": "opencode-go/deepseek-v4.1-flash",
    "builtAt": "…",
    "entries": [{ "id": "…", "name": "kekw", "animated": false,
                  "hash": "sha256", "description": "大笑", "tags": ["笑", "嘲諷"],
                  "usage": "覺得好笑時", "updatedAt": "…" }] }
  ```
- **建立**：`scripts/build-discord-emojis.mjs`
  - 抓 `emoji.imageURL({ size: 128 })`（pn/gif）→ 沿用 `prepareImageBlock` 縮圖。
  - 一次 4~5 張丟給 DSH `dc-chat`（vision），要求只回 JSON。
  - 只重做新的/換圖的（hash）；失敗保留舊資料；刪掉的 emoji 從目錄移除。
  - 每次 batch 建一個新 session（避免圖片累積在 context）；結束歸檔。
- **檢索**：`src/core/discord-emoji.mjs` 的 `retrieveEmojis`
  - 當前伺服器 +6、名稱命中 +4、中文 bigram/ASCII 關鍵字命中 +2。
  - 有查詢字時只回命中關鍵字的（本服 +6 不能單獨讓一個表情入選），按分數取前
    `emoji.maxCandidates` 個，受 `emoji.maxChars`；查詢字是空的就列本服的。
- **注入**：v1 每回合附 `【可用表情】` 區塊；v3 拿掉，改成 `search_emojis` 工具。
  v4 加回精簡版【常用表情】：跨所有目錄按使用次數取前 8 個，只放名稱與使用時機；
  同會話內容沒變就不重帶，30 分鐘後或內容變了才再帶。
- **進來的表情**：群友訊息裡的 `<:名稱:id>`／`<a:名稱:id>` 換成
  `[表情：名稱（目錄描述）]`（純文字，不送圖）；動畫表情多標「動圖；」。目錄沒有就只寫名稱，
  同一則訊息同一個表情只描述一次。Unicode emoji 不動。每日摘要只留名稱，不帶描述。
- **代換**：`sendLong` 內用 `substituteEmojiNames`，把 `:名稱:` → `<:名稱:id>` /
  `<a:名稱:id>`；同名時當前伺服器優先；找不到保留原文。
  URL 與時間（`http://`、`12:30`）不會誤換，因為名稱必須存在目錄。
- **開關**：`discord.emoji.enabled`、`maxCandidates`、`maxChars`、`dir`。

## v2：語意檢索（omlx embedding + Qdrant）

**什麼時候做**：關鍵字 top-12 常常挑不到「對的」表情（例如訊息是「這操作我沒了」，
目錄寫「無語／翻白眼」但沒有共同字）。先用一週的實際使用觀察，不要提前上。

**你已有的**：其他機器上的 omlx embedding server；這台有 Qdrant（6333/6334）。

**介面不變**：`retrieveEmojis(catalogs, { guildId, text, k, maxChars })` 內部換成
向量檢索即可，prompt 與 `:名稱:` 協定都不用改。

**設定草案**：
```json
"emoji": {
  "retrieval": "auto",
  "embedding": {
    "baseURL": "http://<omlx-host>:<port>/v1",
    "model": "<embedding model>",
    "dimensions": 1024,
    "timeoutMs": 8000
  },
  "qdrant": { "url": "http://127.0.0.1:6333", "collection": "discord_emoji" }
}
```

**索引**：
- collection payload：`{ guildId, emojiId, name, text }`；text = description + tags + usage + name。
- 目錄變更時（build 完）重建受影響 guild 的點；用 emojiId 當 point id 的穩定 hash。
- 啟動時檢查 Qdrant collection 是否存在；不存在就 fallback 關鍵字（不要讓聊天掛掉）。

**查詢**：
1. 當前訊息（＋最近上下文）→ embedding。
2. `search` 當前 guild（+6 分）與其他 guild，取 top 20。
3. 重新排序：向量分數 + 當前伺服器加權 + 最近使用次數。
4. 套 `maxCandidates` / `maxChars`。

**成本/延遲**：一次 embedding（幾十 ms）＋一次 Qdrant search；比多送 1k token 便宜。
**降級**：embedding 或 Qdrant 失敗 → 直接走 v1 關鍵字，不影響回覆。

## v1.5：自動 reaction（已完成）

- 觸發：**沒有 @ bot、也沒有回覆 bot** 的頻道訊息（被叫的訊息會回話，不另外 reaction）。
- 用 bridge 端的 `retrieveEmojis` 取 `keywordScore`；分數 ≥ `minKeywordScore` 才進抽籤，
  再過 `probability`、頻道冷卻、全域每小時上限。**不呼叫模型**。
- 只加 reaction（`message.react(<:name:id>)`），不回訊息；失敗只記 log。
- 需要 **Add Reactions**（`1<<6 = 64`）權限。

## v3：貼圖 / 手動 reaction / MCP 動作（已完成）

走 MCP 工具，不用 marker：模型已經靠工具說話，marker 要另外解析，還會跟正文混在一起。
工具與參數見 [DISCORD.md](../guides/DISCORD.md) 的「誰決定要不要發訊息（MCP）」。

- **`search_emojis(query)`**：查自訂表情（貼圖用 `search_stickers`）。v4 起是補充手段：
  【常用表情】沒有的、或想找更貼的才查；query 留空只列當前伺服器。
- **`send_sticker(sticker)`**：只送當前伺服器的 sticker（`channel.send({ stickers: [id] })`）。
  貼圖目錄直接用 Discord 的 `name` / `description` / `tags`，沒有另做 vision 索引。
  跨服改送圖片沒做。
- **`add_reaction(message, emoji)`**：`message` 是 prompt 裡的 `#編號`，不限於觸發訊息。
  一輪最多 3 個。
- 順便加了 `send_message` 的 `reply_to`、`read_history`、`user_info`（同一套 `#編號`）。

## 跨伺服器顯示（更正先前的說法）

- **bot 送出的外部 emoji**：只要 bot 有 `USE_EXTERNAL_EMOJIS`（1<<18 = 262144）且是
  emoji 所屬伺服器的成員，就能送；**觀眾端不需要 Nitro 也看得到**。
  Nitro 限制的是「使用者自己打字」的情境。
  v4 的【常用表情】就是從所有目錄挑的，同一組名字在各個伺服器都能用。
- **貼圖**：guild sticker 綁所屬伺服器，跨服只能改送圖片。
- 邀請權限：用 `/invite` 或控制台產生（bitfield `274878237760`，含 external emoji 與 reactions）。

## 控制台（後續）

- 每個伺服器的目錄數量、`builtAt`、模型。（v1 已顯示）
- 「更新目錄」按鈕（spawn 同一個 CLI；狀態與 log 在控制台）。（v1 已做）
- 建置期間的即時進度與日誌尾巴；子程序輸出一併進控制台日誌與 pm2 log。（v1 已做）
- `emojiCreate/Update/Delete` 事件增量更新（15 秒去抖，hash 快取）。（v1 已做）
- 單條目編輯（description / tags / usage）與停用；使用次數統計。（未做）

## 驗收

- 目錄壞檔不影響聊天（跳過該伺服器）。
- 有查詢字時只回命中的；預算內不超過 `maxChars`。
- 【常用表情】只列有用過的、跨服同名只列一次、受 `maxChars` 限制；沒有 guild 或沒有使用紀錄就不注入。
- `:名稱:` 只在目錄命中時替換；時間/URL 不誤換；未知名稱原樣送出。
- 索引腳本失敗時保留舊目錄，不寫半套。
- v2 上線後：embedding/Qdrant 掛掉會自動退回關鍵字。

## 風險

- vision 索引的描述品質參差；tags 要人可編輯。
- 【常用表情】按總使用次數排，會偏向最熱鬧的伺服器；目前接受，真的不適合再改成 per-guild 權重。
- 跨服同名 emoji 可能是不同的圖；代換時以當前伺服器優先。
- 跨服同名 emoji 以當前伺服器優先；其他服可能被忽略（可接受）。
- 表情太多時，即使 top-N 也可能挑不到；用使用次數與人工精選補強。
