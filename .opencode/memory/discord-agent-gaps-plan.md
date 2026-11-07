---
name: discord-agent-gaps-plan
description: PLAN_AGENT_GAPS 執行慣例：熱點檔案、三條線、新增 MCP 工具 9 處 checklist、完成條件
---

- 計畫檔 `docs/design/PLAN_AGENT_GAPS.md` 不在 git，不要直接編輯；結論／探查結果寫 session 回報或 `docs/design/agent-gaps/<代號>.md`，由管理員合併。
- 熱點檔案：`src/discord-bridge.js`、`src/mcp-discord.js`、`src/core/discord-agent.mjs`、`plugins/dc-agent-presets/dc-tool-restrict.mjs`、`dsh/agent-presets/dc-chat/agent.cordis.yml`、`docs/guides/DISCORD.md`、`scripts/test-discord-bridge.mjs`；Discord 線一次只跑一個 session。
- 三條線：探查線 S1~S4（只讀）、網頁線 G1→G2（不改 safe-fetch.js）、Discord 線 A→C→D→B→H→E→F1→K→I。
- 新增 MCP 工具必改 9 處：mcp-discord.js 註冊、bridge agentHandlers 路由（先 resolve token）、discord-agent.mjs 額度、dc-tool-restrict DISCORD_TOOLS 完整名、persona 說明、build-agent-preset-patches 重生、DISCORD.md 工具段、測試、INVITE_PERMISSIONS/intents（如需）、部署 setup:discord + 重啟順序。
- 完成條件：branch 上測試通過、--check 通過、不 commit/push/部署除非管理員明講。

相關：[[dc-bridge-tests]]、[[discord-deploy]]。