---
name: discord-observability
description: dc-bridge 的 Alloy 日誌收集、Grafana 儀表板、查詢與安全界線
---

截至 2026-11-19，測試伺服器用獨立 Docker Compose 管理 Alloy；`dc-bridge` 與 DSH 仍由 host 上的 PM2 執行。部署決策與 Compose 的限制見 `docs/design/ADR_DEPLOYMENT.md`。

- Compose 檔與 Alloy 設定在 `deploy/alloy/compose.yaml`、`deploy/alloy/config.alloy`；啟動或更新用 `docker compose -f deploy/alloy/compose.yaml up -d`。使用固定 image `grafana/alloy:v1.22.0`、`network_mode: host`、UID/GID `1000:1000`，持久資料掛到 `/data` 並設 `--storage.path=/data`；PM2 log 目錄唯讀掛到 `/pm2logs`。Compose 另限制 Alloy 的 Docker json-file log 為 10 MB × 3。
- 只 tail 穩定檔名 `/pm2logs/dc-bridge-out.log` 與 `dc-bridge-error.log`，label 為 `job=dc-bridge`、`service=dc-bridge`、`stream=stdout|stderr`、`host=mainserver`。沒有 glob 歷史輪替檔。`tail_from_end=false` 首次啟動會回填現有 log，當時造成短暫流量尖峰；輪替後要留意 positions 是否重讀。
- 兩種會包含正文的 log 以 `stage.drop` 丟棄：`MCP 記頻道筆記`、`MCP 存梗圖`。這不是通用清洗：其他 log 仍可能有頻道／使用者 ID 和模型生成的略過原因。當時 Loki 未啟用認證，應只留在可信任的內網。
- LogQL 的未送出統計可在查詢時用 `pattern` 解析 `key`、`reason`，不要把任意理由當索引 label。儀表板查詢用 `[$__range]` 才會跟全域時間範圍走。
- Prometheus 已能讀 Qdrant 的 `collection_vectors`、`rest_responses_total`、`rest_responses_avg_duration_seconds`；dc-bridge 本身當時尚未被 Prometheus scrape。Qdrant query rate 在 2026-11-19 的抽樣為 0，只代表當時區間，不能推成長期沒人用。
- Grafana dashboard 的 portable 匯入檔是 `deploy/grafana/dc-bridge-ops.json`，固定 UID `dc-bridge-ops`，共 11 個面板；`${DS_LOKI}`、`${DS_PROM}` 透過 `__inputs` 選取資料來源，不綁定特定 instance 的 datasource UID。匯入步驟見 `deploy/grafana/README.md`。

相關：[[discord-history-archive]]、[[discord-deploy]]。
