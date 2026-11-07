---
name: discord-security-baseline
description: SnowLuma EULA 合規與 state/ ACL 收緊的不變量與守衛
---

- L6 合規不變量：本專案只探測、不部署 SnowLuma（EULA §5.4）；`start_snowluma`／`stop_snowluma` 與 `snowluma.allowProcessControl` 已移除，audit guard 防止复活。
- `state/` 與 `config.json` 權限收紧走 `src/state-acl.mjs`（`hardenDir`／`hardenFile`）；Windows 上 `mode 0o600` 是空操作，必須動 ACL。
- `scripts/harden-state-acl.mjs` 任何路徑都以 0 退出、绝不阻断启动；提权重试被 `--elevated` 短路防遞迴；`start.bat` 在啟動橋接前呼叫，且 `start.bat` 保持純 ASCII + CRLF。

相關：[[discord-dev-feedback-console]]。