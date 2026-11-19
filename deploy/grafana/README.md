# Grafana dashboard：dc-bridge 營運

`dc-bridge-ops.json` 是 `dc-bridge 營運` 的 import 檔。它用 `__inputs` 指向 Loki 與
Prometheus，匯入時要選這兩個 datasource，不綁定特定 UID。

## 匯入

1. Grafana → Dashboards → New → **Import**。
2. 上傳 `dc-bridge-ops.json`。
3. 兩個 datasource 欄位選 `loki` 與 `prometheus`。
4. Import。

UID 固定是 `dc-bridge-ops`；重複匯入會更新同一份 dashboard。

## 面板

- Log 行數 / 5m
- 已投遞 vs MCP 送出 / 5m
- 未送出回合 / 5m
- 錯誤 log / 5m
- 未送出原因 top 10
- 各頻道未送出 top 10
- 自動壓縮次數 / 1h
- 最近未送出
- Qdrant `dc_history` 點數
- Qdrant query / 5m
- Qdrant query 平均延遲

## 資料來源

- Loki：`{job="dc-bridge"}`，由 [deploy/alloy](../alloy/) 收集 pm2 log。
- Prometheus：`qdrant` job 的 `collection_vectors`、`rest_responses_*`。
