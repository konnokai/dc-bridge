# 計畫：Token / 花費看板（Discord 版）

> 目標：把 DSH 的 token 用量與花費做成控制台看板，能下鑽到每個會話、每一輪。
> 重用 `src/token-ledger.js` 與 `src/model-prices.js`（QQ 版已在用），不重寫記帳。
> 參考：`docs/guides/TOKEN_USAGE_CONSOLE.md`、QQ 控制台「令牌與花費」頁。
>
> **狀態：v1 已實作（2026-10-26）。** 與原計畫的差異：
>
> - 帳本是 JSONL：`state/discord-usage.jsonl`（不是 `.json`）；轉接層在 `src/core/discord-usage.mjs`。
> - `/api/usage` 回「全期總計＋所選時間窗走勢」：投影基線沒有逐時明細，硬切時間窗會失真。
> - `POST /api/usage/rebuild` 未做（原計畫標為可選）。
> - 額外做了 `POST /api/usage/reset`（清空帳本）。
> - 壞行不會讓帳本變唯讀：`token-ledger` 跳過讀不回來的行並計數，控制台會顯示
>   「帳本有 N 行讀不回來」，其餘照常計算（不靜默清零）。

## 資料來源

1. **即時事件**：`session/event` 的 `assistant/message` 帶 `usage`
   （input / output / cache hit / cache miss / model）。
2. **權威累計**：`session/follow` 的 `session/snapshot` 裡 `projections.values.tokenUsage`
   （整條會話日誌，含橋接啟動前的歷史）。
3. **模型**：`model/selection` 事件或 `selectModel` 的回傳值，決定單價。

## 實作步驟（✅ 已完成）

1. **接帳本**
   - `src/core/discord-usage.mjs` 的 `createUsageTracker()` 包住 `createTokenLedger`，
     file = `state/discord-usage.jsonl`。
   - `resolveKey(sessionId)`：`reverse.get(sessionId)`；學習會話 → `internal:黑話學習`；
     其餘 → `unattributed`。
   - `handleSessionEvent` 最前面呼叫 `ingestEvent()`。
   - `session/snapshot` → `ingestSnapshot()`（baseline + records）。
   - 重連會重送 snapshot；帳本本身以 `(turn, step, retry) + seq` 冪等折疊，不會翻倍。

2. **價目**（✅）
   - `resolvePriceTable(config.pricing)`（`model-prices.js`）。
   - 預設內建 DeepSeek 官方價；尖峰/離線（含中國法定節假日）已處理。
   - 加了 DSH 實際模型 id 的別名 `deepseek-v4.1-flash`（原本只有 `deepseek-flash` 等舊名）。
   - 模型 id 對不上價目時，控制台標 `estimated` 並提示；不另外記 log（避免每筆取樣都寫）。

3. **控制台 API**（✅）
   - `GET /api/usage?range=24h|3d|7d|30d`：
     ```json
     {
       "totals": { "turns": 12, "inputTokens": 12345, "cacheHitRate": 0.65,
                   "output": 678, "cost": 0.42, "byTier": { "peak": 0, "off": 0.42 } },
       "conversations": [{ "key": "ch:…", "turns": 3, "cost": 0.1, "lastAt": 0 }],
       "series": { "buckets": [{ "t": 0, "cost": 0.02, "tokens": 1234, "tier": "off" }] },
       "prices": { "version": "…", "now": { "model": "deepseek-v4.1-flash", "tierLabel": "空閒時段" } }
     }
     ```
   - `GET /api/usage/turns?key=ch:<id>&limit=200`：單一會話的逐輪明細。
   - `POST /api/usage/reset`：清空帳本。
   - `POST /api/usage/rebuild`：未做（可選）。

4. **UI**（✅）
   - 控制台「花費」卡片：
     - 總計：輪數、輸入/輸出/快取、金額、平均每輪。
     - 每個會話一列（可排序的欄位先不做，照花費排序）；點列展開逐輪明細。
     - 24h / 3d / 7d / 30d 切換；純 SVG 長條（不引外部套件）。
     - 顯示目前模型與尖峰/空閒價。
   - 空狀態說「還沒有可歸屬的回合」，不顯示 NaN。

5. **歸屬**（✅）
   - `reverse` 在會話建立/重置時維護；重置後舊會話的歷史仍留在帳本、歸在同一個頻道 key
     （舊 session 不再 follow，所以不會再增加）。
   - 學習會話歸 `internal:黑話學習`；其他未映射 session 歸 `unattributed`，不混進頻道。

## 設定

```json
"pricing": {
  "models": {
    "my-relay-model": { "label": "中轉", "off": { "cacheHit": 0.5, "cacheMiss": 3, "output": 9 } }
  }
}
```

## 驗收

- 重啟後總量與 DSH 的 `tokenUsage` 投影一致（誤差 0，snapshot baseline 冪等）。
- 同一輪重連重送不會翻倍。
- 尖峰/離線價格正確（用已知時間戳測）。
- 控制台需要 token；金額有兩位小數，token 用千分位。
- 帳本檔案壞掉 → 只讀不寫 + 大聲 log（不要靜默清零）。

## 風險

- ~~`token-ledger.js` 的 event 形狀是照 QQ 版寫的；先在遠端用一個真實 `assistant/message` 核對欄位。~~
  已用遠端 `session/projections` 核對：`tokenUsage` 是 `uncachedInputTokens` / `cacheReadTokens` /
  `cacheWriteTokens` / `outputTokens`，與 `normalizeUsage()` 一致；模型在
  `values.modelSelection.lastUsed`。
- 不同 provider 的 usage 欄位可能不同（cache 命名）；缺欄位時寧可少算也不要重複算。
- 長時間運行帳本會長大；`token-ledger` 已有 20000 行上限（淘汰最舊逐輪明細，累計總量不變）。
