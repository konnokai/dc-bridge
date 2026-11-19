# ADR：dc-bridge 與 DSH 留在 pm2，不改成 compose

> 狀態：**已決定**（2026-11-19）。
> 相關：[PLAN_MIYORIA_ADOPTION.md](PLAN_MIYORIA_ADOPTION.md)、[deploy/alloy/](../../deploy/alloy/)。

## 決定

`dc-bridge` 與 `dsh` 繼續用 **pm2** 在 host 上跑。Docker Compose 只用在獨立的周邊服務：
Alloy，以及既有的 Prometheus／Loki／Grafana。bridge 本身不進 compose。

## 理由

1. **權限沒有壞，compose 不會自動修**
   bridge 現在以 `jun`（UID 1000）執行，`config.json` 與 `state/` 的檔案是 `0600 jun jun`。
   compose 不會改變 kernel 權限；`user:` 設錯反而會讓 bind mount 長出 root-owned 檔案。
   要隔離就建專用使用者、顧好 ACL，或做 Docker socket proxy，不是換 compose。

2. **`run_script` 沙箱會壞**
   `src/core/discord-sandbox.mjs:166` 用 `os.tmpdir()` 建工作目錄，`:195` 呼叫 host 的 `docker`，
   `:119` 把那個目錄 bind 進沙箱容器。bridge 自己進容器後，host Docker daemon 看不到容器內的
   `/tmp/dc-sbx-*`。要修就得把 host 目錄掛進 bridge 當 `/tmp`，還要掛 `/var/run/docker.sock`
   （root 等價權限），安全上沒有變好。

3. **DSH／MCP 的 loopback 會斷**
   `src/core/discord-agent.mjs:556` 的 agent API 綁 `127.0.0.1` 隨機埠，MCP server 由 DSH 在 host
   拉起，會照 `state/discord-agent.json` 打 loopback。bridge 在 bridge network 的容器裡時，
   `127.0.0.1` 是容器自己。只能用 `network_mode: host` 或跟 DSH 共用 network namespace；
   前者等於「容器裡跑一個 host 行程」，compose 的好處只剩檔案宣告。

4. **部署腳本以 pm2 為中心**
   `scripts/deploy-discord.mjs:237-288` 直接讀 `~/.pm2/logs`、跑 `pm2 restart`、看 `pm2 jlist`、
   寫 `state/.deployed-sha`。改 compose 要重寫 build、上線、回滾與健康檢查，是另一個專案。

5. **狀態都在 host**
   `state/`、`config.json`、`audio/` 都是 host 上的檔案；compose 的 named volume 會讓備份、
   ACL 與現有的 `state-acl.mjs`／`harden-acl.mjs` 變複雜。bind mount 則讓容器只是 Node 的殼。

## 後果

- 好處：不動現有部署、測試與回滾；權限維持 `jun`；沙箱與 DSH 不變。
- 代價：Node、ffmpeg 還是裝在 host；換機器要重裝。
- 周邊：Alloy 用 [deploy/alloy/compose.yaml](../../deploy/alloy/compose.yaml) 獨立管理，
  不進 `/root/docker-monitoring`，由 `jun` 執行 `docker compose up -d`。

## 已考慮的替代方案

| 方案 | 結果 |
| --- | --- |
| 全部改 compose | 否決，理由同上 |
| bridge 用 `network_mode: host` 的 compose | 可行，但容器只是殼；還要處理沙箱 host temp dir、Docker socket、部署腳本 |
| 只容器化 DSH | 否決；DSH 會拉 MCP server，還有 workspace／session 檔案，loopback 與工具問題一樣在 |

## 什麼時候重新考慮

- 搬到一台不想裝 Node／pm2／ffmpeg 的機器。
- 要同時跑多個 bridge 實例。
- 願意處理：`network_mode: host`、沙箱的 host temp dir、Docker socket、部署腳本重寫。
- 或者先做「專用使用者 + Docker socket proxy」；那比 compose 更直接。
