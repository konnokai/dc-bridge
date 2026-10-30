# 上游對比基準

上游是 `upstream`（qq-bridge）。這份文件記錄「已經對到哪個 commit、哪些判斷過了」。
下次要比對，先看這裡，只跑基準之後的新 commit，不要整包重跑。

## 目前基準

- 日期：2026-10-30
- 上游：`upstream/main` @ `6455d60`（44 個 commit）
- 本機：`main` @ `b15b5ba`
- 下次只看這之後的新東西：

```bash
git fetch upstream --prune
git log --oneline 6455d60..upstream/main
```

## 怎麼判斷一個 commit 要不要搬

1. 先讀 commit message 與 body，不要一開始就 diff。
2. 確認缺陷在 Discord 路徑上也存在。`src/bridge.js` 是 QQ 版，Discord 入口
   （`src/discord-bridge.js`）沒有用它；`src/mcp-discord.js` 與 `src/core/discord-*.mjs`
   才是實際路徑。
3. 共用模組要一起看：`src/sensitive.js`、`src/safe-fetch.js`、`src/mcp-web-search-safe.js`、
   `src/role-card.js`、`src/preset-prompt.js`、`src/v2-wait.js`。
4. 確認 Discord 是不是已經有等價機制（令牌對模型不可見、按 key 分鏈、按頻道隔離）。
5. 判斷不用搬的，把理由補進下面，下次不要重問。

## 已經搬過來的

| 上游 | 內容 | 我們的落點 |
| --- | --- | --- |
| `#82` | web_search / web_fetch 結果套不可信資料外殼 | `src/mcp-web-search-safe.js` |
| `#78` | 使用者可控文字進 prompt 前做結構淨化 | `src/core/discord-batch.mjs` 的 `defang` |
| `#88` | 敏感閘門做偽裝歸一化（NFKC、零寬、base64） | `src/sensitive.js` |
| `#85` | 端口白名單概念；Discord 只用在 web_fetch | `src/safe-fetch.js`、`src/mcp-web-search-safe.js`（https/443） |
| `#86` | 提問只認這一輪的觸發者（沒人 @ 時是整批發言者），不是管理員；審批仍只認管理員 | `src/discord-bridge.js`、`src/core/discord-core.mjs` |
| `4a8bfde` | 只搬 zod / MCP SDK 下限；剩 7 條告警在 MCP SDK 的 express/hono 堆疊，stdio 走不到 | `package.json` / lock；伺服器要手動 `npm ci` |

## 判斷不用搬的

| 上游 | 不搬的理由 |
| --- | --- |
| `#79` 令牌片段比對 | 模型看不到令牌（外掛自動帶入）；Discord 會話令牌只有 10 字元，比上游 12 字元窗口還短 |
| `#83` 發送佇列分鏈 | 已經按 key 分鏈 |
| `#24` wait 429 `retryAfterMs` | Discord 沒有 wait 工具 |
| `#93` 回合寬限 / `batchWindowMs` | 沒有 `batchWindowMs`；恢復的回合只擋 `/ask`，一般批次不受影響 |
| `#84` 訊息冪等 + 撤回 | 不存本機訊息，上下文與歷史都是當下去抓 |
| `#118` / `#100` 角色卡節奏與全文 | Discord 沒 import `role-card.js`，人格全文在 preset |
| `#103` console 提示詞同步 | Discord 控制台只有 reload，不會寫 preset |
| `#63` DSH 隨機端口自動發現 | 部署固定 2815，桌面版才需要 |
| `#87` 貼圖 / 黑話跨會話隔離 | 刻意共用：已確認的黑話與記憶跨伺服器；候選黑話、頻道筆記才按伺服器/頻道分開 |

## 固定決策

- `web_fetch` 結果上限維持 50000 字（不套上游的 6000）。
- `web_search` 結果上限 6000 字，截斷時明講。
- `web_fetch` 只允許 https/443。
- 記憶與黑話維持跨伺服器共用。
