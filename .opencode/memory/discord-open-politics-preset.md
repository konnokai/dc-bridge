---
name: discord-open-politics-preset
description: 開放政治討論頻道的獨立 preset、實際 preset 顯示與 fail-closed 行為
---

2026-11-17 新增 `discord.openPoliticsChannels`：列出的 `ch:` 頻道新建會話時用 `dc-chat-open`；私聊不套用，討論串要填自己的 ID。DSH preset 建立後不能直接換，改名單後要 `/reset` 或 `/reload-system-prompt` 才會讓既有會話換人格。

- `dc-chat-open` 固定以 `dc-chat` 為底，只改 4 行政治相關 persona；其他工具設定與安全邊界保持相同。測試逐項釘住差異，避免只比對「政治」字樣而漏掉其他規則被放寬。
- 它不是 `agentPreset` 的變體：`agentPreset` 改成別的值時，開放頻道仍用 `dc-chat-open`，橋接啟動時會記錄警告。
- `requirePreset` 首次建會話時才取 DSH 清單；指定項目找不到或標成 `broken` 都會重抓一次，再 fail-closed。頻道只收到通用錯誤，preset 名稱與安裝細節留在 bridge log。
- `/status` 顯示會話實際使用的 preset，並在設定已變但舊會話尚未重置時顯示下次 preset。對應資料存在 `state/discord-session-presets.json`，只影響顯示；映射缺失時舊會話會顯示未知。會話重置時同步清理映射。
- `/reload-system-prompt` 的交接摘要仍排除政治內容，因此重載後不會保留該政治話題上下文。

此功能於 2026-11-17 完成程式與測試變更；當時沒有 commit、push 或部署。相關：[[discord-persona]]、[[discord-deploy]]、[[dc-bridge-tests]]。
