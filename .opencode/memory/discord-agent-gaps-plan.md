---
name: discord-agent-gaps-plan
description: PLAN_AGENT_GAPS 執行慣例：熱點檔案、三條線、新增 MCP 工具 9 處 checklist、完成條件
---

- `docs/design/PLAN_AGENT_GAPS.md` 是 tracked 計畫文件，可直接同步更新；新增工具 handler 位置已改為 `discord-bridge-agent-read.mjs`、`discord-bridge-agent-trade.mjs`、`discord-bridge-agent-tools.mjs`，入口只負責接線。
- 熱點檔案：`src/discord-bridge.js`（入口接線）、`src/core/discord-bridge-agent-tools.mjs`（其他工具）、`src/core/discord-bridge-agent-read.mjs`（讀取工具）、`src/core/discord-bridge-agent-trade.mjs`（交易工具）、`src/mcp-discord.js`、`src/core/discord-agent.mjs`、`plugins/dc-agent-presets/dc-tool-restrict.mjs`、`dsh/agent-presets/dc-chat/agent.cordis.yml`、`docs/guides/DISCORD.md`、`scripts/test-discord-bridge.mjs`；Discord 線一次只跑一個 session。
- 三條線：探查線 S1~S4（只讀）、網頁線 G1→G2（不改 safe-fetch.js）、Discord 線 A→C→D→B→H→E→F1→K→I。
- 新增 MCP 工具時在 `agent-read`、`agent-trade` 或 `agent-tools` 加 handler，並先 `agentSender.resolve(token)`；入口不再直接放 handler。其他 checklist：`mcp-discord.js` 註冊、`discord-agent.mjs` 額度、`DISCORD_TOOLS` 完整名、persona、重生 preset patch、`DISCORD.md`、測試、權限／intent（如需）、部署 setup 與重啟。
- 完成條件：branch 上測試通過、--check 通過、不 commit/push/部署除非管理員明講。

相關：[[dc-bridge-tests]]、[[discord-deploy]]。
