---
name: discord-dsh-slash-commands
description: DSH 斜線命令 registry 與 Discord bridge 的命令轉送方式
---

截至 2026-11-12，DSH `0.2.1-rc.2` 的 CLI／Web UI `/command [input]` 直接執行 registry，不會當成模型訊息；結果由 UI 顯示在模型歷史之外。UI-less demo 與 ACP automation 沒有這個 command surface。

`sessions.prompt` 傳入斜線文字不會執行 DSH command。已驗證 RPC `commands/execute` 可執行命令；Discord bridge 必須先攔截 `/` 開頭訊息，再呼叫這個 RPC。

- Discord 目前只允許 `ownerIds` 執行 `/compact`；其他斜線訊息只提示改用 DSH Web UI，不會送進模型。DSH 正忙時 `/compact` 會回 busy；實際 DSH 探針中，無可壓縮歷史回 `No compactable history yet.`，未知命令回 `undefined`。
- `/compact` 路由於 2026-11-12 部署在 commit `f473d9f`；本機與遠端 Discord 測試均 29/29 通過。真實 Discord 頻道尚未端到端測試。

相關：[[discord-session-reload]]、[[discord-ttft-timeout]]、[[discord-deploy]]。
