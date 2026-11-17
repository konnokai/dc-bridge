# DSH 端安裝說明（Discord 橋接）

`dc-bridge` 只服務 Discord。DSH 端的四個聊天 preset（`dc-chat`、`dc-chat-open`、`dc-learner`、`dc-trader`）與 MCP 掛載由 `scripts/setup-dsh.mjs` 安裝。

## 安裝步驟

1. **取得倉庫並安裝依賴**：

   ```bash
   git clone https://github.com/konnokai/dc-bridge.git
   cd dc-bridge
   npm install
   ```

2. **建立 `config.json`**：從 `config.example.json` 複製，填 `discord.token` 與 `discord.ownerIds`。`config.example.json` 只保留 Discord 需要的區塊：`dsh`、`discord`、`giphy`、`pricing`、`webSearch`。

3. **安裝 DSH 端配置**：

   ```bash
   node scripts/setup-dsh.mjs
   ```

   預設 profile 是 `web`；要換 profile 就把名稱當第一個參數：

   ```bash
   node scripts/setup-dsh.mjs <profile>
   ```

   腳本會：

   - 從 `dsh/agent-presets/` 重新產生 `plugins/dc-agent-presets/presets/*.patch.yml`，把 `dc-chat` / `dc-chat-open` / `dc-learner` / `dc-trader` 掛進 profile；
   - 在 `cordis.patch.yml` 掛 `mcp-web-search-safe`、`mcp-discord`、`mcp-slang`、`mcp-trade`、`mcp-prts`；
   - 把 `dc-agent-presets` 與 `dsh-llm-hedge` 用 `link:` 依賴註冊進 profile，並維護 `node_modules` junction；
   - 嘗試執行 `dsh plugin --profile <profile> install`。

   腳本可重複執行（冪等）。寫入前會驗證 YAML；解析失敗就停，不覆蓋既有設定。MCP 條目按 id 增刪，其他插件設定會保留。

   - `DSH_HOME` 可指定 DSH 根目錄。
   - `DC_BRIDGE_SKIP_DSH_INSTALL=1` 可跳過自動安裝 bundle，之後手動跑 `dsh plugin --profile <profile> install`。
   - `<profile>` 只能是單一目錄名，不能包含路徑分隔符或 `..`。

4. **重啟 DSH**：新 preset 與 MCP 要重啟（或重新載入 profile）才會生效。

## 驗證

```bash
npm run test:audit
npm run test:discord
```

- `npm run test:audit`：離線安全與共用模組回歸。
- `npm run test:discord`：Discord 橋接全部離線測試。
- `/status` 或控制台「會話」分頁可看到實際 preset；新建會話時 preset 清單應有 `dc-chat`、`dc-chat-open`、`dc-learner`、`dc-trader`。

## 常見問題

- **找不到 preset**：確認 `plugins/dc-agent-presets` 已註冊進 profile 的 `dsh.profile.bundles` 與 `link:` 依賴，然後重跑 `node scripts/setup-dsh.mjs` 並重啟 DSH。
- **DSH 0.2.1 起 `{{cwd}}` 已移除**：persona 只能使用 `{{provider}}`／`{{model}}`，未知變數會讓回合直接 error。
- **`dsh plugin install` 失敗**：先確認 `dsh` CLI 在 PATH；沒有就手動執行 `dsh plugin --profile <profile> install`。
