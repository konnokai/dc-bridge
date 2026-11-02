---
name: upstream-sync
description: 比對 dc-bridge 這個 fork 與上游 qq-bridge 的新 commit，判斷哪些要搬進 Discord 路徑、更新基準文件，必要時清掉 GitHub 的 behind。使用者說「上游又更新了」「跑一下上游比對」「upstream sync」「看看 qq-bridge 有沒有新東西」「把 behind 拉掉」時使用。
---

# 上游對齊

這個 repo 是 qq-bridge 的 fork，但 Discord 是主要入口，QQ 只當實作參考。
每次只處理基準之後的新 commit，不要整包重跑。

先讀 `docs/guides/UPSTREAM_SYNC.md`。裡面有目前基準、已搬與不搬的清單、固定決策。
不要重新討論表裡已經判定過的項目，除非使用者明確要求。

## 1. 抓新 commit

```bash
git fetch upstream --prune
git log --oneline <基準>..upstream/main
```

先讀 commit message 與 body，不要一開始就 diff。要一次看規模與動到的檔案：

```bash
git log --format='=== %h %s%n%b' --stat <基準>..upstream/main
```

## 2. 分類

依檔案的落點分三類：

- **Discord 路徑**：`src/discord-bridge.js`、`src/core/discord-*.mjs`、`src/mcp-discord.js`、`src/mcp-slang.js`、`src/mcp-web-search-safe.js`、`src/web-search.js`、`src/safe-fetch.js`、`src/dsh-client.js`、`src/state-acl.mjs`、`scripts/test-discord-*.mjs`。
- **QQ 專用**：`src/bridge.js`、`restart.bat`、`start.bat`、`src/mcp-snowluma-safe.js`、`src/mcp-host-server.js`、`src/snowluma-conn.js`、`src/send-voice-lib.js`、`plugins/qq-*`。Discord 入口沒走這些，預設不搬。
- **文件 / CI / 版本號**：通常不搬，除非它描述的行為我們也有。

共用模組要先確認 Discord 是否真的 import，不要只看檔名：

- `src/slang-learner.js`：Discord 只用 `extractJsonArray`；黑話與頻道風格在 `src/core/discord-slang.mjs`。
- `src/sticker-lib.js`：Discord 沒有 import；表情與備注在 `src/core/discord-emoji.mjs`。
- `src/voice-core.js`：Discord 只用 `resolveFfmpeg` / `probeAudio`；`safeJoinLibrary` 是 QQ 語音庫。
- `src/role-card.js`：Discord 沒有 import，人格全文在 preset。
- 其餘 `src/sensitive.js`、`src/preset-prompt.js`、`src/v2-wait.js` 是共用模組，改動要一起看。

## 3. 判斷要不要搬

對每個候選問三件事：

1. 這個缺陷在 Discord 路徑也存在嗎？
2. Discord 是否已有等價機制（令牌不給模型、按 key 分鏈、按頻道或伺服器隔離）？
3. 會不會和 `UPSTREAM_SYNC.md` 的固定決策衝突？衝突時固定決策優先。

不搬的，把 commit 與一句理由補進「判斷不用搬的」表，下次不要重問。

## 4. 實作

- 先改 `UPSTREAM_SYNC.md` 的決策，再改程式，兩邊不能互相矛盾。
- 上游常把 QQ 與共用模組混在同一個 commit，逐 hunk 挑，只搬適用部分。
- 本地檔案通常已經和上游分岔。要用 `git diff HEAD upstream/main -- <file>` 看兩邊，不要直接 `git checkout upstream/main -- <file>` 蓋掉 Discord 的改動。
- 保持這個 repo 的既有上限與權限，不要順手接受上游放寬的設定（例如 `web_fetch` 的 http + 80/8080/8443）。
- 新行為補一個小測試釘住；純一行修正可以省略。
- 註解與 commit message 用繁體中文，先套 `speak-human-tw`。

## 5. 驗證

```bash
npm run test:discord
node scripts/test-audit-security.mjs
node scripts/test-media-search.mjs
node scripts/test-hardening.mjs
```

改到 DSH client 或其他共用模組時，再跑相關的 `scripts/test-audit-*.mjs` 與 `scripts/test-mux-reconnect.mjs`。

`npm run test:audit` 若出現 `test-voice-system`（缺 `docs/guides/VOICE.md`）或 `test-preset-local-tools`（缺 DSH modules）失敗，先確認不是這次改動造成，再照實回報。

## 6. 更新基準

搬到一個段落後，更新 `UPSTREAM_SYNC.md`：

- 日期、`upstream/main` 的新基準 commit、本機 `main` 的 commit
- 「已經搬過來的」加列
- 「判斷不用搬的」補理由
- 固定決策真的有變才改

## 7. 清掉 GitHub 的 behind

只有使用者要求時才做。GitHub 算的是 commit 血緣，cherry-pick 再多都不會讓 `behind` 減少。

先確認工作目錄乾淨、移植已經 commit，再空合併：

```bash
git merge -s ours upstream/main -m "chore(upstream): 空合併上游讓 fork behind 歸零"
git push origin main
git rev-list --count HEAD..upstream/main   # 應該是 0
```

`-s ours` 只寫入 merge commit，檔案不變。代價是 git 之後會把 `upstream/main` 當成已合併，`git merge upstream/main` 變成 no-op；我們本來就只 cherry-pick，比對照樣用 `git log <基準>..upstream/main`。

**不要按 GitHub 的 Sync fork。** 那是真的 merge，會把 QQ 端的 commit 與檔案一起拉回來。

## 回報

- 這次看了幾個 commit、搬了哪些、哪些不搬與理由
- 跑了哪些測試、結果
- 基準現在在哪裡
