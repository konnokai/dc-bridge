---
name: discord-security-baseline
description: SnowLuma EULA 合規與 state/ ACL 收緊的不變量與守衛
---

- L6 合規不變量：本專案只探測、不部署 SnowLuma（EULA §5.4）；`start_snowluma`／`stop_snowluma` 與 `snowluma.allowProcessControl` 已移除，audit guard 防止复活。
- `state/` 與 `config.json` 權限收紧走 `src/state-acl.mjs`（`hardenDir`／`hardenFile`）；Windows 上 `mode 0o600` 是空操作，必須動 ACL。
- `scripts/harden-state-acl.mjs` 任何路徑都以 0 退出、绝不阻断启动；提权重试被 `--elevated` 短路防遞迴；`start.bat` 在啟動橋接前呼叫，且 `start.bat` 保持純 ASCII + CRLF。
- 2026-11-17 Discord 新建 `state/` 使用 POSIX mode `0700`；session 與 session-preset 暫存檔使用 `0600` 再替換目標檔。這不取代 Windows ACL 收緊。
- 刪除公開 repo 的檔案不會清除 Git 歷史；歷史中的真實識別資料仍應視為已曝光。

`run_script` 沙箱（2026-11-07 後）：

- 任何能把文字放進會話的人都能觸發，不只 @bot：一般訊息（含自由參與、回訪、系統回合）、`deny.self` 的 @bot、被引用的 `deny.users` 原話（`view_message`／`read_history` 也讀得到）、網頁／圖片文字。
- 討論串用自己的頻道 id；母頻道在清單裡不代表討論串也在。
- 容器是唯一的隔離層；Docker daemon 等於 root，橋接用 `jun` 身分呼叫 docker，參數一律用 `spawn` 陣列傳、語言只接受 enum、容器名由橋接產生。
- 殘存風險：故意占滿主機（CPU、記憶體、磁碟）不在容器限额內；需要更硬的隔離就換獨立 OS 帳號或 rootless Docker。
- 2026-11-17 部署檢查發現輸出含控制台 URL token 與 Discord bot token；憑證值不記錄。對話未確認已輪替，應把兩者視為已暴露並輪替；控制台 token 是 LAN 控制台唯一的門。

相關：[[discord-dev-feedback-console]]、[[discord-run-script-sandbox]]。
