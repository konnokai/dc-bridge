---
name: discord-ignore-user
description: 模型自己的暫時不理名單（ignore_user）與重複拒絕改按 ❌；state/discord-ignore.json、1~1440 分鐘、200 人上限、跨伺服器共用
---

模組：`src/core/discord-ignore.mjs`。三份名單分開：`deny.users`（管理員封鎖）、`deny.self`（本人 `/blacklist`）、這份（模型 `ignore_user` 設，帶到期時間）。

## 不理名單

- 存 `state/discord-ignore.json`（`IGNORE_VERSION = 1`），過期條目載入時跳過；壞檔／過大（>256KB）／版本不認得時備份改名再重建。
- `setIgnored()`：minutes 必須 1~1440（`IGNORE_MAX_MINUTES`）；userId 必須 Discord ID（5~25 位數字）。
- `IGNORE_MAX_USERS = 200`：在 `ignore_user` 工具入口擋下，滿了回 429（HTTP）；`saveIgnoreFile` 不再改動記憶體名單。
- @bot、私聊、reaction 都不收；管理員不能被設；控制台看得到也能解除。
- `isIgnoring()`／`ignoreList()`（最快到期排前）／`formatIgnoreUntil()`（MM/DD HH:MM）。

## 重複拒絕

- `isRefusalMessage()`：NFKC 正規化後比對 `REFUSAL_LINES`；會先剥掉 `:name:` 伺服器表情與 pictographic emoji，再剥空白與標點，所以句尾表情不算內容。改 persona 的拒絕句要同步 `REFUSAL_LINES`（目前集合：`這題我不碰換一個`、`這題我不碰`、`這題不回`、`這個不聊`、`我只會當大肥魚`）。
- `createRefusalTracker()`：同一會話同一人 10 分鐘（`REFUSAL_WINDOW_MS`）內第 2 次拒絕改按 ❌；`count()` 只查不累加，`note()` 在文字或 ❌ 真的成功後才計次，第一則失敗不會讓下一次直接變 ❌；窗口內每次重設時間。
- ❌ 走 `agentSender.react`，佔一輪 3 個 reaction 額度，也進 `finishTurn`；`src/core/discord-agent.mjs` 反應路徑補了 session 存活檢查。
- 自動 reaction 跳過 `image/*` 附件或圖片副檔名（`.txt`／`.pdf` 不再誤擋）；persona 明確叫模型不要對戰績圖按反應或回話。

## 範圍與控制台

- 名單依 user id keying，**所有伺服器共用**（跟 `/blacklist` 一樣）。
- `ignoredUser` 除了批次與上下文，也擋：頻道歷史、搜尋、`view_message`（含被引用那則）、每日摘要、黑話語料、記憶讀取、reaction、handleMessage。
- 控制台「會話」分頁可看名單、原因、到期時間，並透過 `/api/ignore/remove` 直接解除（handler `ignoreRemove`）。
- `/reset` 會順帶清 `lastDirect` 與 refusal tracker。

## 相關

[[discord-deny-user-mention-override]]、[[discord-agent-extras]]。