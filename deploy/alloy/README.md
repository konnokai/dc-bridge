# Alloy：dc-bridge log → Loki

這是獨立的 compose，不屬於 `/root/docker-monitoring`。它只做一件事：把這台機器的
`~/.pm2/logs/dc-bridge-out.log` 與 `dc-bridge-error.log` 送到本機 Loki。

## 跑

```bash
cd /home/jun/dc-bridge/deploy/alloy
docker compose up -d
docker compose logs -f alloy
```

第一次從舊的 `docker run` 容器換過來時，先 `docker rm -f alloy`。

## 驗證

- Loki：`{job="dc-bridge"}`
- Grafana：<https://grafana.konnokai.me/d/dc-bridge-ops>
- Dashboard 匯入檔：[../grafana/dc-bridge-ops.json](../grafana/dc-bridge-ops.json)

## 注意

- `network_mode: host`：Loki 在 `127.0.0.1:3100`。
- `user: "1000:1000"` 是 `jun`；換機器要改。
- `/home/jun/alloy/data` 存 tail 位置，重啟後續讀。
- `MCP 記頻道筆記`、`MCP 存梗圖` 在 `stage.drop` 丟掉，不進 Loki。
- 不要把它加進 `/root/docker-monitoring`；那個 stack 由 root 管，這裡由 `jun` 管。
