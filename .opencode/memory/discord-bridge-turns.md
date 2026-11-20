---
name: discord-bridge-turns
description: `discord-bridge-turns.mjs` 的功能範圍、狀態所有權、事件流接線與行為測試
---

- 截至 2026-11-20 handoff，`createTurns(deps)` 包含提問／審批、自動壓縮、TTFT、DSH 事件流，以及訊息入口（離線佇列、批次組裝、投遞與 reaction）；私人回合仍在入口。訊息入口搬移完成後跑過 `npm run test:discord`（36/36），但 handoff 時該階段尚未 commit，review 仍在進行，不能把它當成已審查完成。
- **取代先前的 `late.turnGate` 接線方案**：`turnGate` 要在 `createTurns` 前建立並直接注入。曾把 `late.turnGate = turnGate` 放進 `deliver` 的 `job.ask` 分支；首次 `/ask` 前事件處理會因 `late.turnGate` 未定義失敗，斷線清理也會再失敗。移除 `late` 可避免這種初始化依賴。
- factory deps 解構成 `const` 後不能在模組內重新賦值。`lastFrameAt`、`offlineTimer`、`offlineFlushing` 由唯一寫入者在模組內持有 `let`；外部需要讀取的 `lastFrameAt` 用 getter 暴露。搬移後要掃描依賴寫入，因 `node --check` 不會抓這類執行期錯誤。
- 大段搬移用語意錨點定位，避免固定行號；巢狀函式也可能有 `return {`，找 factory 回傳物件要比對精確的頂層縮排。先移除原始區間再插別名，避免行號位移。搬完逐行比對來源，只放行明確列出的接線改動；若腳本弄壞區塊，可從 `git show HEAD:<path>` 還原原始範圍再驗證。
- 單靠語法檢查或字串比對不足以驗證搬移：漏掉的 import、deps 與分支錯誤可能只在特定路徑出現。事件流測試應送真實 `turn/start`、`turn/end`，確認正確 ticket 放行、回合紀錄、`lastFrameAt` 與斷線收尾；測試細節見 [[dc-bridge-tests]]。
- 自由變數掃描可能把物件屬性、物件字面值鍵及箭頭參數誤報成未解析名稱；它只能輔助檢查，還要檢查入口 deps 接線並跑結構測試。整體分層見 [[discord-bridge-layering]]。
