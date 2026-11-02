# 上游對比基準

上游是 `upstream`（qq-bridge）。這份文件記錄「已經對到哪個 commit、哪些判斷過了」。
下次要比對，先看這裡，只跑基準之後的新 commit，不要整包重跑。

## 目前基準

- 日期：2026-11-02
- 上游：`upstream/main` @ `b80fa51`（自上次基準 27 個 commit）
- 本機：`main` @ `e5f7334`（空合併 `upstream/main` 後，見下面「清掉 GitHub 的 behind」）
- 下次只看這之後的新東西：

```bash
git fetch upstream --prune
git log --oneline b80fa51..upstream/main
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
| `5551e74` | 搜尋結果裡的 API key 一律遮掉；搜尋端點錯誤不帶未信任的回應內容 | `src/web-search.js` |
| `5551e74` | 擋掉 Azure WireServer `168.63.129.16` | `src/safe-fetch.js` |
| `eca88d5` | fake-ip `198.18/15` 被擋時說明是 Clash/mihomo，並給修法 | `src/safe-fetch.js` |
| `5551e74` | DSH RPC 禁止跟隨重定向 | `src/dsh-client.js` |
| `eca88d5` | 簽名金鑰讀取失敗不再永久快取，下次請求會重試 | `src/dsh-client.js` |
| `eca88d5` | ACL 收緊改成先授權再斷繼承，每步回讀自檢；空 DACL 不算已收緊 | `src/state-acl.mjs` |

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
| `#138`（`0ac4233`、`239e6b9`、`0b2b373`）斷線補發、只停驗證過的實例、`restart.bat` | 都是 `src/bridge.js` 與 QQ 重啟腳本；Discord 用 pm2 部署，重啟與交付游標走自己的路 |
| `d7fae44`、`24e29ba`、`6ccee53`、`38ad429` CodeQL 邊界與 prompt 錯誤外發 | 改動在 `src/bridge.js`；Discord 入口沒有走這支 |
| `5551e74`、`24e29ba` 黑話 / 貼圖的 `scope` 隔離 | Discord 用自己的 `src/core/discord-slang.mjs`（`guildId` / `channelId`）；QQ 的 `slang-learner.js`、`sticker-lib.js` 不在 Discord 路徑 |
| `5551e74` `voice-core.js` 的 `safeJoinLibrary` | 只服務 QQ 語音庫；Discord 的 `media-normalize.js` 只 import `resolveFfmpeg` / `probeAudio` |
| `eca88d5` SnowLuma / host MCP 的 strict 參數 | Discord 只註冊 `mcp-web-search-safe`、`mcp-discord`、`mcp-slang`，不載入 SnowLuma 兩個 server |
| `eca88d5` `mcp-web-search-safe` 的 `registerTool` + `.strict()` | 本 repo 這支已有自己的 `web_fetch` 入口（https/443、`fetchVerdict`、Google Docs 改寫）；未知參數被丟掉不是信任邊界，不值得為此重構 |
| `5551e74` `discoverDshSessionCookie` 只認回環 | 本 repo 刻意允許本機網卡 IP（DSH 用 `--host <LAN IP>`）；Discord 部署也走同一台機器的 2815 |
| `b8199c2` MCP 版本字串與人格注入上限 | 只動 QQ 的 SnowLuma / host server 與 `config.example.json`；Discord preset 自己維護 |
| `8e4ceba` `session-router.mjs` | 本 repo 已刪除該檔（QQ 入口） |
| `2aca5a3` privacy scan 漏報 / `--history` | 本 repo 沒有 CI 跑它、也沒有 `privacy-rules.json`；純手動工具，先不搬 |
| `17c5313` PR 自動改指 dev | 本 repo 不用 dev 分支，也沒有 GitHub Actions |
| `4c9f0b6` 測試與本機設定解耦 | 只改 QQ 的 `test-forward` / `test-stickers` / `test-v2-wait` |
| `3eb7ee1`、`0e1e07b`、`6ba15b7`、`d083d75`、`e9faaa4` 文件 / 授權 / README | 上游文件與子套件授權；本 repo 文件自己維護 |
| `613db68`、`b77e4a2`、`0292f0c`、`f288897`、`1c428ad` 版本與合併 | 版本號與合併 commit，沒有可搬的執行邏輯 |

## 固定決策

- `web_fetch` 結果上限維持 50000 字（不套上游的 6000）。
- `web_search` 結果上限 6000 字，截斷時明講。
- `web_fetch` 只允許 https/443（不套上游放寬的 http + 80/8080/8443）。
- 記憶與黑話維持跨伺服器共用。

## 清掉 GitHub 的 behind

GitHub fork 頁上的 `behind` 算的是 commit 血緣，不是檔案內容。cherry-pick 再多，上游那串 commit 不在我們的歷史裡，數字就不會動。

要讓它歸零又不把 QQ 端的 commit 拉進來，用空合併：

```bash
git fetch upstream --prune
git merge -s ours upstream/main -m "chore(upstream): 空合併上游讓 fork behind 歸零"
git push origin main
git rev-list --count HEAD..upstream/main   # 應該是 0
```

`-s ours` 只寫入 merge commit，檔案完全不變。代價是 git 之後會把 `upstream/main` 當成已合併，`git merge upstream/main` 變成 no-op；我們本來就只 cherry-pick，比對還是照上面的 `git log <基準>..upstream/main` 走。

**不要按 GitHub 的 Sync fork。** 那是真的 merge，會把 QQ 端的 commit 與檔案一起拉回來。
