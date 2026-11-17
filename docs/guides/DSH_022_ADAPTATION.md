# DSH 0.2.2 適配記錄（dc-bridge）

> 適配目標：`@deepseek-ai/dsh` **0.2.2-rc.3**（上一版 0.2.1-rc.2）。
> 實測日期：2026-11-17；機器：Discord 測試伺服器 `192.168.98.21`。

## 1. 結論

橋接依賴的線上協定沒有變：離線鑄 Cookie、`settings/describe`、`session/create`、
`session/selectModel`、`session/prompt`、`session/follow`、`$events`、
`session/projections`、`commands/execute` 都照舊。真正變了兩件事：

1. `session/follow` 不帶 `activate: true` 時，不再喚醒冷 agent（0.2.1-rc.3）。
2. 即時 projection 幀改成 `{ changes: [{ key, val }] }`（0.2.2-alpha.2）。

橋接不消費即時 projection 幀，只讀開場 snapshot 與一元 `session/projections`，
所以執行期不用改；只有 `scripts/probe-020-protocol.mjs` 的輸出要跟著改。

工具面多了 8 個危險名字，守衛名單已補。0.2.1 才有的 `spawn_teammate`、
`schedule_update`、`schedule_delete` 留在名單裡給回退用；0.1.7／0.2.0 的
`dsh_snapshot` / `dsh_rollback` / `incident_resolved` 已從兩份名單移除。

## 2. 實測

| 項目 | 結果 |
| --- | --- |
| 離線鑄 Cookie | ✅ 230 bytes |
| `settings/describe` | ✅ |
| `agentPresets/list` | ✅ `dc-chat` / `dc-learner` / `dc-trader` |
| `session/create` + `dc-chat` + `session/prompt` | ✅ 回「收到」，`turn/end` 是 `completed` |
| `session/projections` | ✅ values 含 `inbox` / `tokenUsage` / `contextPressure` |
| projection 幀 | ✅ `changes` 有值，`key=undefined`（舊腳本會誤判） |
| `test:dsh-inbox` | ✅ 12/12 |
| `node scripts/scan-dsh-tool-names.mjs --guard plugins/dc-agent-presets/dc-tool-restrict.mjs` | ✅ 0 假名、0 漏網 |
| `verify:adaptation` | 55 通過 / 11 失敗；失敗都是 QQ profile 專屬（`qq-chat-v2`、`qq-mode-console`、`deepseek-flash`），不是回歸 |
| `hedge` provider | ✅ `session/modelCatalog` 有 `hedge`；還沒在 0.2.2 上跑強制 failover |

## 3. 程式碼改動

- `plugins/dc-agent-presets/dc-tool-restrict.mjs`：補 `apply_patch`、`office_*`、
  `schedule_edit` / `schedule_view`、`user_terminal_*`；保留 0.2.1 的
  `spawn_teammate`、`schedule_update` / `schedule_delete` 供回退；導出
  `RESTRICTED_TOOL_NAMES` 與 `LEGACY_0_2_1_TOOL_NAMES`。
- `plugins/qq-agent-presets/qq-tool-restrict.mjs`：補同一批新名字；新增
  `LEGACY_0_2_1_TOOL_NAMES`；移除 0.1.7／0.2.0 的 `dsh_snapshot` / `dsh_rollback` /
  `incident_resolved`。
- `scripts/scan-dsh-tool-names.mjs`：新增 `--guard <path>`，可掃 Discord 名單；
  legacy 名字排除在「拼錯假名」之外；`--guard` 沒給路徑或模組沒匯出清單時直接報錯。
- `scripts/verify-dsh-021-adaptation.mjs`：加上 0.2.2 的 8 個名字與 legacy 排除。
- `scripts/probe-020-protocol.mjs`：preset 可用參數或 `DSH_PRESET` 指定；
  projection 幀改讀 `changes`。
- `scripts/test-dsh-session-retire.mjs`：preset / provider / model / effort 可用環境變數
  指定，Discord 伺服器跑 `dc-chat` + `commandcode`。

## 4. 升級與回退

升級：

```bash
cd /home/jun/dsh
cp -a run.sh run.sh.bak-$(date +%Y%m%d-%H%M%S)
sed -i 's/@deepseek-ai\/dsh@0.2.1-rc.2/@deepseek-ai\/dsh@0.2.2-rc.3/' run.sh
export PATH="$HOME/.nvm/versions/node/v26.12.1/bin:$PATH"
pm2 stop dc-bridge
pm2 delete dsh
bash run.sh
# 等 20 秒，確認 pm2 online 與 log 沒有 plugin 載入錯誤
pm2 start dc-bridge
```

回退：把 `run.sh` 換回備份，重跑 `pm2 delete dsh` 與 `bash run.sh`。
升級前的完整備份在 `/home/jun/dsh-backup-<timestamp>.tar.gz`。

## 5. 下次升級要補的

1. `npm run verify:adaptation` 在這台是 QQ 專用。Discord 要看
   `node scripts/probe-events.mjs dc-chat` 與 `node scripts/probe-020-protocol.mjs dc-chat`。
2. `DSH_INSTALL_MODULES` 要指到**執行中**的 npx 目錄：先
   `find ~/.npm/_npx -path '*/node_modules/@deepseek-ai/dsh/package.json'`，
   再用 `ps -ef | grep 'dsh@'` 對版本。
3. `node scripts/scan-dsh-tool-names.mjs --guard plugins/dc-agent-presets/dc-tool-restrict.mjs`
   每次升級必跑。
4. `session/follow` 目前不需要 `activate: true`；送訊息走 `session/prompt`，它會自己啟動。
   只有之後要「打開歷史流就喚醒冷 agent」時才加。
