---
name: discord-auto-compaction
description: Bridge autoCompactTokens 與 DSH compaction-basic 的觸發差異、保留範圍和設定限制
---

## 目前設定（2026-11-17）

- Bridge 的 `autoCompactTokens` 只在 `turn/end` 檢查最後一次 `assistant/message.usage.totalTokens`，透過 `commands/execute` 執行 `/compact`。執行期間會擋住下一批；2026-11-17 移除 10 分鐘冷卻，失敗時下一個 `turn/end` 會再試。設定 `0` 關閉，其他值正規化後至少為 40000；依估計，system prompt 加工具定義佔用三萬多 token，低門檻可能導致每輪重壓，但實際基礎 token 數未量測。Console 標籤也註明非零最小值 40000。
- DSH `compaction-basic` 的 `thresholdRatio` 是每次模型呼叫前檢查的 pressure 門檻。實際門檻為 `floor(min(contextWindow × thresholdRatio, contextWindow − reservedCompletionTokens − 65536))`，所以 ratio `1` 只會把門檻推到預留輸出與 headroom 之後，不是所有模型都完全關閉 pressure 壓縮。
- `dc-chat` 與 `dc-chat-open` 已選擇 `thresholdRatio: 1`，日常自動壓縮交給 Bridge。這項設定與閘門修正在 2026-11-17 由 `b2a887a` 部署；部署會重啟 DSH，既有會話需重建後才使用新 preset。
- 不要用 `auto: false` 取代 ratio `1`：它會停用整個自動壓縮註冊，也會關掉 context overflow 復原。溢位復原不看 pressure 門檻；`/compact` 也不看。
- `retainTokens` 只供 pressure 壓縮與換模型壓縮使用。`/compact` 和 overflow 復原把 `0` 傳給 `selectCompactableRange`，因此只保留最後一個 surface node（另維持 tool call/result 配對），其餘改成摘要。這會比原本的 pressure 壓縮保留更少近期原文，可能增加對話細節流失；參見 [[discord-honest-boundary]]。
- DSH `0.2.2-rc.3` 的 `/compact` 不接受參數，且把 `0` 寫死，Bridge 無法指定 `retainTokens`。2026-11-17 決定維持現狀；每批會重帶最近 12 則頻道訊息和群友記憶。保留量要改只能改 DSH 或另掛 plugin，plugin 會依賴其內部實作。
- tool-result pruner 只在 pressure 壓縮和 overflow 復原時執行，不會隨 `/compact` 執行；ratio 設為 `1` 後，通常要到 overflow 復原才會觸發。
- 2026-11-17 的變更也補測 `tokens === threshold` 不壓縮。`node --check src/discord-bridge.js`、`node --check src/core/discord-batch.mjs` 與 `npm run test:discord` 通過（34/34）；部署流程也完成 preset patch 檢查與遠端測試。較早記錄的「尚未 commit／部署」已由 `b2a887a` 取代。

## 診斷案例（2026-11-17）

當時 Bridge 設為 150,000 仍頻繁壓縮，是因為 DSH preset 的 `thresholdRatio: 0.08` 先在約 80,000 tokens 壓縮。session `5471ba3f-8a4e-4db2-9a97-060445fd12c2` 的 context 峰值約 88,000–93,000，出現 7 組 DSH compaction 事件，沒有 Bridge「自動壓縮」日誌。調 Bridge 門檻不會改 DSH preset 的門檻。這個診斷已由 `b2a887a` 將兩個 preset 設為 ratio `1` 所取代。

相關：[[discord-honest-boundary]]。
