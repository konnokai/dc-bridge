---
name: discord-ttft-fallback
description: TTFT hedge 的量測、DSH 外掛設計、設定同步、憑證 API 與啟用後額度卡
---

## 量測基準（2026-11-16）

- 從測試伺服器 2,356 個 Discord DSH session log 重建 61,356 次 LLM 請求。依 `step/start` 到 `assistant/message.data.stream` 首個 token 計時；文字、reasoning 與 tool-call delta 都算 token。
- 全部樣本 p50 3.6 秒、p90 6.5 秒、p95 8.5 秒、p99 16.7 秒；最大值約 331 秒。近 7 天 dc-chat 每輪第一個請求（n=9,903）p90 6.7 秒、p95 8.2 秒、p99 13.1 秒。
- 同一模型的歷史樣本中，`opencode-go` 與 `commandcode` 的 p90 都約 6.5 秒；這不是同時段 A/B 測試，不能據此判斷哪個平常較快。備援主要用來截斷極端慢回合。
- dc-chat 首請求超過 10／15／20／30 秒的比例分別為 3.28%／1.22%／0.60%／0.13%。12 秒的超時比例未單獨計算。分析結果已與 DSH `sessionStats` 的 8 個 session 比對，TTFT 樣本數與平均值一致。

## 現行設計（2026-11-16）

- 尾延遲備援由 DSH provider adapter `plugins/dsh-llm-hedge` 執行，不在橋接層取消回合後重送 prompt。adapter 在工具交給 agent loop 前競速兩個 provider stream，可避免橋接另開 session 時重複執行工具。
- 使用時 `dsh.provider` 設成 `hedge`，`dsh.model` 指向主線 model。`config.json` 的 `dsh.hedge` 是設定來源；橋接啟動與 DSH 重連時推送到 DSH `llm-hedge` settings。DSH 命名空間只是執行期狀態。`npm run setup:discord` 安裝並掛載外掛。
- 預設 `enabled: false`、`afterMs: 12000`。主線先開始；超過門檻才開始備援；第一個有效 token 勝出，另一條 stream 會 abort。正常結束（包括空回覆）直接算勝出；主線已出錯時由備援接手。呼叫端已取消時不啟動備援。
- 輸家可能忽略 abort；不要 await 輸家的 iterator `return()`，否則它仍在等待的 `next()` 會拖住整個回合。勝出的 stream 可正常收尾。
- 備援只影響目前回合；主線設定不會改 DSH 的 `agent-default-model`。hedge 額度顯示使用主線 provider 的額度來源。
- `discord.ttftTimeoutMs` 仍是總硬上限；啟用 hedge 時 `afterMs` 必須至少比它短 5 秒。控制台改硬上限時也要重新驗證 hedge 設定。
- 無效的 `dsh.hedge` 設定會在啟動時停用 hedge 並記 log，但保留原設定欄位，讓控制台可修正；不要讓橋接因備援設定而無法啟動。
- 空的 `reasoningEffort` 表示不指定，讀取 `config.json` 時必須保留空字串；只有欄位缺失才使用 `max`。備援空 effort 也不能繼承主線 effort。
- 模型目錄來自 DSH `session/modelCatalog`。選擇時必須保存 provider + model，因為相同模型在不同 provider 的 id 可能不同。

## DSH 0.2.1-rc.2 限制與憑證 API

- `settings.get(ns)` 不存在；`settings.describe().value` 在 `settings.update` 後可能仍是舊值。外掛以 `describe()` 的 `value` 加 `user` 層覆蓋，並快取 2 秒。橋接推送前會驗證設定；直接手改 DSH 設定可能繞過驗證。
- `credentials/describe({ refs })` 只回 `configured`、`source`、`writable`，不回傳憑證值；控制台只顯示是否已設定。
- `credentials/set({ ref, value })` 設定憑證，`credentials/unset({ ref })` 清除。新值只送往 DSH，不應回傳瀏覽器或記入記憶。
- 此需求涉及 `OPENCODE_GO_API_KEY` 與 `COMMANDCODE_API_KEY`；只記名稱，不記實際值。
- 以橋接既有 `api.callUnary(...)` 呼叫上述 API。控制台配置仍須遵守伺服器端欄位白名單，見 [[discord-console-config]]。

## 驗證狀態（更新至 2026-11-17）

- 2026-11-16 曾以 `afterMs=50` 實測備援勝出並完成回覆，測後恢復 `enabled=false`、`afterMs=12000`。
- 2026-11-17 部署 DSH `0.2.2-rc.3` 與 hedge 支援後，伺服器設定切為 `provider=hedge`、`enabled=true`、`afterMs=12000`；當時主線是 Command Code，備援是 OpenCode Go。強制主線失敗後的 failover 尚未實測。
- Hedge 啟用時，`GET /api/quota` 回主線額度及 `fallback` 額度；控制台顯示兩張卡，`/status` 仍只顯示主線。2026-11-17 已用 API 回應與 OpenChamber 畫面確認兩張卡均正常。
- 2026-11-17 修正與部署為 `928dc69`；該次部署執行了 `npm run setup:discord`。DSH 外掛 ready 不代表 hedge 已啟用。部署流程見 [[discord-deploy]]。

相關：[[discord-ttft-timeout]]、[[discord-console-config]]、[[dc-bridge-tests]]。
