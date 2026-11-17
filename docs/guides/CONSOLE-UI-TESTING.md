# Discord 控制台離線預覽與回歸

## 瀏覽器回歸

```bash
npm run test:console-ui          # 等於 node scripts/test-console-ui.mjs
```

腳本需要 `playwright` 模組與 Chromium，兩者缺一就在啟動時直接中止，**不會**自動改用本機瀏覽器。先裝：

```bash
npm install --no-save playwright
npx playwright install chromium
```

已經有可用的 Chromium／Chrome／Edge 時，可以用環境變數指定：

- `PLAYWRIGHT_MODULE`：Playwright 模組目錄。
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`：Chromium／Chrome／Edge 執行檔。

測試自己起 `startConsole()` mock server，只連 `127.0.0.1` 的隨機埠；不會連真實 Discord、DSH 或正式 `state/`。

## 沒有本機 Chrome 的環境（OpenChamber）

OpenChamber 這台沒有本機 Chrome／Edge，`npm run test:console-ui` 會直接中止。這不是測試失敗；目視檢查改用 `openchamber_web`：

1. 照 `scripts/test-console-ui.mjs` 的 `startConsole({ host, port, token, htmlPath: 'public/discord-console.html', handlers: {...} })` 起一個臨時 server。handlers 要包含頁面會打的每一個 `/api/*`，缺一個就 500。
2. `browser.open` 開 `http://127.0.0.1:<port>/?token=t#sessions`，`browser.snapshot` 讀文字與可點元素，要互動就 `browser.click`；看完 `browser.close`。
3. 這種檢查是人工目視，不算回歸。改前端後仍要跑 `scripts/test-console-static.mjs`（ID 唯一、JS 可解析、設定欄位與表格契約）和 `npm run test:discord`。
