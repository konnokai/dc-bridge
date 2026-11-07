---
name: discord-blacklist-stale
description: deny.self 的 ⊘ 標記會留在舊 prompt 與 DSH 壓縮摘要裡；每批 prompt 用【黑名單現況】校正，已退出但 ★ 的訊息標「可以回」
---

`deny.self`（使用者自己 `/blacklist` 退出）的訊息在上下文裡標 `⊘`，代表「只看不回」。
`⊘` 是**產生那批 prompt 當下的狀態**，會留在 DSH 會話與自動壓縮摘要裡；使用者解除後，
舊 `⊘` 還會讓模型繼續不理人，造成死迴圈（實測 2026-11-02，貓咪狐狸球）。

## 現行做法（2026-11-02 修正）

- 每批 prompt 在【新訊息】前面加一行【黑名單現況】（`formatBlacklistStatus`），從當下
  `cfg.discord.deny.self` 重算。名單空時明講「目前沒有人退出；先前訊息裡的 ⊘ 只是當時的狀態」。
- 名單有值時，**只列這個伺服器的成員**，名字取法跟作者名稱一致（伺服器暱稱優先），
  快取沒有成員就不列（不印 id，避免模型把 id 當成另一個人或跨伺服器外洩）。
  實作：`guildBlacklistNames(ids, guild)` in `src/core/discord-context.mjs`。
- 已退出但 @bot／回覆 bot 的那則，在【新訊息】標 `（他本人在叫你，可以回）`（`formatBatch`
  的 `entry.direct && entry.muted`）。
- 【最近頻道訊息】圖例改成「⊘ = 已退出，只看不回；跨批的舊 ⊘ 看【黑名單現況】」。
- `dc-chat` preset 規則：⊘ 是這批的狀態，更早的 prompt／摘要裡的 ⊘ 可能過期；
  名單上的人或這批標 ⊘ 的人只看不回，★ 且註明「可以回」的照 ★ 正常回。
- 頻道摘要 prompt（`src/core/discord-notes.mjs`）與 `remember_user`／`note_event` 規則都禁止記錄黑名單狀態。
- DSH 自己的自動壓縮摘要仍可能寫舊 ⊘，靠每批的【黑名單現況】覆蓋（推測，未實測新一輪壓縮）。

## ★ 優先（2026-11-07 修正）

同一個人 @bot 時，【新訊息】標 `★` 並寫「可以回」，【黑名單現況】卻仍把他列在 ⊘「只看不回」，模型得自己猜哪條規則贏。

- `formatBlacklistStatus(names, { max, stars })`：`stars` 名單從 ⊘ 移出，並追加「★ 優先於黑名單：…照 ★ 回；他其他訊息（包括【最近頻道訊息】標 ⊘ 的）一樣只看不回」。原本的 ⊘ 保護句永遠保留。
- `src/discord-bridge.js` 用 user id 挑出這批 `direct && deny.self` 的人（`starredIds`），⊘ 名單排除他們，★ 名單另外產生；合批期間改暱稱也不會再讓同一個人同時出現在兩份名單。
- `dc-chat` preset：有列在【黑名單現況】或這批標 ⊘ 的人只看不回；★ 例外只限黑名單上的人，他其他沒標 ★ 的訊息仍然只看不回。
- 文件：`docs/guides/DISCORD.md` 三處同步。
- 部署：commit 590f0f8（2026-11-07），`dc-bridge` + `dsh` online。
- 已知邊界：沒退出的人和退出的人同名時，沒退出的人叫 bot，prompt 仍可能同時出現「⊘ 只看不回：「小明」」和「★小明」；名單本來只印名字，要解需要把使用者 id 帶進 prompt，範圍較大，未動。
- 審查者（engineering-code-reviewer）指出新句子主詞不清等問題，已修正後再 ship。

## 不用改的部分

- 送出閘門（`canReadMessage`、`isSilentMessage`）都讀當下的 cfg，所以解除後 `reply_to` 馬上可用。
- 私聊不加【黑名單現況】：`deny.self` 在私聊本來就全擋。

相關：[[discord-message-preview]]、[[discord-quiet-gate]]。