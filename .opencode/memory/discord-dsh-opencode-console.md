---
name: discord-dsh-opencode-console
description: DSH 內建 OpenCode Go provider 與 OpenCode Console workspace 整合的差異
---

截至 2026-11-18，DSH 的 `opencode-go` 不是第三方外掛：它由 DeepSeek 官方套件 `@deepseek-ai/dsh-llm-pi-ai` 提供。測試伺服器 DSH 0.2.2-rc.3 的 web profile 已載入它，並將它用作 hedge 備援。套件預設列出 `OPENCODE_API_KEY`；該 profile 的 `apiKeyEnv` 覆寫為 `OPENCODE_GO_API_KEY`。

- [OpenCode Console 的 DeepSeek Harness 整合頁](https://opencode.ai/console/integrations/deepseek-harness)講的是把 DSH 連到 Console workspace，由 workspace 管模型、政策、MCP、skills 與 instructions；不是替換 `opencode-go` provider 的官方外掛。
- `@mars-sea/dsh-commandcode-provider` 是 Command Code 的第三方 provider，與 OpenCode 無關；Console 整合不會取代它或 GOAT 訂閱。`dsh-generate-image` 是另一個第三方生圖套件，也沒有被 Console 整合取代。
- 不建議把 24/7 bot 接到 Console workspace：workspace 模型設定會覆蓋 profile providers；政策尚未載入時工具呼叫會被擋；Console 連線與整合外掛會成為新的可用性依賴；workspace instructions／skills 也會和 repo 管理的 persona/preset 重疊。
- 減少社群 provider 的替代方向是改用內建 `opencode-go` 或 `dsh-llm-deepseek`，但會放棄 Command Code 計費；生圖沒有對應的官方替代。這是 2026-11-18 的方案判讀，未實際執行 Console setup；setup 會改 DSH profile 並覆蓋 provider 設定。

相關：[[discord-dsh-022-upgrade]]、[[discord-commandcode-provider]]、[[discord-image-jobs]]。
