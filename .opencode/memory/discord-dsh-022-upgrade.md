---
name: discord-dsh-022-upgrade
description: DSH 0.2.2-rc.3 升級相容性、工具守衛與驗證限制
---

## DSH 0.2.2-rc.3（2026-11-17）

- 測試伺服器的 `/home/jun/dsh/run.sh` 固定到 `0.2.2-rc.3`。升級時橋接仍是 `c36e34e`；`feat/llm-hedge` 的橋接與守衛改動尚未部署。這是當日狀態，後續部署會取代它。
- DSH 的 RPC 主路徑仍可用：`session/create`、`session/selectModel`、`session/prompt`、`session/follow`、`session/projections`、`commands/execute`、`settings/describe`、`credentials/describe`。升級後用 `dc-chat` 真跑 prompt，收到「收到」且 turn completed。
- `session/follow` 從 DSH 0.2.1-rc.3 起，省略 `activate: true` 不會喚醒冷的普通 Agent。若整合依靠 follow 喚醒 Agent，必須明確設 `activate: true`；收到開場快照不代表 Agent 已啟動。
- 0.2.2-alpha.2 起即時 projection 幀改為 `{ changes: [{ key, val }] }`。目前橋接只讀開場 snapshot 與 `session/projections`，不消費增量 projection 幀；需要更新的是探針或直接解析這些幀的客戶端。
- DSH 0.2.2 新增 8 個需隱藏的危險工具：`apply_patch`、`office_convert`、`office_recalculate`、`office_render`、`schedule_edit`、`schedule_view`、`user_terminal_list`、`user_terminal_read`。回退 0.2.1 時仍要保留 `spawn_teammate`、`schedule_update`、`schedule_delete`；`dsh_snapshot`、`dsh_rollback`、`incident_resolved` 是更舊版本的名字，已從名單移除。
- 0.2.2 的 Web Fetch 不再拒絕非公網位址。`dc-chat` preset 目前明確關閉 `search` 與 `fetch`，執行期白名單仍要維持；若日後開啟，必須另設網路存取限制。
- 伺服器用 npx 快取安裝 DSH。需掃描已安裝工具或跑 `verify:adaptation` 時，將 `DSH_INSTALL_MODULES` 指向該 DSH 的 `node_modules`；`DSH_BASE_URL` 要用 DSH 實際監聽的位址，伺服器只監聽 LAN 位址時，`127.0.0.1` 會得到 `ECONNREFUSED`。
- `verify:adaptation` 仍檢查 QQ preset，不是 Discord 驗證；在 Discord profile 上的 11 個失敗屬 QQ 專屬。獨立用 `node scripts/scan-dsh-tool-names.mjs --guard plugins/dc-agent-presets/dc-tool-restrict.mjs` 檢查 Discord 名單；0.2.2 實測無假名、無未覆蓋危險名。`DANGER_TOOL_RE` 只是發現用啟發式，不能取代完整名單比對。
- 用 `cp -a ~/.dsh` 建測試副本可能因 ACL 漏掉受保護檔案及資料；副本大小不代表完整。升級測試前要檢查複製命令的錯誤與資料完整性。

相關：[[discord-dsh-slash-commands]]、[[discord-security-baseline]]、[[discord-deploy]]、[[discord-ttft-fallback]]。
